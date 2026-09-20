import { INestApplication } from '@nestjs/common';
import {
  call,
  createBooking,
  createTestApp,
  createVenue,
  TEACHER_CHEN,
  TEACHER_ZHANG,
} from './helpers';

/** 同一空间交接必须由前后责任人分别确认；待清场事项全程可查 */
describe('责任交接（e2e）', () => {
  let app: INestApplication;
  let venueId: string;
  let firstId: string;
  let secondId: string;
  let handoverId: string;

  beforeAll(async () => {
    app = await createTestApp();
    // 清场缓冲 30 分钟
    venueId = (await createVenue(app, { name: '多功能教室', turnoverMinutes: 30 })).id;

    // 前一场 14:00-16:00
    firstId = (
      await createBooking(app, TEACHER_ZHANG, {
        title: '机器人社团',
        attendees: 30,
        requiresAccessibleRoute: false,
        requiredEquipment: [],
        audienceGroups: ['students'],
        start: '2026-09-25T14:00:00.000Z',
        end: '2026-09-25T16:00:00.000Z',
        venueId,
      }).expect(201)
    ).body.id;
    await call(app, 'post', `/bookings/${firstId}/confirm`, TEACHER_ZHANG).expect(201);

    // 后一场 16:10-18:00：间隔 10 分钟 < 30 分钟清场缓冲
    secondId = (
      await createBooking(app, TEACHER_CHEN, {
        title: '家长讲座',
        attendees: 40,
        requiresAccessibleRoute: false,
        requiredEquipment: [],
        audienceGroups: ['parents'],
        start: '2026-09-25T16:10:00.000Z',
        end: '2026-09-25T18:00:00.000Z',
        venueId,
      }).expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('确认后一场时自动生成交接记录与待清场事项', async () => {
    const confirmed = await call(app, 'post', `/bookings/${secondId}/confirm`, TEACHER_CHEN).expect(201);
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(confirmed.body.handoverIds).toHaveLength(1);
    handoverId = confirmed.body.handoverIds[0];

    const handover = await call(app, 'get', `/handovers/${handoverId}`, TEACHER_CHEN).expect(200);
    expect(handover.body.outBookingId).toBe(firstId);
    expect(handover.body.inBookingId).toBe(secondId);
    expect(handover.body.status).toBe('PENDING');
    expect(handover.body.cleanupItems.every((i: any) => !i.done)).toBe(true);
    // 保洁人群收到交接待办通知
    const notifications = await call(app, 'get', `/notifications?bookingId=${secondId}`, TEACHER_CHEN).expect(200);
    expect(notifications.body.some((n: any) => n.audienceGroup === 'cleaning')).toBe(true);
  });

  it('交接未完成时后一场不能签到开始', async () => {
    const res = await call(app, 'post', `/bookings/${secondId}/check-in`, TEACHER_CHEN).expect(409);
    expect(res.body.details.handoverId).toBe(handoverId);
    expect(res.body.details.pendingCleanup.length).toBeGreaterThan(0);
  });

  it('交接确认权限：前后责任人各自确认，他人无权代确认', async () => {
    // 后责任人不能确认前场的清场
    await call(app, 'post', `/handovers/${handoverId}/confirm-out`, TEACHER_CHEN).expect(403);
    // 前责任人不能确认后场的接收
    await call(app, 'post', `/handovers/${handoverId}/confirm-in`, TEACHER_ZHANG).expect(403);
    // 后责任人在前场确认清场前不能接收
    await call(app, 'post', `/handovers/${handoverId}/confirm-in`, TEACHER_CHEN).expect(409);
  });

  it('前责任人逐项确认清场，全部完成才算确认', async () => {
    // 只完成部分事项
    const partial = await call(app, 'post', `/handovers/${handoverId}/confirm-out`, TEACHER_ZHANG)
      .send({ items: ['trash', 'furniture'] })
      .expect(201);
    expect(partial.body.outConfirmedAt).toBeNull();
    expect(partial.body.cleanupItems.filter((i: any) => i.done)).toHaveLength(2);

    // 完成剩余事项 → 确认生效
    const full = await call(app, 'post', `/handovers/${handoverId}/confirm-out`, TEACHER_ZHANG)
      .send({ items: ['equipment_off', 'leftovers'] })
      .expect(201);
    expect(full.body.outConfirmedAt).not.toBeNull();
    expect(full.body.status).toBe('PENDING'); // 还缺后责任人确认
  });

  it('后责任人确认接收 → 交接完成 → 可以签到', async () => {
    const done = await call(app, 'post', `/handovers/${handoverId}/confirm-in`, TEACHER_CHEN).expect(201);
    expect(done.body.status).toBe('COMPLETE');

    const checkedIn = await call(app, 'post', `/bookings/${secondId}/check-in`, TEACHER_CHEN).expect(201);
    expect(checkedIn.body.status).toBe('IN_PROGRESS');
  });

  it('交接确认幂等：重复确认不产生变化', async () => {
    const again = await call(app, 'post', `/handovers/${handoverId}/confirm-in`, TEACHER_CHEN).expect(201);
    expect(again.body.status).toBe('COMPLETE');
    const list = await call(app, 'get', `/schedule?venueId=${venueId}&from=2026-09-25T00:00:00Z&to=2026-09-26T00:00:00Z`, TEACHER_ZHANG).expect(200);
    expect(list.body.venues[0].pendingCleanups).toHaveLength(0);
  });

  it('间隔足够的场次不需要交接，可直接签到', async () => {
    const id = (
      await createBooking(app, TEACHER_ZHANG, {
        title: '次日活动',
        attendees: 10,
        requiresAccessibleRoute: false,
        requiredEquipment: [],
        audienceGroups: ['students'],
        start: '2026-09-26T10:00:00.000Z',
        end: '2026-09-26T11:00:00.000Z',
        venueId,
      }).expect(201)
    ).body.id;
    const confirmed = await call(app, 'post', `/bookings/${id}/confirm`, TEACHER_ZHANG).expect(201);
    expect(confirmed.body.handoverIds).toHaveLength(0);
    const checkedIn = await call(app, 'post', `/bookings/${id}/check-in`, TEACHER_ZHANG).expect(201);
    expect(checkedIn.body.status).toBe('IN_PROGRESS');
  });
});
