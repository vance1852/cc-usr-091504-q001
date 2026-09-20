import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { DomainExceptionFilter } from './common/errors';
import { VenuesModule } from './venues/venues.module';
import { BookingsModule } from './bookings/bookings.module';
import { HandoversModule } from './handovers/handovers.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { ClosuresModule } from './closures/closures.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ScheduleModule } from './schedule/schedule.module';

@Module({
  imports: [
    DatabaseModule,
    VenuesModule,
    BookingsModule,
    HandoversModule,
    ApprovalsModule,
    ClosuresModule,
    NotificationsModule,
    ScheduleModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule {}
