import { AxiosError } from 'axios';

jest.mock('@/shared/api/client', () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { apiClient } from '@/shared/api/client';
// eslint-disable-next-line import/first
import {
  addChatReaction,
  deleteChatMessage,
  gapFillChatMessages,
  hideChatMessages,
  listChatHistory,
  normalizeChatApiError,
  removeChatReaction,
  sendChatMessage,
  syncChangedChatMessages,
} from '../api';

const mockGet = apiClient.get as jest.MockedFunction<typeof apiClient.get>;
const mockPost = apiClient.post as jest.MockedFunction<typeof apiClient.post>;
const mockDelete = apiClient.delete as jest.MockedFunction<typeof apiClient.delete>;

const message = {
  id: '11111111-1111-4111-8111-111111111111',
  trip_id: '22222222-2222-4222-8222-222222222222',
  sender: {
    id: null,
    display_name: 'GoPlan AI',
    identify_tag: null,
    avatar_url: null,
  },
  sender_kind: 'AI',
  ai_status: 'SUCCESS',
  content: 'Here is the plan.',
  client_message_id: null,
  created_at: '2026-08-09T01:00:00+00:00',
  updated_at: '2026-08-09T01:00:01+00:00',
  change_sequence: 7,
  is_deleted_for_everyone: false,
  deleted_for_everyone_at: null,
  deleted_for_everyone_by_id: null,
  delete_for_everyone_until: '2026-08-09T01:05:00+00:00',
  can_delete_for_everyone: false,
  reactions: [
    {
      emoji: '👍',
      count: 1,
      reacted_by_ids: ['33333333-3333-4333-8333-333333333333'],
    },
  ],
  action_drafts: [
    {
      id: 'draft-1',
      required_confirmation: 'FUTURE_CONFIRMATION_KIND',
      future_nested_value: { retained: true },
    },
  ],
};

const OTHER_TRIP_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_MESSAGE_ID = '77777777-7777-4777-8777-777777777777';

function axiosError(
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): AxiosError {
  return new AxiosError(
    'Request failed',
    undefined,
    undefined,
    undefined,
    {
      status,
      data,
      headers,
      statusText: 'Request failed',
      config: { headers: {} },
    } as never,
  );
}

describe('chat api', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
  });

  it('loads newest-first history with the opaque cursor and preserves opaque action drafts', async () => {
    mockGet.mockResolvedValue({
      data: { results: [message], next_cursor: 'opaque-cursor==' },
    } as never);

    await expect(
      listChatHistory(message.trip_id, { cursor: 'previous==', limit: 20 }),
    ).resolves.toEqual({
      results: [message],
      next_cursor: 'opaque-cursor==',
    });
    expect(mockGet).toHaveBeenCalledWith(
      `/trips/${message.trip_id}/chat/messages`,
      {
        params: { cursor: 'previous==', limit: 20 },
        signal: undefined,
      },
    );
  });

  it('maps gap-fill and change-sync options to mutually exclusive wire queries', async () => {
    mockGet
      .mockResolvedValueOnce({ data: { results: [message], has_more: true } } as never)
      .mockResolvedValueOnce({ data: { results: [message], has_more: false } } as never);

    await expect(
      gapFillChatMessages(message.trip_id, { since: message.id, limit: 200 }),
    ).resolves.toEqual({ results: [message], has_more: true });
    await expect(
      syncChangedChatMessages(message.trip_id, {
        changedSince: message.change_sequence,
        changedSinceId: message.id,
      }),
    ).resolves.toEqual({ results: [message], has_more: false });

    expect(mockGet.mock.calls).toEqual([
      [
        `/trips/${message.trip_id}/chat/messages`,
        {
          params: { since: message.id, limit: 200 },
          signal: undefined,
        },
      ],
      [
        `/trips/${message.trip_id}/chat/messages`,
        {
          params: {
            changed_since: message.change_sequence,
            changed_since_id: message.id,
            limit: 100,
          },
          signal: undefined,
        },
      ],
    ]);
  });

  it.each([
    ['history', () => listChatHistory(message.trip_id)],
    [
      'gap fill',
      () => gapFillChatMessages(message.trip_id, { since: message.id }),
    ],
    [
      'changed sync',
      () =>
        syncChangedChatMessages(message.trip_id, {
          changedSince: message.change_sequence,
        }),
    ],
  ] as const)(
    'rejects a valid full message from another trip in %s',
    async (_label, request) => {
      mockGet.mockResolvedValueOnce({
        data:
          _label === 'history'
            ? {
                results: [{ ...message, trip_id: OTHER_TRIP_ID }],
                next_cursor: null,
              }
            : {
                results: [{ ...message, trip_id: OTHER_TRIP_ID }],
                has_more: false,
              },
      } as never);

      await expect(request()).rejects.toThrow(
        'The chat server returned an invalid response.',
      );
    },
  );

  it('accepts an uppercase-equivalent response trip id and canonicalizes it', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        results: [{ ...message, trip_id: message.trip_id.toUpperCase() }],
        next_cursor: null,
      },
    } as never);

    await expect(listChatHistory(message.trip_id)).resolves.toMatchObject({
      results: [{ trip_id: message.trip_id }],
    });
  });

  it('canonicalizes full-message and nullable client UUID identities', async () => {
    const canonicalMessageId = 'a1111111-b111-4111-8111-c11111111111';
    const canonicalClientId = 'a4444444-b444-4444-8444-c44444444444';
    mockGet.mockResolvedValueOnce({
      data: {
        results: [
          {
            ...message,
            id: canonicalMessageId.toUpperCase(),
            client_message_id: canonicalClientId.toUpperCase(),
          },
        ],
        next_cursor: null,
      },
    } as never);

    await expect(listChatHistory(message.trip_id)).resolves.toMatchObject({
      results: [
        {
          id: canonicalMessageId,
          client_message_id: canonicalClientId,
        },
      ],
    });
  });

  it('canonicalizes message UUID anchors and reaction paths before transport', async () => {
    const canonicalMessageId = 'a1111111-b111-4111-8111-c11111111111';
    mockGet
      .mockResolvedValueOnce({ data: { results: [], has_more: false } } as never)
      .mockResolvedValueOnce({ data: { results: [], has_more: false } } as never);
    mockPost.mockResolvedValueOnce({
      data: {
        reactions: [],
        change_sequence: 8,
        updated_at: '2026-08-09T01:00:02+00:00',
      },
    } as never);

    await gapFillChatMessages(message.trip_id, {
      since: canonicalMessageId.toUpperCase(),
    });
    await syncChangedChatMessages(message.trip_id, {
      changedSince: 7,
      changedSinceId: canonicalMessageId.toUpperCase(),
    });
    await addChatReaction(
      message.trip_id,
      canonicalMessageId.toUpperCase(),
      '👍',
    );

    expect(mockGet.mock.calls[0]?.[1]).toMatchObject({
      params: { since: canonicalMessageId },
    });
    expect(mockGet.mock.calls[1]?.[1]).toMatchObject({
      params: { changed_since_id: canonicalMessageId },
    });
    expect(mockPost.mock.calls[0]?.[0]).toBe(
      `/trips/${message.trip_id}/chat/messages/${canonicalMessageId}/reactions`,
    );
  });

  it('rejects malformed message UUID anchors and reaction ids before transport', async () => {
    await expect(
      gapFillChatMessages(message.trip_id, { since: 'not-a-uuid' }),
    ).rejects.toThrow('Gap-fill anchor must be a valid UUID.');
    await expect(
      syncChangedChatMessages(message.trip_id, {
        changedSince: 7,
        changedSinceId: 'not-a-uuid',
      }),
    ).rejects.toThrow('Change-sync id must be a valid UUID.');
    await expect(
      addChatReaction(message.trip_id, 'not-a-uuid', '👍'),
    ).rejects.toThrow('Message id must be a valid UUID.');
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('distinguishes a newly created send from an idempotent replay', async () => {
    const input = {
      content: 'Hello once',
      clientMessageId: '44444444-4444-4444-8444-444444444444',
    };
    const sentMessage = {
      ...message,
      client_message_id: input.clientMessageId,
    };
    mockPost
      .mockResolvedValueOnce({ data: { message: sentMessage }, status: 201 } as never)
      .mockResolvedValueOnce({ data: { message: sentMessage }, status: 200 } as never);

    await expect(sendChatMessage(message.trip_id, input)).resolves.toEqual({
      message: sentMessage,
      disposition: 'created',
    });
    await expect(sendChatMessage(message.trip_id, input)).resolves.toEqual({
      message: sentMessage,
      disposition: 'replayed',
    });
    expect(mockPost.mock.calls[0]).toEqual([
      `/trips/${message.trip_id}/chat/messages`,
      {
        content: input.content,
        client_message_id: input.clientMessageId,
      },
      { signal: undefined },
    ]);
  });

  it('canonicalizes an uppercase client id before sending and accepts its equivalent response id', async () => {
    const canonicalClientId = 'a4444444-b444-4444-8444-c44444444444';
    mockPost.mockResolvedValueOnce({
      data: {
        message: { ...message, client_message_id: canonicalClientId },
      },
      status: 201,
    } as never);

    await expect(
      sendChatMessage(message.trip_id, {
        content: 'Canonical id',
        clientMessageId: canonicalClientId.toUpperCase(),
      }),
    ).resolves.toMatchObject({
      message: { client_message_id: canonicalClientId },
      disposition: 'created',
    });
    expect(mockPost).toHaveBeenCalledWith(
      `/trips/${message.trip_id}/chat/messages`,
      { content: 'Canonical id', client_message_id: canonicalClientId },
      { signal: undefined },
    );
  });

  it.each([
    [
      'another trip',
      { ...message, trip_id: OTHER_TRIP_ID },
      '44444444-4444-4444-8444-444444444444',
    ],
    [
      'another client id',
      {
        ...message,
        client_message_id: '66666666-6666-4666-8666-666666666666',
      },
      '44444444-4444-4444-8444-444444444444',
    ],
    [
      'a null client id',
      { ...message, client_message_id: null },
      '44444444-4444-4444-8444-444444444444',
    ],
  ] as const)(
    'rejects a send response bound to %s',
    async (_label, responseMessage, clientMessageId) => {
      mockPost.mockResolvedValueOnce({
        data: { message: responseMessage },
        status: 201,
      } as never);

      await expect(
        sendChatMessage(message.trip_id, {
          content: 'Bound request',
          clientMessageId,
        }),
      ).rejects.toThrow('The chat server returned an invalid response.');
    },
  );

  it('maps single delete modes and bulk hide to their exact response variants', async () => {
    mockDelete
      .mockResolvedValueOnce({
        data: { hidden_message_ids: [message.id] },
      } as never)
      .mockResolvedValueOnce({
        data: {
          message: {
            ...message,
            content: '',
            is_deleted_for_everyone: true,
          },
        },
      } as never);
    mockPost.mockResolvedValueOnce({
      data: { hidden_message_ids: [message.id, OTHER_MESSAGE_ID] },
    } as never);

    await expect(
      deleteChatMessage(message.trip_id, message.id, 'for_me'),
    ).resolves.toEqual({ mode: 'for_me', hidden_message_ids: [message.id] });
    await expect(
      deleteChatMessage(message.trip_id, message.id, 'for_everyone'),
    ).resolves.toEqual({
      mode: 'for_everyone',
      message: {
        ...message,
        content: '',
        is_deleted_for_everyone: true,
      },
    });
    await expect(
      hideChatMessages(message.trip_id, [message.id, OTHER_MESSAGE_ID]),
    ).resolves.toEqual({
      hidden_message_ids: [message.id, OTHER_MESSAGE_ID],
    });

    expect(mockDelete.mock.calls[0]).toEqual([
      `/trips/${message.trip_id}/chat/messages/${message.id}`,
      { data: { mode: 'for_me' }, signal: undefined },
    ]);
    expect(mockPost).toHaveBeenCalledWith(
      `/trips/${message.trip_id}/chat/messages/hide`,
      { message_ids: [message.id, OTHER_MESSAGE_ID] },
      { signal: undefined },
    );
  });

  it('canonicalizes and exactly binds a reordered bulk-hide response to the requested set', async () => {
    const firstId = 'a1111111-b111-4111-8111-c11111111111';
    const secondId = 'a2222222-b222-4222-8222-c22222222222';
    mockPost.mockResolvedValueOnce({
      data: {
        hidden_message_ids: [secondId.toUpperCase(), firstId],
      },
    } as never);

    await expect(
      hideChatMessages(message.trip_id, [
        firstId.toUpperCase(),
        secondId.toUpperCase(),
      ]),
    ).resolves.toEqual({ hidden_message_ids: [secondId, firstId] });
    expect(mockPost).toHaveBeenCalledWith(
      `/trips/${message.trip_id}/chat/messages/hide`,
      { message_ids: [firstId, secondId] },
      { signal: undefined },
    );
  });

  it.each([
    ['empty', []],
    ['subset', ['a1111111-b111-4111-8111-c11111111111']],
    [
      'extra',
      [
        'a1111111-b111-4111-8111-c11111111111',
        'a2222222-b222-4222-8222-c22222222222',
        'a3333333-b333-4333-8333-c33333333333',
      ],
    ],
    [
      'wrong',
      [
        'a3333333-b333-4333-8333-c33333333333',
        'a4444444-b444-4444-8444-c44444444444',
      ],
    ],
  ] as const)(
    'rejects a bulk-hide response with an %s id set',
    async (_label, hiddenMessageIds) => {
      const requestedIds = [
        'a1111111-b111-4111-8111-c11111111111',
        'a2222222-b222-4222-8222-c22222222222',
      ];
      mockPost.mockResolvedValueOnce({
        data: { hidden_message_ids: hiddenMessageIds },
      } as never);

      await expect(
        hideChatMessages(message.trip_id, requestedIds),
      ).rejects.toThrow('The chat server returned an invalid response.');
    },
  );

  it('rejects canonically duplicate bulk-hide request ids before transport', async () => {
    const messageId = 'a1111111-b111-4111-8111-c11111111111';

    await expect(
      hideChatMessages(message.trip_id, [messageId, messageId.toUpperCase()]),
    ).rejects.toThrow('Bulk hide message ids must be unique UUIDs.');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects an empty for_me hidden-id result', async () => {
    mockDelete.mockResolvedValueOnce({
      data: { hidden_message_ids: [] },
    } as never);

    await expect(
      deleteChatMessage(message.trip_id, message.id, 'for_me'),
    ).rejects.toThrow('The chat server returned an invalid response.');
  });

  it('canonicalizes an uppercase for_me message id before request and comparison', async () => {
    const canonicalMessageId = 'a1111111-b111-4111-8111-c11111111111';
    mockDelete.mockResolvedValueOnce({
      data: { hidden_message_ids: [canonicalMessageId] },
    } as never);

    await expect(
      deleteChatMessage(
        message.trip_id,
        canonicalMessageId.toUpperCase(),
        'for_me',
      ),
    ).resolves.toEqual({
      mode: 'for_me',
      hidden_message_ids: [canonicalMessageId],
    });
    expect(mockDelete).toHaveBeenCalledWith(
      `/trips/${message.trip_id}/chat/messages/${canonicalMessageId}`,
      { data: { mode: 'for_me' }, signal: undefined },
    );
  });

  it('canonicalizes an uppercase for_everyone message id before request and comparison', async () => {
    const canonicalMessageId = 'a1111111-b111-4111-8111-c11111111111';
    mockDelete.mockResolvedValueOnce({
      data: {
        message: {
          ...message,
          id: canonicalMessageId,
          content: '',
          is_deleted_for_everyone: true,
        },
      },
    } as never);

    await expect(
      deleteChatMessage(
        message.trip_id,
        canonicalMessageId.toUpperCase(),
        'for_everyone',
      ),
    ).resolves.toMatchObject({
      mode: 'for_everyone',
      message: { id: canonicalMessageId, is_deleted_for_everyone: true },
    });
    expect(mockDelete).toHaveBeenCalledWith(
      `/trips/${message.trip_id}/chat/messages/${canonicalMessageId}`,
      { data: { mode: 'for_everyone' }, signal: undefined },
    );
  });

  it.each([
    [
      'for_me with a contradictory message',
      'for_me',
      { hidden_message_ids: [message.id], message },
    ],
    [
      'for_me with another message id',
      'for_me',
      { hidden_message_ids: ['77777777-7777-4777-8777-777777777777'] },
    ],
    ['for_me with neither variant', 'for_me', {}],
    [
      'for_everyone with contradictory hidden ids',
      'for_everyone',
      {
        hidden_message_ids: [message.id],
        message: { ...message, is_deleted_for_everyone: true },
      },
    ],
    [
      'for_everyone for another message',
      'for_everyone',
      {
        message: {
          ...message,
          id: '88888888-8888-4888-8888-888888888888',
          is_deleted_for_everyone: true,
        },
      },
    ],
    [
      'for_everyone for another trip',
      'for_everyone',
      {
        message: {
          ...message,
          trip_id: OTHER_TRIP_ID,
          is_deleted_for_everyone: true,
        },
      },
    ],
    [
      'for_everyone without a tombstone',
      'for_everyone',
      { message },
    ],
    ['for_everyone with neither variant', 'for_everyone', {}],
  ] as const)(
    'rejects an invalid delete envelope: %s',
    async (_label, mode, data) => {
      mockDelete.mockResolvedValueOnce({ data } as never);

      await expect(
        deleteChatMessage(message.trip_id, message.id, mode),
      ).rejects.toThrow('The chat server returned an invalid response.');
    },
  );

  it('adds and removes only allowed reactions and safely encodes emoji paths', async () => {
    const added = {
      reactions: message.reactions,
      change_sequence: 8,
      updated_at: '2026-08-09T01:00:02+00:00',
    };
    const removed = {
      reactions: [],
      change_sequence: 9,
      updated_at: '2026-08-09T01:00:03+00:00',
    };
    mockPost.mockResolvedValue({ data: added } as never);
    mockDelete.mockResolvedValue({ data: removed } as never);

    await expect(
      addChatReaction(message.trip_id, message.id, '👍'),
    ).resolves.toEqual(added);
    await expect(
      removeChatReaction(message.trip_id, message.id, '❤️'),
    ).resolves.toEqual(removed);

    expect(mockPost).toHaveBeenCalledWith(
      `/trips/${message.trip_id}/chat/messages/${message.id}/reactions`,
      { emoji: '👍' },
      { signal: undefined },
    );
    expect(mockDelete).toHaveBeenCalledWith(
      `/trips/${message.trip_id}/chat/messages/${message.id}/reactions/%E2%9D%A4%EF%B8%8F`,
      { signal: undefined },
    );
  });

  it('fails closed when a reaction response omits valid sequence authority', async () => {
    mockPost.mockResolvedValue({
      data: {
        reactions: [],
        change_sequence: -1,
        updated_at: '2026-08-09T01:00:02+00:00',
      },
    } as never);
    mockDelete.mockResolvedValue({
      data: { reactions: [], change_sequence: 8 },
    } as never);

    await expect(
      addChatReaction(message.trip_id, message.id, '👍'),
    ).rejects.toThrow('The chat server returned an invalid response.');
    await expect(
      removeChatReaction(message.trip_id, message.id, '👍'),
    ).rejects.toThrow('The chat server returned an invalid response.');
  });

  it('rejects client pagination and bulk-hide values outside server ceilings', async () => {
    await expect(
      listChatHistory(message.trip_id, { limit: 101 }),
    ).rejects.toThrow('History limit must be an integer from 1 to 100.');
    await expect(
      gapFillChatMessages(message.trip_id, { since: message.id, limit: 201 }),
    ).rejects.toThrow('Gap-fill limit must be an integer from 1 to 200.');
    await expect(
      syncChangedChatMessages(message.trip_id, {
        changedSince: message.change_sequence,
        limit: 0,
      }),
    ).rejects.toThrow('Change-sync limit must be an integer from 1 to 200.');
    await expect(hideChatMessages(message.trip_id, [])).rejects.toThrow(
      'Bulk hide requires 1 to 100 message ids.',
    );
    await expect(
      hideChatMessages(
        message.trip_id,
        Array.from({ length: 101 }, (_, index) => `message-${index}`),
      ),
    ).rejects.toThrow('Bulk hide requires 1 to 100 message ids.');
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('fails closed when a REST message violates the shipped wire shape', async () => {
    mockGet.mockResolvedValue({
      data: {
        results: [{ ...message, sender: { ...message.sender, id: 42 } }],
        next_cursor: null,
      },
    } as never);

    await expect(listChatHistory(message.trip_id)).rejects.toThrow(
      'The chat server returned an invalid response.',
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'fails closed for invalid message change_sequence %s',
    async (changeSequence) => {
      mockGet.mockResolvedValue({
        data: {
          results: [{ ...message, change_sequence: changeSequence }],
          next_cursor: null,
        },
      } as never);

      await expect(listChatHistory(message.trip_id)).rejects.toThrow(
        'The chat server returned an invalid response.',
      );
    },
  );

  it('canonicalizes uppercase valid trip UUIDs before making a request', async () => {
    mockGet.mockResolvedValue({ data: { results: [], next_cursor: null } } as never);

    await listChatHistory(message.trip_id.toUpperCase());

    expect(mockGet).toHaveBeenCalledWith(
      `/trips/${message.trip_id}/chat/messages`,
      expect.any(Object),
    );
  });

  it('rejects malformed trip ids and change cursors before making a request', async () => {
    await expect(listChatHistory('not-a-uuid')).rejects.toThrow(
      'Trip id must be a valid UUID.',
    );
    await expect(
      syncChangedChatMessages(message.trip_id, { changedSince: -1 }),
    ).rejects.toThrow('Change-sync cursor must be a nonnegative safe integer.');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('preserves server detail, code, status, and Retry-After for a throttled send', () => {
    const normalized = normalizeChatApiError(
      axiosError(
        429,
        {
          detail: 'Request was throttled. Expected available in 42 seconds.',
          error_code: 'THROTTLED',
        },
        { 'retry-after': '42' },
      ),
    );

    expect(normalized).toEqual({
      kind: 'throttled',
      message: 'Request was throttled. Expected available in 42 seconds.',
      errorCode: 'THROTTLED',
      status: 429,
      retryAfterMs: 42_000,
      fieldErrors: null,
    });
  });

  it('does not infer terminal or access loss from status codes without an exact code', () => {
    expect(
      normalizeChatApiError(
        axiosError(409, {
          detail: 'You already reacted with this emoji.',
          error_code: 'REACTION_DUPLICATE',
        }),
      ),
    ).toMatchObject({
      message: 'You already reacted with this emoji.',
      errorCode: 'REACTION_DUPLICATE',
      status: 409,
      retryAfterMs: null,
    });
  });
});
