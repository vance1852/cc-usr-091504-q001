import { VenueVersionData, WeeklySlot } from '../domain/types';

export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseJsonObject<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(value as string) as T;
  } catch {
    return null;
  }
}

export interface VenueVersionRow {
  version: number;
  fire_capacity: number;
  wheelchair_accessible: number | bigint;
  accessibility_note: string;
  fixed_equipment: string;
  weekly_availability: string;
  clearing_minutes: number;
  change_reason: string;
  created_at: string;
}

/** 把场地版本行规范化为领域对象 */
export function toVenueVersionData(row: VenueVersionRow): VenueVersionData {
  return {
    version: row.version,
    fireCapacity: Number(row.fire_capacity),
    wheelchairAccessible: Number(row.wheelchair_accessible) === 1,
    accessibilityNote: row.accessibility_note,
    fixedEquipment: parseJsonArray(row.fixed_equipment),
    weeklyAvailability: parseJsonObject<WeeklySlot[]>(
      row.weekly_availability,
    ) ?? [],
    clearingMinutes: Number(row.clearing_minutes),
    changeReason: row.change_reason,
    createdAt: row.created_at,
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
