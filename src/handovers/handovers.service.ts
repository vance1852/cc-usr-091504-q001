import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rowToBooking, rowToHandover } from '../database/mappers';
import { Booking, CleanupItem, Handover } from '../domain/types';
import { DomainError } from '../common/errors';
import { newId } from '../common/validate';
import { nowIso } from '../domain/time';
import { NotificationsService } from '../notifications/notifications.service';

export const DEFAULT_CLEANUP_ITEMS: Array<Pick<CleanupItem, 'key' | 'label'>> = [
  { key: 'trash', label: '清理场地垃圾' },
  { key: 'furniture', label: '桌椅设备复位' },
  { key: 'equipment_off', label: '关闭并检查固定设备' },
  { key: 'leftovers', label: '检查遗留物品' },
];

/**
 * 同一空间的责任交接：前后两场间隔小于清场缓冲时自动生成，
 * 必须由前责任人（确认清场完成）与后责任人（确认接收）分别确认，
 * 后一场活动在交接完成前不可签到开始。
 */
@Injectable()
export class HandoversService {
  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * 为预约建立与相邻（间隔 < 清场缓冲）占用中预约的交接记录。
   * 幂等：(out_booking_id, in_booking_id) 唯一，重复调用不会产生重复交接。
   */
  ensureForBooking(booking: Booking, turnoverMinutes: number): Handover[] {
    const neighbors = this.db.conn
      .prepare(
        `SELECT * FROM bookings
         WHERE venue_id = ? AND id != ? AND status IN ('CONFIRMED','IN_PROGRESS')
           AND start < ? AND end > ?`,
      )
      .all(
        booking.venueId,
        booking.id,
        // 前后各扩一个清场缓冲窗口，筛出“紧贴”的相邻预约
        new Date(new Date(booking.end).getTime() + turnoverMinutes * 60000).toISOString(),
        new Date(new Date(booking.start).getTime() - turnoverMinutes * 60000).toISOString(),
      )
      .map(rowToBooking) as Booking[];

    const created: Handover[] = [];
    for (const other of neighbors) {
      const gapBefore = (new Date(booking.start).getTime() - new Date(other.end).getTime()) / 60000;
      const gapAfter = (new Date(other.start).getTime() - new Date(booking.end).getTime()) / 60000;
      let out: Booking | null = null;
      let into: Booking | null = null;
      if (gapBefore >= 0 && gapBefore < turnoverMinutes) {
        out = other;
        into = booking;
      } else if (gapAfter >= 0 && gapAfter < turnoverMinutes) {
        out = booking;
        into = other;
      }
      if (!out || !into) continue;
      const existing = this.findBetween(out.id, into.id);
      if (existing) {
        created.push(existing);
        continue;
      }
      const id = newId('hov');
      this.db.conn
        .prepare(
          `INSERT INTO handovers (id, venue_id, out_booking_id, in_booking_id, cleanup_items, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
        )
        .run(
          id,
          booking.venueId,
          out.id,
          into.id,
          JSON.stringify(DEFAULT_CLEANUP_ITEMS.map((i) => ({ ...i, done: false }))),
          nowIso(),
        );
      const handover = this.get(id);
      created.push(handover);
      // 交接涉及保洁安排，生成给保洁人群的待办通知
      this.notifications.createForBooking(
        into.id,
        ['cleaning'],
        `场地交接待办：「${out.title}」→「${into.title}」，需完成清场 ${DEFAULT_CLEANUP_ITEMS.map((i) => i.label).join('、')}`,
      );
    }
    return created;
  }

  get(id: string): Handover {
    const row = this.db.conn.prepare('SELECT * FROM handovers WHERE id = ?').get(id);
    if (!row) throw DomainError.notFound(`交接记录不存在：${id}`);
    return rowToHandover(row);
  }

  findBetween(outBookingId: string, inBookingId: string): Handover | null {
    const row = this.db.conn
      .prepare('SELECT * FROM handovers WHERE out_booking_id = ? AND in_booking_id = ?')
      .get(outBookingId, inBookingId);
    return row ? rowToHandover(row) : null;
  }

  /** 预约作为后一场时的交接（签到前必须完成） */
  incomingFor(bookingId: string): Handover | null {
    const row = this.db.conn
      .prepare('SELECT * FROM handovers WHERE in_booking_id = ?')
      .get(bookingId);
    return row ? rowToHandover(row) : null;
  }

  listForVenue(venueId: string, from?: string, to?: string): Handover[] {
    let sql = `SELECT h.* FROM handovers h
               JOIN bookings b ON b.id = h.in_booking_id
               WHERE h.venue_id = ?`;
    const args: unknown[] = [venueId];
    if (from) {
      sql += ' AND b.end > ?';
      args.push(from);
    }
    if (to) {
      sql += ' AND b.start < ?';
      args.push(to);
    }
    sql += ' ORDER BY h.created_at';
    return this.db.conn.prepare(sql).all(...args).map(rowToHandover);
  }

  /**
   * 前责任人确认：声明清场事项完成。body.items 可逐项勾选，
   * 全部完成才记为前责人已确认。
   */
  confirmOut(id: string, actorId: string, items?: string[]): Handover {
    return this.db.tx(() => {
      const h = this.get(id);
      const outBooking = rowToBooking(
        this.db.conn.prepare('SELECT * FROM bookings WHERE id = ?').get(h.outBookingId),
      );
      if (outBooking.ownerId !== actorId) {
        throw DomainError.forbidden('只有前一场活动的负责人才能确认清场交接');
      }
      if (h.outConfirmedAt) return h; // 幂等：重复确认不产生变化
      const doneKeys = new Set(items ?? h.cleanupItems.map((i) => i.key));
      const items2 = h.cleanupItems.map((i) =>
        doneKeys.has(i.key) ? { ...i, done: true } : i,
      );
      const allDone = items2.every((i) => i.done);
      this.db.conn
        .prepare(
          `UPDATE handovers SET cleanup_items = ?, out_confirmed_by = ?, out_confirmed_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify(items2),
          allDone ? actorId : null,
          allDone ? nowIso() : null,
          id,
        );
      this.refreshStatus(id);
      return this.get(id);
    });
  }

  /** 后责任人确认接收场地 */
  confirmIn(id: string, actorId: string): Handover {
    return this.db.tx(() => {
      const h = this.get(id);
      const inBooking = rowToBooking(
        this.db.conn.prepare('SELECT * FROM bookings WHERE id = ?').get(h.inBookingId),
      );
      if (inBooking.ownerId !== actorId) {
        throw DomainError.forbidden('只有后一场活动的负责人才能确认接收');
      }
      if (!h.outConfirmedAt) {
        throw DomainError.conflict('前一场责任人尚未确认清场完成，暂不能接收');
      }
      if (h.inConfirmedAt) return h; // 幂等
      this.db.conn
        .prepare('UPDATE handovers SET in_confirmed_by = ?, in_confirmed_at = ? WHERE id = ?')
        .run(actorId, nowIso(), id);
      this.refreshStatus(id);
      return this.get(id);
    });
  }

  private refreshStatus(id: string) {
    const h = this.get(id);
    const status = h.outConfirmedAt && h.inConfirmedAt ? 'COMPLETE' : 'PENDING';
    this.db.conn.prepare('UPDATE handovers SET status = ? WHERE id = ?').run(status, id);
  }
}
