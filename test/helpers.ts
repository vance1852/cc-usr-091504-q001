import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createAppModule } from '../src/app.module';
import { UsersService } from '../src/users/users.service';

export interface TestApp {
  app: INestApplication;
  httpUrl: string;
}

/** 每个用例使用独立内存数据库 */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [createAppModule(':memory:')],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0);
  const listener = app.getHttpServer() as { address: () => { port: number } | null };
  const port = listener.address()?.port;
  return { app, httpUrl: `http://127.0.0.1:${port}` };
}

export async function seedUsers(app: INestApplication): Promise<void> {
  const users = app.get(UsersService);
  users.seed([
    { id: 'owner_robot', name: '机器人社团负责人王老师', role: 'owner' },
    { id: 'owner_lecture', name: '家长讲座负责人李老师', role: 'owner' },
    { id: 'owner_other', name: '其他活动负责人赵老师', role: 'owner' },
    { id: 'staff_logistics', name: '总务处周老师', role: 'staff' },
    { id: 'approver_safety', name: '安全审批员陈老师', role: 'approver' },
    { id: 'cleaner_zhang', name: '保洁张师傅', role: 'staff' },
  ]);
}

/** 根据 ISO 时间取周几，供周历可用窗构造 */
export function weekdayOf(iso: string): number {
  return new Date(iso).getDay();
}
