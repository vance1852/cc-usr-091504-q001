import request from 'supertest';
import { INestApplication } from '@nestjs/common';

/** 带调用者身份头的请求封装 */
export function api(app: INestApplication, userId: string) {
  const agent = request(app.getHttpServer());
  const headers = { 'x-user-id': userId };
  return {
    post: (url: string, body?: unknown) =>
      agent.post(url).set(headers).send(body ?? {}),
    get: (url: string) => agent.get(url).set(headers),
    patch: (url: string, body?: unknown) =>
      agent.patch(url).set(headers).send(body ?? {}),
  };
}

export interface VenueSpec {
  name: string;
  fireCapacity: number;
  wheelchairAccessible: boolean;
  fixedEquipment: string[];
  clearingMinutes: number;
  weeklyAvailability?: Array<{ weekday: number; open: string; end: string }>;
  accessibilityNote?: string;
}

export async function createVenue(
  app: INestApplication,
  staffId: string,
  spec: VenueSpec,
): Promise<string> {
  const res = await api(app, staffId)
    .post('/venues', {
      name: spec.name,
      fireCapacity: spec.fireCapacity,
      wheelchairAccessible: spec.wheelchairAccessible,
      accessibilityNote: spec.accessibilityNote ?? '',
      fixedEquipment: spec.fixedEquipment,
      weeklyAvailability: spec.weeklyAvailability ?? [
        { weekday: 0, open: '00:00', end: '23:59' },
        { weekday: 1, open: '00:00', end: '23:59' },
        { weekday: 2, open: '00:00', end: '23:59' },
        { weekday: 3, open: '00:00', end: '23:59' },
        { weekday: 4, open: '00:00', end: '23:59' },
        { weekday: 5, open: '00:00', end: '23:59' },
        { weekday: 6, open: '00:00', end: '23:59' },
      ],
      clearingMinutes: spec.clearingMinutes,
    })
    .expect(201);
  return res.body.id as string;
}

export interface ActivitySpecBody {
  title: string;
  expectedAttendees: number;
  requiresWheelchair?: boolean;
  requiredEquipment?: string[];
  specialAccessNote?: string;
  audienceGroups: string[];
}

export async function createActivity(
  app: INestApplication,
  ownerId: string,
  spec: ActivitySpecBody,
): Promise<string> {
  const res = await api(app, ownerId)
    .post('/activities', {
      requiresWheelchair: false,
      requiredEquipment: [],
      ...spec,
    })
    .expect(201);
  return res.body.id as string;
}
