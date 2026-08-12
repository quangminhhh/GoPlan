import {
  createTranscriptState,
  hasConfirmedClientId,
  selectLatestConfirmed,
  selectLatestChangeCursor,
  selectMessageById,
  selectMessageVersion,
  selectPendingByClientId,
  selectReactionBase,
  selectReactionLiveVersion,
  selectTranscriptMessages,
  transcriptReducer,
  type TranscriptState,
} from '../application/transcriptReducer';
import type {
  ChatApiFailure,
  ChatMessage,
  ReactionSummary,
} from '../types';

const RESOURCE_KEY = 'trip-1:member-1';

const failure: ChatApiFailure = {
  kind: 'network',
  message: 'Connection failed',
  errorCode: 'SEND_FAILED',
  status: null,
  retryAfterMs: null,
  fieldErrors: null,
};

const terminalFailure: ChatApiFailure = {
  ...failure,
  kind: 'message',
  message: 'Trip is read-only',
  errorCode: 'TRIP_TERMINAL',
  status: 409,
};

const accessUncertainFailure: ChatApiFailure = {
  ...failure,
  kind: 'message',
  message: 'Chat access is temporarily unavailable.',
  errorCode: 'CHAT_ACCESS_UNCERTAIN',
};

const mutationInterruptedFailure: ChatApiFailure = {
  ...failure,
  kind: 'message',
  message: 'A chat mutation was interrupted.',
  errorCode: 'CHAT_MUTATION_INTERRUPTED',
};

function reaction(
  emoji: ReactionSummary['emoji'],
  ids: readonly string[],
): ReactionSummary {
  return { emoji, count: ids.length, reacted_by_ids: ids };
}

function message(
  id: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    trip_id: 'trip-1',
    sender: {
      id: 'member-1',
      display_name: 'Member One',
      identify_tag: 'member-one',
      avatar_url: null,
    },
    sender_kind: 'USER',
    ai_status: null,
    content: `Message ${id}`,
    client_message_id: null,
    created_at: '2026-08-09T10:00:00.000Z',
    updated_at: '2026-08-09T10:00:00.000Z',
    change_sequence: 1,
    is_deleted_for_everyone: false,
    deleted_for_everyone_at: null,
    deleted_for_everyone_by_id: null,
    delete_for_everyone_until: '2026-08-09T10:15:00.000Z',
    can_delete_for_everyone: true,
    reactions: [],
    action_drafts: [],
    ...overrides,
  };
}

function initialWith(messages: readonly ChatMessage[]): TranscriptState {
  return transcriptReducer(createTranscriptState(RESOURCE_KEY), {
    type: 'INIT_RESOLVED',
    resourceKey: RESOURCE_KEY,
    messages,
    nextCursor: null,
    requestVersion: 0,
  });
}

describe('transcriptReducer', () => {
  it('creates isolated immutable collections and resource-scopes every action', () => {
    const first = createTranscriptState(RESOURCE_KEY);
    const second = createTranscriptState(RESOURCE_KEY);

    expect(first).toMatchObject({
      resourceKey: RESOURCE_KEY,
      version: 0,
      roomStatus: 'idle',
      terminalLocked: false,
    });
    expect(first.confirmed).not.toBe(second.confirmed);
    expect(first.pending).not.toBe(second.pending);
    expect(first.hidden).not.toBe(second.hidden);
    expect(first.reactionLiveVersions).not.toBe(second.reactionLiveVersions);

    const ignored = transcriptReducer(first, {
      type: 'UPSERT',
      resourceKey: 'another-trip',
      messages: [message('server-1')],
    });
    expect(ignored).toBe(first);
  });

  it('merges an initial page with one shared mutation version without mutating the prior maps', () => {
    const before = createTranscriptState(RESOURCE_KEY);
    const firstMessage = message('server-1');
    const secondMessage = message('server-2');

    const after = transcriptReducer(before, {
      type: 'INIT_RESOLVED',
      resourceKey: RESOURCE_KEY,
      messages: [firstMessage, secondMessage],
      nextCursor: 'older-cursor',
      requestVersion: before.version,
    });

    expect(after.roomStatus).toBe('ready');
    expect(after.version).toBe(1);
    expect(after.messageVersions.get(firstMessage.id)).toBe(1);
    expect(after.messageVersions.get(secondMessage.id)).toBe(1);
    expect(after.nextOlderCursor).toBe('older-cursor');
    expect(after.hasMoreOlder).toBe(true);
    expect(before.confirmed.size).toBe(0);
    expect(after.confirmed).not.toBe(before.confirmed);
    expect(after.messageVersions).not.toBe(before.messageVersions);
  });

  it('does not let a stale REST page overwrite a newer live row but still admits unknown rows', () => {
    const original = message('server-1', { content: 'REST original' });
    const initialized = initialWith([original]);
    const requestVersion = initialized.version;
    const pushed = message('server-1', {
      content: 'Live version',
      updated_at: '2026-08-09T10:01:00.000Z',
      change_sequence: 2,
    });
    const afterPush = transcriptReducer(initialized, {
      type: 'UPSERT',
      resourceKey: RESOURCE_KEY,
      messages: [pushed],
    });

    const afterStalePage = transcriptReducer(afterPush, {
      type: 'UPSERT',
      resourceKey: RESOURCE_KEY,
      messages: [
        message('server-1', { content: 'Stale REST version' }),
        message('server-2', { content: 'Previously unknown older row' }),
      ],
      requestVersion,
    });

    expect(afterStalePage.confirmed.get('server-1')?.content).toBe(
      'Live version',
    );
    expect(afterStalePage.confirmed.get('server-2')?.content).toBe(
      'Previously unknown older row',
    );
    expect(afterStalePage.messageVersions.get('server-1')).toBe(
      afterPush.messageVersions.get('server-1'),
    );
    expect(afterStalePage.messageVersions.get('server-2')).toBe(
      afterStalePage.version,
    );
  });

  it('uses change_sequence instead of timestamps or arrival order for full rows', () => {
    const current = message('server-1', {
      content: 'Sequence ten',
      change_sequence: 10,
      updated_at: '2026-08-09T12:00:00.000Z',
    });
    const initialized = initialWith([current]);
    const lower = transcriptReducer(initialized, {
      type: 'UPSERT',
      resourceKey: RESOURCE_KEY,
      messages: [
        message('server-1', {
          content: 'Lower sequence with later clock',
          change_sequence: 9,
          updated_at: '2026-08-10T12:00:00.000Z',
        }),
      ],
    });
    const equal = transcriptReducer(lower, {
      type: 'PATCH_KNOWN',
      resourceKey: RESOURCE_KEY,
      messages: [
        message('server-1', {
          content: 'Conflicting duplicate',
          change_sequence: 10,
          updated_at: '2026-08-11T12:00:00.000Z',
        }),
      ],
    });
    const higher = transcriptReducer(equal, {
      type: 'PATCH_KNOWN',
      resourceKey: RESOURCE_KEY,
      messages: [
        message('server-1', {
          content: 'Higher sequence with backward clock',
          change_sequence: 11,
          updated_at: '2026-08-08T12:00:00.000Z',
        }),
      ],
    });

    expect(lower).toBe(initialized);
    expect(equal).toBe(initialized);
    expect(higher.confirmed.get('server-1')).toMatchObject({
      content: 'Higher sequence with backward clock',
      change_sequence: 11,
      updated_at: '2026-08-08T12:00:00.000Z',
    });
  });

  it.each([
    ['live', undefined],
    ['REST', 1],
  ] as const)(
    'PATCH_KNOWN applies a %s patch only to messages already loaded',
    (_source, requestVersion) => {
      const initialized = initialWith([message('known')]);
      const action = {
        type: 'PATCH_KNOWN' as const,
        resourceKey: RESOURCE_KEY,
        messages: [
          message('known', { content: 'Patched', change_sequence: 2 }),
          message('unknown', { content: 'Must not appear' }),
        ],
        ...(requestVersion === undefined ? {} : { requestVersion }),
      };

      const after = transcriptReducer(initialized, action);

      expect(after.confirmed.get('known')?.content).toBe('Patched');
      expect(after.confirmed.has('unknown')).toBe(false);
    },
  );

  it('rejects a known REST patch that began before a local optimistic mutation', () => {
    const base = message('server-1', {
      reactions: [reaction('👍', ['member-2'])],
    });
    const initialized = initialWith([base]);
    const requestVersion = initialized.version;
    const startMessageVersion = selectMessageVersion(initialized, base.id);
    const optimistic = [reaction('❤️', ['member-1'])];
    const reacting = transcriptReducer(initialized, {
      type: 'REACTION_START',
      resourceKey: RESOURCE_KEY,
      messageId: base.id,
      operationId: 'reaction-1',
      optimisticReactions: optimistic,
    });

    const afterStalePatch = transcriptReducer(reacting, {
      type: 'PATCH_KNOWN',
      resourceKey: RESOURCE_KEY,
      messages: [message(base.id, { content: 'Stale snapshot' })],
      requestVersion,
    });

    expect(afterStalePatch).toBe(reacting);
    expect(selectMessageVersion(afterStalePatch, base.id)).toBeGreaterThan(
      startMessageVersion,
    );
    expect(selectMessageById(afterStalePatch, base.id)?.reactions).toEqual(
      optimistic,
    );
  });

  describe('optimistic send convergence', () => {
    const optimistic = message('optimistic:client-1', {
      client_message_id: 'client-1',
      content: 'Optimistic message',
    });
    const confirmed = message('server-1', {
      client_message_id: 'client-1',
      content: 'Confirmed message',
    });

    function addPending(): TranscriptState {
      return transcriptReducer(createTranscriptState(RESOURCE_KEY), {
        type: 'ADD_PENDING',
        resourceKey: RESOURCE_KEY,
        message: optimistic,
      });
    }

    it.each(['HTTP-first', 'WS-first'] as const)(
      'converges to one confirmed bubble when %s wins the race',
      (winner) => {
        const pending = addPending();
        const requestVersion = pending.pendingVersions.get('client-1') ?? 0;
        const first =
          winner === 'HTTP-first'
            ? transcriptReducer(pending, {
                type: 'CONFIRM_PENDING',
                resourceKey: RESOURCE_KEY,
                cid: 'client-1',
                message: confirmed,
                requestVersion,
              })
            : transcriptReducer(pending, {
                type: 'UPSERT',
                resourceKey: RESOURCE_KEY,
                messages: [confirmed],
              });
        const settled =
          winner === 'HTTP-first'
            ? transcriptReducer(first, {
                type: 'UPSERT',
                resourceKey: RESOURCE_KEY,
                messages: [confirmed],
              })
            : transcriptReducer(first, {
                type: 'CONFIRM_PENDING',
                resourceKey: RESOURCE_KEY,
                cid: 'client-1',
                message: confirmed,
                requestVersion,
              });

        expect(selectTranscriptMessages(settled)).toHaveLength(1);
        expect(selectTranscriptMessages(settled)[0]?.id).toBe('server-1');
        expect(settled.pendingClientIds.size).toBe(0);
        expect(settled.failedClientIds.size).toBe(0);
        expect(hasConfirmedClientId(settled, 'client-1')).toBe(true);
      },
    );

    it('ignores an HTTP failure that arrives after the WebSocket echo', () => {
      const pending = addPending();
      const requestVersion = pending.pendingVersions.get('client-1') ?? 0;
      const afterPush = transcriptReducer(pending, {
        type: 'UPSERT',
        resourceKey: RESOURCE_KEY,
        messages: [confirmed],
      });
      const afterFailure = transcriptReducer(afterPush, {
        type: 'FAIL_PENDING',
        resourceKey: RESOURCE_KEY,
        cid: 'client-1',
        error: failure,
        requestVersion,
      });

      expect(afterFailure).toBe(afterPush);
      expect(afterFailure.failedClientIds.size).toBe(0);
    });

    it('marks the current attempt failed but ignores the prior attempt after retry', () => {
      const pending = addPending();
      const firstRequestVersion =
        pending.pendingVersions.get('client-1') ?? 0;
      const firstFailure = transcriptReducer(pending, {
        type: 'FAIL_PENDING',
        resourceKey: RESOURCE_KEY,
        cid: 'client-1',
        error: failure,
        requestVersion: firstRequestVersion,
      });
      expect(firstFailure.failedClientIds.has('client-1')).toBe(true);
      expect(firstFailure.failedByClientId.get('client-1')).toBe(failure);

      const retrying = transcriptReducer(firstFailure, {
        type: 'RETRY_PENDING',
        resourceKey: RESOURCE_KEY,
        cid: 'client-1',
      });
      const retryRequestVersion =
        retrying.pendingVersions.get('client-1') ?? 0;
      const staleFirstFailure = transcriptReducer(retrying, {
        type: 'FAIL_PENDING',
        resourceKey: RESOURCE_KEY,
        cid: 'client-1',
        error: failure,
        requestVersion: firstRequestVersion,
      });

      expect(staleFirstFailure).toBe(retrying);
      expect(staleFirstFailure.failedClientIds.size).toBe(0);

      const currentFailure = transcriptReducer(staleFirstFailure, {
        type: 'FAIL_PENDING',
        resourceKey: RESOURCE_KEY,
        cid: 'client-1',
        error: failure,
        requestVersion: retryRequestVersion,
      });
      expect(currentFailure.failedClientIds.has('client-1')).toBe(true);
      expect(selectPendingByClientId(currentFailure, 'client-1')).toBe(
        optimistic,
      );
    });

    it('drops a blocked send without leaving a second retry authority', () => {
      const pending = addPending();
      const requestVersion = pending.pendingVersions.get('client-1') ?? 0;
      const throttled = { ...failure, kind: 'throttled' as const, status: 429 };
      const blocked = transcriptReducer(pending, {
        type: 'BLOCK_PENDING',
        resourceKey: RESOURCE_KEY,
        cid: 'client-1',
        error: throttled,
        requestVersion,
      });

      expect(blocked.pending.size).toBe(0);
      expect(blocked.failedClientIds.size).toBe(0);
      expect(blocked.mutationError).toBeNull();
    });

    it('clears stale mutation feedback on a new attempt and successful confirmation', () => {
      const withOldError = transcriptReducer(
        createTranscriptState(RESOURCE_KEY),
        {
          type: 'SET_MUTATION_ERROR',
          resourceKey: RESOURCE_KEY,
          messageId: null,
          error: failure,
        },
      );
      const pending = transcriptReducer(withOldError, {
        type: 'ADD_PENDING',
        resourceKey: RESOURCE_KEY,
        message: optimistic,
      });
      expect(pending.mutationError).toBeNull();

      const errorWhilePending = transcriptReducer(pending, {
        type: 'SET_MUTATION_ERROR',
        resourceKey: RESOURCE_KEY,
        messageId: null,
        error: failure,
      });
      const requestVersion =
        errorWhilePending.pendingVersions.get('client-1') ?? 0;
      const settled = transcriptReducer(errorWhilePending, {
        type: 'CONFIRM_PENDING',
        resourceKey: RESOURCE_KEY,
        cid: 'client-1',
        message: confirmed,
        requestVersion,
      });

      expect(settled.mutationError).toBeNull();
    });
  });

  it('hides rows immutably and suppresses both late live and REST resurrection', () => {
    const initialized = initialWith([message('server-1')]);
    const oldConfirmed = initialized.confirmed;
    const hidden = transcriptReducer(initialized, {
      type: 'HIDE_MESSAGES',
      resourceKey: RESOURCE_KEY,
      messageIds: ['server-1'],
      requestVersion: initialized.version,
    });

    expect(hidden.confirmed.has('server-1')).toBe(false);
    expect(hidden.hidden.has('server-1')).toBe(true);
    expect(oldConfirmed.has('server-1')).toBe(true);

    const afterLive = transcriptReducer(hidden, {
      type: 'UPSERT',
      resourceKey: RESOURCE_KEY,
      messages: [message('server-1', { content: 'Late push' })],
    });
    const afterRest = transcriptReducer(afterLive, {
      type: 'UPSERT',
      resourceKey: RESOURCE_KEY,
      messages: [message('server-1', { content: 'Late REST row' })],
      requestVersion: hidden.version,
    });
    expect(afterLive).toBe(hidden);
    expect(afterRest).toBe(hidden);
  });

  describe('reaction base and optimistic overlay reconciliation', () => {
    const baseReactions = [reaction('👍', ['member-2'])];
    const optimisticReactions = [reaction('❤️', ['member-1'])];
    const pushedReactions = [reaction('😂', ['member-2', 'member-3'])];
    const responseReactions = [reaction('😮', ['member-1'])];

    function startReaction(): {
      readonly start: TranscriptState;
      readonly reacting: TranscriptState;
      readonly startMessageVersion: number;
    } {
      const start = initialWith([
        message('server-1', { reactions: baseReactions }),
      ]);
      const startMessageVersion = selectMessageVersion(start, 'server-1');
      return {
        start,
        startMessageVersion,
        reacting: transcriptReducer(start, {
          type: 'REACTION_START',
          resourceKey: RESOURCE_KEY,
          messageId: 'server-1',
          operationId: 'operation-1',
          optimisticReactions,
        }),
      };
    }

    it('renders the overlay without overwriting the authoritative base', () => {
      const { start, reacting } = startReaction();

      expect(reacting.confirmed.get('server-1')?.reactions).toEqual(
        baseReactions,
      );
      expect(selectMessageById(reacting, 'server-1')?.reactions).toEqual(
        optimisticReactions,
      );
      expect(start.reactionOverlays.size).toBe(0);
      expect(reacting.pendingReactionMessageIds.has('server-1')).toBe(true);
    });

    it('rejects inverted and duplicate reaction snapshots but accepts a higher sequence with a backward clock', () => {
      const initialized = initialWith([
        message('server-1', {
          change_sequence: 10,
          updated_at: '2026-08-09T12:00:00.000Z',
        }),
      ]);
      const newest = transcriptReducer(initialized, {
        type: 'REACTION_PATCH',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        reactions: pushedReactions,
        changeSequence: 12,
        updatedAt: '2026-08-09T12:02:00.000Z',
      });
      const invertedOlder = transcriptReducer(newest, {
        type: 'REACTION_PATCH',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        reactions: responseReactions,
        changeSequence: 11,
        updatedAt: '2026-08-09T12:03:00.000Z',
      });
      const duplicate = transcriptReducer(invertedOlder, {
        type: 'REACTION_PATCH',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        reactions: responseReactions,
        changeSequence: 12,
        updatedAt: '2026-08-09T12:04:00.000Z',
      });
      const higherBackwardClock = transcriptReducer(duplicate, {
        type: 'REACTION_PATCH',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        reactions: responseReactions,
        changeSequence: 13,
        updatedAt: '2026-08-08T12:00:00.000Z',
      });

      expect(invertedOlder).toBe(newest);
      expect(duplicate).toBe(newest);
      expect(higherBackwardClock.confirmed.get('server-1')).toMatchObject({
        reactions: responseReactions,
        change_sequence: 13,
        updated_at: '2026-08-08T12:00:00.000Z',
      });
    });

    it('never applies a reaction patch to a tombstone', () => {
      const tombstone = message('server-1', {
        content: '',
        change_sequence: 20,
        is_deleted_for_everyone: true,
        deleted_for_everyone_at: '2026-08-09T12:00:00.000Z',
        reactions: [],
      });
      const initialized = initialWith([tombstone]);
      const afterLateReaction = transcriptReducer(initialized, {
        type: 'REACTION_PATCH',
        resourceKey: RESOURCE_KEY,
        messageId: tombstone.id,
        reactions: pushedReactions,
        changeSequence: 21,
        updatedAt: '2026-08-09T12:01:00.000Z',
      });

      expect(afterLateReaction).toBe(initialized);
      expect(afterLateReaction.confirmed.get(tombstone.id)).toBe(tombstone);
    });

    it('keeps an overlay over a newer WS base, then rolls failure back to that latest base', () => {
      const { reacting, startMessageVersion } = startReaction();
      const afterPush = transcriptReducer(reacting, {
        type: 'REACTION_PATCH',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        reactions: pushedReactions,
        changeSequence: 2,
        updatedAt: '2026-08-09T10:01:00.000Z',
      });
      expect(selectMessageById(afterPush, 'server-1')?.reactions).toEqual(
        optimisticReactions,
      );
      expect(afterPush.reactionBase.get('server-1')).toEqual(pushedReactions);

      const afterFailure = transcriptReducer(afterPush, {
        type: 'REACTION_FAIL',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        operationId: 'operation-1',
        error: failure,
        requestVersion: reacting.version,
        startMessageVersion,
      });

      expect(selectMessageById(afterFailure, 'server-1')?.reactions).toEqual(
        pushedReactions,
      );
      expect(afterFailure.reactionOverlays.size).toBe(0);
      expect(afterFailure.mutationError?.error).toBe(failure);
      expect(afterPush.reactionOverlays.has('server-1')).toBe(true);
    });

    it('commits REST success when no newer base exists', () => {
      const { reacting, startMessageVersion } = startReaction();
      const settled = transcriptReducer(reacting, {
        type: 'REACTION_SUCCESS',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        operationId: 'operation-1',
        reactions: responseReactions,
        changeSequence: 2,
        updatedAt: '2026-08-09T10:01:00.000Z',
        requestVersion: reacting.version,
        startMessageVersion,
      });

      expect(selectMessageById(settled, 'server-1')?.reactions).toEqual(
        responseReactions,
      );
      expect(settled.reactionBase.get('server-1')).toEqual(responseReactions);
      expect(settled.pendingReactionMessageIds.size).toBe(0);
    });

    it('does not let a generic REST base suppress authoritative HTTP success', () => {
      const { reacting, startMessageVersion } = startReaction();
      const staleRestReactions = [reaction('👍', ['member-2', 'member-3'])];
      const afterRestPatch = transcriptReducer(reacting, {
        type: 'PATCH_KNOWN',
        resourceKey: RESOURCE_KEY,
        messages: [
          message('server-1', {
            reactions: staleRestReactions,
            change_sequence: 2,
          }),
        ],
        requestVersion: reacting.version,
      });

      expect(selectReactionBase(afterRestPatch, 'server-1')).toEqual(
        staleRestReactions,
      );
      expect(selectReactionLiveVersion(afterRestPatch, 'server-1')).toBe(0);

      const settled = transcriptReducer(afterRestPatch, {
        type: 'REACTION_SUCCESS',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        operationId: 'operation-1',
        reactions: responseReactions,
        changeSequence: 3,
        updatedAt: '2026-08-09T10:02:00.000Z',
        requestVersion: reacting.version,
        startMessageVersion,
      });

      expect(selectMessageById(settled, 'server-1')?.reactions).toEqual(
        responseReactions,
      );
      expect(selectReactionBase(settled, 'server-1')).toEqual(
        responseReactions,
      );
      expect(settled.pendingReactionMessageIds.size).toBe(0);
    });

    it('settles an overlay without overwriting a newer WS base with stale REST success', () => {
      const { reacting, startMessageVersion } = startReaction();
      const afterPush = transcriptReducer(reacting, {
        type: 'REACTION_PATCH',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        reactions: pushedReactions,
        changeSequence: 3,
        updatedAt: '2026-08-09T10:03:00.000Z',
      });
      const settled = transcriptReducer(afterPush, {
        type: 'REACTION_SUCCESS',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        operationId: 'operation-1',
        reactions: responseReactions,
        changeSequence: 2,
        updatedAt: '2026-08-09T10:02:00.000Z',
        requestVersion: reacting.version,
        startMessageVersion,
      });

      expect(selectMessageById(settled, 'server-1')?.reactions).toEqual(
        pushedReactions,
      );
      expect(settled.reactionBase.get('server-1')).toEqual(pushedReactions);
      expect(selectReactionBase(settled, 'server-1')).toEqual(pushedReactions);
      expect(selectReactionLiveVersion(settled, 'server-1')).toBe(
        afterPush.version,
      );
    });

    it('ignores a late failure from an older reaction operation', () => {
      const { reacting, startMessageVersion } = startReaction();
      const firstSettled = transcriptReducer(reacting, {
        type: 'REACTION_SUCCESS',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        operationId: 'operation-1',
        reactions: responseReactions,
        changeSequence: 2,
        updatedAt: '2026-08-09T10:01:00.000Z',
        requestVersion: reacting.version,
        startMessageVersion,
      });
      const secondStartVersion = selectMessageVersion(
        firstSettled,
        'server-1',
      );
      const secondReaction = transcriptReducer(firstSettled, {
        type: 'REACTION_START',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        operationId: 'operation-2',
        optimisticReactions,
      });
      const afterLateFailure = transcriptReducer(secondReaction, {
        type: 'REACTION_FAIL',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        operationId: 'operation-1',
        error: failure,
        requestVersion: secondReaction.version,
        startMessageVersion: secondStartVersion,
      });

      expect(afterLateFailure).toBe(secondReaction);
      expect(
        afterLateFailure.reactionOverlays.get('server-1')?.operationId,
      ).toBe('operation-2');
    });

    it('cancels a reaction overlay when a full deletion patch arrives', () => {
      const { reacting } = startReaction();
      const deleted = message('server-1', {
        content: '',
        change_sequence: 2,
        is_deleted_for_everyone: true,
        deleted_for_everyone_at: '2026-08-09T10:05:00.000Z',
        can_delete_for_everyone: false,
        reactions: [],
      });
      const afterDelete = transcriptReducer(reacting, {
        type: 'PATCH_KNOWN',
        resourceKey: RESOURCE_KEY,
        messages: [deleted],
      });

      expect(afterDelete.reactionOverlays.has('server-1')).toBe(false);
      expect(afterDelete.pendingReactionMessageIds.has('server-1')).toBe(
        false,
      );
      expect(afterDelete.confirmed.get('server-1')).toBe(deleted);
    });
  });

  describe('authoritative delete convergence', () => {
    const tombstone = message('server-1', {
      content: '',
      updated_at: '2026-08-09T10:05:00.000Z',
      change_sequence: 3,
      is_deleted_for_everyone: true,
      deleted_for_everyone_at: '2026-08-09T10:05:00.000Z',
      deleted_for_everyone_by_id: 'member-1',
      delete_for_everyone_until: null,
      can_delete_for_everyone: false,
      reactions: [],
    });

    it('applies an active irreversible tombstone despite intervening row versions', () => {
      let state = initialWith([
        message('server-1', { reactions: [reaction('👍', ['member-2'])] }),
      ]);
      state = transcriptReducer(state, {
        type: 'REACTION_START',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        operationId: 'operation-1',
        optimisticReactions: [reaction('❤️', ['member-1'])],
      });
      state = transcriptReducer(state, {
        type: 'DELETE_START',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
      });
      const deleteRequestVersion = state.version;
      state = transcriptReducer(state, {
        type: 'REACTION_PATCH',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        reactions: [reaction('😂', ['member-2', 'member-3'])],
        changeSequence: 2,
        updatedAt: '2026-08-09T10:04:00.000Z',
      });
      state = transcriptReducer(state, {
        type: 'SET_MUTATION_ERROR',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
        error: failure,
      });
      expect(selectMessageVersion(state, 'server-1')).toBeGreaterThan(
        deleteRequestVersion,
      );
      const beforeDeleteSuccess = state;

      const deleted = transcriptReducer(state, {
        type: 'DELETE_SUCCESS',
        resourceKey: RESOURCE_KEY,
        message: tombstone,
        requestVersion: deleteRequestVersion,
      });

      expect(deleted.confirmed.get('server-1')).toBe(tombstone);
      expect(beforeDeleteSuccess.confirmed.get('server-1')).not.toBe(tombstone);
      expect(deleted.confirmed).not.toBe(beforeDeleteSuccess.confirmed);
      expect(deleted.messageVersions).not.toBe(
        beforeDeleteSuccess.messageVersions,
      );
      expect(deleted.reactionBase).not.toBe(beforeDeleteSuccess.reactionBase);
      expect(deleted.pendingDeleteMessageIds.has('server-1')).toBe(false);
      expect(beforeDeleteSuccess.pendingDeleteMessageIds.has('server-1')).toBe(
        true,
      );
      expect(deleted.pendingReactionMessageIds.has('server-1')).toBe(false);
      expect(deleted.reactionOverlays.has('server-1')).toBe(false);
      expect(selectReactionBase(deleted, 'server-1')).toEqual([]);
      expect(selectReactionLiveVersion(deleted, 'server-1')).toBe(0);
      expect(deleted.mutationError).toBeNull();
    });

    it('ignores a delete success without its active operation or a tombstone', () => {
      const initialized = initialWith([message('server-1')]);
      const withoutOperation = transcriptReducer(initialized, {
        type: 'DELETE_SUCCESS',
        resourceKey: RESOURCE_KEY,
        message: tombstone,
        requestVersion: initialized.version,
      });
      const deleting = transcriptReducer(initialized, {
        type: 'DELETE_START',
        resourceKey: RESOURCE_KEY,
        messageId: 'server-1',
      });
      const malformed = transcriptReducer(deleting, {
        type: 'DELETE_SUCCESS',
        resourceKey: RESOURCE_KEY,
        message: message('server-1'),
        requestVersion: deleting.version,
      });

      expect(withoutOperation).toBe(initialized);
      expect(malformed).toBe(deleting);
    });
  });

  it('locks terminal trips read-only while preserving and continuing to update history', () => {
    let state = initialWith([message('server-1')]);
    state = transcriptReducer(state, {
      type: 'ADD_PENDING',
      resourceKey: RESOURCE_KEY,
      message: message('optimistic:client-1', {
        client_message_id: 'client-1',
      }),
    });
    state = transcriptReducer(state, {
      type: 'FAIL_PENDING',
      resourceKey: RESOURCE_KEY,
      cid: 'client-1',
      error: failure,
      requestVersion: state.pendingVersions.get('client-1') ?? state.version,
    });
    const startMessageVersion = selectMessageVersion(state, 'server-1');
    state = transcriptReducer(state, {
      type: 'REACTION_START',
      resourceKey: RESOURCE_KEY,
      messageId: 'server-1',
      operationId: 'operation-1',
      optimisticReactions: [reaction('❤️', ['member-1'])],
    });
    state = transcriptReducer(state, {
      type: 'DELETE_START',
      resourceKey: RESOURCE_KEY,
      messageId: 'server-1',
    });
    state = transcriptReducer(state, {
      type: 'HIDE_START',
      resourceKey: RESOURCE_KEY,
    });
    state = transcriptReducer(state, {
      type: 'SET_MUTATION_ERROR',
      resourceKey: RESOURCE_KEY,
      messageId: 'server-1',
      error: failure,
    });
    expect(state.failedClientIds.has('client-1')).toBe(true);
    expect(state.pendingReactionMessageIds.has('server-1')).toBe(true);
    expect(state.pendingDeleteMessageIds.has('server-1')).toBe(true);
    expect(state.isHidingMessages).toBe(true);
    expect(state.mutationError?.error).toBe(failure);
    const locked = transcriptReducer(state, {
      type: 'TERMINAL_LOCK',
      resourceKey: RESOURCE_KEY,
      error: terminalFailure,
      requestVersion: state.version,
    });

    expect(locked.terminalLocked).toBe(true);
    expect(locked.confirmed.has('server-1')).toBe(true);
    expect(locked.pending.size).toBe(0);
    expect(locked.failedClientIds.size).toBe(0);
    expect(locked.failedByClientId.size).toBe(0);
    expect(locked.reactionOverlays.size).toBe(0);
    expect(locked.pendingDeleteMessageIds.size).toBe(0);
    expect(locked.isHidingMessages).toBe(false);
    expect(locked.mutationError).toBeNull();
    expect(selectMessageVersion(locked, 'server-1')).toBeGreaterThan(
      startMessageVersion,
    );

    const rejectedPending = transcriptReducer(locked, {
      type: 'ADD_PENDING',
      resourceKey: RESOURCE_KEY,
      message: message('optimistic:client-2', {
        client_message_id: 'client-2',
      }),
    });
    const rejectedReaction = transcriptReducer(locked, {
      type: 'REACTION_START',
      resourceKey: RESOURCE_KEY,
      messageId: 'server-1',
      operationId: 'operation-2',
      optimisticReactions: [],
    });
    expect(rejectedPending).toBe(locked);
    expect(rejectedReaction).toBe(locked);

    const afterLiveHistoryUpdate = transcriptReducer(locked, {
      type: 'UPSERT',
      resourceKey: RESOURCE_KEY,
      messages: [message('server-2')],
    });
    expect(afterLiveHistoryUpdate.confirmed.has('server-2')).toBe(true);
    expect(afterLiveHistoryUpdate.terminalLocked).toBe(true);
  });

  it('suspends only active work while preserving confirmed history and retryable sends', () => {
    let state = initialWith([message('server-1'), message('server-2')]);
    state = transcriptReducer(state, {
      type: 'ADD_PENDING',
      resourceKey: RESOURCE_KEY,
      message: message('optimistic:failed', {
        client_message_id: 'client-failed',
        content: 'Already retryable',
      }),
    });
    state = transcriptReducer(state, {
      type: 'FAIL_PENDING',
      resourceKey: RESOURCE_KEY,
      cid: 'client-failed',
      error: failure,
      requestVersion:
        state.pendingVersions.get('client-failed') ?? state.version,
    });
    state = transcriptReducer(state, {
      type: 'ADD_PENDING',
      resourceKey: RESOURCE_KEY,
      message: message('optimistic:active', {
        client_message_id: 'client-active',
        content: 'Retry after access recovers',
      }),
    });
    state = transcriptReducer(state, {
      type: 'REACTION_START',
      resourceKey: RESOURCE_KEY,
      messageId: 'server-1',
      operationId: 'reaction-active',
      optimisticReactions: [reaction('👍', ['member-1'])],
    });
    const reactionOverlayVersion = selectMessageVersion(state, 'server-1');
    state = transcriptReducer(state, {
      type: 'DELETE_START',
      resourceKey: RESOURCE_KEY,
      messageId: 'server-2',
    });
    state = transcriptReducer(state, {
      type: 'HIDE_START',
      resourceKey: RESOURCE_KEY,
    });
    state = transcriptReducer(state, {
      type: 'OLDER_START',
      resourceKey: RESOURCE_KEY,
    });
    state = transcriptReducer(state, {
      type: 'CATCHUP_PHASE',
      resourceKey: RESOURCE_KEY,
      phase: 'update',
    });

    const confirmed = state.confirmed;
    const suspended = transcriptReducer(state, {
      type: 'SUSPEND_ACCESS',
      resourceKey: RESOURCE_KEY,
      sendError: accessUncertainFailure,
      mutationError: mutationInterruptedFailure,
    });

    expect(suspended.confirmed).toBe(confirmed);
    expect(suspended.roomStatus).toBe('ready');
    expect(suspended.pending.size).toBe(2);
    expect(suspended.pendingClientIds).toEqual(
      new Set(['client-failed', 'client-active']),
    );
    expect(suspended.failedClientIds).toEqual(
      new Set(['client-failed', 'client-active']),
    );
    expect(suspended.failedByClientId.get('client-failed')).toBe(failure);
    expect(suspended.failedByClientId.get('client-active')).toBe(
      accessUncertainFailure,
    );
    expect(suspended.pendingVersions.get('client-active')).toBe(
      suspended.version,
    );
    expect(suspended.reactionOverlays.size).toBe(0);
    expect(suspended.pendingReactionMessageIds.size).toBe(0);
    expect(suspended.pendingDeleteMessageIds.size).toBe(0);
    expect(suspended.isHidingMessages).toBe(false);
    expect(suspended.isLoadingOlder).toBe(false);
    expect(suspended.isGapFilling).toBe(false);
    expect(suspended.isUpdating).toBe(false);
    expect(suspended.mutationError).toEqual({
      messageId: null,
      error: mutationInterruptedFailure,
    });
    expect(selectMessageVersion(suspended, 'server-1')).toBeGreaterThan(
      reactionOverlayVersion,
    );

    const repeated = transcriptReducer(suspended, {
      type: 'SUSPEND_ACCESS',
      resourceKey: RESOURCE_KEY,
      sendError: accessUncertainFailure,
      mutationError: mutationInterruptedFailure,
    });
    const wrongResource = transcriptReducer(suspended, {
      type: 'SUSPEND_ACCESS',
      resourceKey: 'another-trip',
      sendError: accessUncertainFailure,
      mutationError: mutationInterruptedFailure,
    });
    expect(repeated).toBe(suspended);
    expect(wrongResource).toBe(suspended);
  });

  it('clears every transcript surface on kick and suppresses all late work until RESET', () => {
    let state = initialWith([message('server-1')]);
    state = transcriptReducer(state, {
      type: 'ADD_PENDING',
      resourceKey: RESOURCE_KEY,
      message: message('optimistic:client-1', {
        client_message_id: 'client-1',
      }),
    });
    state = transcriptReducer(state, {
      type: 'DELETE_START',
      resourceKey: RESOURCE_KEY,
      messageId: 'server-1',
    });
    const kicked = transcriptReducer(state, {
      type: 'KICKED',
      resourceKey: RESOURCE_KEY,
    });

    expect(kicked.roomStatus).toBe('kicked');
    expect(kicked.confirmed.size).toBe(0);
    expect(kicked.pending.size).toBe(0);
    expect(kicked.hidden.size).toBe(0);
    expect(kicked.pendingDeleteMessageIds.size).toBe(0);

    const ignored = transcriptReducer(kicked, {
      type: 'UPSERT',
      resourceKey: RESOURCE_KEY,
      messages: [message('late-server-row')],
    });
    expect(ignored).toBe(kicked);

    const reset = transcriptReducer(kicked, {
      type: 'RESET',
      resourceKey: 'trip-2:member-1',
    });
    expect(reset.resourceKey).toBe('trip-2:member-1');
    expect(reset.roomStatus).toBe('idle');
    expect(reset.version).toBe(0);
  });

  it('tracks catch-up and mutation busy surfaces without mutating prior sets', () => {
    const initialized = initialWith([message('server-1')]);
    const deleting = transcriptReducer(initialized, {
      type: 'DELETE_START',
      resourceKey: RESOURCE_KEY,
      messageId: 'server-1',
    });
    const gap = transcriptReducer(deleting, {
      type: 'CATCHUP_PHASE',
      resourceKey: RESOURCE_KEY,
      phase: 'gap',
    });
    const updating = transcriptReducer(gap, {
      type: 'CATCHUP_PHASE',
      resourceKey: RESOURCE_KEY,
      phase: 'update',
    });
    const ended = transcriptReducer(updating, {
      type: 'DELETE_END',
      resourceKey: RESOURCE_KEY,
      messageId: 'server-1',
      requestVersion: updating.version,
    });

    expect(initialized.pendingDeleteMessageIds.size).toBe(0);
    expect(deleting.pendingDeleteMessageIds.has('server-1')).toBe(true);
    expect(gap.isGapFilling).toBe(true);
    expect(gap.isUpdating).toBe(false);
    expect(updating.isGapFilling).toBe(false);
    expect(updating.isUpdating).toBe(true);
    expect(ended.pendingDeleteMessageIds.size).toBe(0);
  });

  it('selects effective transcript rows and cursors in stable ascending order', () => {
    const later = message('server-z', {
      client_message_id: 'deduped-client',
      created_at: '2026-08-09T11:00:00.000Z',
      updated_at: '2026-08-09T12:00:00.000Z',
      change_sequence: 30,
    });
    const earlierB = message('server-b', {
      created_at: '2026-08-09T09:00:00.000Z',
      updated_at: '2026-08-09T10:30:00.000Z',
      change_sequence: 20,
    });
    const earlierA = message('server-a', {
      created_at: '2026-08-09T09:00:00.000Z',
      updated_at: '2026-08-09T10:30:00.000Z',
      change_sequence: 10,
    });
    let state = initialWith([later, earlierB, earlierA]);
    state = transcriptReducer(state, {
      type: 'ADD_PENDING',
      resourceKey: RESOURCE_KEY,
      message: message('optimistic:pending', {
        client_message_id: 'pending-client',
        created_at: '2026-08-09T10:00:00.000Z',
      }),
    });
    state = transcriptReducer(state, {
      type: 'ADD_PENDING',
      resourceKey: RESOURCE_KEY,
      message: message('optimistic:duplicate', {
        client_message_id: 'deduped-client',
        created_at: '2026-08-09T13:00:00.000Z',
      }),
    });

    expect(selectTranscriptMessages(state).map((item) => item.id)).toEqual([
      'server-a',
      'server-b',
      'optimistic:pending',
      'server-z',
    ]);
    expect(selectLatestConfirmed(state)?.id).toBe('server-z');
    expect(selectLatestChangeCursor(state)).toEqual({
      changeSequence: 30,
      id: 'server-z',
    });
    expect(selectMessageById(state, 'optimistic:pending')?.id).toBe(
      'optimistic:pending',
    );
  });
});
