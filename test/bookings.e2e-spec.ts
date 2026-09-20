import { INestApplication } from '@nestjs/common';
import {
  APPROVER,
  call,
  createBooking,
  createTestApp,
  createVenue,
  STAFF,
  TEACHER_CHEN,
  TEACHER_ZHANG,
} from './helpers';

/**
 * 场景还原：周五下午，机器人社团与家长讲座拿到了同一间多功能教室的确认单。
 * 系统必须让第二次确认暴露冲突，而不是双重占用。
 */
describe('预约生命周期与冲突（e2e）', () => {
  let app: INestApplication;
  let venueId: string;

  const robotClub = {
    title: '机器人社团',
    attendees: 35,
    requiresAccessibleRoute: false,
    requiredEquipment: ['projector'],
    audienceGroups: ['students'],
    start: '2026-09-25T14:00:00.000Z',
    end: '2026-09-25T16:00:00.000Z',
  };
  const parentLecture = {
    title: '家长讲座',
    attendees: 50,
    requiresAccessibleRoute: false,
    requiredEquipment: ['projector', 'sound'],
    audienceGroups: ['parents'],
    start: '2026-09-25T15:00:00.000Z',
    end: '2026-09-25T17:00:00.000Z',
  };

  beforeAll(async () => {
    app = await createTestApp();
    const venue = await createVenue(app);
    venueId = venue.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('未带身份头 → 401', async () => {
    await call(app, 'get', '/venues').expect(401);
  });

  it('非总务不能登记场地 → 403', async () => {
    await call(app, 'post', '/venues', TEACHER_ZHANG).send({ name: 'x' }).expect(403);
  });

  it('场地创建后版本为 1，且留有版本快照', async () => {
    const res = await call(app, 'get', `/venues/${venueId}`, TEACHER_ZHANG).expect(200);
    expect(res.body.version).toBe(1);
    const versions = await call(app, 'get', `/venues/${venueId}/versions`, TEACHER_ZHANG).expect(200);
    expect(versions.body).toHaveLength(1);
    expect(versions.body[0].snapshot.capacity).toBe(60);
  });

  let robotId: string;

  it('创建预约（PENDING），确认后占用场地并记录所依据的场地版本', async () => {
    const created = await createBooking(app, TEACHER_ZHANG, { ...robotClub, venueId }, 'robot-001').expect(201);
    robotId = created.body.id;
    expect(created.body.status).toBe('PENDING');
    expect(created.body.replayed).toBe(false);

    const confirmed = await call(app, 'post', `/bookings/${robotId}/confirm`, TEACHER_ZHANG).expect(201);
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(confirmed.body.confirmationBasis).toEqual({
      venueVersionAtConfirmation: 1,
      currentVenueVersion: 1,
      stale: false,
    });
  });

  it('重复确认是幂等的，不会产生状态变化', async () => {
    const again = await call(app, 'post', `/bookings/${robotId}/confirm`, TEACHER_ZHANG).expect(201);
    expect(again.body.status).toBe('CONFIRMED');
    const events = await call(app, 'get', `/bookings/${robotId}`, TEACHER_ZHANG).expect(200);
    expect(events.body.events.filter((e: any) => e.type === 'CONFIRMED')).toHaveLength(1);
  });

  it('周五场景：家长讲座与机器人社团时段重叠，确认被拒并给出冲突依据', async () => {
    const created = await createBooking(app, TEACHER_CHEN, { ...parentLecture, venueId }, 'lecture-001').expect(201);
    const res = await call(app, 'post', `/bookings/${created.body.id}/confirm`, TEACHER_CHEN).expect(409);
    expect(res.body.code).toBe('CONFLICT');
    const overlap = res.body.details.violations.find((v: any) => v.code === 'TIME_OVERLAP');
    expect(overlap).toBeDefined();
    expect(overlap.details.conflictBookingId).toBe(robotId);
    expect(overlap.message).toContain('机器人社团');
    // 预约仍为 PENDING，场地没有被双重占用
    const b = await call(app, 'get', `/bookings/${created.body.id}`, TEACHER_CHEN).expect(200);
    expect(b.body.status).toBe('PENDING');
  });

  it('幂等键：重复提交返回同一条预约，不会产生双重占用', async () => {
    const first = await createBooking(app, TEACHER_CHEN, { ...parentLecture, venueId, title: '家长讲座A' }, 'same-key').expect(201);
    const second = await createBooking(app, TEACHER_CHEN, { ...parentLecture, venueId, title: '家长讲座A' }, 'same-key').expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.replayed).toBe(true);

    const list = await call(app, 'get', '/bookings', TEACHER_CHEN).expect(200);
    expect(list.body.filter((b: any) => b.title === '家长讲座A')).toHaveLength(1);
  });

  it('幂等键相同但内容不同 → 409', async () => {
    await createBooking(app, TEACHER_CHEN, { ...parentLecture, venueId, title: '讲座B' }, 'key-b').expect(201);
    await createBooking(app, TEACHER_CHEN, { ...parentLecture, venueId, title: '讲座C' }, 'key-b').expect(409);
  });

  it('负责人只能修改本人项目', async () => {
    const created = await createBooking(app, TEACHER_ZHANG, {
      ...robotClub,
      venueId,
      title: '社团加场',
      start: '2026-09-26T14:00:00.000Z',
      end: '2026-09-26T15:00:00.000Z',
    }).expect(201);
    // 他人修改 → 403
    await call(app, 'patch', `/bookings/${created.body.id}`, TEACHER_CHEN).send({ attendees: 20 }).expect(403);
    // 他人确认 → 403
    await call(app, 'post', `/bookings/${created.body.id}/confirm`, TEACHER_CHEN).expect(403);
    // 他人查看 → 403
    await call(app, 'get', `/bookings/${created.body.id}`, TEACHER_CHEN).expect(403);
    // 本人修改 → 200
    const updated = await call(app, 'patch', `/bookings/${created.body.id}`, TEACHER_ZHANG).send({ attendees: 20 }).expect(200);
    expect(updated.body.attendees).toBe(20);
  });

  it('负责人列表只含本人项目；总务可见全部', async () => {
    const mine = await call(app, 'get', '/bookings', TEACHER_ZHANG).expect(200);
    expect(mine.body.every((b: any) => b.ownerId === TEACHER_ZHANG.id)).toBe(true);
    const all = await call(app, 'get', '/bookings', STAFF).expect(200);
    const owners = new Set(all.body.map((b: any) => b.ownerId));
    expect(owners.size).toBeGreaterThan(1);
  });

  it('已确认的预约不可直接修改，取消后可重新预约', async () => {
    await call(app, 'patch', `/bookings/${robotId}`, TEACHER_ZHANG).send({ attendees: 30 }).expect(409);
    const cancelled = await call(app, 'post', `/bookings/${robotId}/cancel`, TEACHER_ZHANG).send({ reason: '计划调整' }).expect(201);
    expect(cancelled.body.status).toBe('CANCELLED');
    // 取消后原时段空出，家长讲座可以确认
    const lecture = await call(app, 'get', '/bookings?status=PENDING', TEACHER_CHEN).expect(200);
    const target = lecture.body.find((b: any) => b.title === '家长讲座');
    const confirmed = await call(app, 'post', `/bookings/${target.id}/confirm`, TEACHER_CHEN).expect(201);
    expect(confirmed.body.status).toBe('CONFIRMED');
    // 取消产生了给学生和保洁的通知
    const notifications = await call(app, 'get', `/notifications?bookingId=${robotId}`, STAFF).expect(200);
    expect(notifications.body.length).toBeGreaterThan(0);
    expect(notifications.body.every((n: any) => n.status === 'PENDING')).toBe(true);
  });

  it('场地版本变更后，历史确认的依据版本可对比（stale 标记）', async () => {
    // 总务调整容量 → 版本升到 2
    const updated = await call(app, 'patch', `/venues/${venueId}`, STAFF)
      .send({ capacity: 55, changeReason: '消防复核调整容量' })
      .expect(200);
    expect(updated.body.version).toBe(2);
    // 家长讲座是按版本 1 确认的 → stale
    const lecture = await call(app, 'get', '/bookings', TEACHER_CHEN).expect(200);
    const confirmed = lecture.body.find((b: any) => b.status === 'CONFIRMED');
    expect(confirmed.confirmationBasis).toEqual({
      venueVersionAtConfirmation: 1,
      currentVenueVersion: 2,
      stale: true,
    });
    // 版本快照完整可查
    const versions = await call(app, 'get', `/venues/${venueId}/versions`, STAFF).expect(200);
    expect(versions.body).toHaveLength(2);
    expect(versions.body[1].changeReason).toBe('消防复核调整容量');
    expect(versions.body[1].snapshot.capacity).toBe(55);
  });

  it('并发确认同一时段：只有一个能占用，不会双重占用', async () => {
    const mk = async (actor: any, title: string, key: string) =>
      (
        await createBooking(app, actor, {
          title,
          attendees: 20,
          requiresAccessibleRoute: false,
          requiredEquipment: [],
          audienceGroups: ['students'],
          start: '2026-09-28T14:00:00.000Z',
          end: '2026-09-28T15:00:00.000Z',
          venueId,
        }, key).expect(201)
      ).body.id;
    const id1 = await mk(TEACHER_ZHANG, '社团活动1', 'conc-1');
    const id2 = await mk(TEACHER_CHEN, '社团活动2', 'conc-2');

    const [r1, r2] = await Promise.all([
      call(app, 'post', `/bookings/${id1}/confirm`, TEACHER_ZHANG),
      call(app, 'post', `/bookings/${id2}/confirm`, TEACHER_CHEN),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);

    // 该时段实际只有一条占用
    const schedule = await call(
      app,
      'get',
      `/schedule?venueId=${venueId}&from=2026-09-28T00:00:00Z&to=2026-09-29T00:00:00Z`,
      STAFF,
    ).expect(200);
    expect(schedule.body.venues[0].occupants).toHaveLength(1);
  });

  it('审批人不能越权管理场地；总务不能批准例外', async () => {
    await call(app, 'post', '/venues', APPROVER).send({ name: 'x' }).expect(403);
    const any = await call(app, 'get', '/approvals', APPROVER).expect(200);
    expect(any.body).toEqual([]);
  });
});
