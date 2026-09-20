import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rowToBooking, rowToClosure, rowToVenue } from '../database/mappers';
import { HandoversService } from '../handovers/handovers.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * 时段总览：对任一查询时段，给出每个场地的
 * - 实际使用者（占用中的预约及负责人）
 * - 待清场事项（未完成的交接与清场项）
 * - 冲突依据（每次确认所依据的场地版本与当前版本的差异）
 * - 受影响人群
 * - 变更通知状态
 */
@Injectable()
export class ScheduleService {
  constructor(
    private readonly db: DatabaseService,
    private readonly handovers: HandoversService,
    private readonly notifications: NotificationsService,
  ) {}

  overview(from: string, to: string, venueId?: string) {
    let venueSql = 'SELECT * FROM venues';
    const venueArgs: unknown[] = [];
    if (venueId) {
      venueSql += ' WHERE id = ?';
      venueArgs.push(venueId);
    }
    venueSql += ' ORDER BY name';
    const venues = this.db.conn.prepare(venueSql).all(...venueArgs).map(rowToVenue);

    return {
      range: { from, to },
      venues: venues.map((v) => {
        const bookings = this.db.conn
          .prepare(
            `SELECT * FROM bookings
             WHERE venue_id = ? AND status IN ('CONFIRMED','IN_PROGRESS')
               AND start < ? AND end > ?
             ORDER BY start`,
          )
          .all(v.id, to, from)
          .map(rowToBooking);

        const handovers = this.handovers.listForVenue(v.id, from, to);
        const closures = this.db.conn
          .prepare(
            `SELECT * FROM closures WHERE venue_id = ? AND from_ts < ? AND to_ts > ? ORDER BY from_ts`,
          )
          .all(v.id, to, from)
          .map(rowToClosure);

        return {
          venue: v,
          closures,
          occupants: bookings.map((b) => ({
            bookingId: b.id,
            title: b.title,
            status: b.status,
            start: b.start,
            end: b.end,
            // 实际使用者
            ownerId: b.ownerId,
            ownerName: b.ownerName,
            // 受影响人群
            audienceGroups: b.audienceGroups,
            // 冲突依据：确认时场地版本 vs 当前版本
            confirmationBasis: {
              venueVersionAtConfirmation: b.venueVersion,
              currentVenueVersion: v.version,
              stale: b.venueVersion !== null && b.venueVersion !== v.version,
            },
            // 变更通知状态
            notifications: this.notifications.forBooking(b.id).map((n) => ({
              id: n.id,
              audienceGroup: n.audienceGroup,
              status: n.status,
              message: n.message,
              sentAt: n.sentAt,
            })),
          })),
          // 待清场事项
          pendingCleanups: handovers
            .filter((h) => h.status !== 'COMPLETE')
            .map((h) => ({
              handoverId: h.id,
              outBookingId: h.outBookingId,
              inBookingId: h.inBookingId,
              outConfirmed: h.outConfirmedAt !== null,
              inConfirmed: h.inConfirmedAt !== null,
              pendingItems: h.cleanupItems.filter((i) => !i.done),
            })),
        };
      }),
    };
  }
}
