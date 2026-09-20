import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rowToVenue, rowToVenueVersion } from '../database/mappers';
import { Venue, VenueVersion } from '../domain/types';
import { DomainError } from '../common/errors';
import { newId } from '../common/validate';
import { nowIso } from '../domain/time';

/** 影响活动安排的场地属性；这些字段变更会使场地版本自增并留下快照 */
const ARRANGEMENT_FIELDS = [
  'capacity',
  'accessible',
  'equipment',
  'windows',
  'turnoverMinutes',
  'status',
] as const;

@Injectable()
export class VenuesService {
  constructor(private readonly db: DatabaseService) {}

  create(input: {
    name: string;
    capacity: number;
    accessible: boolean;
    equipment: string[];
    windows: Venue['windows'];
    turnoverMinutes: number;
    actorId: string;
  }): Venue {
    const id = newId('ven');
    const now = nowIso();
    this.db.tx(() => {
      this.db.conn
        .prepare(
          `INSERT INTO venues (id, name, capacity, accessible, equipment, windows, turnover_minutes, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', 1, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.capacity,
          input.accessible ? 1 : 0,
          JSON.stringify(input.equipment),
          JSON.stringify(input.windows),
          input.turnoverMinutes,
          now,
          now,
        );
      this.insertVersionSnapshot(id, 1, '创建场地', input.actorId);
    });
    return this.get(id);
  }

  get(id: string): Venue {
    const row = this.db.conn.prepare('SELECT * FROM venues WHERE id = ?').get(id);
    if (!row) throw DomainError.notFound(`场地不存在：${id}`);
    return rowToVenue(row);
  }

  find(id: string): Venue | null {
    const row = this.db.conn.prepare('SELECT * FROM venues WHERE id = ?').get(id);
    return row ? rowToVenue(row) : null;
  }

  list(): Venue[] {
    return this.db.conn
      .prepare('SELECT * FROM venues ORDER BY name')
      .all()
      .map(rowToVenue);
  }

  /**
   * 更新场地。ARRANGEMENT_FIELDS 中任一字段变化都会使版本自增并记录快照，
   * 使历史确认所依据的场地版本可查、可对比。
   */
  update(
    id: string,
    patch: Partial<Pick<Venue, (typeof ARRANGEMENT_FIELDS)[number] | 'name'>>,
    actorId: string,
    changeReason: string,
  ): Venue {
    const current = this.get(id);
    const next: Venue = { ...current, ...patch, id: current.id };
    const arrangementChanged = ARRANGEMENT_FIELDS.some(
      (f) => JSON.stringify(current[f]) !== JSON.stringify(next[f]),
    );
    const nextVersion = arrangementChanged ? current.version + 1 : current.version;
    const now = nowIso();

    this.db.tx(() => {
      this.db.conn
        .prepare(
          `UPDATE venues SET name=?, capacity=?, accessible=?, equipment=?, windows=?,
             turnover_minutes=?, status=?, version=?, updated_at=? WHERE id=?`,
        )
        .run(
          next.name,
          next.capacity,
          next.accessible ? 1 : 0,
          JSON.stringify(next.equipment),
          JSON.stringify(next.windows),
          next.turnoverMinutes,
          next.status,
          nextVersion,
          now,
          id,
        );
      if (arrangementChanged) {
        this.insertVersionSnapshot(id, nextVersion, changeReason, actorId);
      }
    });
    return this.get(id);
  }

  /** 供封闭/重开等流程在事务内直接改写状态并留版本快照 */
  setStatus(id: string, status: Venue['status'], actorId: string, reason: string): Venue {
    const current = this.get(id);
    if (current.status === status) return current;
    return this.update(id, { status }, actorId, reason);
  }

  versions(id: string): VenueVersion[] {
    this.get(id);
    return this.db.conn
      .prepare('SELECT * FROM venue_versions WHERE venue_id = ? ORDER BY version')
      .all(id)
      .map(rowToVenueVersion);
  }

  versionAt(id: string, version: number): VenueVersion | null {
    const row = this.db.conn
      .prepare('SELECT * FROM venue_versions WHERE venue_id = ? AND version = ?')
      .get(id, version);
    return row ? rowToVenueVersion(row) : null;
  }

  private insertVersionSnapshot(venueId: string, version: number, reason: string, actorId: string) {
    const v = this.get(venueId);
    const snapshot = {
      id: v.id,
      name: v.name,
      capacity: v.capacity,
      accessible: v.accessible,
      equipment: v.equipment,
      windows: v.windows,
      turnoverMinutes: v.turnoverMinutes,
      status: v.status,
      version: v.version,
    };
    this.db.conn
      .prepare(
        `INSERT INTO venue_versions (id, venue_id, version, snapshot, change_reason, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId('vv'), venueId, version, JSON.stringify(snapshot), reason, actorId, nowIso());
  }
}
