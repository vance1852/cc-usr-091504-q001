import {
  addMinutes,
  evaluateConflicts,
  intervalsOverlap,
  withinWeeklyAvailability,
} from '../src/domain/conflict.engine';

const base = {
  startAt: '2026-09-18T09:00:00.000Z',
  endAt: '2026-09-18T11:00:00.000Z',
  expectedAttendees: 40,
  requiresWheelchair: false,
  requiredEquipment: ['投影'] as string[],
  specialAccessNote: null,
  fireCapacity: 60,
  wheelchairAccessible: true,
  fixedEquipment: ['投影', '音响'] as string[],
  weeklyAvailability: [
    { weekday: 5, open: '08:00', end: '18:00' },
  ],
  clearingMinutes: 30,
  closures: [] as Array<{ reason: string; startAt: string; endAt: string }>,
  existing: [] as Array<{
    bookingId: string;
    title: string;
    startAt: string;
    endAt: string;
    clearingMinutes: number;
    status: string;
  }>,
};

describe('冲突引擎', () => {
  it('无冲突时可行', () => {
    // 2026-09-18 是周五
    expect(new Date(base.startAt).getDay()).toBe(5);
    const report = evaluateConflicts(base);
    expect(report.feasible).toBe(true);
    expect(report.reasons).toHaveLength(0);
  });

  it('人数超过消防容量时需要例外批准，批准后可行', () => {
    const over = { ...base, expectedAttendees: 80 };
    const report = evaluateConflicts(over);
    expect(report.feasible).toBe(false);
    expect(report.approvalsNeeded).toContain('fire_capacity');
    expect(report.reasons[0].hard).toBe(false);

    const granted = evaluateConflicts({
      ...over,
      grantedApprovals: ['fire_capacity'],
    });
    expect(granted.feasible).toBe(true);
  });

  it('轮椅需求遇到不可用场地为硬冲突（备用通道维修时不得安置）', () => {
    const report = evaluateConflicts({
      ...base,
      requiresWheelchair: true,
      wheelchairAccessible: false,
    });
    expect(report.feasible).toBe(false);
    const wheelchair = report.reasons.find((r) => r.kind === 'wheelchair_unavailable');
    expect(wheelchair?.hard).toBe(true);
  });

  it('缺少固定设备为硬冲突，且不能通过批准豁免', () => {
    const report = evaluateConflicts({
      ...base,
      requiredEquipment: ['投影', '3D打印机'],
    });
    const missing = report.reasons.find((r) => r.kind === 'missing_equipment');
    expect(missing?.hard).toBe(true);
    expect(missing?.detail).toMatchObject({ missing: ['3D打印机'] });
    expect(report.approvalsNeeded).toHaveLength(0);
  });

  it('特殊通行要求需要额外批准', () => {
    const report = evaluateConflicts({
      ...base,
      specialAccessNote: '家长车辆需进入校园',
    });
    expect(report.approvalsNeeded).toContain('special_access');
    const granted = evaluateConflicts({
      ...base,
      specialAccessNote: '家长车辆需进入校园',
      grantedApprovals: ['special_access'],
    });
    expect(granted.feasible).toBe(true);
  });

  it('临时封闭为硬冲突', () => {
    const report = evaluateConflicts({
      ...base,
      closures: [
        {
          reason: '无障碍通道维修',
          startAt: '2026-09-18T06:00:00.000Z',
          endAt: '2026-09-18T12:00:00.000Z',
        },
      ],
    });
    expect(report.reasons.some((r) => r.kind === 'closure' && r.hard)).toBe(true);
  });

  it('不在周历可用窗内为硬冲突', () => {
    const report = evaluateConflicts({
      ...base,
      weeklyAvailability: [{ weekday: 1, open: '08:00', end: '18:00' }],
    });
    expect(
      report.reasons.some((r) => r.kind === 'outside_availability'),
    ).toBe(true);
  });

  it('与既有占用重叠为硬冲突；考虑清场缓冲后首尾相接不冲突', () => {
    // 既有 07:00-08:30 加 30 分钟清场 → 09:00 才空出，候选 09:00 开始不重叠
    const touching = evaluateConflicts({
      ...base,
      existing: [
        {
          bookingId: 'bk_prev',
          title: '早间活动',
          startAt: '2026-09-18T07:00:00.000Z',
          endAt: '2026-09-18T08:30:00.000Z',
          clearingMinutes: 30,
          status: 'confirmed',
        },
      ],
    });
    expect(touching.reasons.filter((r) => r.kind === 'time_overlap')).toHaveLength(0);

    // 既有 08:45 结束 + 30 清场 → 09:15 才空出，与 09:00 开始冲突
    const overlap = evaluateConflicts({
      ...base,
      existing: [
        {
          bookingId: 'bk_prev2',
          title: '拖堂活动',
          startAt: '2026-09-18T07:00:00.000Z',
          endAt: '2026-09-18T08:45:00.000Z',
          clearingMinutes: 30,
          status: 'confirmed',
        },
      ],
    });
    expect(overlap.reasons[0].kind).toBe('time_overlap');
    expect(overlap.reasons[0].detail).toMatchObject({ otherBookingId: 'bk_prev2' });
  });

  it('intervalsOverlap 清场缓冲边界为左闭右开', () => {
    const d = '2026-09-18T';
    expect(
      intervalsOverlap(
        { startAt: `${d}09:00:00.000Z`, endAt: `${d}10:00:00.000Z`, clearingMinutes: 30 },
        { startAt: `${d}10:30:00.000Z`, endAt: `${d}11:30:00.000Z` },
      ),
    ).toBe(false);
    expect(
      intervalsOverlap(
        { startAt: `${d}09:00:00.000Z`, endAt: `${d}10:00:00.000Z`, clearingMinutes: 31 },
        { startAt: `${d}10:30:00.000Z`, endAt: `${d}11:30:00.000Z` },
      ),
    ).toBe(true);
  });

  it('周历可用窗判断', () => {
    const friday = '2026-09-18T10:00:00.000Z';
    expect(
      withinWeeklyAvailability(friday, addMinutes(friday, 60), [
        { weekday: 5, open: '00:00', end: '23:59' },
      ]),
    ).toBe(true);
    expect(
      withinWeeklyAvailability(friday, addMinutes(friday, 60), [
        { weekday: 1, open: '00:00', end: '23:59' },
      ]),
    ).toBe(false);
  });

  it('容量超标与设备缺失同时存在：既有硬冲突也有待批准例外', () => {
    const report = evaluateConflicts({
      ...base,
      expectedAttendees: 200,
      fixedEquipment: ['音响'],
    });
    expect(report.feasible).toBe(false);
    expect(report.reasons.some((r) => r.kind === 'missing_equipment' && r.hard)).toBe(true);
    expect(report.approvalsNeeded).toContain('fire_capacity');
  });
});
