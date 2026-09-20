import { Module } from '@nestjs/common';
import { ClosuresService } from './closures.service';
import { ClosuresController } from './closures.controller';
import { VenuesModule } from '../venues/venues.module';
import { HandoversModule } from '../handovers/handovers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BookingsModule } from '../bookings/bookings.module';

@Module({
  imports: [VenuesModule, HandoversModule, NotificationsModule, BookingsModule],
  providers: [ClosuresService],
  controllers: [ClosuresController],
})
export class ClosuresModule {}
