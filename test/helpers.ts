import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

process.env.DATABASE_PATH = ':memory:';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

export interface Actor {
  id: string;
  role: 'organizer' | 'staff' | 'approver';
}

export const STAFF: Actor = { id: 'staff-li', role: 'staff' };
export const APPROVER: Actor = { id: 'approver-wang', role: 'approver' };
export const TEACHER_ZHANG: Actor = { id: 'teacher-zhang', role: 'organizer' };
export const TEACHER_CHEN: Actor = { id: 'teacher-chen', role: 'organizer' };

/** 构造带身份头的请求 */
export function call(
  app: INestApplication,
  method: 'get' | 'post' | 'patch' | 'delete',
  url: string,
  actor?: Actor,
): any {
  let r = request(app.getHttpServer())[method](url);
  if (actor) {
    r = r.set('x-user-id', actor.id).set('x-user-role', actor.role);
  }
  return r;
}

/** 一周七天 07:00-22:00 全开放的可用时段 */
export const ALL_WEEK_WINDOWS = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  start: '07:00',
  end: '22:00',
}));

export async function createVenue(
  app: INestApplication,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const res = await call(app, 'post', '/venues', STAFF)
    .send({
      name: '多功能教室',
      capacity: 60,
      accessible: true,
      equipment: ['projector', 'sound'],
      windows: ALL_WEEK_WINDOWS,
      turnoverMinutes: 30,
      ...overrides,
    })
    .expect(201);
  return res.body;
}

export function createBooking(
  app: INestApplication,
  actor: Actor,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): any {
  let r = call(app, 'post', '/bookings', actor);
  if (idempotencyKey) r = r.set('Idempotency-Key', idempotencyKey);
  return r.send(body);
}

/** 2026-09-25 是周五（UTC），测试统一使用这一天 */
export const FRIDAY = '2026-09-25';
