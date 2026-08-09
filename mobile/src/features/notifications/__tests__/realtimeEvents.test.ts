import { parseNotificationRealtimeEvent } from '../realtimeEvents';

const notification = {
  id: 'notification-1',
  notification_type: 'FRIEND_REQUEST',
  actor: { id: 'user-2', display_name: 'Bob', identify_tag: 'bob#ABC123' },
  payload: { friend_request_id: 'request-1' },
  is_read: false,
  read_at: null,
  created_at: '2026-08-09T01:00:00Z',
};

describe('parseNotificationRealtimeEvent', () => {
  it('parses the exact created envelope and keeps unknown notification types forward-compatible', () => {
    expect(
      parseNotificationRealtimeEvent({
        type: 'notification',
        event: 'created',
        notification: { ...notification, notification_type: 'FUTURE_NOTIFICATION' },
      }),
    ).toEqual({
      type: 'notification',
      event: 'created',
      notification: { ...notification, notification_type: 'FUTURE_NOTIFICATION' },
    });
  });

  it('parses read and read_all envelopes and removes duplicate read ids', () => {
    expect(
      parseNotificationRealtimeEvent({
        type: 'notification',
        event: 'read',
        notification_ids: ['notification-1', 'notification-1', 'notification-2'],
      }),
    ).toEqual({
      type: 'notification',
      event: 'read',
      notification_ids: ['notification-1', 'notification-2'],
    });
    expect(
      parseNotificationRealtimeEvent({ type: 'notification', event: 'read_all' }),
    ).toEqual({ type: 'notification', event: 'read_all' });
  });

  it.each([
    null,
    notification,
    { type: 'notification', event: 'created', notification: { payload: {} } },
    { type: 'notification', event: 'created', notification: { id: 'notification-1' } },
    {
      type: 'notification',
      event: 'created',
      notification: { ...notification, actor: { display_name: 'Missing actor id' } },
    },
    {
      type: 'notification',
      event: 'created',
      notification: { ...notification, is_read: 'false' },
    },
    {
      type: 'notification',
      event: 'created',
      notification: { ...notification, read_at: 123 },
    },
    { type: 'notification', event: 'read', notification_ids: 'notification-1' },
    { type: 'notification', event: 'read', notification_ids: [''] },
    { type: 'notification', event: 'read', notification_ids: ['notification-1', 2] },
    { type: 'notification', event: 'unknown' },
    { type: 'chat.message', event: 'created', notification },
  ])('rejects a malformed or unrelated frame: %p', (value) => {
    expect(parseNotificationRealtimeEvent(value)).toBeNull();
  });
});
