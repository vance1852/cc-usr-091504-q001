import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { BookingsService } from '../bookings/bookings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { parseJsonArray, parseJsonObject } from '../common/serialization';
import { ConflictReport, VenueSnapshot } from '../domain/types';

/**
 * 综合态势：任一时间窗内汇总
 * 实际使用者、待清场事项、冲突依据、受影响人群、变更通知状态。
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly bookings: BookingsService,
    private readonly notifications: NotificationsService,
  ) {}

  situation(from: string, to: string, venueId?: string) {
    const venueClause = venueId ? 'AND b.venue_id = ?' : '';
    // 占位符顺序：start_at < to, end_at > from
    const args = venueId ? [to, from, venueId] : [to, from];

    const bookingRows = this.db.all(
      `SELECT b.*, a.title, a.owner_id, a.audience_groups
       FROM bookings b JOIN activities a ON a.id = b.activity_id
       WHERE b.start_at < ? AND b.end_at > ?
         ${venueClause}
       ORDER BY b.venue_id, b.start_at`,
      ...args,
    );

    const actualUsers: unknown[] = [];
    const held: unknown[] = [];
    const conflicts: unknown[] = [];
    const affectedPeople = new Map<string, { role: string; via: string[] }>();

    for (const r of bookingRows) {
      const groups = parseJsonArray(r.audience_groups);
      const base = {
        bookingId: r.id,
        venueId: r.venue_id,
        venueName: r.venue_name,
        title: r.title,
        ownerId: r.owner_id,
        startAt: r.start_at,
        endAt: r.end_at,
        audienceGroups: groups,
        venueVersion: parseJsonObject<VenueSnapshot>(r.venue_snapshot as string)?.version,
      };
      this.addPerson(affectedPeople, r.owner_id as string, '负责人', r.title as string);
      for (const g of groups) {
        this.addPerson(affectedPeople, g, '人群', r.title as string);
      }

      if (r.status === 'confirmed') {
        actualUsers.push({ ...base, status: r.status });
      } else if (r.status === 'held' || r.status === 'pending_approval') {
        held.push({ ...base, status: r.status });
      }

      if (r.status === 'rejected' || r.status === 'pending_approval') {
        const report = parseJsonObject<ConflictReport>(r.conflict_report as string);
        conflicts.push({
          ...base,
          status: r.status,
          conflictReport: report,
        });
      }
    }

    // 封闭记录本身也是冲突依据
    const closureClause = venueId ? 'AND venue_id = ?' : '';
    const closureArgs = venueId
      ? [to, from, venueId]
      : [to, from];
    const closures = this.db.all(
      `SELECT * FROM venue_closures
       WHERE start_at < ? AND end_at > ? ${closureClause}`,
      ...closureArgs,
    );

    // 待清场事项
    const cleanup = this.bookings.listCleanup({
      status: 'pending',
      venueId,
      from,
      to: undefined,
    });
    const pendingCleanup = cleanup.filter(
      (c) => (c.due_at as string) >= from && (c.due_at as string) <= to,
    );

    // 通知状态（时间窗内各场地汇总）
    const notificationVenues = new Set<string>();
    for (const r of bookingRows) notificationVenues.add(r.venue_id as string);
    for (const c of closures) notificationVenues.add(c.venue_id as string);
    const notifications: Record<string, unknown> = {};
    for (const vId of notificationVenues) {
      notifications[vId] = this.notifications.statusForVenue(vId, from, to);
    }

    return {
      window: { from, to },
      actualUsers,
      held,
      pendingCleanup,
      conflicts,
      closures: closures.map((c) => ({
        id: c.id,
        venueId: c.venue_id,
        reason: c.reason,
        startAt: c.start_at,
        endAt: c.end_at,
      })),
      affectedPeople: [...affectedPeople.entries()].map(([name, info]) => ({
        name,
        role: info.role,
        via: info.via,
      })),
      notifications,
    };
  }

  private addPerson(
    map: Map<string, { role: string; via: string[] }>,
    name: string,
    role: string,
    via: string,
  ): void {
    const entry = map.get(name);
    if (entry) {
      if (!entry.via.includes(via)) entry.via.push(via);
    } else {
      map.set(name, { role, via: [via] });
    }
  }
}
