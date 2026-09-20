import { Module } from '@nestjs/common';
import { ScheduleService } from './schedule.service';
import { ScheduleController } from './schedule.controller';
import { HandoversModule } from '../handovers/handovers.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [HandoversModule, NotificationsModule],
  providers: [ScheduleService],
  controllers: [ScheduleController],
})
export class ScheduleModule {}
