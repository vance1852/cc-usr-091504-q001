import { INestApplication } from '@nestjs/common';
import { createTestApp, seedUsers } from './helpers';
import { api, createActivity, createVenue } from './http-helpers';

const FRIDAY = '2026-09-25'; // 周五

describe('预订、冲突、版本与审批（端到端）', () => {
  let app: INestApplication;
  let hallId: string;
  let smallRoomId: string;

  beforeEach(async () => {
    ({ app } = await createTestApp());
    await seedUsers(app);
    hallId = await createVenue(app, 'staff_logistics', {
      name: '一号多功能教室',
      fireCapacity: 80,
      wheelchairAccessible: true,
      fixedEquipment: ['投影', '音响', '舞台灯'],
      clearingMinutes: 30,
    });
    smallRoomId = await createVenue(app, 'staff_logistics', {
      name: '小会议室',
      fireCapacity: 20,
      wheelchairAccessible: true,
      fixedEquipment: ['白板'],
      clearingMinutes: 15,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('同一时段重复申请不会双重占用：第二单被拒并给出冲突依据', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      requiredEquipment: ['投影'],
      audienceGroups: ['学生', '指导老师'],
    });
    const lecture = await createActivity(app, 'owner_lecture', {
      title: '家长讲座',
      expectedAttendees: 60,
      requiredEquipment: ['投影', '音响'],
      audienceGroups: ['家长'],
    });
    const slot = {
      venueId: hallId,
      startAt: `${FRIDAY}T08:00:00.000Z`,
      endAt: `${FRIDAY}T10:00:00.000Z`,
    };

    const first = await api(app, 'owner_robot')
      .post('/bookings', { activityId: robot, ...slot })
      .expect(201);
    expect(first.body.status).toBe('confirmed');

    const second = await api(app, 'owner_lecture')
      .post('/bookings', { activityId: lecture, ...slot })
      .expect(201);
    expect(second.body.status).toBe('rejected');
    const overlap = second.body.conflictReport.reasons.find(
      (r: { kind: string }) => r.kind === 'time_overlap',
    );
    expect(overlap.hard).toBe(true);
    expect(overlap.detail.otherBookingId).toBe(first.body.id);

    // 该时段实际使用者只有机器人社团
    const usage = await api(app, 'staff_logistics')
      .get(
        `/bookings?from=${FRIDAY}T07:00:00.000Z&to=${FRIDAY}T11:00:00.000Z`,
      )
      .expect(200);
    const actual = usage.body.usages.filter((u: { actualUser: boolean }) => u.actualUser);
    expect(actual).toHaveLength(1);
    expect(actual[0].title).toBe('机器人社团');
  });

  it('清场缓冲内也算冲突：10:00 结束 + 30 分清场，10:15 开始的申请被拒', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      audienceGroups: ['学生'],
    });
    await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T10:00:00.000Z`,
      })
      .expect(201);

    const lecture = await createActivity(app, 'owner_lecture', {
      title: '家长讲座',
      expectedAttendees: 40,
      audienceGroups: ['家长'],
    });
    const tooSoon = await api(app, 'owner_lecture')
      .post('/bookings', {
        activityId: lecture,
        venueId: hallId,
        startAt: `${FRIDAY}T10:15:00.000Z`,
        endAt: `${FRIDAY}T11:30:00.000Z`,
      })
      .expect(201);
    expect(tooSoon.body.status).toBe('rejected');
    expect(tooSoon.body.conflictReport.reasons[0].kind).toBe('time_overlap');

    // 10:30 开始则不冲突
    const ok = await api(app, 'owner_lecture')
      .post('/bookings', {
        activityId: lecture,
        venueId: hallId,
        startAt: `${FRIDAY}T10:30:00.000Z`,
        endAt: `${FRIDAY}T12:00:00.000Z`,
      })
      .expect(201);
    expect(ok.body.status).toBe('confirmed');
  });

  it('相同幂等键的重复请求返回原单，不产生双重占用', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      audienceGroups: ['学生'],
    });
    const payload = {
      activityId: robot,
      venueId: hallId,
      startAt: `${FRIDAY}T08:00:00.000Z`,
      endAt: `${FRIDAY}T10:00:00.000Z`,
      idempotencyKey: 'robot-friday-slot-1',
    };
    const first = await api(app, 'owner_robot').post('/bookings', payload).expect(201);
    const retry = await api(app, 'owner_robot').post('/bookings', payload).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.reused).toBe(true);

    const all = await api(app, 'staff_logistics')
      .get(`/bookings?from=${FRIDAY}T00:00:00.000Z&to=${FRIDAY}T23:59:00.000Z`)
      .expect(200);
    expect(all.body.usages).toHaveLength(1);
  });

  it('确认单永久保留所依据的场地版本，事后改容量不影响历史确认', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      audienceGroups: ['学生'],
    });
    const confirmed = await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T10:00:00.000Z`,
      })
      .expect(201);
    expect(confirmed.body.venueSnapshot.version).toBe(1);
    expect(confirmed.body.venueSnapshot.fireCapacity).toBe(80);

    // 总务把容量下调到 50 并发布版本 2
    await api(app, 'staff_logistics')
      .post(`/venues/${hallId}/versions`, {
        fireCapacity: 50,
        wheelchairAccessible: true,
        fixedEquipment: ['投影', '音响', '舞台灯'],
        weeklyAvailability: [
          { weekday: 0, open: '00:00', end: '23:59' },
          { weekday: 1, open: '00:00', end: '23:59' },
          { weekday: 2, open: '00:00', end: '23:59' },
          { weekday: 3, open: '00:00', end: '23:59' },
          { weekday: 4, open: '00:00', end: '23:59' },
          { weekday: 5, open: '00:00', end: '23:59' },
          { weekday: 6, open: '00:00', end: '23:59' },
        ],
        clearingMinutes: 30,
        changeReason: '消防复检后核减',
      })
      .expect(201);

    const fetched = await api(app, 'staff_logistics')
      .get(`/bookings/${confirmed.body.id}`)
      .expect(200);
    expect(fetched.body.venueSnapshot.version).toBe(1);
    expect(fetched.body.venueSnapshot.fireCapacity).toBe(80);
  });

  it('超消防容量需审批员额外批准，批准后按当前版本确认', async () => {
    const lecture = await createActivity(app, 'owner_lecture', {
      title: '家长讲座',
      expectedAttendees: 100,
      audienceGroups: ['家长'],
    });
    const asked = await api(app, 'owner_lecture')
      .post('/bookings', {
        activityId: lecture,
        venueId: hallId,
        startAt: `${FRIDAY}T13:00:00.000Z`,
        endAt: `${FRIDAY}T15:00:00.000Z`,
      })
      .expect(201);
    expect(asked.body.status).toBe('pending_approval');
    expect(asked.body.conflictReport.approvalsNeeded).toContain('fire_capacity');
    // 待审批占位：其他人同时段仍不能占用
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 20,
      audienceGroups: ['学生'],
    });
    const clash = await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: `${FRIDAY}T13:30:00.000Z`,
        endAt: `${FRIDAY}T14:30:00.000Z`,
      })
      .expect(201);
    expect(clash.body.status).toBe('rejected');

    // 负责人无权自行批准
    await api(app, 'owner_lecture')
      .post(`/bookings/${asked.body.id}/approvals`, { type: 'fire_capacity' })
      .expect(403);

    await api(app, 'approver_safety')
      .post(`/bookings/${asked.body.id}/approvals`, {
        type: 'fire_capacity',
        note: '加开疏散通道，限站立席位',
      })
      .expect(201);
    const done = await api(app, 'staff_logistics')
      .get(`/bookings/${asked.body.id}`)
      .expect(200);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('confirmed');
    expect(done.body.approvals[0].type).toBe('fire_capacity');
  });

  it('特殊通行要求需额外批准', async () => {
    const lecture = await createActivity(app, 'owner_lecture', {
      title: '家长讲座',
      expectedAttendees: 40,
      specialAccessNote: '家长车辆从东门进入',
      audienceGroups: ['家长'],
    });
    const asked = await api(app, 'owner_lecture')
      .post('/bookings', {
        activityId: lecture,
        venueId: hallId,
        startAt: `${FRIDAY}T13:00:00.000Z`,
        endAt: `${FRIDAY}T15:00:00.000Z`,
      })
      .expect(201);
    expect(asked.body.conflictReport.approvalsNeeded).toContain('special_access');
    await api(app, 'approver_safety')
      .post(`/bookings/${asked.body.id}/approvals`, { type: 'special_access' })
      .expect(201);
    const done = await api(app, 'owner_lecture')
      .get(`/bookings/${asked.body.id}`)
      .expect(200);
    expect(done.body.status).toBe('confirmed');
  });

  it('缺少固定设备是硬冲突，不能靠审批放行', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 10,
      requiredEquipment: ['3D打印机'],
      audienceGroups: ['学生'],
    });
    const res = await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: smallRoomId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T09:00:00.000Z`,
      })
      .expect(201);
    expect(res.body.status).toBe('rejected');
    expect(res.body.conflictReport.approvalsNeeded).toHaveLength(0);
    expect(res.body.conflictReport.reasons[0].kind).toBe('missing_equipment');
  });

  it('负责人只能修改本人项目；场地状态仅总务可改', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      audienceGroups: ['学生'],
    });
    await api(app, 'owner_lecture')
      .patch(`/activities/${robot}`, { title: '被冒名修改' })
      .expect(403);
    await api(app, 'owner_robot')
      .patch(`/activities/${robot}`, { expectedAttendees: 32 })
      .expect(200);

    await api(app, 'owner_robot').post('/venues', {
      name: '自建场地',
      fireCapacity: 10,
      wheelchairAccessible: true,
      fixedEquipment: [],
      weeklyAvailability: [],
      clearingMinutes: 10,
    }).expect(403);

    await api(app, 'owner_robot')
      .post(`/venues/${hallId}/versions`, {
        fireCapacity: 1,
        wheelchairAccessible: false,
        fixedEquipment: [],
        weeklyAvailability: [],
        clearingMinutes: 10,
      })
      .expect(403);
  });

  it('同空间交接必须前后责任人分别确认，旁人不可代确认', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      audienceGroups: ['学生'],
    });
    const lecture = await createActivity(app, 'owner_lecture', {
      title: '家长讲座',
      expectedAttendees: 40,
      audienceGroups: ['家长'],
    });
    await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T10:00:00.000Z`,
      })
      .expect(201);
    await api(app, 'owner_lecture')
      .post('/bookings', {
        activityId: lecture,
        venueId: hallId,
        startAt: `${FRIDAY}T10:30:00.000Z`,
        endAt: `${FRIDAY}T12:00:00.000Z`,
      })
      .expect(201);

    const handovers = await api(app, 'staff_logistics')
      .get(`/bookings/handovers/list?venueId=${hallId}`)
      .expect(200);
    expect(handovers.body).toHaveLength(1);
    const handoverId = handovers.body[0].id;
    expect(handovers.body[0].status).toBe('pending');

    // 后序责任人不能替前序确认
    await api(app, 'owner_lecture')
      .post(`/bookings/handovers/${handoverId}/confirm`, { side: 'predecessor' })
      .expect(403);
    // 前序责任人交出
    await api(app, 'owner_robot')
      .post(`/bookings/handovers/${handoverId}/confirm`, { side: 'predecessor' })
      .expect(201);
    // 重复确认被拒
    await api(app, 'owner_robot')
      .post(`/bookings/handovers/${handoverId}/confirm`, { side: 'predecessor' })
      .expect(409);
    // 仅一侧确认时交接未完成
    const mid = await api(app, 'staff_logistics')
      .get(`/bookings/handovers/list?venueId=${hallId}`)
      .expect(200);
    expect(mid.body[0].status).toBe('pending');
    // 后序责任人接收 → 交接成立
    await api(app, 'owner_lecture')
      .post(`/bookings/handovers/${handoverId}/confirm`, { side: 'successor' })
      .expect(201);
    const done = await api(app, 'staff_logistics')
      .get(`/bookings/handovers/list?venueId=${hallId}`)
      .expect(200);
    expect(done.body[0].status).toBe('confirmed');
  });

  it('确认后生成待清场事项，保洁完成后可销项', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      audienceGroups: ['学生'],
    });
    const confirmed = await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T10:00:00.000Z`,
      })
      .expect(201);

    const list = await api(app, 'cleaner_zhang')
      .get('/bookings/cleanup/list?status=pending')
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].assignee_group).toBe('保洁人员');
    expect(list.body[0].clear_by_at).toBe(`${FRIDAY}T10:30:00.000Z`);

    await api(app, 'cleaner_zhang')
      .post(`/bookings/cleanup/${list.body[0].id}/done`)
      .expect(201);
    const remaining = await api(app, 'cleaner_zhang')
      .get('/bookings/cleanup/list?status=pending')
      .expect(200);
    expect(remaining.body).toHaveLength(0);
    expect(confirmed.body.id).toBeDefined();
  });

  it('中间插入新活动后，原先首尾活动间的交接单作废', async () => {
    const mk = async (owner: string, title: string) =>
      createActivity(app, owner, {
        title,
        expectedAttendees: 20,
        audienceGroups: ['学生'],
      });
    const a = await mk('owner_robot', '早场');
    const c = await mk('owner_lecture', '晚场');

    await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: a,
        venueId: hallId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T09:00:00.000Z`,
      })
      .expect(201);
    await api(app, 'owner_lecture')
      .post('/bookings', {
        activityId: c,
        venueId: hallId,
        startAt: `${FRIDAY}T11:00:00.000Z`,
        endAt: `${FRIDAY}T12:00:00.000Z`,
      })
      .expect(201);

    const before = await api(app, 'staff_logistics')
      .get(`/bookings/handovers/list?venueId=${hallId}`)
      .expect(200);
    expect(before.body).toHaveLength(1);
    const oldHandover = before.body[0];
    expect(oldHandover.status).toBe('pending');

    // 第三位负责人在中间插入活动
    const b = await mk('owner_other', '中场');
    await api(app, 'owner_other')
      .post('/bookings', {
        activityId: b,
        venueId: hallId,
        startAt: `${FRIDAY}T09:30:00.000Z`,
        endAt: `${FRIDAY}T10:30:00.000Z`,
      })
      .expect(201);

    const after = await api(app, 'staff_logistics')
      .get(`/bookings/handovers/list?venueId=${hallId}`)
      .expect(200);
    // 旧交接单作废，新增 A→B、B→C 两张
    const voided = after.body.find((h: { id: number }) => h.id === oldHandover.id);
    expect(voided.status).toBe('voided');
    const pending = after.body.filter((h: { status: string }) => h.status === 'pending');
    expect(pending).toHaveLength(2);
  });
});
