import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, Row } from '../db/database.service';
import { nowIso, toVenueVersionData } from '../common/serialization';
import { VenueVersionData, WeeklySlot } from '../domain/types';

export interface VenueVersionInput {
  fireCapacity: number;
  wheelchairAccessible: boolean;
  accessibilityNote?: string;
  fixedEquipment: string[];
  weeklyAvailability: WeeklySlot[];
  clearingMinutes: number;
  changeReason?: string;
}

@Injectable()
export class VenuesService {
  constructor(private readonly db: DatabaseService) {}

  create(name: string, firstVersion: VenueVersionInput): string {
    return this.db.transaction(() => {
      const id = `venue_${randomUUID()}`;
      this.db.run(
        'INSERT INTO venues (id, name, active, created_at) VALUES (?, ?, 1, ?)',
        id,
        name,
        nowIso(),
      );
      const versionId = this.insertVersion(id, 1, firstVersion);
      this.db.run(
        'UPDATE venues SET current_version_id = ? WHERE id = ?',
        versionId,
        id,
      );
      return id;
    });
  }

  private insertVersion(
    venueId: string,
    version: number,
    input: VenueVersionInput,
  ): number {
    const res = this.db
      .prepare(
        `INSERT INTO venue_versions
          (venue_id, version, fire_capacity, wheelchair_accessible,
           accessibility_note, fixed_equipment, weekly_availability,
           clearing_minutes, change_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        venueId,
        version,
        input.fireCapacity,
        input.wheelchairAccessible ? 1 : 0,
        input.accessibilityNote ?? '',
        JSON.stringify(input.fixedEquipment ?? []),
        JSON.stringify(input.weeklyAvailability ?? []),
        input.clearingMinutes,
        input.changeReason ?? '',
        nowIso(),
      ) as unknown as { lastInsertRowid: number | bigint };
    return Number(res.lastInsertRowid);
  }

  /**
   * 修改场地属性（仅总务人员可调用，由控制器限权）。
   * 任何容量/无障碍/设备/可用时段/清场时间变更都产生新版本，
   * 已有确认单仍指向旧版本，保证“每次确认所依据的场地版本”可追溯。
   */
  publishNewVersion(venueId: string, input: VenueVersionInput): number {
    return this.db.transaction(() => {
      const venue = this.db.get('SELECT id FROM venues WHERE id = ?', venueId);
      if (!venue) throw new NotFoundException(`场地不存在：${venueId}`);
      const current = this.getCurrentVersion(venueId);
      const version = (current?.version ?? 0) + 1;
      const versionId = this.insertVersion(venueId, version, input);
      this.db.run(
        'UPDATE venues SET current_version_id = ? WHERE id = ?',
        versionId,
        venueId,
      );
      return version;
    });
  }

  /** 总务人员停用场地（历史确认单保留） */
  deactivate(venueId: string): void {
    this.db.run('UPDATE venues SET active = 0 WHERE id = ?', venueId);
  }

  getCurrentVersionRow(venueId: string): Row {
    const row = this.db.get(
      `SELECT vv.* FROM venue_versions vv
       JOIN venues v ON v.current_version_id = vv.id
       WHERE v.id = ?`,
      venueId,
    );
    if (!row) throw new NotFoundException(`场地无版本数据：${venueId}`);
    return row;
  }

  getCurrentVersion(venueId: string): VenueVersionData | null {
    const row = this.db.get(
      `SELECT vv.* FROM venue_versions vv
       JOIN venues v ON v.current_version_id = vv.id
       WHERE v.id = ?`,
      venueId,
    );
    return row ? toVenueVersionData(row as never) : null;
  }

  getVersionById(versionId: number): VenueVersionData & { venueId: string } {
    const row = this.db.get(
      'SELECT * FROM venue_versions WHERE id = ?',
      versionId,
    );
    if (!row) throw new NotFoundException(`场地版本不存在：${versionId}`);
    return { ...toVenueVersionData(row as never), venueId: row.venue_id as string };
  }

  listActive(): Row[] {
    return this.db.all(
      `SELECT v.id, v.name, v.active, vv.version, vv.fire_capacity,
              vv.wheelchair_accessible, vv.accessibility_note,
              vv.fixed_equipment, vv.weekly_availability, vv.clearing_minutes
       FROM venues v
       JOIN venue_versions vv ON vv.id = v.current_version_id
       WHERE v.active = 1
       ORDER BY v.name`,
    );
  }

  listAll(): Row[] {
    return this.db.all(
      `SELECT v.id, v.name, v.active, vv.version, vv.fire_capacity,
              vv.wheelchair_accessible, vv.clearing_minutes
       FROM venues v
       JOIN venue_versions vv ON vv.id = v.current_version_id
       ORDER BY v.name`,
    );
  }
}
