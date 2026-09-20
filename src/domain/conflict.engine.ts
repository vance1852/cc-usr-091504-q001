import {
  ConflictReason,
  ConflictReport,
  WeeklySlot,
} from './types';

/** 含清场缓冲的时间区间 */
export interface Interval {
  startAt: string;
  endAt: string;
  /** 结束后需要的清场分钟数 */
  clearingMinutes?: number;
}

/** 左闭右开区间是否重叠；左场活动含清场缓冲 */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  const aCleared = addMinutes(a.endAt, a.clearingMinutes ?? 0);
  return a.startAt < b.endAt && aCleared > b.startAt;
}

export function addMinutes(iso: string, minutes: number): string {
  const ms = new Date(iso).getTime() + minutes * 60_000;
  return new Date(ms).toISOString();
}

export function minutesBetween(startIso: string, endIso: string): number {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

/** 判断 [startAt,endAt) 是否落在周历可用窗内（仅支持同日时段） */
export function withinWeeklyAvailability(
  startAt: string,
  endAt: string,
  slots: WeeklySlot[],
): boolean {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (
    start.getFullYear() !== end.getFullYear() ||
    start.getMonth() !== end.getMonth() ||
    start.getDate() !== end.getDate()
  ) {
    return false;
  }
  const weekday = start.getDay();
  const s = hhmm(start);
  const e = hhmm(end);
  return slots.some(
    (slot) =>
      slot.weekday === weekday && slot.open <= s && e <= slot.end,
  );
}

export interface ConflictInput {
  startAt: string;
  endAt: string;
  expectedAttendees: number;
  requiresWheelchair: boolean;
  requiredEquipment: string[];
  specialAccessNote?: string | null;
  fireCapacity: number;
  wheelchairAccessible: boolean;
  fixedEquipment: string[];
  weeklyAvailability: WeeklySlot[];
  clearingMinutes: number;
  /** 与候选时段重叠的封闭记录 */
  closures: Array<{ reason: string; startAt: string; endAt: string }>;
  /** 与候选时段（含清场缓冲）重叠的既有占用 */
  existing: Array<{
    bookingId: string;
    title: string;
    startAt: string;
    endAt: string;
    clearingMinutes: number;
    status: string;
  }>;
  /** 已取得的例外批准 */
  grantedApprovals?: Array<'fire_capacity' | 'special_access'>;
}

/**
 * 核心冲突判断。
 * 硬条件（不可批准）：时间重叠、周历不可用、临时封闭、固定设备缺失。
 * 可例外（需批准）：消防容量超标、特殊通行要求。
 * 无障碍（轮椅）不满足为硬条件——备用场地无障碍通道维修时不得安置。
 */
export function evaluateConflicts(input: ConflictInput): ConflictReport {
  const list: ConflictReason[] = [];

  // 1. 周历可用时段
  if (
    input.weeklyAvailability.length > 0 &&
    !withinWeeklyAvailability(
      input.startAt,
      input.endAt,
      input.weeklyAvailability,
    )
  ) {
    list.push({
      kind: 'outside_availability',
      hard: true,
      message: '时段不在场地周历可用时间内',
      detail: { startAt: input.startAt, endAt: input.endAt },
    });
  }

  // 2. 临时封闭
  for (const c of input.closures) {
    if (input.startAt < c.endAt && input.endAt > c.startAt) {
      list.push({
        kind: 'closure',
        hard: true,
        message: `场地临时封闭：${c.reason}`,
        detail: { closureStart: c.startAt, closureEnd: c.endAt },
      });
    }
  }

  // 3. 与既有占用重叠（含双方清场缓冲）
  for (const b of input.existing) {
    if (
      intervalsOverlap(
        { startAt: b.startAt, endAt: b.endAt, clearingMinutes: b.clearingMinutes },
        { startAt: input.startAt, endAt: input.endAt, clearingMinutes: input.clearingMinutes },
      )
    ) {
      list.push({
        kind: 'time_overlap',
        hard: true,
        message: `与活动「${b.title}」时段冲突（含清场缓冲）`,
        detail: {
          otherBookingId: b.bookingId,
          otherStart: b.startAt,
          otherEnd: b.endAt,
          otherStatus: b.status,
        },
      });
    }
  }

  // 4. 固定设备
  const have = new Set(input.fixedEquipment);
  const missing = input.requiredEquipment.filter((eq) => !have.has(eq));
  if (missing.length > 0) {
    list.push({
      kind: 'missing_equipment',
      hard: true,
      message: `场地缺少固定设备：${missing.join('、')}`,
      detail: { missing },
    });
  }

  const granted = new Set(input.grantedApprovals ?? []);
  const approvalsNeeded: Array<'fire_capacity' | 'special_access'> = [];

  // 5. 消防容量（可例外）
  if (input.expectedAttendees > input.fireCapacity) {
    if (granted.has('fire_capacity')) {
      list.push({
        kind: 'capacity_exceeded',
        hard: false,
        message: `人数 ${input.expectedAttendees} 超过消防容量 ${input.fireCapacity}，已获消防容量例外批准`,
        detail: { expected: input.expectedAttendees, capacity: input.fireCapacity },
      });
    } else {
      approvalsNeeded.push('fire_capacity');
      list.push({
        kind: 'capacity_exceeded',
        hard: false,
        message: `人数 ${input.expectedAttendees} 超过消防容量 ${input.fireCapacity}，需消防容量例外批准`,
        detail: { expected: input.expectedAttendees, capacity: input.fireCapacity },
      });
    }
  }

  // 6. 无障碍（硬条件）
  if (input.requiresWheelchair && !input.wheelchairAccessible) {
    list.push({
      kind: 'wheelchair_unavailable',
      hard: true,
      message: '活动需要轮椅通行，但场地（含无障碍通道）当前不可用',
    });
  }

  // 7. 特殊通行要求（可例外）
  if (input.specialAccessNote && input.specialAccessNote.trim() !== '') {
    if (!granted.has('special_access')) {
      approvalsNeeded.push('special_access');
      list.push({
        kind: 'special_access_unapproved',
        hard: false,
        message: `特殊通行要求「${input.specialAccessNote}」需额外批准`,
        detail: { note: input.specialAccessNote },
      });
    }
  }

  const hasHard = list.some((r) => r.hard);
  return {
    feasible: !hasHard && approvalsNeeded.length === 0,
    reasons: list,
    approvalsNeeded: [...new Set(approvalsNeeded)],
  };
}

/** 从冲突报告中筛出硬冲突 */
export function hardReasons(report: ConflictReport): ConflictReason[] {
  return report.reasons.filter((r) => r.hard);
}
