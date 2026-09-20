import { INestApplication } from '@nestjs/common';
import {
  call,
  createBooking,
  createTestApp,
  createVenue,
  STAFF,
  TEACHER_CHEN,
  TEACHER_ZHANG,
} from './helpers';

/**
 * 场景还原：多功能教室临时封闭。系统应给出满足硬条件的替代方案；
 * 备用场地无障碍通道维修中时，有无障碍需求的活动应得到无法安置的明确原因；
 * 已经开始的活动不可静默迁移。
 */
describe('临时封闭与迁移（e2e）', () => {
  let app: INestApplication;
  let venueA: any; // 多功能教室（将被封闭）
  let venueB: any; // 备用教室：无障碍通道维修中
  let venueC: any; // 大报告厅
  let bRobot: string; // 可迁移到备用教室
  let bLecture: string; // 有无障碍需求 → 只能去大报告厅
  let bRehab: string; // 无障碍 + 特殊设备 → 无法安置
  let bOngoing: string; // 已开始 → 不可静默迁移

  beforeAll(async () => {
    app = await createTestApp();
    venueA = await createVenue(app, { name: '多功能教室', capacity: 60, equipment: ['projector', 'sound', 'lab'] });
    venueB = await createVenue(app, {
      name: '备用教室',
      capacity: 50,
      accessible: false, // 无障碍通道正在维修
      equipment: ['projector', 'lab'],
    });
    venueC = await createVenue(app, { name: '大报告厅', capacity: 100, equipment: ['projector', 'sound', 'stage'] });

    const mk = async (actor: any, body: any) => {
      const id = (await createBooking(app, actor, body).expect(201)).body.id;
      await call(app, 'post', `/bookings/${id}/confirm`, actor).expect(201);
      return id;
    };

    bRobot = await mk(TEACHER_ZHANG, {
      title: '机器人社团',
      attendees: 35,
      requiresAccessibleRoute: false,
      requiredEquipment: ['projector'],
      audienceGroups: ['students'],
      start: '2026-09-25T08:00:00.000Z',
      end: '2026-09-25T09:00:00.000Z',
      venueId: venueA.id,
    });
    bLecture = await mk(TEACHER_CHEN, {
      title: '家长讲座',
      attendees: 50,
      requiresAccessibleRoute: true,
      requiredEquipment: ['sound'],
      audienceGroups: ['parents'],
      start: '2026-09-25T10:00:00.000Z',
      end: '2026-09-25T11:00:00.000Z',
      venueId: venueA.id,
    });
    bRehab = await mk(TEACHER_ZHANG, {
      title: '康复训练工作坊',
      attendees: 20,
      requiresAccessibleRoute: true,
      requiredEquipment: ['lab'], // 只有备用教室有，但备用教室无障碍不可用
      audienceGroups: ['students', 'parents'],
      start: '2026-09-25T12:00:00.000Z',
      end: '2026-09-25T13:00:00.000Z',
      venueId: venueA.id,
    });
    bOngoing = await mk(TEACHER_CHEN, {
      title: '晨会',
      attendees: 25,
      requiresAccessibleRoute: false,
      requiredEquipment: [],
      audienceGroups: ['students'],
      start: '2026-09-25T14:00:00.000Z',
      end: '2026-09-25T15:00:00.000Z',
      venueId: venueA.id,
    });
    // 晨会已开始
    await call(app, 'post', `/bookings/${bOngoing}/check-in`, TEACHER_CHEN).expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  let closureId: string;

  it('非总务不能封闭场地', async () => {
    await call(app, 'post', `/venues/${venueA.id}/closures`, TEACHER_ZHANG)
      .send({ reason: 'x', from: '2026-09-25T00:00:00Z', to: '2026-09-26T00:00:00Z' })
      .expect(403);
  });

  it('总务封闭场地：迁移可满足硬条件的、说明无法安置的、已开始的不静默迁移', async () => {
    const res = await call(app, 'post', `/venues/${venueA.id}/closures`, STAFF)
      .send({ reason: '消防管道检修', from: '2026-09-25T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' })
      .expect(201);

    closureId = res.body.closure.id;
    expect(res.body.venue.status).toBe('CLOSED');
    expect(res.body.venue.version).toBe(2); // 封闭使场地版本自增

    const impacts = Object.fromEntries(res.body.impacts.map((i: any) => [i.bookingId, i]));

    // 机器人社团 → 备用教室（容量最接近且满足全部硬条件）
    expect(impacts[bRobot].action).toBe('RELOCATED');
    expect(impacts[bRobot].toVenueId).toBe(venueB.id);

    // 家长讲座有无障碍需求 → 备用教室不行，去大报告厅
    expect(impacts[bLecture].action).toBe('RELOCATED');
    expect(impacts[bLecture].toVenueId).toBe(venueC.id);

    // 康复工作坊：备用教室有无障碍问题、大报告厅缺设备 → 无法安置，原因明确
    expect(impacts[bRehab].action).toBe('UNABLE');
    const reasons = impacts[bRehab].reasons.join('\n');
    expect(reasons).toContain('备用教室');
    expect(reasons).toContain('无障碍');
    expect(reasons).toContain('大报告厅');
    expect(reasons).toContain('lab');

    // 晨会已开始 → 不静默迁移，需人工处理
    expect(impacts[bOngoing].action).toBe('MANUAL_REQUIRED');
    expect(impacts[bOngoing].reasons[0]).toContain('不可静默迁移');
  });

  it('迁移后的预约记录新场地及其版本，事件留痕', async () => {
    const robot = await call(app, 'get', `/bookings/${bRobot}`, TEACHER_ZHANG).expect(200);
    expect(robot.body.venueId).toBe(venueB.id);
    expect(robot.body.status).toBe('CONFIRMED');
    expect(robot.body.confirmationBasis).toEqual({
      venueVersionAtConfirmation: venueB.version,
      currentVenueVersion: venueB.version,
      stale: false,
    });
    const relocated = robot.body.events.find((e: any) => e.type === 'RELOCATED');
    expect(relocated.payload.fromVenueId).toBe(venueA.id);
    expect(relocated.payload.toVenueId).toBe(venueB.id);
  });

  it('无法安置的预约进入 DISPLACED，原因可查', async () => {
    const rehab = await call(app, 'get', `/bookings/${bRehab}`, TEACHER_ZHANG).expect(200);
    expect(rehab.body.status).toBe('DISPLACED');
    const displaced = rehab.body.events.find((e: any) => e.type === 'DISPLACED');
    expect(displaced.payload.reasons.length).toBeGreaterThan(0);
  });

  it('已开始的活动仍在原场地，不被静默迁移', async () => {
    const ongoing = await call(app, 'get', `/bookings/${bOngoing}`, TEACHER_CHEN).expect(200);
    expect(ongoing.body.status).toBe('IN_PROGRESS');
    expect(ongoing.body.venueId).toBe(venueA.id);
  });

  it('封闭后该场地不能再确认新预约', async () => {
    const created = await createBooking(app, TEACHER_ZHANG, {
      title: '临时活动',
      attendees: 10,
      requiresAccessibleRoute: false,
      requiredEquipment: [],
      audienceGroups: ['students'],
      start: '2026-09-25T16:00:00.000Z',
      end: '2026-09-25T17:00:00.000Z',
      venueId: venueA.id,
    }).expect(201);
    const res = await call(app, 'post', `/bookings/${created.body.id}/confirm`, TEACHER_ZHANG).expect(409);
    expect(res.body.details.violations.map((v: any) => v.code)).toContain('VENUE_CLOSED');
  });

  it('变更通知覆盖受影响人群（学生/家长/保洁），派发后状态为已发送', async () => {
    // 康复工作坊通知了学生、家长和总务
    const rehabNotes = await call(app, 'get', `/notifications?bookingId=${bRehab}`, STAFF).expect(200);
    const groups = rehabNotes.body.map((n: any) => n.audienceGroup).sort();
    expect(groups).toEqual(['parents', 'staff', 'students']);
    expect(rehabNotes.body.every((n: any) => n.status === 'PENDING')).toBe(true);
    expect(rehabNotes.body[0].message).toContain('暂无满足条件的替代场地');

    // 机器人社团迁移通知发给学生和保洁
    const robotNotes = await call(app, 'get', `/notifications?bookingId=${bRobot}`, STAFF).expect(200);
    expect(robotNotes.body.map((n: any) => n.audienceGroup).sort()).toEqual(['cleaning', 'students']);
    expect(robotNotes.body[0].message).toContain('备用教室');

    // 总务派发全部通知
    const dispatched = await call(app, 'post', '/notifications/dispatch', STAFF).send({}).expect(201);
    expect(dispatched.body.dispatched.length).toBeGreaterThan(0);
    const after = await call(app, 'get', `/notifications?bookingId=${bRobot}`, STAFF).expect(200);
    expect(after.body.every((n: any) => n.status === 'SENT' && n.sentAt)).toBe(true);
  });

  it('时段总览：实际使用者、冲突依据、受影响人群、通知状态一应俱全', async () => {
    const res = await call(
      app,
      'get',
      '/schedule?from=2026-09-25T00:00:00Z&to=2026-09-26T00:00:00Z',
      STAFF,
    ).expect(200);

    const byVenue = Object.fromEntries(res.body.venues.map((v: any) => [v.venue.id, v]));

    // 备用教室现在由机器人社团使用
    const occupantB = byVenue[venueB.id].occupants.find((o: any) => o.bookingId === bRobot);
    expect(occupantB.ownerId).toBe(TEACHER_ZHANG.id);
    expect(occupantB.audienceGroups).toEqual(['students']);
    expect(occupantB.confirmationBasis.stale).toBe(false);
    expect(occupantB.notifications.every((n: any) => n.status === 'SENT')).toBe(true);

    // 多功能教室：晨会仍在进行，封闭记录可查
    expect(byVenue[venueA.id].occupants.some((o: any) => o.bookingId === bOngoing)).toBe(true);
    expect(byVenue[venueA.id].closures).toHaveLength(1);
    expect(byVenue[venueA.id].closures[0].reason).toBe('消防管道检修');
  });

  it('封闭影响记录可回溯', async () => {
    const res = await call(app, 'get', `/venues/${venueA.id}/closures`, STAFF).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(closureId);
    expect(res.body[0].impacts).toHaveLength(4);
  });

  it('总务重开场地后版本再次自增，可正常确认', async () => {
    const reopened = await call(app, 'post', `/venues/${venueA.id}/reopen`, STAFF)
      .send({ reason: '检修完成' })
      .expect(201);
    expect(reopened.body.status).toBe('OPEN');
    expect(reopened.body.version).toBe(3);

    const created = await createBooking(app, TEACHER_ZHANG, {
      title: '补课',
      attendees: 20,
      requiresAccessibleRoute: false,
      requiredEquipment: [],
      audienceGroups: ['students'],
      start: '2026-09-26T09:00:00.000Z',
      end: '2026-09-26T10:00:00.000Z',
      venueId: venueA.id,
    }).expect(201);
    const confirmed = await call(app, 'post', `/bookings/${created.body.id}/confirm`, TEACHER_ZHANG).expect(201);
    expect(confirmed.body.confirmationBasis.venueVersionAtConfirmation).toBe(3);
  });
});
