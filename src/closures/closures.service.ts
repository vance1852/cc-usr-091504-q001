import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, Row } from '../db/database.service';
import { BookingsService } from '../bookings/bookings.service';
import { VenuesService } from '../venues/venues.service';
import { NotificationsService } from '../notifications/notifications.service';
import { nowIso, parseJsonArray } from '../common/serialization';
import { ConflictKind } from '../domain/types';

const AFFECTED_STATUSES = ['confirmed', 'held', 'pending_approval'];

export interface AlternativeProposalView {
  proposalId: number;
  venueId: string;
  venueName: string;
  venueVersion: number;
  /** 无任何冲突，可直接安置 */
  immediatelyUsable: boolean;
  /** 安置该方案仍需的例外批准 */
  requiresApproval: Array<'fire_capacity' | 'special_access'>;
  softReasons: Array<{ kind: ConflictKind; message: string }>;
}

export interface ClosureImpactView {
  bookingId: string;
  title: string;
  ownerId: string;
  audienceGroups: string[];
  started: boolean;
  outcome: 'immovable' | 'alternatives_ready' | 'no_alternative';
  /** outcome=no_alternative 时逐场地给出的不可安置原因（硬条件） */
  impossibleReasons?: Array<{ venueId: string; venueName: string; reasons: string[] }>;
  alternatives: AlternativeProposalView[];
  reason: string;
}

@Injectable()
export class ClosuresService {
  constructor(
    private readonly db: DatabaseService,
    private readonly bookings: BookingsService,
    private readonly venues: VenuesService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * 总务人员登记临时封闭。系统不会静默迁移任何活动：
   *  - 已开始的活动：标记 immovable，原地保留并发出警示；
   *  - 未开始的活动：找出所有满足硬条件的替代场地（含仅需例外批准的），
   *    生成备选方案等负责人选择；无任何可行场地时逐场地写明原因。
   */
  registerClosure(
    venueId: string,
    startAt: string,
    endAt: string,
    reason: string,
    staffId: string,
  ) {
    if (new Date(endAt) <= new Date(startAt)) {
      throw new BadRequestException('封闭结束时间必须晚于开始时间');
    }
    return this.db.transaction(() => {
      const venue = this.db.get('SELECT id, name FROM venues WHERE id = ? AND active = 1', venueId);
      if (!venue) throw new NotFoundException(`场地不存在或已停用：${venueId}`);

      const closureId = this.db.insert(
        `INSERT INTO venue_closures (venue_id, start_at, end_at, reason, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        venueId,
        startAt,
        endAt,
        reason,
        staffId,
        nowIso(),
      );

      const affected = this.db.all(
        `SELECT b.*, a.title, a.owner_id, a.audience_groups
         FROM bookings b JOIN activities a ON a.id = b.activity_id
         WHERE b.venue_id = ?
           AND b.status IN (${AFFECTED_STATUSES.map(() => '?').join(',')})
           AND b.start_at < ? AND b.end_at > ?
         ORDER BY b.start_at`,
        venueId,
        ...AFFECTED_STATUSES,
        endAt,
        startAt,
      );

      const otherVenues = this.venues
        .listActive()
        .filter((v) => v.id !== venueId);

      const impacts: ClosureImpactView[] = [];
      for (const b of affected) {
        impacts.push(
          this.processAffected(closureId, b, otherVenues, reason),
        );
      }

      return {
        closureId,
        venueId,
        venueName: venue.name,
        startAt,
        endAt,
        reason,
        affectedCount: affected.length,
        impacts,
      };
    });
  }

  private processAffected(
    closureId: number,
    booking: Row,
    otherVenues: Row[],
    closureReason: string,
  ): ClosureImpactView {
    const bookingId = booking.id as string;
    const ownerId = booking.owner_id as string;
    const audienceGroups = parseJsonArray(booking.audience_groups);
    const started =
      new Date(booking.start_at as string).getTime() <= Date.now();

    // 已开始的活动不可静默迁移
    if (started) {
      this.recordImpact(closureId, bookingId, 'immovable', {
        reason: '活动已经开始，不得迁移；请现场处置（疏散/顺延/就地保障）',
      });
      this.notifications.enqueueForAudience(
        {
          bookingId,
          venueId: booking.venue_id as string,
          type: 'closure_immovable',
          payload: {
            closureReason,
            startAt: booking.start_at,
            endAt: booking.end_at,
            instruction: '活动已开始，保留原安排，请立即现场协调',
          },
        },
        { ownerId, audienceGroups },
      );
      return {
        bookingId,
        title: booking.title as string,
        ownerId,
        audienceGroups,
        started: true,
        outcome: 'immovable',
        alternatives: [],
        reason: '活动已经开始，不可迁移',
      };
    }

    // 为每个候选场地按其当前版本评估硬条件
    const candidates: Array<{
      venue: Row;
      report: ReturnType<BookingsService['evaluateVenue']>;
    }> = [];
    const impossible: Array<{ venueId: string; venueName: string; reasons: string[] }> = [];

    for (const venue of otherVenues) {
      const report = this.bookings.evaluateVenue(
        booking.activity_id as string,
        venue.id as string,
        booking.start_at as string,
        booking.end_at as string,
        { excludeBookingId: bookingId },
      );
      const hard = report.report.reasons.filter((r) => r.hard);
      if (hard.length > 0) {
        impossible.push({
          venueId: venue.id as string,
          venueName: venue.name as string,
          reasons: hard.map((r) => r.message),
        });
      } else {
        candidates.push({ venue, report });
      }
    }

    if (candidates.length === 0) {
      this.recordImpact(closureId, bookingId, 'no_alternative', {
        impossible,
        reason: '封闭时段内没有满足硬条件的替代场地',
      });
      this.notifications.enqueueForAudience(
        {
          bookingId,
          venueId: booking.venue_id as string,
          type: 'closure_no_alternative',
          payload: { closureReason, impossible },
        },
        { ownerId, audienceGroups },
      );
      return {
        bookingId,
        title: booking.title as string,
        ownerId,
        audienceGroups,
        started: false,
        outcome: 'no_alternative',
        impossibleReasons: impossible,
        alternatives: [],
        reason: '无满足硬条件的替代场地',
      };
    }

    // 可直接安置优先，其次仅需例外批准
    candidates.sort((a, b) => {
      const ac = a.report.report.approvalsNeeded.length;
      const bc = b.report.report.approvalsNeeded.length;
      return ac - bc;
    });

    const alternatives: AlternativeProposalView[] = [];
    for (const { venue, report } of candidates) {
      const proposalId = this.db.insert(
        `INSERT INTO migration_proposals
          (closure_id, booking_id, venue_id, venue_version_id,
           requires_approval, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'proposed', ?)`,
        closureId,
        bookingId,
        venue.id,
        report.versionId,
        JSON.stringify(report.report.approvalsNeeded),
        nowIso(),
      );
      alternatives.push({
        proposalId,
        venueId: venue.id as string,
        venueName: report.venueName,
        venueVersion: report.version.version,
        immediatelyUsable: report.report.feasible,
        requiresApproval: report.report.approvalsNeeded,
        softReasons: report.report.reasons
          .filter((r) => !r.hard)
          .map((r) => ({ kind: r.kind, message: r.message })),
      });
    }

    this.recordImpact(closureId, bookingId, 'alternatives_ready', {
      alternativeCount: alternatives.length,
    });
    this.notifications.enqueueForAudience(
      {
        bookingId,
        venueId: booking.venue_id as string,
        type: 'closure_alternatives_ready',
        payload: {
          closureReason,
          alternatives: alternatives.map((a) => ({
            proposalId: a.proposalId,
            venueName: a.venueName,
            immediatelyUsable: a.immediatelyUsable,
            requiresApproval: a.requiresApproval,
          })),
        },
      },
      { ownerId, audienceGroups },
    );

    return {
      bookingId,
      title: booking.title as string,
      ownerId,
      audienceGroups,
      started: false,
      outcome: 'alternatives_ready',
      alternatives,
      reason: closureReason,
    };
  }

  private recordImpact(
    closureId: number,
    bookingId: string,
    outcome: 'immovable' | 'alternatives_ready' | 'no_alternative',
    detail: Record<string, unknown>,
  ): void {
    this.db.run(
      `INSERT INTO closure_impacts (closure_id, booking_id, outcome, detail, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      closureId,
      bookingId,
      outcome,
      JSON.stringify(detail),
      nowIso(),
    );
  }

  /**
   * 活动负责人接受备选方案。接受时按候选场地“当前版本”重新评估，
   * 防止在等待期间产生新占用；原确认单取消并由替代单接续（replacement_of）。
   * 不静默：必须由负责人显式接受。
   */
  acceptProposal(proposalId: number, userId: string) {
    return this.db.transaction(() => {
      const proposal = this.db.get(
        'SELECT * FROM migration_proposals WHERE id = ?',
        proposalId,
      );
      if (!proposal) throw new NotFoundException(`备选方案不存在：${proposalId}`);
      if (proposal.status !== 'proposed') {
        throw new BadRequestException('该备选方案已处理或已失效');
      }
      const original = this.bookings.requireRow(proposal.booking_id as string);
      const activity = this.db.get(
        'SELECT * FROM activities WHERE id = ?',
        original.activity_id,
      )!;
      if (activity.owner_id !== userId) {
        throw new BadRequestException('仅活动负责人本人可接受迁移方案');
      }
      if (new Date(original.start_at as string).getTime() <= Date.now()) {
        throw new BadRequestException('活动已经开始，不能再迁移');
      }

      const evaluation = this.bookings.evaluateVenue(
        original.activity_id as string,
        proposal.venue_id as string,
        original.start_at as string,
        original.end_at as string,
        { excludeBookingId: original.id as string },
      );
      const hard = evaluation.report.reasons.filter((r) => r.hard);
      if (hard.length > 0) {
        throw new BadRequestException({
          message: '该备选场地现已不满足硬条件，请改选其他方案',
          conflictReport: evaluation.report,
        });
      }

      // 作废同活动的其他备选
      this.db.run(
        `UPDATE migration_proposals SET status = 'void', decided_at = ?
         WHERE booking_id = ? AND id != ? AND status = 'proposed'`,
        nowIso(),
        original.id,
        proposalId,
      );

      const newStatus =
        evaluation.report.approvalsNeeded.length > 0
          ? 'pending_approval'
          : 'confirmed';
      const newId = `bk_${randomUUID()}`;
      const snapshot = {
        venueId: proposal.venue_id,
        venueName: evaluation.venueName,
        versionId: evaluation.versionId,
        capturedAt: nowIso(),
        ...evaluation.version,
      };
      this.db.run(
        `INSERT INTO bookings
          (id, activity_id, venue_id, venue_version_id, venue_snapshot,
           venue_name, clearing_minutes, start_at, end_at, status,
           conflict_report, created_by, created_at, confirmed_at, replacement_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId,
        original.activity_id,
        proposal.venue_id,
        evaluation.versionId,
        JSON.stringify(snapshot),
        evaluation.venueName,
        evaluation.version.clearingMinutes,
        original.start_at,
        original.end_at,
        newStatus,
        JSON.stringify(evaluation.report),
        userId,
        nowIso(),
        newStatus === 'confirmed' ? nowIso() : null,
        original.id,
      );

      // 取消原单（封闭迁移）
      this.db.run(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = ?,
           cancel_reason = ? WHERE id = ?`,
        nowIso(),
        `因场地临时封闭迁移至 ${evaluation.venueName}`,
        original.id,
      );
      this.db.run(
        `UPDATE cleanup_tasks SET status = 'done' WHERE booking_id = ? AND status = 'pending'`,
        original.id,
      );
      this.db.run(
        `UPDATE handovers SET status = 'voided' WHERE status = 'pending'
           AND (predecessor_booking_id = ? OR successor_booking_id = ?)`,
        original.id,
        original.id,
      );
      this.db.run(
        "UPDATE migration_proposals SET status = 'accepted', decided_at = ? WHERE id = ?",
        nowIso(),
        proposalId,
      );

      const audienceGroups = parseJsonArray(activity.audience_groups);
      if (newStatus === 'confirmed') {
        // 建立清场任务、相邻交接，并发出迁移通知
        this.bookings.establishMigration(newId, audienceGroups);
      } else {
        this.notifications.enqueueForAudience(
          {
            bookingId: newId,
            venueId: proposal.venue_id as string,
            type: 'migration_pending_approval',
            payload: {
              originalBookingId: original.id,
              newVenue: evaluation.venueName,
              approvalsNeeded: evaluation.report.approvalsNeeded,
            },
          },
          { ownerId: userId, audienceGroups },
        );
      }

      return this.bookings.getBooking(newId);
    });
  }

  /** 负责人拒绝全部备选（活动取消或等待总务另行安排） */
  rejectProposal(proposalId: number, userId: string): void {
    this.db.transaction(() => {
      const proposal = this.db.get(
        'SELECT * FROM migration_proposals WHERE id = ?',
        proposalId,
      );
      if (!proposal) throw new NotFoundException(`备选方案不存在：${proposalId}`);
      const activity = this.db.get(
        `SELECT a.owner_id FROM migration_proposals mp
         JOIN bookings b ON b.id = mp.booking_id
         JOIN activities a ON a.id = b.activity_id
         WHERE mp.id = ?`,
        proposalId,
      )!;
      if (activity.owner_id !== userId) {
        throw new BadRequestException('仅活动负责人本人可处理迁移方案');
      }
      this.db.run(
        "UPDATE migration_proposals SET status = 'rejected', decided_at = ? WHERE id = ?",
        nowIso(),
        proposalId,
      );
    });
  }

  listClosures(venueId?: string) {
    const closures = venueId
      ? this.db.all(
          'SELECT * FROM venue_closures WHERE venue_id = ? ORDER BY start_at',
          venueId,
        )
      : this.db.all('SELECT * FROM venue_closures ORDER BY start_at');
    return closures.map((c) => this.decorateClosure(c));
  }

  getClosure(closureId: number) {
    const closure = this.db.get(
      'SELECT * FROM venue_closures WHERE id = ?',
      closureId,
    );
    if (!closure) throw new NotFoundException(`封闭记录不存在：${closureId}`);
    return this.decorateClosure(closure);
  }

  private decorateClosure(closure: Row) {
    const impacts = this.db.all(
      'SELECT * FROM closure_impacts WHERE closure_id = ? ORDER BY id',
      closure.id,
    );
    return {
      id: closure.id,
      venueId: closure.venue_id,
      startAt: closure.start_at,
      endAt: closure.end_at,
      reason: closure.reason,
      createdBy: closure.created_by,
      createdAt: closure.created_at,
      impacts: impacts.map((i) => ({
        bookingId: i.booking_id,
        outcome: i.outcome,
        detail: JSON.parse(i.detail as string),
      })),
    };
  }
}
