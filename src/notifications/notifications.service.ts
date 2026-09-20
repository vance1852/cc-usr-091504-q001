import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { nowIso } from '../common/serialization';

export interface NewNotification {
  bookingId?: string | null;
  venueId: string;
  personId?: string | null;
  audienceGroup?: string | null;
  type: string;
  payload?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly db: DatabaseService) {}

  enqueue(n: NewNotification): void {
    this.db.run(
      `INSERT INTO notifications
        (booking_id, venue_id, person_id, audience_group, type, payload, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      n.bookingId ?? null,
      n.venueId,
      n.personId ?? null,
      n.audienceGroup ?? null,
      n.type,
      JSON.stringify(n.payload ?? {}),
      nowIso(),
    );
  }

  /** 为一次变更向责任人与各受影响人群分别入队通知 */
  enqueueForAudience(
    base: Omit<NewNotification, 'personId' | 'audienceGroup'>,
    params: { ownerId: string; audienceGroups: string[] },
  ): void {
    this.enqueue({ ...base, personId: params.ownerId });
    for (const group of params.audienceGroups) {
      this.enqueue({ ...base, audienceGroup: group });
    }
  }

  /** 模拟投递通道：把待发通知标记为已送达，返回投递结果 */
  dispatchPending(limit = 100): Array<{ id: number; type: string; status: string }> {
    const pending = this.db.all(
      'SELECT id, type FROM notifications WHERE status = ? ORDER BY id LIMIT ?',
      'pending',
      limit,
    );
    const sent: Array<{ id: number; type: string; status: string }> = [];
    for (const row of pending) {
      this.db.run(
        "UPDATE notifications SET status = 'sent', sent_at = ? WHERE id = ?",
        nowIso(),
        row.id,
      );
      sent.push({ id: Number(row.id), type: row.type as string, status: 'sent' });
    }
    return sent;
  }

  listByBooking(bookingId: string) {
    return this.db.all(
      'SELECT * FROM notifications WHERE booking_id = ? ORDER BY id',
      bookingId,
    );
  }

  statusForVenue(venueId: string, from?: string, to?: string) {
    const rows = this.db.all(
      `SELECT type, status, COUNT(*) AS count FROM notifications
       WHERE venue_id = ?
         AND (? IS NULL OR created_at >= ?)
         AND (? IS NULL OR created_at <= ?)
       GROUP BY type, status ORDER BY type`,
      venueId,
      from ?? null,
      from ?? null,
      to ?? null,
      to ?? null,
    );
    return rows.map((r) => ({
      type: r.type,
      status: r.status,
      count: Number(r.count),
    }));
  }
}
