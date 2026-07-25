import { getTripTarget, parseNotificationPayload, parseTripInvitationPayload } from '../payloadParsers';

const tripInvitation = {
  trip_id: 'trip-1',
  trip_name: 'Da Lat escape',
  destination: 'Da Lat',
  start_date: '2026-08-01',
  end_date: '2026-08-03',
  invitation_id: 'invitation-1',
  invitation_status: 'PENDING',
};

describe('notification payload parsers', () => {
  it.each([
    ['FRIEND_REQUEST', {}, 'friendRequest'],
    ['FRIEND_ACCEPTED', {}, 'friendAccepted'],
    ['TRIP_INVITATION', tripInvitation, 'tripInvitation'],
    [
      'TRIP_INVITATION_ACCEPTED',
      { trip_id: 'trip-1', trip_name: 'Da Lat escape', accepted_by_name: 'Bob' },
      'tripInvitationAccepted',
    ],
    [
      'TRIP_INVITATION_DECLINED',
      { trip_id: 'trip-1', trip_name: 'Da Lat escape', declined_by_name: 'Bob' },
      'tripInvitationDeclined',
    ],
    ['TRIP_CANCELLED', { trip_id: 'trip-1', trip_name: 'Da Lat escape' }, 'tripCancelled'],
    ['TRIP_MEMBER_REMOVED', { trip_id: 'trip-1', trip_name: 'Da Lat escape' }, 'tripMemberRemoved'],
    [
      'TRIP_TIMELINE_REMINDER',
      {
        trip_id: 'trip-1',
        trip_name: 'Da Lat escape',
        activity_id: 'activity-1',
        activity_title: 'Cable car',
        section_label: 'Day 1',
        activity_date: '2026-08-01',
        activity_time: '09:00',
        location_label: 'Station',
      },
      'tripTimelineReminder',
    ],
  ])('parses %s without unsafe payload assertions', (type, payload, kind) => {
    expect(parseNotificationPayload(type, payload).kind).toBe(kind);
  });

  it.each([
    ['UNKNOWN_TYPE', { secret: 'must-not-render' }],
    ['TRIP_INVITATION', { ...tripInvitation, invitation_id: 42 }],
    ['TRIP_CANCELLED', []],
    ['TRIP_MEMBER_REMOVED', 'raw payload'],
    ['TRIP_TIMELINE_REMINDER', { trip_id: 'trip-1' }],
    ['FRIEND_REQUEST', null],
  ])('returns a neutral fallback for malformed or unknown %s payloads', (type, payload) => {
    expect(parseNotificationPayload(type, payload)).toEqual({ kind: 'fallback' });
  });

  it('keeps legacy or unknown invitation status non-actionable while preserving safe details', () => {
    expect(parseTripInvitationPayload({ ...tripInvitation, invitation_status: undefined })).toEqual({
      ...tripInvitation,
      invitation_status: null,
    });
    expect(parseTripInvitationPayload({ ...tripInvitation, invitation_status: 'EXPIRED' })?.invitation_status).toBeNull();
  });

  it('only exposes an accepted invitation as a directly accessible trip target', () => {
    const pending = parseNotificationPayload('TRIP_INVITATION', tripInvitation);
    const accepted = parseNotificationPayload('TRIP_INVITATION', {
      ...tripInvitation,
      invitation_status: 'ACCEPTED',
    });

    expect(getTripTarget(pending)).toBeNull();
    expect(getTripTarget(accepted)).toBe('trip-1');
  });

  it.each([
    ['an empty location', { location_label: '' }],
    ['an omitted location', {}],
  ])('keeps a timeline reminder with %s actionable', (_label, locationFields) => {
    const parsed = parseNotificationPayload('TRIP_TIMELINE_REMINDER', {
      trip_id: 'trip-1',
      trip_name: 'Da Lat escape',
      activity_id: 'activity-1',
      activity_title: 'Cable car',
      section_label: 'Day 1',
      activity_date: '2026-08-01',
      activity_time: '09:00',
      ...locationFields,
    });

    expect(parsed.kind).toBe('tripTimelineReminder');
    expect(getTripTarget(parsed)).toBe('trip-1');
  });
});
