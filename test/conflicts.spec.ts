import { evaluatePlacement, uncoveredWaivables } from '../src/domain/conflicts';
import { fitsWindows, overlaps } from '../src/domain/time';
import { Approval, Booking, Venue } from '../src/domain/types';

const venue = (overrides: Partial<Venue> = {}): Venue => ({
  id: 'v1',
  name: '多功能教室',
  capacity: 60,
  accessible: true,
  equipment: ['projector', 'sound'],
  windows: [{ dayOfWeek: 5, start: '08:00', end: '20:00' }], // 仅周五
  turnoverMinutes: 30,
  status: 'OPEN',
  version: 1,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

const bookingReq = {
  start: '2026-09-25T09:00:00.000Z', // 周五
  end: '2026-09-25T10:00:00.000Z',
  attendees: 40,
  requiresAccessibleRoute: false,
  requiredEquipment: ['projector'],
};

const existingBooking = (start: string, end: string): Booking => ({
  id: 'b-other',
  ownerId: 'u',
  ownerName: null,
  title: '别的活动',
  attendees: 10,
  requiresAccessibleRoute: false,
  requiredEquipment: [],
  audienceGroups: [],
  start,
  end,
  venueId: 'v1',
  venueVersion: 1,
  status: 'CONFIRMED',
  idempotencyKey: null,
  requestHash: null,
  createdAt: '',
  updatedAt: '',
});

describe('时段与窗口工具', () => {
  it('半开区间重叠判断', () => {
    expect(overlaps('2026-09-25T09:00Z', '2026-09-25T10:00Z', '2026-09-25T09:30Z', '2026-09-25T10:30Z')).toBe(true);
    expect(overlaps('2026-09-25T09:00Z', '2026-09-25T10:00Z', '2026-09-25T10:00Z', '2026-09-25T11:00Z')).toBe(false);
  });

  it('可用窗口：完整落在窗口内才可行', () => {
    const windows = [{ dayOfWeek: 5, start: '08:00', end: '20:00' }];
    expect(fitsWindows('2026-09-25T09:00:00Z', '2026-09-25T10:00:00Z', windows)).toBe(true);
    expect(fitsWindows('2026-09-25T06:00:00Z', '2026-09-25T07:00:00Z', windows)).toBe(false);
    // 跨天不可
    expect(fitsWindows('2026-09-25T19:00:00Z', '2026-09-26T09:00:00Z', windows)).toBe(false);
    // 非周五不可
    expect(fitsWindows('2026-09-24T09:00:00Z', '2026-09-24T10:00:00Z', windows)).toBe(false);
  });
});

describe('冲突判断 evaluatePlacement', () => {
  it('全部满足时无违规', () => {
    const r = evaluatePlacement(venue(), bookingReq, []);
    expect(r.violations).toEqual([]);
    expect(r.tightNeighbors).toEqual([]);
  });

  it('容量超限 → 可豁免违规（消防容量）', () => {
    const r = evaluatePlacement(venue(), { ...bookingReq, attendees: 80 }, []);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].code).toBe('CAPACITY_EXCEEDED');
    expect(r.violations[0].severity).toBe('WAIVABLE');
    expect(r.violations[0].approvalType).toBe('FIRE_CAPACITY');
  });

  it('无障碍需求但通道不可用 → 可豁免违规（特殊通行）', () => {
    const r = evaluatePlacement(
      venue({ accessible: false }),
      { ...bookingReq, requiresAccessibleRoute: true },
      [],
    );
    expect(r.violations[0].code).toBe('ACCESSIBILITY_UNAVAILABLE');
    expect(r.violations[0].approvalType).toBe('SPECIAL_ACCESS');
  });

  it('设备缺失 → 硬冲突', () => {
    const r = evaluatePlacement(venue(), { ...bookingReq, requiredEquipment: ['stage'] }, []);
    expect(r.violations[0].code).toBe('EQUIPMENT_MISSING');
    expect(r.violations[0].severity).toBe('HARD');
  });

  it('场地封闭 → 硬冲突', () => {
    const r = evaluatePlacement(venue({ status: 'CLOSED' }), bookingReq, []);
    expect(r.violations.map((v) => v.code)).toContain('VENUE_CLOSED');
  });

  it('超出可用时段 → 硬冲突', () => {
    const r = evaluatePlacement(venue(), { ...bookingReq, start: '2026-09-26T09:00:00Z', end: '2026-09-26T10:00:00Z' }, []);
    expect(r.violations.map((v) => v.code)).toContain('OUTSIDE_AVAILABILITY');
  });

  it('时段重叠 → 硬冲突并给出冲突依据', () => {
    const r = evaluatePlacement(venue(), bookingReq, [existingBooking('2026-09-25T09:30:00Z', '2026-09-25T10:30:00Z')]);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].code).toBe('TIME_OVERLAP');
    expect(r.violations[0].details?.conflictBookingId).toBe('b-other');
  });

  it('清场时间纳入冲突判断：间隔小于清场缓冲 → 需要交接（非硬冲突）', () => {
    // 前一场 08:00-09:00，本场 09:10 开始，间隔 10 分钟 < 30 分钟清场缓冲
    const r = evaluatePlacement(
      venue(),
      { ...bookingReq, start: '2026-09-25T09:10:00Z', end: '2026-09-25T10:00:00Z' },
      [existingBooking('2026-09-25T08:00:00Z', '2026-09-25T09:00:00Z')],
    );
    expect(r.violations).toEqual([]);
    expect(r.tightNeighbors).toHaveLength(1);
  });

  it('间隔大于等于清场缓冲 → 无需交接', () => {
    const r = evaluatePlacement(
      venue(),
      { ...bookingReq, start: '2026-09-25T09:30:00Z', end: '2026-09-25T10:30:00Z' },
      [existingBooking('2026-09-25T08:00:00Z', '2026-09-25T09:00:00Z')],
    );
    expect(r.tightNeighbors).toEqual([]);
  });

  it('开始时间不早于结束时间 → 非法', () => {
    const r = evaluatePlacement(venue(), { ...bookingReq, end: bookingReq.start }, []);
    expect(r.violations[0].code).toBe('INVALID_TIME');
  });
});

describe('例外批准覆盖 uncoveredWaivables', () => {
  const approval = (type: Approval['type'], status: Approval['status']): Approval => ({
    id: 'a1',
    bookingId: 'b1',
    type,
    status,
    reason: '',
    decidedBy: null,
    decidedAt: null,
    createdAt: '',
  });

  it('已批准对应类型 → 覆盖', () => {
    const r = evaluatePlacement(venue(), { ...bookingReq, attendees: 80 }, []);
    expect(uncoveredWaivables(r.violations, [approval('FIRE_CAPACITY', 'APPROVED')])).toEqual([]);
  });

  it('仅申请未批准 / 类型不匹配 → 未覆盖', () => {
    const r = evaluatePlacement(venue(), { ...bookingReq, attendees: 80 }, []);
    expect(uncoveredWaivables(r.violations, [approval('FIRE_CAPACITY', 'PENDING')])).toHaveLength(1);
    expect(uncoveredWaivables(r.violations, [approval('SPECIAL_ACCESS', 'APPROVED')])).toHaveLength(1);
  });
});
