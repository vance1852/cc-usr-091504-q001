import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rowToNotification } from '../database/mappers';
import { Notification } from '../domain/types';
import { newId } from '../common/validate';
import { nowIso } from '../domain/time';

/**
 * 变更通知：每次影响学生/家长/保洁等人群的安排变化都会生成通知记录，
 * 状态从 PENDING 到 SENT（由总务派发），全程可查。
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly db: DatabaseService) {}

  /** 为一次预约的各受影响人群生成待派发通知（去重） */
  createForBooking(bookingId: string, audienceGroups: string[], message: string): Notification[] {
    const groups = [...new Set(audienceGroups)];
    const now = nowIso();
    const created: Notification[] = [];
    for (const group of groups) {
      const id = newId('ntf');
      this.db.conn
        .prepare(
          `INSERT INTO notifications (id, booking_id, audience_group, message, status, created_at)
           VALUES (?, ?, ?, ?, 'PENDING', ?)`,
        )
        .run(id, bookingId, group, message, now);
      created.push(this.getById(id));
    }
    return created;
  }

  getById(id: string): Notification {
    return rowToNotification(
      this.db.conn.prepare('SELECT * FROM notifications WHERE id = ?').get(id),
    );
  }

  forBooking(bookingId: string): Notification[] {
    return this.db.conn
      .prepare('SELECT * FROM notifications WHERE booking_id = ? ORDER BY created_at')
      .all(bookingId)
      .map(rowToNotification);
  }

  list(filter: { status?: string; bookingId?: string }): Notification[] {
    let sql = 'SELECT * FROM notifications WHERE 1=1';
    const args: unknown[] = [];
    if (filter.status) {
      sql += ' AND status = ?';
      args.push(filter.status);
    }
    if (filter.bookingId) {
      sql += ' AND booking_id = ?';
      args.push(filter.bookingId);
    }
    sql += ' ORDER BY created_at';
    return this.db.conn.prepare(sql).all(...args).map(rowToNotification);
  }

  /** 总务派发：将待派发通知标记为已发送（模拟发送动作，状态留痕） */
  dispatch(ids?: string[]): Notification[] {
    const now = nowIso();
    return this.db.tx(() => {
      let rows: any[];
      if (ids && ids.length > 0) {
        const marks = ids.map(() => '?').join(',');
        rows = this.db.conn
          .prepare(`SELECT * FROM notifications WHERE status = 'PENDING' AND id IN (${marks})`)
          .all(...ids);
      } else {
        rows = this.db.conn
          .prepare(`SELECT * FROM notifications WHERE status = 'PENDING'`)
          .all();
      }
      const update = this.db.conn.prepare(
        `UPDATE notifications SET status = 'SENT', sent_at = ? WHERE id = ?`,
      );
      for (const r of rows) update.run(now, r.id);
      return rows.map((r) => this.getById(r.id));
    });
  }
}
