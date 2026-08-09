import { parseChatRealtimeEvent } from '../realtimeEvents';

const tripId = 'a2222222-b222-4222-8222-c22222222222';
const message = {
  id: '11111111-1111-4111-8111-111111111111',
  trip_id: tripId,
  sender: {
    id: null,
    display_name: 'GoPlan AI',
    identify_tag: null,
    avatar_url: null,
  },
  sender_kind: 'AI',
  ai_status: 'SUCCESS',
  content: 'A realtime answer.',
  client_message_id: null,
  created_at: '2026-08-09T01:00:00+00:00',
  updated_at: '2026-08-09T01:00:01+00:00',
  change_sequence: 12,
  is_deleted_for_everyone: false,
  deleted_for_everyone_at: null,
  deleted_for_everyone_by_id: null,
  delete_for_everyone_until: null,
  can_delete_for_everyone: false,
  reactions: [],
  action_drafts: [
    {
      id: 'draft-1',
      required_confirmation: 'UNKNOWN_FUTURE_AUTHORITY',
      unknown_nested_value: { preserve: ['all', 'values'] },
    },
  ],
};

describe('parseChatRealtimeEvent', () => {
  it.each(['chat.message', 'chat.message_deleted'] as const)(
    'parses a full %s payload and preserves nullable sender plus opaque drafts',
    (type) => {
      expect(parseChatRealtimeEvent({ type, trip_id: tripId, message })).toEqual({
        type,
        trip_id: tripId,
        message,
      });
    },
  );

  it.each(['chat.subscribed', 'chat.unsubscribed', 'chat.kicked'] as const)(
    'parses the trip-scoped %s control event',
    (type) => {
      expect(parseChatRealtimeEvent({ type, trip_id: tripId })).toEqual({
        type,
        trip_id: tripId,
      });
    },
  );

  it('parses reaction updates as a patch rather than inventing a full message', () => {
    expect(
      parseChatRealtimeEvent({
        type: 'chat.reaction_update',
        trip_id: tripId,
        message_id: message.id,
        reactions: [
          {
            emoji: '😂',
            count: 2,
            reacted_by_ids: ['user-1', 'user-2'],
          },
        ],
        change_sequence: 13,
        updated_at: '2026-08-09T01:00:02+00:00',
      }),
    ).toEqual({
      type: 'chat.reaction_update',
      trip_id: tripId,
      message_id: message.id,
      reactions: [
        {
          emoji: '😂',
          count: 2,
          reacted_by_ids: ['user-1', 'user-2'],
        },
      ],
      change_sequence: 13,
      updated_at: '2026-08-09T01:00:02+00:00',
    });
  });

  it('canonicalizes uppercase room ids for acknowledgements and full events', () => {
    const uppercaseTripId = tripId.toUpperCase();
    expect(
      parseChatRealtimeEvent({
        type: 'chat.subscribed',
        trip_id: uppercaseTripId,
      }),
    ).toEqual({ type: 'chat.subscribed', trip_id: tripId });
    expect(
      parseChatRealtimeEvent({
        type: 'chat.message',
        trip_id: uppercaseTripId,
        message: { ...message, trip_id: uppercaseTripId },
      }),
    ).toEqual({ type: 'chat.message', trip_id: tripId, message });
  });

  it('accepts an open chat.error code and preserves the server detail', () => {
    expect(
      parseChatRealtimeEvent({
        type: 'chat.error',
        trip_id: tripId,
        error_code: 'FUTURE_ROOM_ERROR',
        detail: 'The server explained the future error.',
      }),
    ).toEqual({
      type: 'chat.error',
      trip_id: tripId,
      error_code: 'FUTURE_ROOM_ERROR',
      detail: 'The server explained the future error.',
    });
  });

  it('parses both AI typing variants and retains the nullable requester', () => {
    expect(
      parseChatRealtimeEvent({
        type: 'chat.ai_typing_started',
        trip_id: tripId,
        interaction_id: 'interaction-1',
        requested_by_user_id: null,
      }),
    ).toEqual({
      type: 'chat.ai_typing_started',
      trip_id: tripId,
      interaction_id: 'interaction-1',
      requested_by_user_id: null,
    });
    expect(
      parseChatRealtimeEvent({
        type: 'chat.ai_typing_stopped',
        trip_id: tripId,
        interaction_id: 'interaction-1',
      }),
    ).toEqual({
      type: 'chat.ai_typing_stopped',
      trip_id: tripId,
      interaction_id: 'interaction-1',
    });
  });

  it.each([
    null,
    {},
    { type: 'chat.future', trip_id: tripId },
    { type: 'chat.subscribed', trip_id: '' },
    { type: 'chat.message', trip_id: tripId, message: { id: message.id } },
    {
      type: 'chat.message',
      trip_id: 'different-trip',
      message,
    },
    {
      type: 'chat.message',
      trip_id: tripId,
      message: { ...message, sender: { ...message.sender, id: '' } },
    },
    {
      type: 'chat.message',
      trip_id: tripId,
      message: { ...message, client_message_id: '' },
    },
    {
      type: 'chat.message',
      trip_id: tripId,
      message: {
        ...message,
        reactions: [
          { emoji: '👍', count: 1, reacted_by_ids: ['user-1'] },
          { emoji: '👍', count: 1, reacted_by_ids: ['user-2'] },
        ],
      },
    },
    {
      type: 'chat.message',
      trip_id: tripId,
      message: {
        ...message,
        reactions: [
          { emoji: '👍', count: 2, reacted_by_ids: ['user-1', 'user-1'] },
        ],
      },
    },
    {
      type: 'chat.reaction_update',
      trip_id: tripId,
      message_id: message.id,
      reactions: [{ emoji: '🦄', count: 1, reacted_by_ids: ['user-1'] }],
      change_sequence: 13,
      updated_at: '2026-08-09T01:00:02+00:00',
    },
    {
      type: 'chat.reaction_update',
      trip_id: tripId,
      message_id: message.id,
      reactions: [],
      change_sequence: -1,
      updated_at: '2026-08-09T01:00:02+00:00',
    },
    {
      type: 'chat.reaction_update',
      trip_id: tripId,
      message_id: message.id,
      reactions: [],
      change_sequence: 13,
    },
    {
      type: 'chat.error',
      trip_id: tripId,
      error_code: 42,
      detail: 'Malformed code.',
    },
    {
      type: 'chat.ai_typing_started',
      trip_id: tripId,
      interaction_id: 'interaction-1',
    },
  ])('fails closed for malformed or unknown frames %#', (value) => {
    expect(parseChatRealtimeEvent(value)).toBeNull();
  });
});
