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
    jest.clearAllMocks();
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

  it('distinguishes a newly created send from an idempotent replay', async () => {
    mockPost
      .mockResolvedValueOnce({ data: { message }, status: 201 } as never)
      .mockResolvedValueOnce({ data: { message }, status: 200 } as never);

    const input = {
      content: 'Hello once',
      clientMessageId: '44444444-4444-4444-8444-444444444444',
    };
    await expect(sendChatMessage(message.trip_id, input)).resolves.toEqual({
      message,
      disposition: 'created',
    });
    await expect(sendChatMessage(message.trip_id, input)).resolves.toEqual({
      message,
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

  it('maps single delete modes and bulk hide to their exact response variants', async () => {
    mockDelete
      .mockResolvedValueOnce({
        data: { hidden_message_ids: [message.id] },
      } as never)
      .mockResolvedValueOnce({ data: { message } } as never);
    mockPost.mockResolvedValueOnce({
      data: { hidden_message_ids: [message.id, 'message-2'] },
    } as never);

    await expect(
      deleteChatMessage(message.trip_id, message.id, 'for_me'),
    ).resolves.toEqual({ mode: 'for_me', hidden_message_ids: [message.id] });
    await expect(
      deleteChatMessage(message.trip_id, message.id, 'for_everyone'),
    ).resolves.toEqual({ mode: 'for_everyone', message });
    await expect(
      hideChatMessages(message.trip_id, [message.id, 'message-2']),
    ).resolves.toEqual({ hidden_message_ids: [message.id, 'message-2'] });

    expect(mockDelete.mock.calls[0]).toEqual([
      `/trips/${message.trip_id}/chat/messages/${message.id}`,
      { data: { mode: 'for_me' }, signal: undefined },
    ]);
    expect(mockPost).toHaveBeenCalledWith(
      `/trips/${message.trip_id}/chat/messages/hide`,
      { message_ids: [message.id, 'message-2'] },
      { signal: undefined },
    );
  });

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
