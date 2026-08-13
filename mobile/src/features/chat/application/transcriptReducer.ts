import type {
  ChatApiFailure,
  ChatMessage,
  ReactionSummary,
} from '../types';
import {
  aiActionDraftSourceIdentity,
  parseAIActionDraft,
  type AIActionDraft,
} from '../ai/drafts';

export type ChatRoomStatus = 'idle' | 'loading' | 'ready' | 'error' | 'kicked';

export interface ChangeSyncCursor {
  readonly changeSequence: number;
  readonly id: string;
}

export interface TranscriptReactionOverlay {
  readonly operationId: string;
  readonly optimisticReactions: readonly ReactionSummary[];
  readonly startMessageVersion: number;
}

export interface TranscriptMutationError {
  readonly messageId: string | null;
  readonly error: ChatApiFailure;
}

export interface TranscriptAIDraftOverlay {
  readonly draft: AIActionDraft;
  readonly projectedIdentity: string;
  readonly priorSourceIdentities: ReadonlySet<string>;
  readonly lastAuthoritativeSequence: number;
}

interface DeferredFullMessagePatch {
  readonly message: ChatMessage;
  readonly live: boolean;
}

interface DeferredReactionPatch {
  readonly reactions: readonly ReactionSummary[];
  readonly changeSequence: number;
  readonly updatedAt: string;
}

interface DeferredAuthoritativePatch {
  readonly fullMessage: DeferredFullMessagePatch | null;
  readonly reaction: DeferredReactionPatch | null;
}

export interface TranscriptState {
  readonly resourceKey: string;
  /** Shared logical clock captured before starting REST requests. */
  readonly version: number;
  readonly roomStatus: ChatRoomStatus;
  readonly roomError: ChatApiFailure | null;
  readonly isLoadingInitial: boolean;
  readonly confirmed: ReadonlyMap<string, ChatMessage>;
  /** Last transcript mutation version for each confirmed server id. */
  readonly messageVersions: ReadonlyMap<string, number>;
  /** Last authoritative reaction-base version for each confirmed server id. */
  readonly reactionBaseVersions: ReadonlyMap<string, number>;
  /** Last reducer version sourced from a live reaction-bearing push. */
  readonly reactionLiveVersions: ReadonlyMap<string, number>;
  readonly pending: ReadonlyMap<string, ChatMessage>;
  /** Request baseline for the currently active send attempt. */
  readonly pendingVersions: ReadonlyMap<string, number>;
  readonly pendingClientIds: ReadonlySet<string>;
  readonly failedClientIds: ReadonlySet<string>;
  readonly failedByClientId: ReadonlyMap<string, ChatApiFailure>;
  readonly hidden: ReadonlySet<string>;
  readonly reactionBase: ReadonlyMap<
    string,
    readonly ReactionSummary[]
  >;
  readonly reactionOverlays: ReadonlyMap<
    string,
    TranscriptReactionOverlay
  >;
  /**
   * Immediate HTTP draft projections. Full chat rows remain authoritative and
   * retain their server-authored change_sequence; this overlay is reconciled
   * separately when a newer full row arrives.
   */
  readonly aiDraftOverlays: ReadonlyMap<
    string,
    ReadonlyMap<string, TranscriptAIDraftOverlay>
  >;
  /** Newer authority retained until an unloaded paginated row materializes. */
  readonly deferredAuthoritativePatches: ReadonlyMap<
    string,
    DeferredAuthoritativePatch
  >;
  readonly hasMoreOlder: boolean;
  readonly nextOlderCursor: string | null;
  readonly isLoadingOlder: boolean;
  readonly olderLoadError: ChatApiFailure | null;
  readonly isGapFilling: boolean;
  readonly isUpdating: boolean;
  readonly terminalLocked: boolean;
  readonly pendingReactionMessageIds: ReadonlySet<string>;
  readonly pendingDeleteMessageIds: ReadonlySet<string>;
  readonly isHidingMessages: boolean;
  readonly mutationError: TranscriptMutationError | null;
}

interface ResourceScopedAction {
  readonly resourceKey: string;
}

export type TranscriptAction =
  | (ResourceScopedAction & { readonly type: 'RESET' })
  | (ResourceScopedAction & { readonly type: 'INIT_START' })
  | (ResourceScopedAction & {
      readonly type: 'INIT_RESOLVED';
      readonly messages: readonly ChatMessage[];
      readonly nextCursor: string | null;
      readonly requestVersion: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'INIT_FAILED';
      readonly error: ChatApiFailure;
      readonly requestVersion: number;
    })
  | (ResourceScopedAction & { readonly type: 'OLDER_START' })
  | (ResourceScopedAction & {
      readonly type: 'OLDER_RESOLVED';
      readonly messages: readonly ChatMessage[];
      readonly nextCursor: string | null;
      readonly requestVersion: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'OLDER_FAILED';
      readonly error: ChatApiFailure;
      readonly requestVersion: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'UPSERT';
      readonly messages: readonly ChatMessage[];
      /** Required for REST data; omitted only for a live authoritative push. */
      readonly requestVersion?: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'PATCH_KNOWN';
      readonly messages: readonly ChatMessage[];
      /** Required for REST data; omitted only for a live authoritative push. */
      readonly requestVersion?: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'AI_DRAFT_LOCAL_SNAPSHOT';
      readonly messageId: string;
      readonly draftId: string;
      readonly expectedSourceIdentity: string;
      readonly draft: AIActionDraft;
    })
  | (ResourceScopedAction & {
      readonly type: 'REACTION_PATCH';
      readonly messageId: string;
      readonly reactions: readonly ReactionSummary[];
      readonly changeSequence: number;
      readonly updatedAt: string;
    })
  | (ResourceScopedAction & {
      readonly type: 'ADD_PENDING';
      readonly message: ChatMessage;
    })
  | (ResourceScopedAction & {
      readonly type: 'RETRY_PENDING';
      readonly cid: string;
    })
  | (ResourceScopedAction & {
      readonly type: 'CONFIRM_PENDING';
      readonly cid: string;
      readonly message: ChatMessage;
      readonly requestVersion: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'FAIL_PENDING';
      readonly cid: string;
      readonly error: ChatApiFailure;
      readonly requestVersion: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'BLOCK_PENDING';
      readonly cid: string;
      readonly error: ChatApiFailure;
      readonly requestVersion: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'HIDE_MESSAGES';
      readonly messageIds: readonly string[];
      readonly requestVersion: number;
    })
  | (ResourceScopedAction & { readonly type: 'KICKED' })
  | (ResourceScopedAction & {
      readonly type: 'TERMINAL_LOCK';
      readonly error: ChatApiFailure;
      readonly requestVersion: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'SUSPEND_ACCESS';
      readonly sendError: ChatApiFailure;
      readonly mutationError: ChatApiFailure;
    })
  | (ResourceScopedAction & {
      readonly type: 'CATCHUP_PHASE';
      readonly phase: 'gap' | 'update' | null;
    })
  | (ResourceScopedAction & {
      readonly type: 'REACTION_START';
      readonly messageId: string;
      readonly operationId: string;
      readonly optimisticReactions: readonly ReactionSummary[];
    })
  | (ResourceScopedAction & {
      readonly type: 'REACTION_SUCCESS';
      readonly messageId: string;
      readonly operationId: string;
      readonly reactions: readonly ReactionSummary[];
      readonly changeSequence: number;
      readonly updatedAt: string;
      readonly requestVersion: number;
      readonly startMessageVersion: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'REACTION_FAIL';
      readonly messageId: string;
      readonly operationId: string;
      readonly error: ChatApiFailure;
      readonly requestVersion: number;
      readonly startMessageVersion: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'DELETE_START';
      readonly messageId: string;
    })
  | (ResourceScopedAction & {
      readonly type: 'DELETE_SUCCESS';
      readonly message: ChatMessage;
      readonly requestVersion: number;
    })
  | (ResourceScopedAction & {
      readonly type: 'DELETE_END';
      readonly messageId: string;
      readonly requestVersion: number;
      readonly error?: ChatApiFailure | null;
    })
  | (ResourceScopedAction & { readonly type: 'HIDE_START' })
  | (ResourceScopedAction & {
      readonly type: 'HIDE_END';
      readonly requestVersion: number;
      readonly error?: ChatApiFailure | null;
    })
  | (ResourceScopedAction & {
      readonly type: 'SET_MUTATION_ERROR';
      readonly messageId: string | null;
      readonly error: ChatApiFailure | null;
    });

export function createTranscriptState(resourceKey: string): TranscriptState {
  return {
    resourceKey,
    version: 0,
    roomStatus: 'idle',
    roomError: null,
    isLoadingInitial: false,
    confirmed: new Map(),
    messageVersions: new Map(),
    reactionBaseVersions: new Map(),
    reactionLiveVersions: new Map(),
    pending: new Map(),
    pendingVersions: new Map(),
    pendingClientIds: new Set(),
    failedClientIds: new Set(),
    failedByClientId: new Map(),
    hidden: new Set(),
    reactionBase: new Map(),
    reactionOverlays: new Map(),
    aiDraftOverlays: new Map(),
    deferredAuthoritativePatches: new Map(),
    hasMoreOlder: false,
    nextOlderCursor: null,
    isLoadingOlder: false,
    olderLoadError: null,
    isGapFilling: false,
    isUpdating: false,
    terminalLocked: false,
    pendingReactionMessageIds: new Set(),
    pendingDeleteMessageIds: new Set(),
    isHidingMessages: false,
    mutationError: null,
  };
}

type MergeMode = 'upsert' | 'patch-known';

function shouldReplaceFullMessage(
  current: ChatMessage,
  incoming: ChatMessage,
): boolean {
  if (current.is_deleted_for_everyone && !incoming.is_deleted_for_everyone) {
    return false;
  }
  return (
    incoming.change_sequence > current.change_sequence ||
    (incoming.change_sequence === current.change_sequence &&
      incoming.is_deleted_for_everyone &&
      !current.is_deleted_for_everyone)
  );
}

/** Returns the deferred full row only when it will supersede this raw page row. */
export function selectDeferredFullAuthorityForMaterialization(
  state: TranscriptState,
  incoming: ChatMessage,
): ChatMessage | null {
  const deferred = state.deferredAuthoritativePatches.get(incoming.id)
    ?.fullMessage?.message;
  return deferred !== undefined && shouldReplaceFullMessage(incoming, deferred)
    ? deferred
    : null;
}

function retainDeferredFullMessage(
  current: DeferredAuthoritativePatch | undefined,
  message: ChatMessage,
  live: boolean,
): DeferredAuthoritativePatch | null {
  const currentFullMessage = current?.fullMessage?.message;
  if (
    currentFullMessage !== undefined &&
    !shouldReplaceFullMessage(currentFullMessage, message)
  ) {
    return null;
  }
  return {
    fullMessage: { message, live },
    reaction: message.is_deleted_for_everyone ? null : current?.reaction ?? null,
  };
}

function retainDeferredReaction(
  current: DeferredAuthoritativePatch | undefined,
  reaction: DeferredReactionPatch,
): DeferredAuthoritativePatch | null {
  if (
    current?.fullMessage?.message.is_deleted_for_everyone ||
    (current?.fullMessage !== null &&
      current?.fullMessage !== undefined &&
      current.fullMessage.message.change_sequence >= reaction.changeSequence) ||
    (current?.reaction !== null &&
      current?.reaction !== undefined &&
      current.reaction.changeSequence >= reaction.changeSequence)
  ) {
    return null;
  }
  return {
    fullMessage: current?.fullMessage ?? null,
    reaction,
  };
}

function materializeDeferredPatch(
  message: ChatMessage,
  deferred: DeferredAuthoritativePatch,
): { readonly message: ChatMessage; readonly live: boolean } {
  let resolved = message;
  let live = false;
  const fullMessage = deferred.fullMessage;
  if (
    fullMessage !== null &&
    shouldReplaceFullMessage(resolved, fullMessage.message)
  ) {
    resolved = fullMessage.message;
    live = fullMessage.live;
  }
  const reaction = deferred.reaction;
  if (
    reaction !== null &&
    !resolved.is_deleted_for_everyone &&
    reaction.changeSequence > resolved.change_sequence
  ) {
    resolved = {
      ...resolved,
      reactions: reaction.reactions,
      change_sequence: reaction.changeSequence,
      updated_at: reaction.updatedAt,
    };
    live = true;
  }
  return { message: resolved, live };
}

function parsedDraftById(
  message: ChatMessage,
  draftId: string,
): AIActionDraft | null {
  for (const candidate of message.action_drafts) {
    const parsed = parseAIActionDraft(candidate);
    if (parsed?.id === draftId) {
      return parsed;
    }
  }
  return null;
}

function reconcileAIDraftOverlaysForFullMessage(
  overlays: ReadonlyMap<string, TranscriptAIDraftOverlay>,
  message: ChatMessage,
): ReadonlyMap<string, TranscriptAIDraftOverlay> | null {
  if (message.is_deleted_for_everyone) {
    return null;
  }

  const next = new Map<string, TranscriptAIDraftOverlay>();
  for (const [draftId, overlay] of overlays) {
    const incomingDraft = parsedDraftById(message, draftId);
    if (incomingDraft === null) {
      continue;
    }
    const incomingIdentity = aiActionDraftSourceIdentity(incomingDraft);
    if (incomingIdentity === overlay.projectedIdentity) {
      continue;
    }
    if (overlay.priorSourceIdentities.has(incomingIdentity)) {
      next.set(draftId, {
        ...overlay,
        lastAuthoritativeSequence: message.change_sequence,
      });
    }
  }
  return next.size > 0 ? next : null;
}

function mergeMessages(
  state: TranscriptState,
  messages: readonly ChatMessage[],
  mode: MergeMode,
  _requestVersion: number | undefined,
): TranscriptState {
  const eligible = new Map<
    string,
    { readonly message: ChatMessage; readonly live: boolean }
  >();
  let deferredAuthoritativePatches = state.deferredAuthoritativePatches;
  let deferredChanged = false;

  const mutableDeferredPatches = () => {
    if (!deferredChanged) {
      deferredAuthoritativePatches = new Map(deferredAuthoritativePatches);
      deferredChanged = true;
    }
    return deferredAuthoritativePatches as Map<
      string,
      DeferredAuthoritativePatch
    >;
  };

  for (const incoming of messages) {
    if (state.hidden.has(incoming.id)) {
      continue;
    }
    const current = state.confirmed.get(incoming.id);
    if (mode === 'patch-known' && current === undefined) {
      const retained = retainDeferredFullMessage(
        deferredAuthoritativePatches.get(incoming.id),
        incoming,
        _requestVersion === undefined,
      );
      if (retained !== null) {
        mutableDeferredPatches().set(incoming.id, retained);
      }
      continue;
    }

    let message = incoming;
    let live = _requestVersion === undefined;
    const deferred = deferredAuthoritativePatches.get(message.id);
    if (current === undefined && deferred !== undefined) {
      const materialized = materializeDeferredPatch(message, deferred);
      message = materialized.message;
      live = live || materialized.live;
      mutableDeferredPatches().delete(message.id);
    }
    if (
      current !== undefined &&
      !shouldReplaceFullMessage(current, message)
    ) {
      continue;
    }
    eligible.set(message.id, { message, live });
  }

  if (eligible.size === 0) {
    return deferredChanged
      ? {
          ...state,
          version: state.version + 1,
          deferredAuthoritativePatches,
        }
      : state;
  }

  const nextVersion = state.version + 1;
  const confirmed = new Map(state.confirmed);
  const messageVersions = new Map(state.messageVersions);
  const reactionBaseVersions = new Map(state.reactionBaseVersions);
  const reactionLiveVersions = new Map(state.reactionLiveVersions);
  const pending = new Map(state.pending);
  const pendingVersions = new Map(state.pendingVersions);
  const pendingClientIds = new Set(state.pendingClientIds);
  const failedClientIds = new Set(state.failedClientIds);
  const failedByClientId = new Map(state.failedByClientId);
  const reactionBase = new Map(state.reactionBase);
  const reactionOverlays = new Map(state.reactionOverlays);
  const aiDraftOverlays = new Map(state.aiDraftOverlays);
  const pendingReactionMessageIds = new Set(
    state.pendingReactionMessageIds,
  );

  for (const { message, live } of eligible.values()) {
    confirmed.set(message.id, message);
    messageVersions.set(message.id, nextVersion);
    reactionBase.set(message.id, message.reactions);
    reactionBaseVersions.set(message.id, nextVersion);
    if (live) {
      reactionLiveVersions.set(message.id, nextVersion);
    }

    if (message.is_deleted_for_everyone) {
      reactionOverlays.delete(message.id);
      pendingReactionMessageIds.delete(message.id);
    }

    const messageDraftOverlays = aiDraftOverlays.get(message.id);
    if (messageDraftOverlays !== undefined) {
      const reconciled = reconcileAIDraftOverlaysForFullMessage(
        messageDraftOverlays,
        message,
      );
      if (reconciled === null) {
        aiDraftOverlays.delete(message.id);
      } else {
        aiDraftOverlays.set(message.id, reconciled);
      }
    }

    const cid = message.client_message_id;
    if (cid !== null) {
      pending.delete(cid);
      pendingVersions.delete(cid);
      pendingClientIds.delete(cid);
      failedClientIds.delete(cid);
      failedByClientId.delete(cid);
    }
  }

  return {
    ...state,
    version: nextVersion,
    confirmed,
    messageVersions,
    reactionBaseVersions,
    reactionLiveVersions,
    pending,
    pendingVersions,
    pendingClientIds,
    failedClientIds,
    failedByClientId,
    reactionBase,
    reactionOverlays,
    aiDraftOverlays,
    deferredAuthoritativePatches,
    pendingReactionMessageIds,
  };
}

function removePending(
  state: TranscriptState,
  cid: string,
  requestVersion: number,
  mode: 'settled' | 'failed' | 'blocked',
  error?: ChatApiFailure,
): TranscriptState {
  const pending = state.pending.get(cid);
  const attemptVersion = state.pendingVersions.get(cid);
  if (
    pending === undefined ||
    attemptVersion === undefined ||
    attemptVersion > requestVersion
  ) {
    return state;
  }

  const nextVersion = state.version + 1;
  const pendingMap = new Map(state.pending);
  const pendingVersions = new Map(state.pendingVersions);
  const pendingClientIds = new Set(state.pendingClientIds);
  const failedClientIds = new Set(state.failedClientIds);
  const failedByClientId = new Map(state.failedByClientId);

  if (mode === 'failed' && error !== undefined) {
    failedClientIds.add(cid);
    failedByClientId.set(cid, error);
    pendingVersions.set(cid, nextVersion);
  } else {
    pendingMap.delete(cid);
    pendingVersions.delete(cid);
    pendingClientIds.delete(cid);
    failedClientIds.delete(cid);
    failedByClientId.delete(cid);
  }

  return {
    ...state,
    version: nextVersion,
    pending: pendingMap,
    pendingVersions,
    pendingClientIds,
    failedClientIds,
    failedByClientId,
    mutationError: state.mutationError,
  };
}

function settleReaction(
  state: TranscriptState,
  action: Extract<
    TranscriptAction,
    { readonly type: 'REACTION_SUCCESS' | 'REACTION_FAIL' }
  >,
): TranscriptState {
  const overlay = state.reactionOverlays.get(action.messageId);
  const message = state.confirmed.get(action.messageId);
  if (
    overlay === undefined ||
    message === undefined ||
    overlay.operationId !== action.operationId ||
    overlay.startMessageVersion !== action.startMessageVersion
  ) {
    return state;
  }

  const nextVersion = state.version + 1;
  const confirmed = new Map(state.confirmed);
  const messageVersions = new Map(state.messageVersions);
  const reactionBaseVersions = new Map(state.reactionBaseVersions);
  const reactionLiveVersions = new Map(state.reactionLiveVersions);
  const reactionBase = new Map(state.reactionBase);
  const reactionOverlays = new Map(state.reactionOverlays);
  const pendingReactionMessageIds = new Set(
    state.pendingReactionMessageIds,
  );
  reactionOverlays.delete(action.messageId);
  pendingReactionMessageIds.delete(action.messageId);
  messageVersions.set(action.messageId, nextVersion);

  let mutationError = state.mutationError;
  if (action.type === 'REACTION_SUCCESS') {
    if (
      !message.is_deleted_for_everyone &&
      action.changeSequence > message.change_sequence
    ) {
      const updatedMessage = {
        ...message,
        reactions: action.reactions,
        change_sequence: action.changeSequence,
        updated_at: action.updatedAt,
      };
      confirmed.set(action.messageId, updatedMessage);
      reactionBase.set(action.messageId, action.reactions);
      reactionBaseVersions.set(action.messageId, nextVersion);
    }
    mutationError = null;
  } else {
    mutationError = { messageId: action.messageId, error: action.error };
  }

  return {
    ...state,
    version: nextVersion,
    confirmed,
    messageVersions,
    reactionBaseVersions,
    reactionLiveVersions,
    reactionBase,
    reactionOverlays,
    pendingReactionMessageIds,
    mutationError,
  };
}

export function transcriptReducer(
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState {
  if (action.type === 'RESET') {
    return createTranscriptState(action.resourceKey);
  }
  if (action.resourceKey !== state.resourceKey || state.roomStatus === 'kicked') {
    return state;
  }

  switch (action.type) {
    case 'INIT_START':
      if (state.isLoadingInitial) {
        return state;
      }
      if (state.terminalLocked) {
        return { ...state, isLoadingInitial: true, roomError: null };
      }
      return {
        ...state,
        roomStatus: 'loading',
        roomError: null,
        isLoadingInitial: true,
      };

    case 'INIT_RESOLVED': {
      const merged = mergeMessages(
        state,
        action.messages,
        'upsert',
        action.requestVersion,
      );
      return {
        ...merged,
        roomStatus: 'ready',
        roomError: null,
        isLoadingInitial: false,
        nextOlderCursor: action.nextCursor,
        hasMoreOlder: action.nextCursor !== null,
      };
    }

    case 'INIT_FAILED':
      if (state.terminalLocked) {
        return {
          ...state,
          roomStatus: 'ready',
          roomError: action.error,
          isLoadingInitial: false,
        };
      }
      return {
        ...state,
        roomStatus: 'error',
        roomError: action.error,
        isLoadingInitial: false,
      };

    case 'OLDER_START':
      if (state.isLoadingOlder) {
        return state;
      }
      return {
        ...state,
        isLoadingOlder: true,
        olderLoadError: null,
      };

    case 'OLDER_RESOLVED': {
      const merged = mergeMessages(
        state,
        action.messages,
        'upsert',
        action.requestVersion,
      );
      return {
        ...merged,
        nextOlderCursor: action.nextCursor,
        hasMoreOlder: action.nextCursor !== null,
        isLoadingOlder: false,
        olderLoadError: null,
      };
    }

    case 'OLDER_FAILED':
      return {
        ...state,
        isLoadingOlder: false,
        olderLoadError: action.error,
      };

    case 'UPSERT':
      return mergeMessages(
        state,
        action.messages,
        'upsert',
        action.requestVersion,
      );

    case 'PATCH_KNOWN':
      return mergeMessages(
        state,
        action.messages,
        'patch-known',
        action.requestVersion,
      );

    case 'AI_DRAFT_LOCAL_SNAPSHOT': {
      const message = state.confirmed.get(action.messageId);
      if (
        message === undefined ||
        message.sender_kind !== 'AI' ||
        message.is_deleted_for_everyone ||
        state.hidden.has(action.messageId) ||
        action.draft.id !== action.draftId
      ) {
        return state;
      }

      const messageOverlays = state.aiDraftOverlays.get(action.messageId);
      const currentOverlay = messageOverlays?.get(action.draftId);
      const currentDraft =
        currentOverlay?.draft ?? parsedDraftById(message, action.draftId);
      if (
        currentDraft === null ||
        aiActionDraftSourceIdentity(currentDraft) !==
          action.expectedSourceIdentity
      ) {
        return state;
      }

      const nextVersion = state.version + 1;
      const priorSourceIdentities = new Set(
        currentOverlay?.priorSourceIdentities ?? [],
      );
      priorSourceIdentities.add(action.expectedSourceIdentity);
      const nextMessageOverlays = new Map(messageOverlays ?? []);
      nextMessageOverlays.set(action.draftId, {
        draft: action.draft,
        projectedIdentity: aiActionDraftSourceIdentity(action.draft),
        priorSourceIdentities,
        lastAuthoritativeSequence: message.change_sequence,
      });
      const aiDraftOverlays = new Map(state.aiDraftOverlays);
      aiDraftOverlays.set(action.messageId, nextMessageOverlays);
      const messageVersions = new Map(state.messageVersions);
      messageVersions.set(action.messageId, nextVersion);
      return {
        ...state,
        version: nextVersion,
        messageVersions,
        aiDraftOverlays,
      };
    }

    case 'REACTION_PATCH': {
      const message = state.confirmed.get(action.messageId);
      if (message === undefined) {
        if (state.hidden.has(action.messageId)) {
          return state;
        }
        const retained = retainDeferredReaction(
          state.deferredAuthoritativePatches.get(action.messageId),
          {
            reactions: action.reactions,
            changeSequence: action.changeSequence,
            updatedAt: action.updatedAt,
          },
        );
        if (retained === null) {
          return state;
        }
        const deferredAuthoritativePatches = new Map(
          state.deferredAuthoritativePatches,
        );
        deferredAuthoritativePatches.set(action.messageId, retained);
        return {
          ...state,
          version: state.version + 1,
          deferredAuthoritativePatches,
        };
      }
      if (
        message.is_deleted_for_everyone ||
        state.hidden.has(action.messageId) ||
        action.changeSequence <= message.change_sequence
      ) {
        return state;
      }
      const nextVersion = state.version + 1;
      const confirmed = new Map(state.confirmed);
      const messageVersions = new Map(state.messageVersions);
      const reactionBaseVersions = new Map(state.reactionBaseVersions);
      const reactionLiveVersions = new Map(state.reactionLiveVersions);
      const reactionBase = new Map(state.reactionBase);
      confirmed.set(action.messageId, {
        ...message,
        reactions: action.reactions,
        change_sequence: action.changeSequence,
        updated_at: action.updatedAt,
      });
      messageVersions.set(action.messageId, nextVersion);
      reactionBaseVersions.set(action.messageId, nextVersion);
      reactionLiveVersions.set(action.messageId, nextVersion);
      reactionBase.set(action.messageId, action.reactions);
      return {
        ...state,
        version: nextVersion,
        confirmed,
        messageVersions,
        reactionBaseVersions,
        reactionLiveVersions,
        reactionBase,
      };
    }

    case 'ADD_PENDING': {
      const cid = action.message.client_message_id;
      if (
        state.terminalLocked ||
        cid === null ||
        cid.length === 0 ||
        hasConfirmedClientId(state, cid)
      ) {
        return state;
      }
      const nextVersion = state.version + 1;
      const pending = new Map(state.pending);
      const pendingVersions = new Map(state.pendingVersions);
      const pendingClientIds = new Set(state.pendingClientIds);
      const failedClientIds = new Set(state.failedClientIds);
      const failedByClientId = new Map(state.failedByClientId);
      pending.set(cid, action.message);
      pendingVersions.set(cid, state.version);
      pendingClientIds.add(cid);
      failedClientIds.delete(cid);
      failedByClientId.delete(cid);
      return {
        ...state,
        version: nextVersion,
        pending,
        pendingVersions,
        pendingClientIds,
        failedClientIds,
        failedByClientId,
        mutationError: null,
      };
    }

    case 'RETRY_PENDING': {
      if (state.terminalLocked || !state.pending.has(action.cid)) {
        return state;
      }
      const nextVersion = state.version + 1;
      const pendingVersions = new Map(state.pendingVersions);
      const failedClientIds = new Set(state.failedClientIds);
      const failedByClientId = new Map(state.failedByClientId);
      pendingVersions.set(action.cid, state.version);
      failedClientIds.delete(action.cid);
      failedByClientId.delete(action.cid);
      return {
        ...state,
        version: nextVersion,
        pendingVersions,
        failedClientIds,
        failedByClientId,
        mutationError: null,
      };
    }

    case 'CONFIRM_PENDING': {
      const merged = mergeMessages(
        state,
        [action.message],
        'upsert',
        action.requestVersion,
      );
      const settled = !merged.pending.has(action.cid)
        ? merged
        : removePending(
            merged,
            action.cid,
            action.requestVersion,
            'settled',
          );
      return settled.mutationError === null
        ? settled
        : { ...settled, mutationError: null };
    }

    case 'FAIL_PENDING':
      return removePending(
        state,
        action.cid,
        action.requestVersion,
        'failed',
        action.error,
      );

    case 'BLOCK_PENDING':
      return removePending(
        state,
        action.cid,
        action.requestVersion,
        'blocked',
        action.error,
      );

    case 'HIDE_MESSAGES': {
      if (action.messageIds.length === 0) {
        return state;
      }
      const nextVersion = state.version + 1;
      const confirmed = new Map(state.confirmed);
      const messageVersions = new Map(state.messageVersions);
      const reactionBaseVersions = new Map(state.reactionBaseVersions);
      const reactionLiveVersions = new Map(state.reactionLiveVersions);
      const pending = new Map(state.pending);
      const pendingVersions = new Map(state.pendingVersions);
      const pendingClientIds = new Set(state.pendingClientIds);
      const failedClientIds = new Set(state.failedClientIds);
      const failedByClientId = new Map(state.failedByClientId);
      const hidden = new Set(state.hidden);
      const reactionBase = new Map(state.reactionBase);
      const reactionOverlays = new Map(state.reactionOverlays);
      const aiDraftOverlays = new Map(state.aiDraftOverlays);
      const deferredAuthoritativePatches = new Map(
        state.deferredAuthoritativePatches,
      );
      const pendingReactionMessageIds = new Set(
        state.pendingReactionMessageIds,
      );
      const pendingDeleteMessageIds = new Set(state.pendingDeleteMessageIds);

      for (const messageId of new Set(action.messageIds)) {
        hidden.add(messageId);
        confirmed.delete(messageId);
        messageVersions.delete(messageId);
        reactionBaseVersions.delete(messageId);
        reactionLiveVersions.delete(messageId);
        reactionBase.delete(messageId);
        reactionOverlays.delete(messageId);
        aiDraftOverlays.delete(messageId);
        deferredAuthoritativePatches.delete(messageId);
        pendingReactionMessageIds.delete(messageId);
        pendingDeleteMessageIds.delete(messageId);

        for (const [cid, optimistic] of pending) {
          if (optimistic.id !== messageId && cid !== messageId) {
            continue;
          }
          pending.delete(cid);
          pendingVersions.delete(cid);
          pendingClientIds.delete(cid);
          failedClientIds.delete(cid);
          failedByClientId.delete(cid);
        }
      }

      return {
        ...state,
        version: nextVersion,
        confirmed,
        messageVersions,
        reactionBaseVersions,
        reactionLiveVersions,
        pending,
        pendingVersions,
        pendingClientIds,
        failedClientIds,
        failedByClientId,
        hidden,
        reactionBase,
        reactionOverlays,
        aiDraftOverlays,
        deferredAuthoritativePatches,
        pendingReactionMessageIds,
        pendingDeleteMessageIds,
        mutationError: null,
      };
    }

    case 'KICKED': {
      const cleared = createTranscriptState(state.resourceKey);
      return {
        ...cleared,
        version: state.version + 1,
        roomStatus: 'kicked',
      };
    }

    case 'TERMINAL_LOCK': {
      if (
        state.terminalLocked &&
        state.roomStatus === 'ready' &&
        state.pending.size === 0 &&
        state.reactionOverlays.size === 0 &&
        state.pendingDeleteMessageIds.size === 0 &&
        !state.isHidingMessages &&
        state.mutationError === null
      ) {
        return state;
      }
      const nextVersion = state.version + 1;
      const messageVersions = new Map(state.messageVersions);
      for (const messageId of state.reactionOverlays.keys()) {
        messageVersions.set(messageId, nextVersion);
      }
      return {
        ...state,
        version: nextVersion,
        messageVersions,
        pending: new Map(),
        pendingVersions: new Map(),
        pendingClientIds: new Set(),
        failedClientIds: new Set(),
        failedByClientId: new Map(),
        reactionOverlays: new Map(),
        roomStatus: 'ready',
        terminalLocked: true,
        pendingReactionMessageIds: new Set(),
        pendingDeleteMessageIds: new Set(),
        olderLoadError: null,
        isHidingMessages: false,
        mutationError: null,
      };
    }

    case 'SUSPEND_ACCESS': {
      const activeSendClientIds = [...state.pending.keys()].filter(
        (clientMessageId) => !state.failedClientIds.has(clientMessageId),
      );
      const interruptedMessageIds = new Set([
        ...state.reactionOverlays.keys(),
        ...state.pendingDeleteMessageIds,
      ]);
      const interruptedMutation =
        interruptedMessageIds.size > 0 || state.isHidingMessages;
      const hadBusyState =
        activeSendClientIds.length > 0 ||
        interruptedMutation ||
        state.isLoadingInitial ||
        state.isLoadingOlder ||
        state.isGapFilling ||
        state.isUpdating;
      if (!hadBusyState) {
        return state;
      }

      const nextVersion = state.version + 1;
      const pendingVersions = new Map(state.pendingVersions);
      const failedClientIds = new Set(state.failedClientIds);
      const failedByClientId = new Map(state.failedByClientId);
      for (const clientMessageId of activeSendClientIds) {
        pendingVersions.set(clientMessageId, nextVersion);
        failedClientIds.add(clientMessageId);
        failedByClientId.set(clientMessageId, action.sendError);
      }

      const messageVersions = new Map(state.messageVersions);
      for (const messageId of state.reactionOverlays.keys()) {
        messageVersions.set(messageId, nextVersion);
      }
      const interruptedMessageId =
        !state.isHidingMessages && interruptedMessageIds.size === 1
          ? [...interruptedMessageIds][0]
          : null;

      return {
        ...state,
        version: nextVersion,
        messageVersions,
        pendingVersions,
        failedClientIds,
        failedByClientId,
        reactionOverlays: new Map(),
        pendingReactionMessageIds: new Set(),
        pendingDeleteMessageIds: new Set(),
        isLoadingInitial: false,
        isLoadingOlder: false,
        isGapFilling: false,
        isUpdating: false,
        isHidingMessages: false,
        mutationError: interruptedMutation
          ? {
              messageId: interruptedMessageId,
              error: action.mutationError,
            }
          : state.mutationError,
      };
    }

    case 'CATCHUP_PHASE':
      return {
        ...state,
        isGapFilling: action.phase === 'gap',
        isUpdating: action.phase === 'update',
      };

    case 'REACTION_START': {
      const message = state.confirmed.get(action.messageId);
      if (
        state.terminalLocked ||
        message === undefined ||
        message.is_deleted_for_everyone ||
        state.reactionOverlays.has(action.messageId)
      ) {
        return state;
      }
      const startMessageVersion = selectMessageVersion(
        state,
        action.messageId,
      );
      const nextVersion = state.version + 1;
      const messageVersions = new Map(state.messageVersions);
      const reactionOverlays = new Map(state.reactionOverlays);
      const pendingReactionMessageIds = new Set(
        state.pendingReactionMessageIds,
      );
      messageVersions.set(action.messageId, nextVersion);
      reactionOverlays.set(action.messageId, {
        operationId: action.operationId,
        optimisticReactions: action.optimisticReactions,
        startMessageVersion,
      });
      pendingReactionMessageIds.add(action.messageId);
      return {
        ...state,
        version: nextVersion,
        messageVersions,
        reactionOverlays,
        pendingReactionMessageIds,
        mutationError: null,
      };
    }

    case 'REACTION_SUCCESS':
    case 'REACTION_FAIL':
      return settleReaction(state, action);

    case 'DELETE_START': {
      if (state.terminalLocked || !state.confirmed.has(action.messageId)) {
        return state;
      }
      const pendingDeleteMessageIds = new Set(
        state.pendingDeleteMessageIds,
      );
      pendingDeleteMessageIds.add(action.messageId);
      return {
        ...state,
        pendingDeleteMessageIds,
        mutationError: null,
      };
    }

    case 'DELETE_SUCCESS': {
      const message = action.message;
      const current = state.confirmed.get(message.id);
      if (
        !message.is_deleted_for_everyone ||
        state.hidden.has(message.id) ||
        current === undefined ||
        !state.pendingDeleteMessageIds.has(message.id)
      ) {
        return state;
      }

      const nextVersion = state.version + 1;
      const confirmed = new Map(state.confirmed);
      const messageVersions = new Map(state.messageVersions);
      const reactionBaseVersions = new Map(state.reactionBaseVersions);
      const reactionLiveVersions = new Map(state.reactionLiveVersions);
      const reactionBase = new Map(state.reactionBase);
      const reactionOverlays = new Map(state.reactionOverlays);
      const aiDraftOverlays = new Map(state.aiDraftOverlays);
      const pendingReactionMessageIds = new Set(
        state.pendingReactionMessageIds,
      );
      const pendingDeleteMessageIds = new Set(
        state.pendingDeleteMessageIds,
      );

      const accepted = message.change_sequence > current.change_sequence;
      const authoritative = accepted ? message : current;
      confirmed.set(message.id, authoritative);
      messageVersions.set(message.id, nextVersion);
      if (accepted) {
        reactionBaseVersions.set(message.id, nextVersion);
      }
      reactionLiveVersions.delete(message.id);
      reactionBase.set(message.id, authoritative.reactions);
      reactionOverlays.delete(message.id);
      if (authoritative.is_deleted_for_everyone) {
        aiDraftOverlays.delete(message.id);
      }
      pendingReactionMessageIds.delete(message.id);
      pendingDeleteMessageIds.delete(message.id);

      return {
        ...state,
        version: nextVersion,
        confirmed,
        messageVersions,
        reactionBaseVersions,
        reactionLiveVersions,
        reactionBase,
        reactionOverlays,
        aiDraftOverlays,
        pendingReactionMessageIds,
        pendingDeleteMessageIds,
        mutationError: null,
      };
    }

    case 'DELETE_END': {
      if (!state.pendingDeleteMessageIds.has(action.messageId)) {
        return state;
      }
      const pendingDeleteMessageIds = new Set(
        state.pendingDeleteMessageIds,
      );
      pendingDeleteMessageIds.delete(action.messageId);
      return {
        ...state,
        pendingDeleteMessageIds,
        mutationError: action.error
          ? { messageId: action.messageId, error: action.error }
          : state.mutationError,
      };
    }

    case 'HIDE_START':
      if (state.terminalLocked || state.isHidingMessages) {
        return state;
      }
      return { ...state, isHidingMessages: true, mutationError: null };

    case 'HIDE_END':
      if (!state.isHidingMessages) {
        return state;
      }
      return {
        ...state,
        isHidingMessages: false,
        mutationError: action.error
          ? { messageId: null, error: action.error }
          : state.mutationError,
      };

    case 'SET_MUTATION_ERROR':
      return {
        ...state,
        mutationError:
          action.error === null
            ? null
            : { messageId: action.messageId, error: action.error },
      };
  }
}

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function withEffectiveReactions(
  state: TranscriptState,
  message: ChatMessage,
): ChatMessage {
  const overlay = state.reactionOverlays.get(message.id);
  if (overlay !== undefined) {
    return { ...message, reactions: overlay.optimisticReactions };
  }
  const base = state.reactionBase.get(message.id);
  if (base !== undefined && base !== message.reactions) {
    return { ...message, reactions: base };
  }
  return message;
}

function withEffectiveAIDrafts(
  state: TranscriptState,
  message: ChatMessage,
): ChatMessage {
  const overlays = state.aiDraftOverlays.get(message.id);
  if (
    overlays === undefined ||
    overlays.size === 0 ||
    message.is_deleted_for_everyone
  ) {
    return message;
  }

  let changed = false;
  const actionDrafts = message.action_drafts.map((candidate) => {
    const parsed = parseAIActionDraft(candidate);
    if (parsed === null) {
      return candidate;
    }
    const overlay = overlays.get(parsed.id);
    if (overlay === undefined) {
      return candidate;
    }
    changed = true;
    return overlay.draft;
  });
  return changed ? { ...message, action_drafts: actionDrafts } : message;
}

function withEffectiveMessage(
  state: TranscriptState,
  message: ChatMessage,
): ChatMessage {
  return withEffectiveAIDrafts(state, withEffectiveReactions(state, message));
}

/** Confirmed and optimistic messages ordered by `(created_at, id)` ascending. */
export function selectTranscriptMessages(
  state: TranscriptState,
): readonly ChatMessage[] {
  const messages: ChatMessage[] = [];
  const confirmedClientIds = new Set<string>();

  for (const message of state.confirmed.values()) {
    if (state.hidden.has(message.id)) {
      continue;
    }
    messages.push(withEffectiveMessage(state, message));
    if (message.client_message_id !== null) {
      confirmedClientIds.add(message.client_message_id);
    }
  }

  for (const [cid, message] of state.pending) {
    if (
      state.hidden.has(message.id) ||
      confirmedClientIds.has(cid)
    ) {
      continue;
    }
    messages.push(message);
  }

  return messages.sort(compareMessages);
}

export function selectMessageById(
  state: TranscriptState,
  id: string,
): ChatMessage | null {
  const confirmed = state.confirmed.get(id);
  if (confirmed !== undefined && !state.hidden.has(id)) {
    return withEffectiveMessage(state, confirmed);
  }
  for (const message of state.pending.values()) {
    if (message.id === id && !state.hidden.has(id)) {
      return message;
    }
  }
  return null;
}

export function selectPendingByClientId(
  state: TranscriptState,
  cid: string,
): ChatMessage | null {
  return state.pending.get(cid) ?? null;
}

export function hasConfirmedClientId(
  state: TranscriptState,
  cid: string,
): boolean {
  for (const message of state.confirmed.values()) {
    if (message.client_message_id === cid) {
      return true;
    }
  }
  return false;
}

export function selectLatestConfirmed(
  state: TranscriptState,
): ChatMessage | null {
  let latest: ChatMessage | null = null;
  for (const message of state.confirmed.values()) {
    if (latest === null || compareMessages(latest, message) < 0) {
      latest = message;
    }
  }
  return latest;
}

export function selectLatestChangeCursor(
  state: TranscriptState,
): ChangeSyncCursor | null {
  let latest: ChangeSyncCursor | null = null;
  for (const message of state.confirmed.values()) {
    if (
      latest === null ||
      message.change_sequence > latest.changeSequence ||
      (message.change_sequence === latest.changeSequence &&
        message.id > latest.id)
    ) {
      latest = { changeSequence: message.change_sequence, id: message.id };
    }
  }
  return latest;
}

export function selectMessageVersion(
  state: TranscriptState,
  id: string,
): number {
  return state.messageVersions.get(id) ?? 0;
}

/** Latest authoritative reaction base, excluding any optimistic overlay. */
export function selectReactionBase(
  state: TranscriptState,
  id: string,
): readonly ReactionSummary[] | null {
  if (state.hidden.has(id) || !state.confirmed.has(id)) {
    return null;
  }
  return state.reactionBase.get(id) ?? null;
}

/** Reducer clock of the latest live reaction-bearing push for this message. */
export function selectReactionLiveVersion(
  state: TranscriptState,
  id: string,
): number {
  return state.reactionLiveVersions.get(id) ?? 0;
}
