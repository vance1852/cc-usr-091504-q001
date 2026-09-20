import { Module } from '@nestjs/common';
import { HandoversService } from './handovers.service';
import { HandoversController } from './handovers.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  providers: [HandoversService],
  controllers: [HandoversController],
  exports: [HandoversService],
})
export class HandoversModule {}
