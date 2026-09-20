import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, Row } from '../db/database.service';
import { ActivitiesService } from '../activities/activities.service';
import { VenuesService } from '../venues/venues.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  nowIso,
  parseJsonArray,
  parseJsonObject,
  toVenueVersionData,
} from '../common/serialization';
import {
  ConflictReport,
  VenueSnapshot,
  VenueVersionData,
} from '../domain/types';
import { evaluateConflicts } from '../domain/conflict.engine';

const OCCUPYING_STATUSES = ['pending_approval', 'held', 'confirmed'];

export interface VenueEvaluation {
  report: ConflictReport;
  versionId: number;
  version: VenueVersionData;
  venueName: string;
}

export interface RequestBookingInput {
  activityId: string;
  venueId: string;
  startAt: string;
  endAt: string;
  idempotencyKey?: string;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activities: ActivitiesService,
    private readonly venues: VenuesService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- 冲突评估 ----------

  /**
   * 按某场地“当前版本”评估活动是否可安置。
   * 评估维度：周历可用窗、临时封闭、时间重叠（含清场缓冲）、
   * 固定设备、消防容量（可批准）、无障碍（硬条件）、特殊通行（可批准）。
   */
  evaluateVenue(
    activityId: string,
    venueId: string,
    startAt: string,
    endAt: string,
    opts: {
      grantedApprovals?: Array<'fire_capacity' | 'special_access'>;
      excludeBookingId?: string;
    } = {},
  ): VenueEvaluation {
    const activity = this.activities.requireActivity(activityId);
    const versionRow = this.venues.getCurrentVersionRow(venueId);
    const version = toVenueVersionData(versionRow as never);
    const venueRow = this.db.get('SELECT name FROM venues WHERE id = ?', venueId)!;

    const closures = this.db
      .all(
        `SELECT reason, start_at, end_at FROM venue_closures
         WHERE venue_id = ? AND start_at < ? AND end_at > ?`,
        venueId,
        endAt,
        startAt,
      )
      .map((c) => ({
        reason: c.reason as string,
        startAt: c.start_at as string,
        endAt: c.end_at as string,
      }));

    const existing = this.db
      .all(
        `SELECT b.id, b.start_at, b.end_at, b.clearing_minutes, b.status, a.title
         FROM bookings b JOIN activities a ON a.id = b.activity_id
         WHERE b.venue_id = ?
           AND b.status IN (${OCCUPYING_STATUSES.map(() => '?').join(',')})
           AND datetime(b.start_at) < datetime(?, '+' || ? || ' minutes')
           AND datetime(b.end_at, '+' || b.clearing_minutes || ' minutes') > datetime(?)
           AND b.id != ?`,
        venueId,
        ...OCCUPYING_STATUSES,
        endAt,
        version.clearingMinutes,
        startAt,
        opts.excludeBookingId ?? '',
      )
      .map((b) => ({
        bookingId: b.id as string,
        title: b.title as string,
        startAt: b.start_at as string,
        endAt: b.end_at as string,
        clearingMinutes: Number(b.clearing_minutes),
        status: b.status as string,
      }));

    const report = evaluateConflicts({
      startAt,
      endAt,
      expectedAttendees: Number(activity.expected_attendees),
      requiresWheelchair: Number(activity.requires_wheelchair) === 1,
      requiredEquipment: parseJsonArray(activity.required_equipment),
      specialAccessNote: (activity.special_access_note as string | null) ?? null,
      fireCapacity: version.fireCapacity,
      wheelchairAccessible: version.wheelchairAccessible,
      fixedEquipment: version.fixedEquipment,
      weeklyAvailability: version.weeklyAvailability,
      clearingMinutes: version.clearingMinutes,
      closures,
      existing,
      grantedApprovals: opts.grantedApprovals,
    });

    return {
      report,
      versionId: Number(versionRow.id),
      version,
      venueName: venueRow.name as string,
    };
  }

  // ---------- 申请 / 确认单 ----------

  /**
   * 提交场地申请。结果三选一：
   *  - confirmed：无冲突，立即出具确认单（快照当前场地版本）
   *  - pending_approval：仅有容量/特殊通行类例外，等待审批
   *  - rejected：存在硬冲突，返回冲突依据，不产生占用
   * 幂等：相同 idempotencyKey 的重复请求返回原单，不产生双重占用。
   */
  requestBooking(input: RequestBookingInput, requesterId: string) {
    if (new Date(input.endAt) <= new Date(input.startAt)) {
      throw new BadRequestException('结束时间必须晚于开始时间');
    }
    const activity = this.activities.requireOwned(input.activityId, requesterId);

    return this.db.transaction(() => {
      if (input.idempotencyKey) {
        const existing = this.db.get(
          'SELECT id FROM bookings WHERE idempotency_key = ?',
          input.idempotencyKey,
        );
        if (existing) {
          return { ...this.getBooking(existing.id as string), reused: true };
        }
      }

      const evaluation = this.evaluateVenue(
        input.activityId,
        input.venueId,
        input.startAt,
        input.endAt,
      );
      const { report } = evaluation;

      const id = `bk_${randomUUID()}`;
      const hasHard = report.reasons.some((r) => r.hard);
      const status = hasHard
        ? 'rejected'
        : report.approvalsNeeded.length > 0
          ? 'pending_approval'
          : 'confirmed';

      const snapshot = this.buildSnapshot(input.venueId, evaluation);
      this.db
        .prepare(
          `INSERT INTO bookings
            (id, activity_id, venue_id, venue_version_id, venue_snapshot,
             venue_name, clearing_minutes, start_at, end_at, status,
             conflict_report, idempotency_key, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.activityId,
          input.venueId,
          evaluation.versionId,
          JSON.stringify(snapshot),
          evaluation.venueName,
          evaluation.version.clearingMinutes,
          input.startAt,
          input.endAt,
          status,
          JSON.stringify(report),
          input.idempotencyKey ?? null,
          requesterId,
          nowIso(),
        );

      const audienceGroups = parseJsonArray(activity.audience_groups);
      if (status === 'confirmed') {
        this.onConfirmed(id, audienceGroups);
      } else if (status === 'pending_approval') {
        this.notifications.enqueueForAudience(
          {
            bookingId: id,
            venueId: input.venueId,
            type: 'approval_requested',
            payload: { approvalsNeeded: report.approvalsNeeded },
          },
          { ownerId: requesterId, audienceGroups },
        );
      } else {
        this.notifications.enqueueForAudience(
          {
            bookingId: id,
            venueId: input.venueId,
            type: 'booking_rejected',
            payload: { reasons: report.reasons },
          },
          { ownerId: requesterId, audienceGroups },
        );
      }

      return {
        ...this.getBooking(id),
        reused: false,
      };
    });
  }

  private buildSnapshot(venueId: string, evaluation: VenueEvaluation) {
    return {
      venueId,
      venueName: evaluation.venueName,
      versionId: evaluation.versionId,
      capturedAt: nowIso(),
      ...evaluation.version,
    };
  }

  /** 确认单成立时：清场任务、相邻交接、通知 */
  private onConfirmed(
    bookingId: string,
    audienceGroups: string[],
    notificationType: string = 'booking_confirmed',
    payloadExtra: Record<string, unknown> = {},
  ): void {
    const booking = this.requireRow(bookingId);
    this.db.run('UPDATE bookings SET confirmed_at = ? WHERE id = ?', nowIso(), bookingId);

    // 清场任务：活动结束时点应完成清场
    const endAt = booking.end_at as string;
    const clearing = Number(booking.clearing_minutes);
    const clearBy = new Date(
      new Date(endAt).getTime() + clearing * 60_000,
    ).toISOString();
    this.db.run(
      `INSERT INTO cleanup_tasks
        (booking_id, venue_id, due_at, clear_by_at, status, assignee_group, created_at)
       VALUES (?, ?, ?, ?, 'pending', '保洁人员', ?)`,
      bookingId,
      booking.venue_id,
      endAt,
      clearBy,
      nowIso(),
    );

    this.linkHandovers(bookingId);

    this.notifications.enqueueForAudience(
      {
        bookingId,
        venueId: booking.venue_id as string,
        type: notificationType,
        payload: {
          venueName: booking.venue_name,
          startAt: booking.start_at,
          endAt: booking.end_at,
          venueVersion: parseJsonObject<VenueSnapshot>(booking.venue_snapshot as string)?.version,
          ...payloadExtra,
        },
      },
      {
        ownerId: booking.created_by as string,
        audienceGroups,
      },
    );
  }

  /**
   * 迁移替代单确认后建立配套的清场任务与交接（供封闭迁移流程调用）。
   */
  establishMigration(bookingId: string, audienceGroups: string[]): void {
    this.onConfirmed(bookingId, audienceGroups, 'booking_migrated');
  }

  /** 为新确认的活动链接同一场地前后最近的相邻活动 */
  private linkHandovers(bookingId: string): void {
    const b = this.requireRow(bookingId);
    const predecessor = this.db.get(
      `SELECT id FROM bookings
       WHERE venue_id = ? AND status = 'confirmed' AND id != ?
         AND end_at <= ?
       ORDER BY end_at DESC LIMIT 1`,
      b.venue_id,
      bookingId,
      b.start_at,
    );
    const successor = this.db.get(
      `SELECT id FROM bookings
       WHERE venue_id = ? AND status = 'confirmed' AND id != ?
         AND start_at >= ?
       ORDER BY start_at ASC LIMIT 1`,
      b.venue_id,
      bookingId,
      b.end_at,
    );
    if (predecessor) {
      this.insertHandover(predecessor.id as string, bookingId, b.venue_id as string);
    }
    if (successor) {
      this.insertHandover(bookingId, successor.id as string, b.venue_id as string);
    }
    // 新活动插入后，前后两者不再相邻，作废它们之间待确认的旧交接单
    if (predecessor && successor) {
      this.db.run(
        `UPDATE handovers SET status = 'voided'
         WHERE status = 'pending'
           AND predecessor_booking_id = ? AND successor_booking_id = ?`,
        predecessor.id,
        successor.id,
      );
    }
  }

  private insertHandover(
    predecessorId: string,
    successorId: string,
    venueId: string,
  ): void {
    this.db.run(
      `INSERT OR IGNORE INTO handovers
        (venue_id, predecessor_booking_id, successor_booking_id, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`,
      venueId,
      predecessorId,
      successorId,
      nowIso(),
    );
  }

  // ---------- 例外批准 ----------

  /**
   * 审批员授予消防容量/特殊通行例外。
   * 批准后按“当前场地版本”重新评估：若期间场地已变更且出现硬冲突，
   * 不予确认并说明依据；确认单快照的是确认时的场地版本。
   */
  approve(
    bookingId: string,
    type: 'fire_capacity' | 'special_access',
    approverId: string,
    note = '',
  ) {
    return this.db.transaction(() => {
      const booking = this.requireRow(bookingId);
      if (booking.status !== 'pending_approval') {
        throw new ConflictException(
          `申请单状态为 ${booking.status}，无需审批或已终结`,
        );
      }
      const report = parseJsonObject<ConflictReport>(
        booking.conflict_report as string,
      );
      if (!report?.approvalsNeeded.includes(type)) {
        throw new BadRequestException(`该申请不涉及 ${type} 例外`);
      }
      this.db.run(
        `INSERT OR IGNORE INTO booking_approvals
          (booking_id, type, approver_id, note, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        bookingId,
        type,
        approverId,
        note,
        nowIso(),
      );

      const granted = this.grantedApprovals(bookingId);
      const evaluation = this.evaluateVenue(
        booking.activity_id as string,
        booking.venue_id as string,
        booking.start_at as string,
        booking.end_at as string,
        { grantedApprovals: granted, excludeBookingId: bookingId },
      );
      const hasHard = evaluation.report.reasons.some((r) => r.hard);
      if (hasHard) {
        this.db.run(
          'UPDATE bookings SET conflict_report = ? WHERE id = ?',
          JSON.stringify(evaluation.report),
          bookingId,
        );
        throw new ConflictException({
          message: '批准后按当前场地版本重新评估仍存在硬冲突，无法确认',
          conflictReport: evaluation.report,
        });
      }

      const stillNeeded = evaluation.report.approvalsNeeded.filter(
        (t) => !granted.includes(t),
      );
      if (stillNeeded.length > 0) {
        this.db.run(
          'UPDATE bookings SET conflict_report = ? WHERE id = ?',
          JSON.stringify(evaluation.report),
          bookingId,
        );
        return this.getBooking(bookingId);
      }

      // 全部例外齐备 → 按当前版本出具确认单
      const snapshot = this.buildSnapshot(
        booking.venue_id as string,
        evaluation,
      );
      this.db.run(
        `UPDATE bookings SET status = 'confirmed', venue_version_id = ?,
           venue_snapshot = ?, venue_name = ?, clearing_minutes = ?,
           conflict_report = ?, confirmed_at = ?
         WHERE id = ?`,
        evaluation.versionId,
        JSON.stringify(snapshot),
        evaluation.venueName,
        evaluation.version.clearingMinutes,
        JSON.stringify(evaluation.report),
        nowIso(),
        bookingId,
      );
      const activity = this.activities.get(booking.activity_id as string)!;
      this.onConfirmed(
        bookingId,
        parseJsonArray(activity.audience_groups),
      );
      return this.getBooking(bookingId);
    });
  }

  private grantedApprovals(bookingId: string): Array<'fire_capacity' | 'special_access'> {
    return this.db
      .all('SELECT type FROM booking_approvals WHERE booking_id = ?', bookingId)
      .map((r) => r.type as 'fire_capacity' | 'special_access');
  }

  // ---------- 取消 ----------

  cancel(bookingId: string, requesterId: string, reason: string, byStaff = false): Row {
    return this.db.transaction(() => {
      const booking = this.requireRow(bookingId);
      if (booking.status === 'cancelled') {
        throw new ConflictException('该申请单已取消');
      }
      if (booking.status === 'rejected') {
        throw new ConflictException('已驳回的申请单无需取消');
      }
      if (!byStaff && booking.created_by !== requesterId) {
        throw new ForbiddenException('只能取消本人负责的活动申请');
      }

      const started = new Date(booking.start_at as string).getTime() <= Date.now();
      this.db.run(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
         WHERE id = ?`,
        nowIso(),
        reason,
        bookingId,
      );
      // 未开始的活动取消：删除待清场任务；已开始的保留清场责任
      if (!started) {
        this.db.run(
          `UPDATE cleanup_tasks SET status = 'done' WHERE booking_id = ? AND status = 'pending'`,
          bookingId,
        );
      }
      this.db.run(
        `UPDATE handovers SET status = 'voided'
         WHERE status = 'pending'
           AND (predecessor_booking_id = ? OR successor_booking_id = ?)`,
        bookingId,
        bookingId,
      );
      const activity = this.activities.get(booking.activity_id as string)!;
      this.notifications.enqueueForAudience(
        {
          bookingId,
          venueId: booking.venue_id as string,
          type: 'booking_cancelled',
          payload: { reason, started, byStaff },
        },
        {
          ownerId: activity.owner_id as string,
          audienceGroups: parseJsonArray(activity.audience_groups),
        },
      );
      return this.requireRow(bookingId);
    });
  }

  // ---------- 交接确认 ----------

  listHandovers(venueId?: string) {
    const sql = `
      SELECT h.*,
        pb.start_at AS pred_start, pb.end_at AS pred_end,
        pa.title AS pred_title, pa.owner_id AS pred_owner,
        sb.start_at AS succ_start, sb.end_at AS succ_end,
        sa.title AS succ_title, sa.owner_id AS succ_owner
      FROM handovers h
      JOIN bookings pb ON pb.id = h.predecessor_booking_id
      JOIN bookings sb ON sb.id = h.successor_booking_id
      JOIN activities pa ON pa.id = pb.activity_id
      JOIN activities sa ON sa.id = sb.activity_id
      ${venueId ? 'WHERE h.venue_id = ?' : ''}
      ORDER BY h.id`;
    return venueId ? this.db.all(sql, venueId) : this.db.all(sql);
  }

  /**
   * 交接必须由前后责任人分别确认：
   * side=predecessor 仅前序活动负责人可确认，side=successor 仅后序可确认。
   * 两侧均确认后交接成立。
   */
  confirmHandover(
    handoverId: number,
    side: 'predecessor' | 'successor',
    userId: string,
  ) {
    return this.db.transaction(() => {
      const h = this.db.get('SELECT * FROM handovers WHERE id = ?', handoverId);
      if (!h) throw new NotFoundException(`交接单不存在：${handoverId}`);
      if (h.status === 'voided') {
        throw new ConflictException('该交接已因活动取消而作废');
      }
      const bookingId =
        side === 'predecessor'
          ? (h.predecessor_booking_id as string)
          : (h.successor_booking_id as string);
      const booking = this.requireRow(bookingId);
      const activity = this.activities.get(booking.activity_id as string)!;
      if (activity.owner_id !== userId) {
        throw new ForbiddenException(
          side === 'predecessor'
            ? '仅前序活动负责人可确认交出'
            : '仅后序活动负责人可确认接收',
        );
      }
      if (side === 'predecessor') {
        if (h.predecessor_confirmed_by) {
          throw new ConflictException('前序责任人已确认，请勿重复操作');
        }
        this.db.run(
          'UPDATE handovers SET predecessor_confirmed_by = ?, predecessor_confirmed_at = ? WHERE id = ?',
          userId,
          nowIso(),
          handoverId,
        );
      } else {
        if (h.successor_confirmed_by) {
          throw new ConflictException('后序责任人已确认，请勿重复操作');
        }
        this.db.run(
          'UPDATE handovers SET successor_confirmed_by = ?, successor_confirmed_at = ? WHERE id = ?',
          userId,
          nowIso(),
          handoverId,
        );
      }
      const updated = this.db.get('SELECT * FROM handovers WHERE id = ?', handoverId)!;
      if (updated.predecessor_confirmed_by && updated.successor_confirmed_by) {
        this.db.run("UPDATE handovers SET status = 'confirmed' WHERE id = ?", handoverId);
      }
      return this.db.get(
        `SELECT h.*, pa.title AS pred_title, sa.title AS succ_title
         FROM handovers h
         JOIN bookings pb ON pb.id = h.predecessor_booking_id
         JOIN bookings sb ON sb.id = h.successor_booking_id
         JOIN activities pa ON pa.id = pb.activity_id
         JOIN activities sa ON sa.id = sb.activity_id
         WHERE h.id = ?`,
        handoverId,
      );
    });
  }

  // ---------- 清场 ----------

  listCleanup(params: { status?: string; venueId?: string; from?: string; to?: string }) {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.status) {
      clauses.push('ct.status = ?');
      args.push(params.status);
    }
    if (params.venueId) {
      clauses.push('ct.venue_id = ?');
      args.push(params.venueId);
    }
    if (params.from) {
      clauses.push('ct.clear_by_at >= ?');
      args.push(params.from);
    }
    if (params.to) {
      clauses.push('ct.clear_by_at <= ?');
      args.push(params.to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.all(
      `SELECT ct.*, a.title, v.name AS venue_name
       FROM cleanup_tasks ct
       JOIN bookings b ON b.id = ct.booking_id
       JOIN activities a ON a.id = b.activity_id
       JOIN venues v ON v.id = ct.venue_id
       ${where}
       ORDER BY ct.clear_by_at`,
      ...args,
    );
  }

  completeCleanup(taskId: number, userId: string) {
    const row = this.db.get('SELECT * FROM cleanup_tasks WHERE id = ?', taskId);
    if (!row) throw new NotFoundException(`清场任务不存在：${taskId}`);
    if (row.status === 'done') {
      throw new ConflictException('清场任务已完成');
    }
    this.db.run(
      "UPDATE cleanup_tasks SET status = 'done', done_by = ?, done_at = ? WHERE id = ?",
      userId,
      nowIso(),
      taskId,
    );
    return this.db.get('SELECT * FROM cleanup_tasks WHERE id = ?', taskId);
  }

  // ---------- 查询 ----------

  requireRow(id: string): Row {
    const row = this.db.get('SELECT * FROM bookings WHERE id = ?', id);
    if (!row) throw new NotFoundException(`申请单不存在：${id}`);
    return row;
  }

  getBooking(id: string) {
    const row = this.requireRow(id);
    const activity = this.activities.get(row.activity_id as string)!;
    const approvals = this.db.all(
      'SELECT type, approver_id, note, created_at FROM booking_approvals WHERE booking_id = ?',
      id,
    );
    const notifications = this.db.all(
      'SELECT id, type, status, person_id, audience_group, created_at, sent_at FROM notifications WHERE booking_id = ? ORDER BY id',
      id,
    );
    return {
      id: row.id,
      activityId: row.activity_id,
      title: activity.title,
      ownerId: activity.owner_id,
      venueId: row.venue_id,
      venueName: row.venue_name,
      startAt: row.start_at,
      endAt: row.end_at,
      status: row.status,
      conflictReport: parseJsonObject<ConflictReport>(row.conflict_report as string),
      approvals,
      venueSnapshot: parseJsonObject(row.venue_snapshot as string),
      notifications,
      confirmedAt: row.confirmed_at,
      cancelledAt: row.cancelled_at,
      cancelReason: row.cancel_reason,
      replacementOf: row.replacement_of,
    };
  }

  /** 某时刻/时间窗的实际使用者（confirmed 为实际使用，其余为占位） */
  usageInWindow(from: string, to: string, venueId?: string) {
    const venueClause = venueId ? 'AND b.venue_id = ?' : '';
    // 占位符顺序：start_at < to, end_at > from
    const args = venueId ? [to, from, venueId] : [to, from];
    const rows = this.db.all(
      `SELECT b.*, a.title, a.owner_id, a.audience_groups
       FROM bookings b JOIN activities a ON a.id = b.activity_id
       WHERE b.status IN ('confirmed','held','pending_approval')
         AND b.start_at < ? AND b.end_at > ?
         ${venueClause}
       ORDER BY b.venue_id, b.start_at`,
      ...args,
    );
    return rows.map((r) => ({
      bookingId: r.id,
      venueId: r.venue_id,
      title: r.title,
      ownerId: r.owner_id,
      startAt: r.start_at,
      endAt: r.end_at,
      status: r.status,
      actualUser: r.status === 'confirmed',
      audienceGroups: parseJsonArray(r.audience_groups),
      venueVersion: parseJsonObject<VenueSnapshot>(r.venue_snapshot as string)?.version,
    }));
  }
}
