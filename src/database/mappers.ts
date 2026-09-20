import {
  Approval,
  Booking,
  BookingEvent,
  Closure,
  ClosureImpact,
  Handover,
  Notification,
  Venue,
  VenueVersion,
} from '../domain/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function rowToVenue(r: any): Venue {
  return {
    id: r.id,
    name: r.name,
    capacity: r.capacity,
    accessible: !!r.accessible,
    equipment: JSON.parse(r.equipment),
    windows: JSON.parse(r.windows),
    turnoverMinutes: r.turnover_minutes,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToVenueVersion(r: any): VenueVersion {
  return {
    id: r.id,
    venueId: r.venue_id,
    version: r.version,
    snapshot: JSON.parse(r.snapshot),
    changeReason: r.change_reason,
    changedBy: r.changed_by,
    changedAt: r.changed_at,
  };
}

export function rowToBooking(r: any): Booking {
  return {
    id: r.id,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    title: r.title,
    attendees: r.attendees,
    requiresAccessibleRoute: !!r.requires_accessible,
    requiredEquipment: JSON.parse(r.required_equipment),
    audienceGroups: JSON.parse(r.audience_groups),
    start: r.start,
    end: r.end,
    venueId: r.venue_id,
    venueVersion: r.venue_version,
    status: r.status,
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToEvent(r: any): BookingEvent {
  return {
    id: r.id,
    bookingId: r.booking_id,
    type: r.type,
    payload: JSON.parse(r.payload),
    actorId: r.actor_id,
    createdAt: r.created_at,
  };
}

export function rowToHandover(r: any): Handover {
  return {
    id: r.id,
    venueId: r.venue_id,
    outBookingId: r.out_booking_id,
    inBookingId: r.in_booking_id,
    cleanupItems: JSON.parse(r.cleanup_items),
    outConfirmedBy: r.out_confirmed_by,
    outConfirmedAt: r.out_confirmed_at,
    inConfirmedBy: r.in_confirmed_by,
    inConfirmedAt: r.in_confirmed_at,
    status: r.status,
    createdAt: r.created_at,
  };
}

export function rowToApproval(r: any): Approval {
  return {
    id: r.id,
    bookingId: r.booking_id,
    type: r.type,
    status: r.status,
    reason: r.reason,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

export function rowToClosure(r: any): Closure {
  return {
    id: r.id,
    venueId: r.venue_id,
    reason: r.reason,
    from: r.from_ts,
    to: r.to_ts,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export function rowToImpact(r: any): ClosureImpact {
  return {
    id: r.id,
    closureId: r.closure_id,
    bookingId: r.booking_id,
    action: r.action,
    toVenueId: r.to_venue_id,
    reasons: JSON.parse(r.reasons),
    createdAt: r.created_at,
  };
}

export function rowToNotification(r: any): Notification {
  return {
    id: r.id,
    bookingId: r.booking_id,
    audienceGroup: r.audience_group,
    message: r.message,
    status: r.status,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}
