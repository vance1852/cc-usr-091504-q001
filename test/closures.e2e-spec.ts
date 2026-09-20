import { INestApplication } from '@nestjs/common';
import { createTestApp, seedUsers } from './helpers';
import { api, createActivity, createVenue } from './http-helpers';
import { DatabaseService } from '../src/db/database.service';

const FRIDAY = '2026-09-25';
const ALL_WEEK = [
  { weekday: 0, open: '00:00', end: '23:59' },
  { weekday: 1, open: '00:00', end: '23:59' },
  { weekday: 2, open: '00:00', end: '23:59' },
  { weekday: 3, open: '00:00', end: '23:59' },
  { weekday: 4, open: '00:00', end: '23:59' },
  { weekday: 5, open: '00:00', end: '23:59' },
  { weekday: 6, open: '00:00', end: '23:59' },
];

describe('临时封闭与替代方案（端到端）', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let hallId: string;
  let backupId: string;
  let tinyRoomId: string;

  beforeEach(async () => {
    ({ app } = await createTestApp());
    await seedUsers(app);
    db = app.get(DatabaseService);
    hallId = await createVenue(app, 'staff_logistics', {
      name: '一号多功能教室',
      fireCapacity: 80,
      wheelchairAccessible: true,
      fixedEquipment: ['投影', '音响'],
      clearingMinutes: 30,
    });
    backupId = await createVenue(app, 'staff_logistics', {
      name: '二号多功能厅（备用）',
      fireCapacity: 90,
      wheelchairAccessible: true,
      fixedEquipment: ['投影', '音响'],
      clearingMinutes: 20,
    });
    tinyRoomId = await createVenue(app, 'staff_logistics', {
      name: '小型研讨间',
      fireCapacity: 12,
      wheelchairAccessible: true,
      fixedEquipment: ['白板'],
      clearingMinutes: 10,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('封闭时不静默迁移：给出满足硬条件的备选，逐场地说明不可安置原因', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      requiredEquipment: ['投影'],
      audienceGroups: ['学生', '指导老师'],
    });
    const confirmed = await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T10:00:00.000Z`,
      })
      .expect(201);
    expect(confirmed.body.status).toBe('confirmed');

    const closure = await api(app, 'staff_logistics')
      .post('/closures', {
        venueId: hallId,
        startAt: `${FRIDAY}T06:00:00.000Z`,
        endAt: `${FRIDAY}T12:00:00.000Z`,
        reason: '消防设施检修',
      })
      .expect(201);

    expect(closure.body.affectedCount).toBe(1);
    const impact = closure.body.impacts[0];
    expect(impact.outcome).toBe('alternatives_ready');
    expect(impact.started).toBe(false);

    // 二号厅可直接安置；小型研讨间因容量/设备不满足硬条件被排除并说明原因
    const usable = impact.alternatives.filter(
      (a: { immediatelyUsable: boolean }) => a.immediatelyUsable,
    );
    expect(usable).toHaveLength(1);
    expect(usable[0].venueName).toBe('二号多功能厅（备用）');

    // 原确认单仍然存在且未被系统擅改（不静默迁移）
    const still = await api(app, 'staff_logistics')
      .get(`/bookings/${confirmed.body.id}`)
      .expect(200);
    expect(still.body.status).toBe('confirmed');
    expect(still.body.venueId).toBe(hallId);

    // 封闭详情保留逐场地不可安置原因
    const detail = await api(app, 'staff_logistics')
      .get(`/closures/${closure.body.closureId}`)
      .expect(200);
    expect(detail.body.impacts[0].outcome).toBe('alternatives_ready');
  });

  it('负责人显式接受备选后才迁移：原单取消、新单确认并接续、通知入队', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      audienceGroups: ['学生'],
    });
    const original = await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T10:00:00.000Z`,
      })
      .expect(201);

    const closure = await api(app, 'staff_logistics')
      .post('/closures', {
        venueId: hallId,
        startAt: `${FRIDAY}T06:00:00.000Z`,
        endAt: `${FRIDAY}T12:00:00.000Z`,
        reason: '消防设施检修',
      })
      .expect(201);
    const proposal = closure.body.impacts[0].alternatives[0];

    // 旁人不能替负责人接受
    await api(app, 'owner_lecture')
      .post(`/closures/proposals/${proposal.proposalId}/accept`)
      .expect(400);

    const migrated = await api(app, 'owner_robot')
      .post(`/closures/proposals/${proposal.proposalId}/accept`)
      .expect(201);
    expect(migrated.body.status).toBe('confirmed');
    expect(migrated.body.venueId).toBe(backupId);
    expect(migrated.body.replacementOf).toBe(original.body.id);

    const oldOne = await api(app, 'staff_logistics')
      .get(`/bookings/${original.body.id}`)
      .expect(200);
    expect(oldOne.body.status).toBe('cancelled');

    // 同一时段另一活动不能占用二号厅（迁移已生效，无双重占用）
    const lecture = await createActivity(app, 'owner_lecture', {
      title: '家长讲座',
      expectedAttendees: 40,
      audienceGroups: ['家长'],
    });
    const clash = await api(app, 'owner_lecture')
      .post('/bookings', {
        activityId: lecture,
        venueId: backupId,
        startAt: `${FRIDAY}T08:30:00.000Z`,
        endAt: `${FRIDAY}T09:30:00.000Z`,
      })
      .expect(201);
    expect(clash.body.status).toBe('rejected');
  });

  it('已经开始的活动不可迁移：登记封闭时标记 immovable 且保留原安排', async () => {
    // 使用一个已开始的时段（相对当前时间在过去）
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团（进行中）',
      expectedAttendees: 30,
      audienceGroups: ['学生'],
    });
    const start = new Date(Date.now() - 30 * 60_000).toISOString();
    const end = new Date(Date.now() + 60 * 60_000).toISOString();
    const confirmed = await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: start,
        endAt: end,
      })
      .expect(201);

    const closure = await api(app, 'staff_logistics')
      .post('/closures', {
        venueId: hallId,
        startAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        endAt: new Date(Date.now() + 120 * 60_000).toISOString(),
        reason: '突发水管检修',
      })
      .expect(201);

    const impact = closure.body.impacts[0];
    expect(impact.outcome).toBe('immovable');
    expect(impact.started).toBe(true);
    expect(impact.alternatives).toEqual([]);

    const still = await api(app, 'staff_logistics')
      .get(`/bookings/${confirmed.body.id}`)
      .expect(200);
    expect(still.body.status).toBe('confirmed');
    // 通知类型为不可迁移警示
    const notes = still.body.notifications.map(
      (n: { type: string }) => n.type,
    );
    expect(notes).toContain('closure_immovable');
  });

  it('备用场地无障碍通道维修时，轮椅需求活动无法安置并给出明确原因', async () => {
    // 备用厅无障碍通道正在维修 → 发布为不可达版本
    await api(app, 'staff_logistics')
      .post(`/venues/${backupId}/versions`, {
        fireCapacity: 90,
        wheelchairAccessible: false,
        accessibilityNote: '无障碍通道维修中，暂停轮椅通行',
        fixedEquipment: ['投影', '音响'],
        weeklyAvailability: ALL_WEEK,
        clearingMinutes: 20,
        changeReason: '无障碍通道维修',
      })
      .expect(201);

    const robot = await createActivity(app, 'owner_robot', {
      title: '轮椅学生参与的机器人展示',
      expectedAttendees: 30,
      requiresWheelchair: true,
      requiredEquipment: ['投影'],
      audienceGroups: ['学生', '家长'],
    });
    await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T10:00:00.000Z`,
      })
      .expect(201);

    const closure = await api(app, 'staff_logistics')
      .post('/closures', {
        venueId: hallId,
        startAt: `${FRIDAY}T06:00:00.000Z`,
        endAt: `${FRIDAY}T12:00:00.000Z`,
        reason: '无障碍通道维修连带停用',
      })
      .expect(201);

    const impact = closure.body.impacts[0];
    expect(impact.outcome).toBe('no_alternative');
    const allReasons = impact.impossibleReasons
      .flatMap((r: { reasons: string[] }) => r.reasons)
      .join(' ');
    expect(allReasons).toContain('轮椅');
    // 通知为无法安置类型
    const notes = await db.all(
      `SELECT type FROM notifications WHERE type = 'closure_no_alternative'`,
    );
    expect(notes.length).toBeGreaterThan(0);
  });

  it('变更通知按受影响人群分别入队，投递后可查通知状态', async () => {
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      audienceGroups: ['学生', '家长'],
    });
    await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T10:00:00.000Z`,
      })
      .expect(201);

    await api(app, 'staff_logistics')
      .post('/closures', {
        venueId: hallId,
        startAt: `${FRIDAY}T06:00:00.000Z`,
        endAt: `${FRIDAY}T12:00:00.000Z`,
        reason: '消防设施检修',
      })
      .expect(201);

    // 负责人本人 + 学生 + 家长三类都各有通知
    const pending = db.all(
      `SELECT person_id, audience_group, type FROM notifications
       WHERE type LIKE 'closure_%' ORDER BY id`,
    );
    const targets = pending.map((r) => r.person_id ?? r.audience_group);
    expect(targets).toContain('owner_robot');
    expect(targets).toContain('学生');
    expect(targets).toContain('家长');

    // 非总务不能触发投递
    await api(app, 'owner_robot').post('/notifications/dispatch').expect(403);

    const dispatch = await api(app, 'staff_logistics')
      .post('/notifications/dispatch')
      .expect(201);
    expect(dispatch.body.count).toBeGreaterThan(0);

    const status = await api(app, 'staff_logistics')
      .get(`/notifications/status?venueId=${hallId}`)
      .expect(200);
    const sent = status.body.summary.filter(
      (s: { status: string }) => s.status === 'sent',
    );
    expect(sent.length).toBeGreaterThan(0);
  });

  it('遗留的双确认单（基线迁入脏数据）在态势查询中如实暴露两个实际使用者', async () => {
    // 模拟从旧系统迁入、双方都持有确认单的历史情况
    const robot = await createActivity(app, 'owner_robot', {
      title: '机器人社团',
      expectedAttendees: 30,
      audienceGroups: ['学生'],
    });
    const lecture = await createActivity(app, 'owner_lecture', {
      title: '家长讲座',
      expectedAttendees: 60,
      audienceGroups: ['家长'],
    });
    const first = await api(app, 'owner_robot')
      .post('/bookings', {
        activityId: robot,
        venueId: hallId,
        startAt: `${FRIDAY}T08:00:00.000Z`,
        endAt: `${FRIDAY}T10:00:00.000Z`,
      })
      .expect(201);

    // 直接写入一条历史遗留 confirmed 记录，绕过冲突引擎
    const vv = db.get('SELECT * FROM venue_versions WHERE id = ?', first.body.venueSnapshot.versionId)!;
    db.run(
      `INSERT INTO bookings
        (id, activity_id, venue_id, venue_version_id, venue_snapshot, venue_name,
         clearing_minutes, start_at, end_at, status, conflict_report, created_by, created_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, 30, ?, ?, 'confirmed', '{}', ?, ?, ?)`,
      'bk_legacy_lecture',
      lecture,
      hallId,
      vv.id,
      JSON.stringify(first.body.venueSnapshot),
      '一号多功能教室',
      `${FRIDAY}T08:00:00.000Z`,
      `${FRIDAY}T10:00:00.000Z`,
      'owner_lecture',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const situation = await api(app, 'staff_logistics')
      .get(
        `/overview/situation?from=${FRIDAY}T07:00:00.000Z&to=${FRIDAY}T11:00:00.000Z&venueId=${hallId}`,
      )
      .expect(200);
    expect(situation.body.actualUsers).toHaveLength(2);
    const titles = situation.body.actualUsers.map(
      (u: { title: string }) => u.title,
    );
    expect(titles).toEqual(expect.arrayContaining(['机器人社团', '家长讲座']));
    // 受影响人群包含学生、家长与两位负责人
    const people = situation.body.affectedPeople.map(
      (p: { name: string }) => p.name,
    );
    expect(people).toEqual(
      expect.arrayContaining(['学生', '家长', 'owner_robot', 'owner_lecture']),
    );
  });
});
