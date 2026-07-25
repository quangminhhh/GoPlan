import type {
  InvitationStatus,
  ParsedNotificationPayload,
  TripInvitationPayload,
  TripPayload,
  TripResponsePayload,
  TripTimelineReminderPayload,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : null;
}

function isInvitationStatus(value: unknown): value is InvitationStatus {
  return value === 'PENDING' || value === 'ACCEPTED' || value === 'DECLINED' || value === 'CANCELLED';
}

export function parseTripInvitationPayload(raw: unknown): TripInvitationPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  const tripId = readString(raw, 'trip_id');
  const tripName = readString(raw, 'trip_name');
  const destination = readString(raw, 'destination');
  const startDate = readString(raw, 'start_date');
  const endDate = readString(raw, 'end_date');
  const invitationId = readString(raw, 'invitation_id');
  if (!tripId || !tripName || !destination || !startDate || !endDate || !invitationId) {
    return null;
  }
  return {
    trip_id: tripId,
    trip_name: tripName,
    destination,
    start_date: startDate,
    end_date: endDate,
    invitation_id: invitationId,
    invitation_status: isInvitationStatus(raw.invitation_status) ? raw.invitation_status : null,
  };
}

function parseTripPayload(raw: unknown): TripPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  const tripId = readString(raw, 'trip_id');
  const tripName = readString(raw, 'trip_name');
  return tripId && tripName ? { trip_id: tripId, trip_name: tripName } : null;
}

function parseTripResponsePayload(raw: unknown, nameKey: string): TripResponsePayload | null {
  const trip = parseTripPayload(raw);
  if (!trip || !isRecord(raw)) {
    return null;
  }
  return {
    ...trip,
    responder_name: readString(raw, nameKey),
  };
}

function parseTimelineReminderPayload(raw: unknown): TripTimelineReminderPayload | null {
  const trip = parseTripPayload(raw);
  if (!trip || !isRecord(raw)) {
    return null;
  }
  const activityId = readString(raw, 'activity_id');
  const activityTitle = readString(raw, 'activity_title');
  const sectionLabel = readString(raw, 'section_label');
  const activityDate = readString(raw, 'activity_date');
  const activityTime = readString(raw, 'activity_time');
  const locationLabel = readOptionalString(raw, 'location_label');
  if (!activityId || !activityTitle || !sectionLabel || !activityDate || !activityTime || locationLabel === null) {
    return null;
  }
  return {
    ...trip,
    activity_id: activityId,
    activity_title: activityTitle,
    section_label: sectionLabel,
    activity_date: activityDate,
    activity_time: activityTime,
    location_label: locationLabel,
  };
}

export function parseNotificationPayload(notificationType: string, raw: unknown): ParsedNotificationPayload {
  switch (notificationType) {
    case 'FRIEND_REQUEST':
      return isRecord(raw) ? { kind: 'friendRequest' } : { kind: 'fallback' };
    case 'FRIEND_ACCEPTED':
      return isRecord(raw) ? { kind: 'friendAccepted' } : { kind: 'fallback' };
    case 'TRIP_INVITATION': {
      const invitation = parseTripInvitationPayload(raw);
      return invitation ? { kind: 'tripInvitation', invitation } : { kind: 'fallback' };
    }
    case 'TRIP_INVITATION_ACCEPTED': {
      const response = parseTripResponsePayload(raw, 'accepted_by_name');
      return response ? { kind: 'tripInvitationAccepted', response } : { kind: 'fallback' };
    }
    case 'TRIP_INVITATION_DECLINED': {
      const response = parseTripResponsePayload(raw, 'declined_by_name');
      return response ? { kind: 'tripInvitationDeclined', response } : { kind: 'fallback' };
    }
    case 'TRIP_CANCELLED': {
      const trip = parseTripPayload(raw);
      return trip ? { kind: 'tripCancelled', trip } : { kind: 'fallback' };
    }
    case 'TRIP_MEMBER_REMOVED': {
      const trip = parseTripPayload(raw);
      return trip ? { kind: 'tripMemberRemoved', trip } : { kind: 'fallback' };
    }
    case 'TRIP_TIMELINE_REMINDER': {
      const reminder = parseTimelineReminderPayload(raw);
      return reminder ? { kind: 'tripTimelineReminder', reminder } : { kind: 'fallback' };
    }
    default:
      return { kind: 'fallback' };
  }
}

export function getTripTarget(parsed: ParsedNotificationPayload): string | null {
  switch (parsed.kind) {
    case 'tripInvitation':
      return parsed.invitation.invitation_status === 'ACCEPTED' ? parsed.invitation.trip_id : null;
    case 'tripInvitationAccepted':
    case 'tripInvitationDeclined':
      return parsed.response.trip_id;
    case 'tripCancelled':
    case 'tripMemberRemoved':
      return parsed.trip.trip_id;
    case 'tripTimelineReminder':
      return parsed.reminder.trip_id;
    default:
      return null;
  }
}
