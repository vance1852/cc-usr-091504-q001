import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { BookingViewService } from './booking-view.service';
import { VenuesModule } from '../venues/venues.module';
import { HandoversModule } from '../handovers/handovers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalsModule } from '../approvals/approvals.module';

@Module({
  imports: [VenuesModule, HandoversModule, NotificationsModule, ApprovalsModule],
  providers: [BookingsService, BookingViewService],
  controllers: [BookingsController],
  exports: [BookingsService, BookingViewService],
})
export class BookingsModule {}
