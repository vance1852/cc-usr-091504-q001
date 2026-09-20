import { Injectable } from '@nestjs/common';
import { Booking } from '../domain/types';
import { BookingsService } from './bookings.service';
import { VenuesService } from '../venues/venues.service';
import { HandoversService } from '../handovers/handovers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalsService } from '../approvals/approvals.service';

/**
 * 预约的完整视图：除基本字段外，附带
 * - confirmationBasis：确认所依据的场地版本 vs 当前版本（冲突依据）
 * - handover：作为后一场的责任交接（含待清场事项）
 * - notifications：变更通知状态
 * - approvals：例外批准记录
 * - events：状态变更历史
 */
@Injectable()
export class BookingViewService {
  constructor(
    private readonly bookings: BookingsService,
    private readonly venues: VenuesService,
    private readonly handovers: HandoversService,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
  ) {}

  detail(id: string) {
    const b = this.bookings.get(id);
    return this.render(b, true);
  }

  render(b: Booking, withEvents = false) {
    const venue = this.venues.find(b.venueId);
    const handover = this.handovers.incomingFor(b.id);
    const view: Record<string, unknown> = {
      ...b,
      venueName: venue?.name ?? null,
      confirmationBasis: {
        venueVersionAtConfirmation: b.venueVersion,
        currentVenueVersion: venue?.version ?? null,
        stale: b.venueVersion !== null && venue !== null && b.venueVersion !== venue.version,
      },
      handover: handover ?? null,
      notifications: this.notifications.forBooking(b.id),
      approvals: this.approvals.forBooking(b.id),
    };
    if (withEvents) {
      view.events = this.bookings.events(b.id);
    }
    return view;
  }
}
