import { Module } from '@nestjs/common';
import { ClosuresService } from './closures.service';
import { ClosuresController } from './closures.controller';
import { BookingsModule } from '../bookings/bookings.module';
import { VenuesModule } from '../venues/venues.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [BookingsModule, VenuesModule, NotificationsModule],
  controllers: [ClosuresController],
  providers: [ClosuresService],
  exports: [ClosuresService],
})
export class ClosuresModule {}
