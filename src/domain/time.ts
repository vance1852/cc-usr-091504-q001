import { TimeWindow } from '../domain/types';

/** 归一化为 UTC ISO 字符串，非法输入返回 null */
export function toIso(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 半开区间重叠判断：[aStart,aEnd) 与 [bStart,bEnd) */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 两个间隔之间的空隙（分钟）；重叠时为负数 */
export function gapMinutes(aEnd: string, bStart: string): number {
  return (new Date(bStart).getTime() - new Date(aEnd).getTime()) / 60000;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidWindow(w: unknown): w is TimeWindow {
  if (typeof w !== 'object' || w === null) return false;
  const win = w as TimeWindow;
  return (
    Number.isInteger(win.dayOfWeek) &&
    win.dayOfWeek >= 0 &&
    win.dayOfWeek <= 6 &&
    HHMM.test(win.start) &&
    HHMM.test(win.end) &&
    win.start < win.end
  );
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 判断 [start,end) 是否完整落在某个可用时段内。
 * 预约不允许跨天（按 UTC 日切分），且起止必须落在同一天的同一个窗口内。
 */
export function fitsWindows(startIso: string, endIso: string, windows: TimeWindow[]): boolean {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (s.getUTCDate() !== e.getUTCDate() || s.getUTCMonth() !== e.getUTCMonth()) return false;
  const day = s.getUTCDay();
  const sMin = s.getUTCHours() * 60 + s.getUTCMinutes();
  const eMin = e.getUTCHours() * 60 + e.getUTCMinutes() + (e.getUTCSeconds() > 0 || e.getUTCMilliseconds() > 0 ? 1 : 0);
  return windows.some(
    (w) => w.dayOfWeek === day && sMin >= minutesOf(w.start) && eMin <= minutesOf(w.end),
  );
}
