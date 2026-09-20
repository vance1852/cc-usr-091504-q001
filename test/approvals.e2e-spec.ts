import { INestApplication } from '@nestjs/common';
import {
  APPROVER,
  call,
  createBooking,
  createTestApp,
  createVenue,
  STAFF,
  TEACHER_ZHANG,
} from './helpers';

/** 涉及消防容量或特殊通行要求的例外需额外批准 */
describe('例外批准（e2e）', () => {
  let app: INestApplication;
  let smallVenueId: string;
  let inaccessibleVenueId: string;

  beforeAll(async () => {
    app = await createTestApp();
    smallVenueId = (await createVenue(app, { name: '小报告厅', capacity: 40 })).id;
    inaccessibleVenueId = (await createVenue(app, {
      name: '旧楼教室',
      capacity: 100,
      accessible: false, // 无障碍通道维修中
    })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('超消防容量：未批准前确认被拒，批准后确认成功', async () => {
    const created = await createBooking(app, TEACHER_ZHANG, {
      title: '全校集会',
      attendees: 55,
      requiresAccessibleRoute: false,
      requiredEquipment: [],
      audienceGroups: ['students', 'parents'],
      start: '2026-09-25T10:00:00.000Z',
      end: '2026-09-25T11:00:00.000Z',
      venueId: smallVenueId,
    }).expect(201);
    const id = created.body.id;

    // 未申请批准直接确认 → 409，提示需要批准
    const denied = await call(app, 'post', `/bookings/${id}/confirm`, TEACHER_ZHANG).expect(409);
    expect(denied.body.details.approvable).toBe(true);
    expect(denied.body.details.violations[0].code).toBe('CAPACITY_EXCEEDED');

    // 负责人申请消防容量例外
    const approval = await call(app, 'post', `/bookings/${id}/exceptions`, TEACHER_ZHANG)
      .send({ type: 'FIRE_CAPACITY', reason: '增加现场秩序志愿者，分区域就座' })
      .expect(201);
    expect(approval.body.status).toBe('PENDING');

    // 审批前确认仍被拒
    await call(app, 'post', `/bookings/${id}/confirm`, TEACHER_ZHANG).expect(409);

    // 非审批人不能批准
    await call(app, 'post', `/approvals/${approval.body.id}/approve`, STAFF).expect(403);

    // 审批人批准 → 确认成功，事件里保留豁免依据
    await call(app, 'post', `/approvals/${approval.body.id}/approve`, APPROVER).expect(201);
    const confirmed = await call(app, 'post', `/bookings/${id}/confirm`, TEACHER_ZHANG).expect(201);
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(confirmed.body.waivedViolations[0].code).toBe('CAPACITY_EXCEEDED');
  });

  it('特殊通行：无障碍不可用需 SPECIAL_ACCESS 批准；被拒绝后不能确认', async () => {
    const created = await createBooking(app, TEACHER_ZHANG, {
      title: '轮椅使用者分享会',
      attendees: 30,
      requiresAccessibleRoute: true,
      requiredEquipment: [],
      audienceGroups: ['students', 'parents'],
      start: '2026-09-26T10:00:00.000Z',
      end: '2026-09-26T11:00:00.000Z',
      venueId: inaccessibleVenueId,
    }).expect(201);
    const id = created.body.id;

    const denied = await call(app, 'post', `/bookings/${id}/confirm`, TEACHER_ZHANG).expect(409);
    expect(denied.body.details.violations[0].code).toBe('ACCESSIBILITY_UNAVAILABLE');

    const approval = await call(app, 'post', `/bookings/${id}/exceptions`, TEACHER_ZHANG)
      .send({ type: 'SPECIAL_ACCESS', reason: '安排专人引导临时坡道' })
      .expect(201);

    await call(app, 'post', `/approvals/${approval.body.id}/reject`, APPROVER).expect(201);
    // 被拒绝后确认仍被拒
    const still = await call(app, 'post', `/bookings/${id}/confirm`, TEACHER_ZHANG).expect(409);
    expect(still.body.details.violations[0].code).toBe('ACCESSIBILITY_UNAVAILABLE');
    // 已处理的申请不可重复处理
    await call(app, 'post', `/approvals/${approval.body.id}/approve`, APPROVER).expect(409);
  });

  it('他人不能代申请例外；重复申请复用同一条待审批记录', async () => {
    const created = await createBooking(app, TEACHER_ZHANG, {
      title: '大型讲座',
      attendees: 50,
      requiresAccessibleRoute: false,
      requiredEquipment: [],
      audienceGroups: ['parents'],
      start: '2026-09-27T10:00:00.000Z',
      end: '2026-09-27T11:00:00.000Z',
      venueId: smallVenueId,
    }).expect(201);
    const id = created.body.id;

    await call(app, 'post', `/bookings/${id}/exceptions`, STAFF)
      .send({ type: 'FIRE_CAPACITY', reason: 'x' })
      .expect(403);

    const a1 = await call(app, 'post', `/bookings/${id}/exceptions`, TEACHER_ZHANG)
      .send({ type: 'FIRE_CAPACITY', reason: '第一次' })
      .expect(201);
    const a2 = await call(app, 'post', `/bookings/${id}/exceptions`, TEACHER_ZHANG)
      .send({ type: 'FIRE_CAPACITY', reason: '重复提交' })
      .expect(201);
    expect(a2.body.id).toBe(a1.body.id);
  });
});
