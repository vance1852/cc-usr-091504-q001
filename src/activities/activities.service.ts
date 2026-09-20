import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, Row } from '../db/database.service';
import { nowIso, parseJsonArray } from '../common/serialization';
import { ActivitySpec } from '../domain/types';

@Injectable()
export class ActivitiesService {
  constructor(private readonly db: DatabaseService) {}

  create(spec: ActivitySpec): string {
    const id = spec.id ?? `act_${randomUUID()}`;
    this.db.run(
      `INSERT INTO activities
        (id, title, owner_id, expected_attendees, requires_wheelchair,
         required_equipment, special_access_note, audience_groups, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      spec.title,
      spec.ownerId,
      spec.expectedAttendees,
      spec.requiresWheelchair ? 1 : 0,
      JSON.stringify(spec.requiredEquipment ?? []),
      spec.specialAccessNote ?? null,
      JSON.stringify(spec.audienceGroups ?? []),
      nowIso(),
    );
    return id;
  }

  /** 活动负责人只可修改本人项目；总务/审批员不代为修改 */
  update(
    id: string,
    requesterId: string,
    patch: Partial<ActivitySpec>,
  ): void {
    const current = this.requireOwned(id, requesterId);
    const merged: ActivitySpec = {
      title: patch.title ?? (current.title as string),
      ownerId: current.owner_id as string,
      expectedAttendees:
        patch.expectedAttendees ?? Number(current.expected_attendees),
      requiresWheelchair:
        patch.requiresWheelchair ??
        Number(current.requires_wheelchair) === 1,
      requiredEquipment:
        patch.requiredEquipment ?? parseJsonArray(current.required_equipment),
      specialAccessNote:
        patch.specialAccessNote !== undefined
          ? patch.specialAccessNote
          : (current.special_access_note as string | null),
      audienceGroups:
        patch.audienceGroups ?? parseJsonArray(current.audience_groups),
    };
    this.db.run(
      `UPDATE activities SET title = ?, expected_attendees = ?,
         requires_wheelchair = ?, required_equipment = ?,
         special_access_note = ?, audience_groups = ?
       WHERE id = ?`,
      merged.title,
      merged.expectedAttendees,
      merged.requiresWheelchair ? 1 : 0,
      JSON.stringify(merged.requiredEquipment),
      merged.specialAccessNote,
      JSON.stringify(merged.audienceGroups),
      id,
    );
  }

  requireOwned(id: string, requesterId: string): Row {
    const row = this.db.get('SELECT * FROM activities WHERE id = ?', id);
    if (!row) throw new NotFoundException(`活动不存在：${id}`);
    if (row.owner_id !== requesterId) {
      throw new ForbiddenException(
        `活动「${row.title}」属于其他负责人，不可修改`,
      );
    }
    return row;
  }

  get(id: string): Row | undefined {
    return this.db.get('SELECT * FROM activities WHERE id = ?', id);
  }

  requireActivity(id: string): Row {
    const row = this.get(id);
    if (!row) throw new NotFoundException(`活动不存在：${id}`);
    return row;
  }

  listByOwner(ownerId: string): Row[] {
    return this.db.all('SELECT * FROM activities WHERE owner_id = ?', ownerId);
  }
}
