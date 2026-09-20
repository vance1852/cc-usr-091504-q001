import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rowToApproval, rowToBooking } from '../database/mappers';
import { Approval, ApprovalType } from '../domain/types';
import { DomainError } from '../common/errors';
import { newId } from '../common/validate';
import { nowIso } from '../domain/time';

/**
 * 例外批准：涉及消防容量（FIRE_CAPACITY）或特殊通行要求（SPECIAL_ACCESS）的
 * 预约，必须经审批人批准后方能确认。
 */
@Injectable()
export class ApprovalsService {
  constructor(private readonly db: DatabaseService) {}

  request(bookingId: string, type: ApprovalType, reason: string, actorId: string): Approval {
    const booking = rowToBooking(
      this.db.conn.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) ??
        (() => {
          throw DomainError.notFound(`预约不存在：${bookingId}`);
        })(),
    );
    if (booking.ownerId !== actorId) {
      throw DomainError.forbidden('只能为本人项目申请例外批准');
    }
    // 同一预约同一类型已有待审批记录时直接复用，避免重复申请
    const existing = this.db.conn
      .prepare(`SELECT * FROM approvals WHERE booking_id = ? AND type = ? AND status = 'PENDING'`)
      .get(bookingId, type);
    if (existing) return rowToApproval(existing);

    const id = newId('apr');
    this.db.conn
      .prepare(
        `INSERT INTO approvals (id, booking_id, type, status, reason, created_at)
         VALUES (?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(id, bookingId, type, reason, nowIso());
    return this.get(id);
  }

  get(id: string): Approval {
    const row = this.db.conn.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    if (!row) throw DomainError.notFound(`批准记录不存在：${id}`);
    return rowToApproval(row);
  }

  list(filter: { status?: string; bookingId?: string }): Approval[] {
    let sql = 'SELECT * FROM approvals WHERE 1=1';
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
    return this.db.conn.prepare(sql).all(...args).map(rowToApproval);
  }

  forBooking(bookingId: string): Approval[] {
    return this.list({ bookingId });
  }

  decide(id: string, approve: boolean, actorId: string): Approval {
    return this.db.tx(() => {
      const a = this.get(id);
      if (a.status !== 'PENDING') {
        throw DomainError.conflict(`该申请已被${a.status === 'APPROVED' ? '批准' : '拒绝'}，不可重复处理`);
      }
      this.db.conn
        .prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
        .run(approve ? 'APPROVED' : 'REJECTED', actorId, nowIso(), id);
      return this.get(id);
    });
  }
}
