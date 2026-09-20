import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rowToBooking, rowToEvent } from '../database/mappers';
import { ACTIVE_BOOKING_STATUSES, AuthUser, Booking, BookingEvent } from '../domain/types';
import { DomainError } from '../common/errors';
import { hashPayload, newId } from '../common/validate';
import { nowIso } from '../domain/time';
import { evaluatePlacement, uncoveredWaivables, Violation } from '../domain/conflicts';
import { isUniqueViolation } from '../database/sqlite';
import { VenuesService } from '../venues/venues.service';
import { HandoversService } from '../handovers/handovers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalsService } from '../approvals/approvals.service';

export interface CreateBookingInput {
  ownerId: string;
  ownerName: string | null;
  title: string;
  attendees: number;
  requiresAccessibleRoute: boolean;
  requiredEquipment: string[];
  audienceGroups: string[];
  start: string;
  end: string;
  venueId: string;
  idempotencyKey: string | null;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly venues: VenuesService,
    private readonly handovers: HandoversService,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * 创建预约（PENDING）。幂等：携带相同 Idempotency-Key 的重复请求返回同一条记录，
   * 不会产生双重占用；Key 相同但内容不同则报 409。
   */
  create(input: CreateBookingInput): { booking: Booking; replayed: boolean } {
    this.venues.get(input.venueId); // 场地必须存在
    const requestHash = input.idempotencyKey ? hashPayload(this.payloadOf(input)) : null;

    if (input.idempotencyKey) {
      const existing = this.db.conn
        .prepare('SELECT * FROM bookings WHERE owner_id = ? AND idempotency_key = ?')
        .get(input.ownerId, input.idempotencyKey);
      if (existing) {
        const b = rowToBooking(existing);
        if (b.requestHash !== requestHash) {
          throw DomainError.conflict(
            'Idempotency-Key 已被使用且请求内容不一致',
            { bookingId: b.id },
          );
        }
        return { booking: b, replayed: true };
      }
    }

    const id = newId('bkg');
    const now = nowIso();
    try {
      this.db.tx(() => {
        this.db.conn
          .prepare(
            `INSERT INTO bookings (id, owner_id, owner_name, title, attendees, requires_accessible,
               required_equipment, audience_groups, start, end, venue_id, venue_version, status,
               idempotency_key, request_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'PENDING', ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.ownerId,
            input.ownerName,
            input.title,
            input.attendees,
            input.requiresAccessibleRoute ? 1 : 0,
            JSON.stringify(input.requiredEquipment),
            JSON.stringify(input.audienceGroups),
            input.start,
            input.end,
            input.venueId,
            input.idempotencyKey,
            requestHash,
            now,
            now,
          );
        this.addEvent(id, 'CREATED', { venueId: input.venueId, start: input.start, end: input.end }, input.ownerId);
      });
    } catch (e: any) {
      // 并发下同 Key 插入冲突：回读已存在的记录返回（不产生第二条）
      if (input.idempotencyKey && isUniqueViolation(e)) {
        const row = this.db.conn
          .prepare('SELECT * FROM bookings WHERE owner_id = ? AND idempotency_key = ?')
          .get(input.ownerId, input.idempotencyKey);
        if (row) return { booking: rowToBooking(row), replayed: true };
      }
      throw e;
    }
    return { booking: this.get(id), replayed: false };
  }

  private payloadOf(input: CreateBookingInput) {
    return {
      title: input.title,
      attendees: input.attendees,
      requiresAccessibleRoute: input.requiresAccessibleRoute,
      requiredEquipment: input.requiredEquipment,
      audienceGroups: input.audienceGroups,
      start: input.start,
      end: input.end,
      venueId: input.venueId,
    };
  }

  get(id: string): Booking {
    const row = this.db.conn.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!row) throw DomainError.notFound(`预约不存在：${id}`);
    return rowToBooking(row);
  }

  list(filter: { ownerId?: string; venueId?: string; status?: string }): Booking[] {
    let sql = 'SELECT * FROM bookings WHERE 1=1';
    const args: unknown[] = [];
    if (filter.ownerId) {
      sql += ' AND owner_id = ?';
      args.push(filter.ownerId);
    }
    if (filter.venueId) {
      sql += ' AND venue_id = ?';
      args.push(filter.venueId);
    }
    if (filter.status) {
      sql += ' AND status = ?';
      args.push(filter.status);
    }
    sql += ' ORDER BY start';
    return this.db.conn.prepare(sql).all(...args).map(rowToBooking);
  }

  /** 负责人修改本人项目：仅 PENDING 状态可改，已确认的须先取消再重新预约 */
  update(id: string, patch: Partial<CreateBookingInput>, user: AuthUser): Booking {
    const b = this.get(id);
    this.assertOwner(b, user);
    if (b.status !== 'PENDING') {
      throw DomainError.conflict(`当前状态 ${b.status} 不可修改，仅待确认（PENDING）的预约可修改`);
    }
    const next = { ...b, ...stripUndefined(patch) };
    if (patch.venueId) this.venues.get(patch.venueId);
    this.db.conn
      .prepare(
        `UPDATE bookings SET title=?, attendees=?, requires_accessible=?, required_equipment=?,
           audience_groups=?, start=?, end=?, venue_id=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.title,
        next.attendees,
        next.requiresAccessibleRoute ? 1 : 0,
        JSON.stringify(next.requiredEquipment),
        JSON.stringify(next.audienceGroups),
        next.start,
        next.end,
        next.venueId,
        nowIso(),
        id,
      );
    this.addEvent(id, 'UPDATED', stripUndefined(patch) as Record<string, unknown>, user.id);
    return this.get(id);
  }

  /**
   * 确认预约：在单个事务内完成冲突判断与状态写入，并发确认不会双重占用。
   * 幂等：已确认时重复调用直接返回当前状态。
   * 确认时把当前场地版本写入 booking.venue_version，作为本次确认的依据。
   */
  confirm(id: string, user: AuthUser): { booking: Booking; violations: Violation[]; handoverIds: string[] } {
    return this.db.tx(() => {
      const b = this.get(id);
      this.assertOwner(b, user);
      if (b.status === 'CONFIRMED') {
        const incoming = this.handovers.incomingFor(id);
        return { booking: b, violations: [], handoverIds: incoming ? [incoming.id] : [] };
      }
      if (b.status !== 'PENDING') {
        throw DomainError.conflict(`当前状态 ${b.status} 不可确认`);
      }

      const venue = this.venues.get(b.venueId);
      const existing = this.activeBookingsAt(b.venueId, id);
      const evaluation = evaluatePlacement(venue, b, existing);

      const hard = evaluation.violations.filter((v) => v.severity === 'HARD');
      if (hard.length > 0) {
        throw DomainError.conflict('存在硬冲突，无法确认', { violations: hard });
      }
      const waivable = evaluation.violations.filter((v) => v.severity === 'WAIVABLE');
      const uncovered = uncoveredWaivables(waivable, this.approvals.forBooking(id));
      if (uncovered.length > 0) {
        throw DomainError.conflict('存在需额外批准的例外（消防容量/特殊通行），请先申请并获批', {
          violations: uncovered,
          approvable: true,
        });
      }

      const now = nowIso();
      this.db.conn
        .prepare(`UPDATE bookings SET status='CONFIRMED', venue_version=?, updated_at=? WHERE id=?`)
        .run(venue.version, now, id);
      this.addEvent(
        id,
        'CONFIRMED',
        { venueId: venue.id, venueVersion: venue.version, waivedViolations: waivable },
        user.id,
      );

      // 清场缓冲不足的相邻场次：建立交接，前后责任人分别确认后方可开始
      const handovers = this.handovers.ensureForBooking(this.get(id), venue.turnoverMinutes);
      if (handovers.length > 0) {
        this.addEvent(id, 'HANDOVER_REQUIRED', { handoverIds: handovers.map((h) => h.id) }, user.id);
      }
      return { booking: this.get(id), violations: waivable, handoverIds: handovers.map((h) => h.id) };
    });
  }

  /** 取消：负责人可取消本人项目；总务可取消任何预约。取消会通知受影响人群。 */
  cancel(id: string, user: AuthUser, reason?: string): Booking {
    return this.db.tx(() => {
      const b = this.get(id);
      if (user.role !== 'staff') this.assertOwner(b, user);
      if (['CANCELLED', 'COMPLETED'].includes(b.status)) {
        throw DomainError.conflict(`当前状态 ${b.status} 不可取消`);
      }
      this.db.conn
        .prepare(`UPDATE bookings SET status='CANCELLED', updated_at=? WHERE id=?`)
        .run(nowIso(), id);
      this.addEvent(id, 'CANCELLED', { reason: reason ?? null }, user.id);
      if (ACTIVE_BOOKING_STATUSES.includes(b.status)) {
        this.notifications.createForBooking(
          id,
          [...b.audienceGroups, 'cleaning'],
          `活动「${b.title}」(${b.start}) 已取消${reason ? `：${reason}` : ''}`,
        );
      }
      return this.get(id);
    });
  }

  /** 签到开始：需要交接的场次必须等交接完成（前后责任人分别确认） */
  checkIn(id: string, user: AuthUser): Booking {
    return this.db.tx(() => {
      const b = this.get(id);
      this.assertOwner(b, user);
      if (b.status === 'IN_PROGRESS') return b; // 幂等
      if (b.status !== 'CONFIRMED') {
        throw DomainError.conflict(`当前状态 ${b.status} 不可签到`);
      }
      const incoming = this.handovers.incomingFor(id);
      if (incoming && incoming.status !== 'COMPLETE') {
        throw DomainError.conflict('与前一场的责任交接尚未完成（需前后责任人分别确认），暂不能开始', {
          handoverId: incoming.id,
          handoverStatus: incoming.status,
          pendingCleanup: incoming.cleanupItems.filter((i) => !i.done),
        });
      }
      this.db.conn
        .prepare(`UPDATE bookings SET status='IN_PROGRESS', updated_at=? WHERE id=?`)
        .run(nowIso(), id);
      this.addEvent(id, 'CHECKED_IN', {}, user.id);
      return this.get(id);
    });
  }

  complete(id: string, user: AuthUser): Booking {
    return this.db.tx(() => {
      const b = this.get(id);
      this.assertOwner(b, user);
      if (b.status === 'COMPLETED') return b;
      if (b.status !== 'IN_PROGRESS') {
        throw DomainError.conflict(`当前状态 ${b.status} 不可结束`);
      }
      this.db.conn
        .prepare(`UPDATE bookings SET status='COMPLETED', updated_at=? WHERE id=?`)
        .run(nowIso(), id);
      this.addEvent(id, 'COMPLETED', {}, user.id);
      return this.get(id);
    });
  }

  events(id: string): BookingEvent[] {
    return this.db.conn
      .prepare('SELECT * FROM booking_events WHERE booking_id = ? ORDER BY created_at')
      .all(id)
      .map(rowToEvent);
  }

  /** 某场地当前占用中的预约（确认/进行中），可选排除某条 */
  activeBookingsAt(venueId: string, excludeId?: string): Booking[] {
    let sql = `SELECT * FROM bookings WHERE venue_id = ? AND status IN ('CONFIRMED','IN_PROGRESS')`;
    const args: unknown[] = [venueId];
    if (excludeId) {
      sql += ' AND id != ?';
      args.push(excludeId);
    }
    return this.db.conn.prepare(sql).all(...args).map(rowToBooking);
  }

  addEvent(bookingId: string, type: string, payload: Record<string, unknown>, actorId: string) {
    this.db.conn
      .prepare(
        `INSERT INTO booking_events (id, booking_id, type, payload, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newId('evt'), bookingId, type, JSON.stringify(payload), actorId, nowIso());
  }

  assertOwner(b: Booking, user: AuthUser) {
    if (b.ownerId !== user.id) {
      throw DomainError.forbidden('活动负责人只能修改本人项目');
    }
  }
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
