import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createAppModule } from './app.module';
import { UsersService } from './users/users.service';

async function bootstrap(): Promise<void> {
  const dbFile = process.env.DB_FILE ?? 'campus.sqlite';
  const app = await NestFactory.create(createAppModule(dbFile), {
    logger: ['error', 'warn', 'log'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // 先完成模块初始化（打开数据库），再引导账号，最后监听端口
  await app.init();

  // 首次启动引导初始总务账号（可通过环境变量覆盖）
  const staffId = process.env.INITIAL_STAFF_ID ?? 'staff_logistics';
  const staffName = process.env.INITIAL_STAFF_NAME ?? '总务处管理员';
  const bootstrapped = app.get(UsersService).bootstrapInitialStaff(staffId, staffName);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(
    `校园活动空间协调服务已启动: http://localhost:${port} (db=${dbFile})` +
      (bootstrapped ? `，已引导初始总务账号 ${staffId}` : ''),
  );
}

void bootstrap();
