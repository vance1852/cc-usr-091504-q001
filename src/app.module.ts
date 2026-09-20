import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { UsersModule } from './users/users.module';
import { VenuesModule } from './venues/venues.module';
import { ActivitiesModule } from './activities/activities.module';
import { NotificationsModule } from './notifications/notifications.module';
import { BookingsModule } from './bookings/bookings.module';
import { ClosuresModule } from './closures/closures.module';
import { OverviewModule } from './overview/overview.module';

export function createAppModule(dbFile: string) {
  @Module({
    imports: [
      DatabaseModule.forFile(dbFile),
      UsersModule,
      VenuesModule,
      ActivitiesModule,
      NotificationsModule,
      BookingsModule,
      ClosuresModule,
      OverviewModule,
    ],
  })
  class AppModule {}

  return AppModule;
}
