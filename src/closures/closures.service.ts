import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rowToBooking, rowToClosure, rowToImpact } from '../database/mappers';
import { Booking, Closure, ClosureImpact, Venue } from '../domain/types';
import { DomainError } from '../common/errors';
import { newId } from '../common/validate';
import { nowIso, overlaps } from '../domain/time';
import { evaluatePlacement } from '../domain/conflicts';
import { VenuesService } from '../venues/venues.service';
import { HandoversService } from '../handovers/handovers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingsService } from '../bookings/bookings.service';

export interface ClosureResult {
  closure: Closure;
  venue: Venue;
  impacts: Array<ClosureImpact & { bookingTitle: string }>;
}

/**
 * 临时封闭：总务封闭场地时，系统在单个事务内
 * 1. 将场地置为 CLOSED（版本自增、留快照）；
 * 2. 找出受影响的已确认/进行中预约；
 * 3. 对未开始的预约搜索满足全部硬条件（容量/无障碍/设备/时段/无冲突）的替代场地并迁移，
 *    迁移记录所依据的新场地版本，并为受影响人群生成变更通知；
 * 4. 无法满足硬条件的，记录无法安置的明确原因；
 * 5. 已经开始的活动不静默迁移，标记为需人工处理。
 */
@Injectable()
export class ClosuresService {
  constructor(
    private readonly db: DatabaseService,
    private readonly venues: VenuesService,
    private readonly handovers: HandoversService,
    private readonly notifications: NotificationsService,
    private readonly bookings: BookingsService,
  ) {}

  closeVenue(
    venueId: string,
    input: { reason: string; from: string; to: string; actorId: string },
  ): ClosureResult {
    return this.db.tx(() => {
      const venue = this.venues.get(venueId);
      if (!(input.from < input.to)) {
        throw DomainError.badRequest('封闭开始时间必须早于结束时间');
      }

      const closureId = newId('cls');
      this.db.conn
        .prepare(
          `INSERT INTO closures (id, venue_id, reason, from_ts, to_ts, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(closureId, venueId, input.reason, input.from, input.to, input.actorId, nowIso());

      // 场地封闭 → 状态变更并升版本（确认依据可追溯）
      const closedVenue = this.venues.setStatus(venueId, 'CLOSED', input.actorId, `临时封闭：${input.reason}`);

      const affected = this.affectedBookings(venueId, input.from, input.to);
      const impacts: Array<ClosureImpact & { bookingTitle: string }> = [];

      for (const booking of affected) {
        if (booking.status === 'IN_PROGRESS') {
          // 已经开始的活动不可静默迁移
          const impact = this.recordImpact(closureId, booking.id, 'MANUAL_REQUIRED', null, [
            '活动已开始，不可静默迁移，需总务现场人工协调',
          ]);
          impacts.push({ ...impact, bookingTitle: booking.title });
          this.bookings.addEvent(booking.id, 'CLOSURE_MANUAL_REQUIRED', { closureId }, input.actorId);
          this.notifications.createForBooking(
            booking.id,
            [...booking.audienceGroups, 'staff'],
            `场地「${venue.name}」临时封闭（${input.reason}），活动「${booking.title}」正在进行中，需现场人工协调`,
          );
          continue;
        }

        const alternative = this.findAlternative(booking, venueId);
        if (alternative) {
          const target = alternative.venue;
          this.db.conn
            .prepare(`UPDATE bookings SET venue_id=?, venue_version=?, updated_at=? WHERE id=?`)
            .run(target.id, target.version, nowIso(), booking.id);
          this.bookings.addEvent(
            booking.id,
            'RELOCATED',
            {
              closureId,
              fromVenueId: venueId,
              toVenueId: target.id,
              venueVersion: target.version,
              reason: input.reason,
            },
            input.actorId,
          );
          // 新场地的相邻场次可能需要交接
          const moved = this.bookings.get(booking.id);
          this.handovers.ensureForBooking(moved, target.turnoverMinutes);
          const impact = this.recordImpact(closureId, booking.id, 'RELOCATED', target.id, [
            `满足全部硬条件（容量 ${target.capacity}≥${booking.attendees}` +
              `${booking.requiresAccessibleRoute ? '、无障碍可用' : ''}` +
              `、设备齐全、时段可用），迁移至「${target.name}」v${target.version}`,
          ]);
          impacts.push({ ...impact, bookingTitle: booking.title });
          this.notifications.createForBooking(
            booking.id,
            [...booking.audienceGroups, 'cleaning'],
            `场地「${venue.name}」临时封闭（${input.reason}）：活动「${booking.title}」已迁移至「${target.name}」，时间不变（${booking.start} ~ ${booking.end}）`,
          );
        } else {
          const reasons = this.explainNoAlternative(booking, venueId);
          this.db.conn
            .prepare(`UPDATE bookings SET status='DISPLACED', updated_at=? WHERE id=?`)
            .run(nowIso(), booking.id);
          this.bookings.addEvent(booking.id, 'DISPLACED', { closureId, reasons }, input.actorId);
          const impact = this.recordImpact(closureId, booking.id, 'UNABLE', null, reasons);
          impacts.push({ ...impact, bookingTitle: booking.title });
          this.notifications.createForBooking(
            booking.id,
            [...booking.audienceGroups, 'staff'],
            `场地「${venue.name}」临时封闭（${input.reason}）：活动「${booking.title}」暂无满足条件的替代场地。原因：${reasons.join('；')}`,
          );
        }
      }

      return {
        closure: this.getClosure(closureId),
        venue: closedVenue,
        impacts,
      };
    });
  }

  /** 重开场地（总务），版本自增 */
  reopenVenue(venueId: string, actorId: string, reason: string): Venue {
    return this.venues.setStatus(venueId, 'OPEN', actorId, reason || '场地重新开放');
  }

  getClosure(id: string): Closure {
    const row = this.db.conn.prepare('SELECT * FROM closures WHERE id = ?').get(id);
    if (!row) throw DomainError.notFound(`封闭记录不存在：${id}`);
    return rowToClosure(row);
  }

  impactsOf(closureId: string): ClosureImpact[] {
    return this.db.conn
      .prepare('SELECT * FROM closure_impacts WHERE closure_id = ? ORDER BY created_at')
      .all(closureId)
      .map(rowToImpact);
  }

  closuresOf(venueId: string): Closure[] {
    return this.db.conn
      .prepare('SELECT * FROM closures WHERE venue_id = ? ORDER BY created_at')
      .all(venueId)
      .map(rowToClosure);
  }

  private affectedBookings(venueId: string, from: string, to: string): Booking[] {
    return this.db.conn
      .prepare(
        `SELECT * FROM bookings
         WHERE venue_id = ? AND status IN ('CONFIRMED','IN_PROGRESS') AND start < ? AND end > ?
         ORDER BY start`,
      )
      .all(venueId, to, from)
      .map(rowToBooking);
  }

  /**
   * 搜索满足全部硬条件的替代场地：开放中、时段可用、容量足够、
   * 无障碍满足、固定设备齐全、与现有占用无冲突。
   * 迁移不走例外批准——替代方案必须无条件满足硬条件。
   */
  private findAlternative(booking: Booking, excludeVenueId: string): { venue: Venue } | null {
    const candidates = this.venues
      .list()
      .filter((v) => v.id !== excludeVenueId && v.status === 'OPEN')
      .sort((a, b) => a.capacity - b.capacity); // 优先容量最接近的，避免大材小用
    for (const candidate of candidates) {
      const existing = this.bookings.activeBookingsAt(candidate.id);
      const evaluation = evaluatePlacement(candidate, booking, existing);
      if (evaluation.violations.length === 0) {
        return { venue: candidate };
      }
    }
    return null;
  }

  /** 汇总每个候选场地被拒的原因，作为无法安置的明确说明 */
  private explainNoAlternative(booking: Booking, excludeVenueId: string): string[] {
    const reasons: string[] = [];
    const candidates = this.venues.list().filter((v) => v.id !== excludeVenueId);
    if (candidates.length === 0) {
      return ['校内没有其他可用场地'];
    }
    for (const candidate of candidates) {
      if (candidate.status !== 'OPEN') {
        reasons.push(`「${candidate.name}」：场地封闭中`);
        continue;
      }
      const existing = this.bookings.activeBookingsAt(candidate.id);
      const evaluation = evaluatePlacement(candidate, booking, existing);
      if (evaluation.violations.length === 0) continue; // 理论不到达：有解就不会走到这里
      reasons.push(`「${candidate.name}」：${evaluation.violations.map((v) => v.message).join('；')}`);
    }
    return reasons.length > 0 ? reasons : ['没有满足硬条件的替代场地'];
  }

  private recordImpact(
    closureId: string,
    bookingId: string,
    action: ClosureImpact['action'],
    toVenueId: string | null,
    reasons: string[],
  ): ClosureImpact {
    const id = newId('imp');
    this.db.conn
      .prepare(
        `INSERT INTO closure_impacts (id, closure_id, booking_id, action, to_venue_id, reasons, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, closureId, bookingId, action, toVenueId, JSON.stringify(reasons), nowIso());
    return rowToImpact(this.db.conn.prepare('SELECT * FROM closure_impacts WHERE id = ?').get(id));
  }
}
