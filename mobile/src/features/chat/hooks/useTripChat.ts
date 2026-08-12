import { useFocusEffect } from 'expo-router';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useSession } from '@/features/auth/session';
import type { AuthUser } from '@/features/auth/types';
import {
  useRealtimeSnapshot,
  useRealtimeTransport,
} from '@/features/realtime/application/RealtimeProvider';
import type { RealtimeStatus } from '@/features/realtime/types';
import { useTripDetail } from '@/features/trips/hooks/useTripDetail';
import type { TripStatus } from '@/features/trips/types';
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
import { parseAIActionDraft, type AIActionDraft } from '../ai/drafts';
import {
  createAIReconciliationCoordinator,
  type AIReconciliationCoordinator,
} from '../ai/reconciliation';
import {
  createAITypingVisualController,
  EMPTY_AI_TYPING_STATE,
  type AITypingState,
  type AITypingVisualController,
} from '../ai/typingState';
import {
  createTranscriptState,
  hasConfirmedClientId,
  selectLatestConfirmed,
  selectLatestChangeCursor,
  selectMessageById,
  selectMessageVersion,
  selectPendingByClientId,
  selectTranscriptMessages,
  transcriptReducer,
  type ChatRoomStatus,
  type TranscriptState,
  type TranscriptAction,
} from '../application/transcriptReducer';
import { canonicalizeChatTripId } from '../contracts';
import { parseChatRealtimeEvent } from '../realtimeEvents';
import type {
  AllowedReactionEmoji,
  ChatApiFailure,
  ChatMessage,
  DeleteChatMessageMode,
  ReactionSummary,
} from '../types';

const HISTORY_PAGE_SIZE = 30;
const RECONCILIATION_PAGE_SIZE = 100;
const RECONCILIATION_MAX_PAGES = 50;
const TERMINAL_ERROR_CODE = 'TRIP_TERMINAL';
const SUBSCRIPTION_LIMIT_ERROR_CODE = 'SUBSCRIPTION_LIMIT_REACHED';
const CHAT_ACCESS_UNCERTAIN_ERROR_CODE = 'CHAT_ACCESS_UNCERTAIN';
const CHAT_MUTATION_INTERRUPTED_ERROR_CODE = 'CHAT_MUTATION_INTERRUPTED';
const ACCESS_LOST_ERROR_CODES = new Set(['TRIP_NOT_FOUND', 'FORBIDDEN']);
const EMPTY_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_FAILURE_MAP: ReadonlyMap<string, ChatApiFailure> = new Map();
const AI_TYPING_TIMER_SCHEDULER = {
  set: (callback: () => void, delayMs: number): unknown =>
    globalThis.setTimeout(callback, delayMs),
  clear: (handle: unknown): void => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

type ChatCurrentUser = Pick<
  AuthUser,
  'id' | 'display_name' | 'identify_tag' | 'avatar_url'
>;

export type ChatSubscriptionStatus =
  | 'inactive'
  | 'waiting'
  | 'subscribing'
  | 'subscribed'
  | 'rejected';

export type ChatAccessStatus = 'checking' | 'granted' | 'denied' | 'error';
export type ChatRoomViewStatus = Exclude<ChatRoomStatus, 'idle'>;

export interface ChatRoomError {
  readonly errorCode: string;
  readonly detail: string;
}

interface ResourceScopedChatRoomError {
  readonly resourceKey: string;
  readonly error: ChatRoomError;
}

export type ChatSendOutcome =
  | {
      readonly kind: 'created';
      readonly clientMessageId: string;
    }
  | {
      readonly kind: 'replayed';
      readonly clientMessageId: string;
    }
  | {
      readonly kind: 'failed';
      readonly clientMessageId: string;
      readonly error: ChatApiFailure;
    }
  | {
      readonly kind: 'blocked';
      readonly error: ChatApiFailure;
    };

export type ChatMutationOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'rejected'; readonly error: ChatApiFailure };

export interface ChatMutationError {
  readonly messageId: string | null;
  readonly error: ChatApiFailure;
}

export interface UseTripChatOptions {
  readonly tripId: string | undefined;
}

export interface ApplyAIDraftSnapshotInput {
  readonly messageId: string;
  readonly draftId: string;
  readonly expectedSourceIdentity: string;
  readonly draft: AIActionDraft;
}

export interface UseTripChatResult {
  readonly currentUserId: string | null;
  readonly tripStatus: TripStatus | null;
  readonly accessStatus: ChatAccessStatus;
  readonly roomStatus: ChatRoomViewStatus;
  readonly subscriptionStatus: ChatSubscriptionStatus;
  readonly roomError: ChatRoomError | null;
  /** Ascending by `(created_at, id)`; reverse before feeding an inverted list. */
  readonly messages: readonly ChatMessage[];
  readonly pendingClientIds: ReadonlySet<string>;
  readonly failedClientIds: ReadonlySet<string>;
  readonly failedByClientId: ReadonlyMap<string, ChatApiFailure>;
  readonly pendingReactionMessageIds: ReadonlySet<string>;
  readonly pendingDeleteMessageIds: ReadonlySet<string>;
  readonly hasMoreOlder: boolean;
  readonly isLoadingOlder: boolean;
  readonly olderLoadError: ChatApiFailure | null;
  readonly isGapFilling: boolean;
  readonly isUpdating: boolean;
  readonly isHidingMessages: boolean;
  readonly isReadOnly: boolean;
  readonly mutationError: ChatMutationError | null;
  readonly aiTypingState: AITypingState;
  readonly connectionStatus: RealtimeStatus;
  readonly connectionEpoch: number;
  readonly aiReconciliationCoordinator: AIReconciliationCoordinator;
  readonly ambiguousAIDraftIds: ReadonlySet<string>;
  readonly retryInitialLoad: () => Promise<void>;
  readonly loadOlder: () => Promise<void>;
  readonly sendMessage: (content: string) => Promise<ChatSendOutcome>;
  readonly retryPending: (clientMessageId: string) => Promise<ChatSendOutcome>;
  readonly toggleReaction: (
    messageId: string,
    emoji: AllowedReactionEmoji,
  ) => Promise<ChatMutationOutcome>;
  readonly deleteMessage: (
    messageId: string,
    mode: DeleteChatMessageMode,
  ) => Promise<ChatMutationOutcome>;
  readonly hideMessagesForMe: (
    messageIds: readonly string[],
  ) => Promise<ChatMutationOutcome>;
  readonly applyAIDraftSnapshot: (
    input: ApplyAIDraftSnapshotInput,
  ) => Promise<void>;
}

interface CatchUpRun {
  readonly resourceKey: string;
  readonly focusGeneration: number;
  readonly connectionEpoch: number;
  readonly controller: AbortController;
}

interface LiveReactionProof {
  readonly reactions: readonly ReactionSummary[];
  readonly changeSequence: number;
  readonly updatedAt: string;
}

interface LiveDeleteProof {
  readonly message: ChatMessage;
}

interface ActiveAITypingVisualController {
  readonly controller: AITypingVisualController;
  readonly resourceKey: string;
  readonly focusGeneration: number;
  readonly connectionEpoch: number;
}

interface AITypingPresentation {
  readonly state: AITypingState;
  readonly resourceKey: string | null;
  readonly connectionEpoch: number | null;
}

const EMPTY_AI_TYPING_PRESENTATION: AITypingPresentation = {
  state: EMPTY_AI_TYPING_STATE,
  resourceKey: null,
  connectionEpoch: null,
};

function localFailure(
  message: string,
  errorCode: string,
  status: number | null = null,
): ChatApiFailure {
  return {
    kind: 'message',
    message,
    errorCode,
    status,
    retryAfterMs: null,
    fieldErrors: null,
  };
}

function roomError(errorCode: string, detail: string): ChatRoomError {
  return { errorCode, detail };
}

function isAccessLost(error: ChatApiFailure): boolean {
  return error.errorCode !== null && ACCESS_LOST_ERROR_CODES.has(error.errorCode);
}

function isBlockedSend(error: ChatApiFailure): boolean {
  if (error.status === 429 || error.errorCode === 'THROTTLED') {
    return true;
  }
  return (
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408
  );
}

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface AIDraftObservationIndex {
  readonly resourceKey: string;
  readonly byMessageId: Map<string, readonly AIActionDraft[]>;
  readonly byDraftId: Map<
    string,
    Map<string, readonly AIActionDraft[]>
  >;
  readonly ambiguousDraftIds: Set<string>;
  readonly ambiguitySnapshots: Map<'current', ReadonlySet<string>>;
}

interface AIDraftObservationChange {
  readonly previousByDraftId: ReadonlyMap<
    string,
    readonly AIActionDraft[]
  >;
  readonly nextByDraftId: ReadonlyMap<
    string,
    readonly AIActionDraft[]
  >;
}

function effectiveAIDraftsForMessage(
  state: TranscriptState,
  messageId: string,
): readonly AIActionDraft[] {
  const message = selectMessageById(state, messageId);
  if (
    message === null ||
    message.sender_kind !== 'AI' ||
    message.is_deleted_for_everyone ||
    message.action_drafts.length === 0
  ) {
    return [];
  }
  const drafts: AIActionDraft[] = [];
  for (const candidate of message.action_drafts) {
    const parsed = parseAIActionDraft(candidate);
    if (parsed !== null) {
      drafts.push(parsed);
    }
  }
  return drafts;
}

function indexedDraftOccurrences(
  index: AIDraftObservationIndex,
  draftId: string,
): readonly AIActionDraft[] {
  const occurrencesByMessage = index.byDraftId.get(draftId);
  return occurrencesByMessage === undefined
    ? []
    : [...occurrencesByMessage.values()].flat();
}

function updateAIDraftObservationIndex(
  index: AIDraftObservationIndex,
  nextState: TranscriptState,
  messageIds: readonly string[],
): AIDraftObservationChange {
  const affectedMessageIds = [...new Set(messageIds)];
  const nextDraftsByMessage = new Map<string, readonly AIActionDraft[]>();
  const affectedDraftIds = new Set<string>();
  for (const messageId of affectedMessageIds) {
    for (const draft of index.byMessageId.get(messageId) ?? []) {
      affectedDraftIds.add(draft.id);
    }
    const nextDrafts = effectiveAIDraftsForMessage(nextState, messageId);
    nextDraftsByMessage.set(messageId, nextDrafts);
    for (const draft of nextDrafts) {
      affectedDraftIds.add(draft.id);
    }
  }

  const previousByDraftId = new Map<
    string,
    readonly AIActionDraft[]
  >();
  for (const draftId of affectedDraftIds) {
    previousByDraftId.set(
      draftId,
      [...indexedDraftOccurrences(index, draftId)],
    );
  }

  for (const messageId of affectedMessageIds) {
    const priorDraftIds = new Set(
      (index.byMessageId.get(messageId) ?? []).map((draft) => draft.id),
    );
    for (const draftId of priorDraftIds) {
      const occurrencesByMessage = index.byDraftId.get(draftId);
      occurrencesByMessage?.delete(messageId);
      if (occurrencesByMessage?.size === 0) {
        index.byDraftId.delete(draftId);
      }
    }
    index.byMessageId.delete(messageId);
  }

  for (const [messageId, drafts] of nextDraftsByMessage) {
    if (drafts.length === 0) {
      continue;
    }
    index.byMessageId.set(messageId, drafts);
    const draftsById = new Map<string, AIActionDraft[]>();
    for (const draft of drafts) {
      const occurrences = draftsById.get(draft.id) ?? [];
      occurrences.push(draft);
      draftsById.set(draft.id, occurrences);
    }
    for (const [draftId, occurrences] of draftsById) {
      const occurrencesByMessage =
        index.byDraftId.get(draftId) ??
        new Map<string, readonly AIActionDraft[]>();
      occurrencesByMessage.set(messageId, occurrences);
      index.byDraftId.set(draftId, occurrencesByMessage);
    }
  }

  const nextByDraftId = new Map<
    string,
    readonly AIActionDraft[]
  >();
  for (const draftId of affectedDraftIds) {
    nextByDraftId.set(
      draftId,
      [...indexedDraftOccurrences(index, draftId)],
    );
  }
  let ambiguityChanged = false;
  for (const [draftId, occurrences] of nextByDraftId) {
    const isAmbiguous = occurrences.length > 1;
    if (index.ambiguousDraftIds.has(draftId) === isAmbiguous) {
      continue;
    }
    ambiguityChanged = true;
    if (isAmbiguous) {
      index.ambiguousDraftIds.add(draftId);
    } else {
      index.ambiguousDraftIds.delete(draftId);
    }
  }
  if (ambiguityChanged) {
    index.ambiguitySnapshots.set(
      'current',
      new Set(index.ambiguousDraftIds),
    );
  }
  return { previousByDraftId, nextByDraftId };
}

function latestChangeCursorFromMessages(
  messages: readonly ChatMessage[],
): { readonly changeSequence: number; readonly id: string } | null {
  let latest: { readonly changeSequence: number; readonly id: string } | null =
    null;
  for (const message of messages) {
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

export function createChatClientMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (marker) => {
    const randomNibble = Math.floor(Math.random() * 16);
    const value = marker === 'x' ? randomNibble : (randomNibble % 4) + 8;
    return value.toString(16);
  });
}

function createOptimisticMessage(
  tripId: string,
  currentUser: ChatCurrentUser,
  content: string,
  clientMessageId: string,
): ChatMessage {
  const now = new Date().toISOString();
  return {
    id: `optimistic:${clientMessageId}`,
    trip_id: tripId,
    sender: {
      id: currentUser.id,
      display_name: currentUser.display_name,
      identify_tag: currentUser.identify_tag,
      avatar_url: currentUser.avatar_url,
    },
    sender_kind: 'USER',
    ai_status: null,
    content,
    client_message_id: clientMessageId,
    created_at: now,
    updated_at: now,
    change_sequence: 0,
    is_deleted_for_everyone: false,
    deleted_for_everyone_at: null,
    deleted_for_everyone_by_id: null,
    delete_for_everyone_until: null,
    can_delete_for_everyone: false,
    reactions: [],
    action_drafts: [],
  };
}

function optimisticReactionSnapshot(
  reactions: readonly ReactionSummary[],
  userId: string,
  selectedEmoji: AllowedReactionEmoji,
): readonly ReactionSummary[] {
  const currentlySelected = reactions.find((reaction) =>
    reaction.reacted_by_ids.includes(userId),
  )?.emoji;
  const shouldRemove = currentlySelected === selectedEmoji;
  const next: ReactionSummary[] = [];

  for (const reaction of reactions) {
    const withoutCurrentUser = reaction.reacted_by_ids.filter(
      (reactedById) => reactedById !== userId,
    );
    if (withoutCurrentUser.length > 0) {
      next.push({
        ...reaction,
        count: withoutCurrentUser.length,
        reacted_by_ids: withoutCurrentUser,
      });
    }
  }

  if (!shouldRemove) {
    const existingIndex = next.findIndex(
      (reaction) => reaction.emoji === selectedEmoji,
    );
    if (existingIndex >= 0) {
      const existing = next[existingIndex];
      next[existingIndex] = {
        ...existing,
        count: existing.count + 1,
        reacted_by_ids: [...existing.reacted_by_ids, userId],
      };
    } else {
      next.push({ emoji: selectedEmoji, count: 1, reacted_by_ids: [userId] });
    }
  }

  return next;
}

function confirmsReactionOutcome(
  reactions: readonly ReactionSummary[],
  userId: string,
  emoji: AllowedReactionEmoji,
  removing: boolean,
): boolean {
  if (removing) {
    return reactions.every(
      (reaction) => !reaction.reacted_by_ids.includes(userId),
    );
  }
  return reactions.some(
    (reaction) =>
      reaction.emoji === emoji && reaction.reacted_by_ids.includes(userId),
  );
}

export function useTripChat({ tripId: rawTripId }: UseTripChatOptions): UseTripChatResult {
  const tripId = canonicalizeChatTripId(rawTripId) ?? '';
  const { status: sessionStatus, user } = useSession();
  const tripDetail = useTripDetail(tripId || undefined);
  const refreshTripDetail = tripDetail.refresh;
  const realtime = useRealtimeTransport();
  const realtimeSnapshot = useRealtimeSnapshot();
  const ownerUserId = user?.id ?? null;
  const resourceKey = `${ownerUserId ?? 'no-session'}:${tripId}`;
  const tripStatus = tripDetail.detail?.trip.status ?? null;
  const [state, reactDispatch] = useReducer(
    transcriptReducer,
    resourceKey,
    createTranscriptState,
  );
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<ChatSubscriptionStatus>('inactive');
  const [currentRoomError, setCurrentRoomError] =
    useState<ChatRoomError | null>(null);
  const [aiReconciliationError, setAIReconciliationError] =
    useState<ResourceScopedChatRoomError | null>(null);
  const [aiTypingPresentation, setAITypingPresentation] =
    useState<AITypingPresentation>(EMPTY_AI_TYPING_PRESENTATION);
  const clearNonterminalRoomError = useCallback(() => {
    setCurrentRoomError((current) =>
      current?.errorCode === TERMINAL_ERROR_CODE ? current : null,
    );
  }, []);

  const activeResourceKeyRef = useRef(resourceKey);
  const stateRef = useRef(state);
  const snapshotRef = useRef(realtimeSnapshot);
  const accessGranted = Boolean(
    tripId &&
    sessionStatus === 'signedIn' &&
      user &&
      tripDetail.error === null &&
      tripDetail.status === 'ready' &&
      tripDetail.detail?.my_membership.status === 'ACTIVE',
  );
  const tripDetailAccessLost =
    tripDetail.error?.errorCode !== undefined &&
    ACCESS_LOST_ERROR_CODES.has(tripDetail.error.errorCode);
  const accessStatus: ChatAccessStatus = accessGranted
    ? 'granted'
    : sessionStatus === 'restoring' || tripDetail.status === 'loading'
      ? 'checking'
      : sessionStatus === 'signedOut' ||
          tripDetailAccessLost ||
          (tripDetail.status === 'ready' &&
            tripDetail.detail?.my_membership.status !== 'ACTIVE')
        ? 'denied'
        : 'error';
  const accessGrantedRef = useRef(accessGranted);
  const kickedRef = useRef(false);
  const focusedRef = useRef(false);
  const focusGenerationRef = useRef(0);
  const sentEpochRef = useRef<number | null>(null);
  const ackedEpochRef = useRef<number | null>(null);
  const rejectedEpochRef = useRef<number | null>(null);
  const catchUpRequestedEpochRef = useRef<number | null>(null);
  const catchUpRunRef = useRef<CatchUpRun | null>(null);
  const initialLoadControllerRef = useRef<AbortController | null>(null);
  const olderLoadControllerRef = useRef<AbortController | null>(null);
  const requestControllersRef = useRef(new Set<AbortController>());
  const mutationControllersRef = useRef(new Set<AbortController>());
  const sendLocksRef = useRef(new Map<string, symbol>());
  const reactionLocksRef = useRef(new Map<string, symbol>());
  const liveReactionProofsRef = useRef(new Map<string, LiveReactionProof>());
  const liveDeleteProofsRef = useRef(new Map<string, LiveDeleteProof>());
  const deleteLocksRef = useRef(new Map<string, symbol>());
  const hideLockRef = useRef<symbol | null>(null);
  const aiTypingControllerRef =
    useRef<ActiveAITypingVisualController | null>(null);
  const aiTypingDisposalGenerationRef = useRef(0);
  const aiReconciliationCoordinator = useMemo(
    () => createAIReconciliationCoordinator({ resourceKey, tripId }),
    [resourceKey, tripId],
  );
  const aiDraftObservationIndex = useMemo<AIDraftObservationIndex>(
    () => ({
      resourceKey,
      byMessageId: new Map(),
      byDraftId: new Map(),
      ambiguousDraftIds: new Set(),
      ambiguitySnapshots: new Map([['current', EMPTY_ID_SET]]),
    }),
    [resourceKey],
  );

  const dispatch = useCallback(
    (action: TranscriptAction) => {
      // Async reconciliation can dispatch several causally ordered results
      // before React publishes a render. Keep a write-through reducer mirror
      // so every later request captures the exact post-action version.
      const previousState = stateRef.current;
      const nextState = transcriptReducer(previousState, action);
      let reconciliation = Promise.resolve();
      let observationMode: 'seed-new' | 'transition' | 'silent' | null = null;
      let affectedMessageIds: readonly string[] = [];
      switch (action.type) {
        case 'INIT_RESOLVED':
        case 'OLDER_RESOLVED':
          observationMode = 'seed-new';
          affectedMessageIds = action.messages.map((message) => message.id);
          break;
        case 'UPSERT':
        case 'PATCH_KNOWN':
          observationMode = 'transition';
          affectedMessageIds = action.messages.map((message) => message.id);
          break;
        case 'AI_DRAFT_LOCAL_SNAPSHOT':
          observationMode = 'transition';
          affectedMessageIds = [action.messageId];
          break;
        case 'HIDE_MESSAGES':
          observationMode = 'silent';
          affectedMessageIds = action.messageIds;
          break;
        case 'DELETE_SUCCESS':
          observationMode = 'silent';
          affectedMessageIds = [action.message.id];
          break;
        case 'RESET':
        case 'KICKED':
          aiDraftObservationIndex.byMessageId.clear();
          aiDraftObservationIndex.byDraftId.clear();
          aiDraftObservationIndex.ambiguousDraftIds.clear();
          aiDraftObservationIndex.ambiguitySnapshots.set(
            'current',
            EMPTY_ID_SET,
          );
          break;
      }

      if (
        nextState !== previousState &&
        observationMode !== null &&
        affectedMessageIds.length > 0
      ) {
        const { previousByDraftId, nextByDraftId } =
          updateAIDraftObservationIndex(
            aiDraftObservationIndex,
            nextState,
            affectedMessageIds,
          );
        const claims: Promise<unknown>[] = [];
        for (const [draftId, nextOccurrences] of nextByDraftId) {
          if (
            observationMode === 'silent' ||
            nextOccurrences.length !== 1 ||
            nextOccurrences[0].status !== 'CONFIRMED'
          ) {
            continue;
          }
          const previousOccurrences = previousByDraftId.get(draftId) ?? [];
          if (previousOccurrences.length > 1) {
            continue;
          }
          const nextDraft = nextOccurrences[0];
          const previousDraft = previousOccurrences[0] ?? null;
          if (previousDraft?.status === 'CONFIRMED') {
            aiReconciliationCoordinator.seedConfirmedDrafts([nextDraft]);
            continue;
          }
          if (observationMode === 'seed-new' && previousDraft === null) {
            aiReconciliationCoordinator.seedConfirmedDrafts([nextDraft]);
            continue;
          }
          claims.push(
            aiReconciliationCoordinator.reconcile({
              previousStatus: previousDraft?.status ?? null,
              draft: nextDraft,
            }),
          );
        }
        reconciliation = Promise.all(claims).then(() => undefined);
        if (claims.length > 0) {
          void reconciliation.catch(() => {
            if (activeResourceKeyRef.current === resourceKey) {
              setAIReconciliationError({
                resourceKey,
                error: roomError(
                  'AI_RECONCILIATION_FAILED',
                  'The AI action was confirmed, but another trip screen could not refresh automatically.',
                ),
              });
            }
          });
        }
      }
      stateRef.current = nextState;
      reactDispatch(action);
      return reconciliation;
    },
    [
      aiDraftObservationIndex,
      aiReconciliationCoordinator,
      reactDispatch,
      resourceKey,
    ],
  );

  useLayoutEffect(() => {
    activeResourceKeyRef.current = resourceKey;
    snapshotRef.current = realtimeSnapshot;
    accessGrantedRef.current = accessGranted;
  }, [accessGranted, realtimeSnapshot, resourceKey]);

  const isResourceCurrent = useCallback(
    (expectedResourceKey: string) =>
      activeResourceKeyRef.current === expectedResourceKey,
    [],
  );

  const disposeAITypingVisual = useCallback(() => {
    const disposalGeneration = aiTypingDisposalGenerationRef.current + 1;
    aiTypingDisposalGenerationRef.current = disposalGeneration;
    const active = aiTypingControllerRef.current;
    aiTypingControllerRef.current = null;
    active?.controller.dispose();
    queueMicrotask(() => {
      if (
        aiTypingDisposalGenerationRef.current !== disposalGeneration ||
        aiTypingControllerRef.current !== null
      ) {
        return;
      }
      setAITypingPresentation((current) =>
        current === EMPTY_AI_TYPING_PRESENTATION ||
        (current.state.active === null && current.resourceKey === null)
          ? current
          : EMPTY_AI_TYPING_PRESENTATION,
      );
    });
  }, []);

  const ensureAITypingVisual = useCallback(
    (connectionEpoch: number) => {
      const focusGeneration = focusGenerationRef.current;
      const current = aiTypingControllerRef.current;
      if (
        current !== null &&
        current.resourceKey === resourceKey &&
        current.focusGeneration === focusGeneration &&
        current.connectionEpoch === connectionEpoch
      ) {
        return current.controller;
      }

      disposeAITypingVisual();
      let controller: AITypingVisualController;
      controller = createAITypingVisualController({
        scheduler: AI_TYPING_TIMER_SCHEDULER,
        now: () => Date.now(),
        onChange: (next) => {
          const active = aiTypingControllerRef.current;
          const snapshot = snapshotRef.current;
          if (
            active?.controller !== controller ||
            active.resourceKey !== resourceKey ||
            active.focusGeneration !== focusGeneration ||
            active.connectionEpoch !== connectionEpoch ||
            activeResourceKeyRef.current !== resourceKey ||
            focusGenerationRef.current !== focusGeneration ||
            !focusedRef.current ||
            !accessGrantedRef.current ||
            kickedRef.current ||
            snapshot.status !== 'connected' ||
            snapshot.connectionEpoch !== connectionEpoch ||
            ackedEpochRef.current !== connectionEpoch
          ) {
            return;
          }
          setAITypingPresentation({
            state: next,
            resourceKey,
            connectionEpoch,
          });
        },
      });
      aiTypingControllerRef.current = {
        controller,
        resourceKey,
        focusGeneration,
        connectionEpoch,
      };
      aiTypingDisposalGenerationRef.current += 1;
      setAITypingPresentation({
        state: EMPTY_AI_TYPING_STATE,
        resourceKey,
        connectionEpoch,
      });
      return controller;
    },
    [disposeAITypingVisual, resourceKey],
  );

  const applyAIDraftSnapshot = useCallback(
    (input: ApplyAIDraftSnapshotInput): Promise<void> => {
      if (
        !isResourceCurrent(resourceKey) ||
        stateRef.current.resourceKey !== resourceKey ||
        !accessGrantedRef.current ||
        kickedRef.current
      ) {
        return Promise.resolve();
      }
      return dispatch({
        type: 'AI_DRAFT_LOCAL_SNAPSHOT',
        resourceKey,
        messageId: input.messageId,
        draftId: input.draftId,
        expectedSourceIdentity: input.expectedSourceIdentity,
        draft: input.draft,
      });
    },
    [dispatch, isResourceCurrent, resourceKey],
  );

  const registerController = useCallback(() => {
    const controller = new AbortController();
    requestControllersRef.current.add(controller);
    return controller;
  }, []);

  const releaseController = useCallback((controller: AbortController) => {
    requestControllersRef.current.delete(controller);
  }, []);

  const abortAllRequests = useCallback(() => {
    const initialController = initialLoadControllerRef.current;
    initialLoadControllerRef.current = null;
    initialController?.abort();
    const olderController = olderLoadControllerRef.current;
    olderLoadControllerRef.current = null;
    olderController?.abort();
    for (const controller of requestControllersRef.current) {
      controller.abort();
    }
    requestControllersRef.current.clear();
    catchUpRunRef.current = null;
  }, []);

  const invalidateMutationOwnership = useCallback(() => {
    for (const controller of mutationControllersRef.current) {
      controller.abort();
    }
    mutationControllersRef.current.clear();
    sendLocksRef.current.clear();
    reactionLocksRef.current.clear();
    deleteLocksRef.current.clear();
    hideLockRef.current = null;
    liveReactionProofsRef.current.clear();
    liveDeleteProofsRef.current.clear();
  }, []);

  const resetTransientSubscriptionOwnership = useCallback(() => {
    const snapshot = snapshotRef.current;
    focusGenerationRef.current += 1;
    if (
      focusedRef.current &&
      snapshot.status === 'connected' &&
      sentEpochRef.current === snapshot.connectionEpoch
    ) {
      realtime.send({ type: 'chat.unsubscribe', trip_id: tripId });
    }
    abortAllRequests();
    invalidateMutationOwnership();
    disposeAITypingVisual();
    sentEpochRef.current = null;
    ackedEpochRef.current = null;
    rejectedEpochRef.current = null;
    catchUpRequestedEpochRef.current = null;
    setSubscriptionStatus('inactive');
    if (stateRef.current.resourceKey === resourceKey) {
      dispatch({
        type: 'SUSPEND_ACCESS',
        resourceKey,
        sendError: localFailure(
          'Chat access is temporarily unavailable. Retry this message after access recovers.',
          CHAT_ACCESS_UNCERTAIN_ERROR_CODE,
        ),
        mutationError: localFailure(
          'A chat change was interrupted while trip access was being verified. Review the current message before trying again.',
          CHAT_MUTATION_INTERRUPTED_ERROR_CODE,
        ),
      });
    }
  }, [
    abortAllRequests,
    dispatch,
    disposeAITypingVisual,
    invalidateMutationOwnership,
    realtime,
    resourceKey,
    tripId,
  ]);

  const kickRoom = useCallback(
    (detail: string, errorCode = 'FORBIDDEN') => {
      kickedRef.current = true;
      focusGenerationRef.current += 1;
      abortAllRequests();
      invalidateMutationOwnership();
      disposeAITypingVisual();
      setSubscriptionStatus('inactive');
      setCurrentRoomError(roomError(errorCode, detail));
      dispatch({ type: 'KICKED', resourceKey });
    },
    [
      abortAllRequests,
      dispatch,
      disposeAITypingVisual,
      invalidateMutationOwnership,
      resourceKey,
    ],
  );

  const applyAuthoritativeFailure = useCallback(
    (error: ChatApiFailure, messageId: string | null = null) => {
      if (error.errorCode === TERMINAL_ERROR_CODE) {
        invalidateMutationOwnership();
        dispatch({
          type: 'TERMINAL_LOCK',
          resourceKey,
          error,
          requestVersion: stateRef.current.version,
        });
        setCurrentRoomError(roomError(TERMINAL_ERROR_CODE, error.message));
      } else if (isAccessLost(error)) {
        kickRoom(error.message, error.errorCode ?? 'FORBIDDEN');
      }
      dispatch({
        type: 'SET_MUTATION_ERROR',
        resourceKey,
        messageId,
        error,
      });
    },
    [dispatch, invalidateMutationOwnership, kickRoom, resourceKey],
  );

  useEffect(() => {
    let cancelled = false;
    invalidateMutationOwnership();
    disposeAITypingVisual();
    kickedRef.current = false;
    sentEpochRef.current = null;
    ackedEpochRef.current = null;
    rejectedEpochRef.current = null;
    catchUpRequestedEpochRef.current = null;
    dispatch({ type: 'RESET', resourceKey });
    queueMicrotask(() => {
      if (!cancelled) {
        setCurrentRoomError(null);
        setAIReconciliationError(null);
      }
    });
    return () => {
      cancelled = true;
      focusGenerationRef.current += 1;
      abortAllRequests();
      invalidateMutationOwnership();
      disposeAITypingVisual();
    };
  }, [
    abortAllRequests,
    dispatch,
    disposeAITypingVisual,
    invalidateMutationOwnership,
    resourceKey,
  ]);

  const loadInitialHistory = useCallback(async () => {
    if (
      initialLoadControllerRef.current !== null ||
      stateRef.current.roomStatus === 'ready' ||
      kickedRef.current ||
      !tripId
    ) {
      return;
    }
    const controller = registerController();
    initialLoadControllerRef.current = controller;
    const requestVersion =
      stateRef.current.resourceKey === resourceKey
        ? stateRef.current.version
        : 0;
    dispatch({ type: 'INIT_START', resourceKey });
    try {
      const response = await listChatHistory(
        tripId,
        { limit: HISTORY_PAGE_SIZE },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        !isResourceCurrent(resourceKey) ||
        kickedRef.current
      ) {
        return;
      }
      dispatch({
        type: 'INIT_RESOLVED',
        resourceKey,
        messages: response.results,
        nextCursor: response.next_cursor,
        requestVersion,
      });
      clearNonterminalRoomError();
    } catch (caught: unknown) {
      if (controller.signal.aborted || !isResourceCurrent(resourceKey)) {
        return;
      }
      const error = normalizeChatApiError(caught);
      if (isAccessLost(error)) {
        kickRoom(error.message, error.errorCode ?? 'FORBIDDEN');
        return;
      }
      setCurrentRoomError(
        roomError(error.errorCode ?? 'CHAT_INITIAL_LOAD_FAILED', error.message),
      );
      dispatch({
        type: 'INIT_FAILED',
        resourceKey,
        error,
        requestVersion,
      });
    } finally {
      releaseController(controller);
      if (initialLoadControllerRef.current === controller) {
        initialLoadControllerRef.current = null;
      }
    }
  }, [
    clearNonterminalRoomError,
    dispatch,
    isResourceCurrent,
    kickRoom,
    registerController,
    releaseController,
    resourceKey,
    tripId,
  ]);

  useEffect(() => {
    if (accessStatus === 'checking' || accessStatus === 'error') {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) {
          resetTransientSubscriptionOwnership();
        }
      });
      return () => {
        cancelled = true;
      };
    }
    if (accessStatus === 'denied') {
      kickedRef.current = true;
      const tripDetailErrorCode = tripDetail.error?.errorCode;
      const hasExactAccessFailure =
        tripDetailErrorCode !== undefined &&
        ACCESS_LOST_ERROR_CODES.has(tripDetailErrorCode);
      const errorCode = hasExactAccessFailure
        ? tripDetailErrorCode
        : 'FORBIDDEN';
      const detail = hasExactAccessFailure
        ? tripDetail.error?.message ??
          'You no longer have access to this trip chat.'
        : 'You no longer have access to this trip chat.';
      queueMicrotask(() => {
        if (activeResourceKeyRef.current === resourceKey) {
          kickRoom(detail, errorCode);
        }
      });
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadInitialHistory();
      }
    });
    return () => {
      cancelled = true;
      initialLoadControllerRef.current?.abort();
    };
  }, [
    accessStatus,
    kickRoom,
    loadInitialHistory,
    resetTransientSubscriptionOwnership,
    resourceKey,
    tripDetail.error?.errorCode,
    tripDetail.error?.message,
  ]);

  useEffect(() => {
    if (
      (tripStatus !== 'COMPLETED' && tripStatus !== 'CANCELLED') ||
      state.resourceKey !== resourceKey ||
      state.roomStatus === 'kicked' ||
      state.terminalLocked
    ) {
      return;
    }
    invalidateMutationOwnership();
    dispatch({
      type: 'TERMINAL_LOCK',
      resourceKey,
      error: localFailure(
        'This trip chat is read-only because the trip has ended.',
        TERMINAL_ERROR_CODE,
        409,
      ),
      requestVersion: state.version,
    });
  }, [
    dispatch,
    invalidateMutationOwnership,
    resourceKey,
    state.resourceKey,
    state.roomStatus,
    state.terminalLocked,
    state.version,
    tripStatus,
  ]);

  const isCatchUpCurrent = useCallback(
    (run: CatchUpRun) =>
      !run.controller.signal.aborted &&
      isResourceCurrent(run.resourceKey) &&
      focusedRef.current &&
      focusGenerationRef.current === run.focusGeneration &&
      snapshotRef.current.status === 'connected' &&
      snapshotRef.current.connectionEpoch === run.connectionEpoch &&
      ackedEpochRef.current === run.connectionEpoch &&
      !kickedRef.current,
    [isResourceCurrent],
  );

  const runCatchUp = useCallback(
    async (connectionEpoch: number) => {
      if (
        catchUpRunRef.current !== null ||
        stateRef.current.resourceKey !== resourceKey ||
        stateRef.current.roomStatus !== 'ready'
      ) {
        return;
      }

      const run: CatchUpRun = {
        resourceKey,
        focusGeneration: focusGenerationRef.current,
        connectionEpoch,
        controller: registerController(),
      };
      catchUpRunRef.current = run;
      catchUpRequestedEpochRef.current = null;
      let changeCursor = selectLatestChangeCursor(stateRef.current);
      let firstUpdateRequestVersionFloor: number | null = null;
      let latest = selectLatestConfirmed(stateRef.current);
      dispatch({ type: 'CATCHUP_PHASE', resourceKey, phase: 'gap' });

      try {
        if (latest === null) {
          const requestVersion = stateRef.current.version;
          const history = await listChatHistory(
            tripId,
            { limit: HISTORY_PAGE_SIZE },
            run.controller.signal,
          );
          if (!isCatchUpCurrent(run)) return;
          dispatch({
            type: 'INIT_RESOLVED',
            resourceKey,
            messages: history.results,
            nextCursor: history.next_cursor,
            requestVersion,
          });
          latest = [...history.results].sort(compareMessages).at(-1) ?? null;
          changeCursor ??= latestChangeCursorFromMessages(history.results);
          if (history.results.length > 0) {
            firstUpdateRequestVersionFloor = stateRef.current.version;
          }
        } else {
          let since = latest.id;
          let completed = false;
          for (let page = 0; page < RECONCILIATION_MAX_PAGES; page += 1) {
            const requestVersion = stateRef.current.version;
            const response = await gapFillChatMessages(
              tripId,
              { since, limit: RECONCILIATION_PAGE_SIZE },
              run.controller.signal,
            );
            if (!isCatchUpCurrent(run)) return;
            dispatch({
              type: 'UPSERT',
              resourceKey,
              messages: response.results,
              requestVersion,
            });
            const last = response.results.at(-1);
            if (!response.has_more || last === undefined) {
              completed = true;
              break;
            }
            since = last.id;
          }
          if (!completed) {
            setCurrentRoomError(
              roomError(
                'GAP_FILL_INCOMPLETE',
                'Chat recovery reached its safety limit. Reopen chat to retry.',
              ),
            );
          }
        }

        if (changeCursor !== null && isCatchUpCurrent(run)) {
          dispatch({ type: 'CATCHUP_PHASE', resourceKey, phase: 'update' });
          let changedSince = changeCursor.changeSequence;
          let changedSinceId: string | undefined = changeCursor.id;
          let completed = false;
          for (let page = 0; page < RECONCILIATION_MAX_PAGES; page += 1) {
            const requestVersion = Math.max(
              stateRef.current.version,
              firstUpdateRequestVersionFloor ?? stateRef.current.version,
            );
            firstUpdateRequestVersionFloor = null;
            const response = await syncChangedChatMessages(
              tripId,
              {
                changedSince,
                changedSinceId,
                limit: RECONCILIATION_PAGE_SIZE,
              },
              run.controller.signal,
            );
            if (!isCatchUpCurrent(run)) return;
            dispatch({
              type: 'PATCH_KNOWN',
              resourceKey,
              messages: response.results,
              requestVersion,
            });
            const last = response.results.at(-1);
            if (!response.has_more || last === undefined) {
              completed = true;
              break;
            }
            changedSince = last.change_sequence;
            changedSinceId = last.id;
          }
          if (!completed) {
            setCurrentRoomError(
              roomError(
                'CHANGE_SYNC_INCOMPLETE',
                'Chat updates could not be fully synchronized. Reopen chat to retry.',
              ),
            );
          }
        }
      } catch (caught: unknown) {
        if (!isCatchUpCurrent(run)) return;
        const error = normalizeChatApiError(caught);
        if (isAccessLost(error)) {
          kickRoom(error.message, error.errorCode ?? 'FORBIDDEN');
        } else {
          setCurrentRoomError(
            roomError(error.errorCode ?? 'CHAT_SYNC_FAILED', error.message),
          );
        }
      } finally {
        releaseController(run.controller);
        const stillOwnsCatchUp = catchUpRunRef.current === run;
        if (stillOwnsCatchUp) {
          catchUpRunRef.current = null;
        }
        if (stillOwnsCatchUp && isResourceCurrent(resourceKey)) {
          dispatch({ type: 'CATCHUP_PHASE', resourceKey, phase: null });
        }
      }
    },
    [
      dispatch,
      isCatchUpCurrent,
      isResourceCurrent,
      kickRoom,
      registerController,
      releaseController,
      resourceKey,
      tripId,
    ],
  );

  const attemptSubscribe = useCallback(() => {
    const snapshot = snapshotRef.current;
    if (
      !focusedRef.current ||
      !accessGrantedRef.current ||
      kickedRef.current ||
      snapshot.status !== 'connected' ||
      sentEpochRef.current === snapshot.connectionEpoch ||
      rejectedEpochRef.current === snapshot.connectionEpoch
    ) {
      return;
    }
    const sent = realtime.send({ type: 'chat.subscribe', trip_id: tripId });
    if (sent) {
      sentEpochRef.current = snapshot.connectionEpoch;
      setSubscriptionStatus('subscribing');
    } else {
      setSubscriptionStatus('waiting');
    }
  }, [realtime, tripId]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      focusGenerationRef.current += 1;
      disposeAITypingVisual();
      setSubscriptionStatus(
        snapshotRef.current.status === 'connected' ? 'subscribing' : 'waiting',
      );
      attemptSubscribe();

      return () => {
        focusedRef.current = false;
        focusGenerationRef.current += 1;
        disposeAITypingVisual();
        const activeCatchUp = catchUpRunRef.current;
        activeCatchUp?.controller.abort();
        if (activeCatchUp !== null && catchUpRunRef.current === activeCatchUp) {
          catchUpRunRef.current = null;
          if (isResourceCurrent(activeCatchUp.resourceKey)) {
            dispatch({
              type: 'CATCHUP_PHASE',
              resourceKey: activeCatchUp.resourceKey,
              phase: null,
            });
          }
        }
        const snapshot = snapshotRef.current;
        if (
          snapshot.status === 'connected' &&
          sentEpochRef.current === snapshot.connectionEpoch
        ) {
          realtime.send({ type: 'chat.unsubscribe', trip_id: tripId });
        }
        sentEpochRef.current = null;
        ackedEpochRef.current = null;
        rejectedEpochRef.current = null;
        catchUpRequestedEpochRef.current = null;
        setSubscriptionStatus('inactive');
      };
    }, [
      attemptSubscribe,
      dispatch,
      disposeAITypingVisual,
      isResourceCurrent,
      realtime,
      tripId,
    ]),
  );

  useEffect(() => {
    const activeCatchUp = catchUpRunRef.current;
    const activeTyping = aiTypingControllerRef.current;
    if (
      activeTyping !== null &&
      (realtimeSnapshot.status !== 'connected' ||
        activeTyping.connectionEpoch !== realtimeSnapshot.connectionEpoch ||
        activeTyping.resourceKey !== resourceKey ||
        !focusedRef.current ||
        !accessGranted)
    ) {
      disposeAITypingVisual();
    }
    if (
      activeCatchUp !== null &&
      (realtimeSnapshot.status !== 'connected' ||
        activeCatchUp.connectionEpoch !== realtimeSnapshot.connectionEpoch)
    ) {
      activeCatchUp.controller.abort();
      if (catchUpRunRef.current === activeCatchUp) {
        catchUpRunRef.current = null;
        dispatch({ type: 'CATCHUP_PHASE', resourceKey, phase: null });
      }
    }

    if (!focusedRef.current || kickedRef.current || !accessGranted) {
      return;
    }
    if (realtimeSnapshot.status !== 'connected') {
      ackedEpochRef.current = null;
      return;
    }
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        attemptSubscribe();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    accessGranted,
    attemptSubscribe,
    dispatch,
    disposeAITypingVisual,
    realtimeSnapshot,
    resourceKey,
  ]);

  useEffect(() => {
    if (
      subscriptionStatus === 'subscribed' &&
      state.roomStatus === 'ready' &&
      ackedEpochRef.current !== null &&
      catchUpRequestedEpochRef.current === ackedEpochRef.current
    ) {
      void runCatchUp(ackedEpochRef.current);
    }
  }, [runCatchUp, state.roomStatus, subscriptionStatus]);

  useEffect(() => {
    if (!accessGranted) {
      return;
    }
    return realtime.subscribeAll((envelope) => {
      const event = parseChatRealtimeEvent(envelope);
      if (
        event === null ||
        event.trip_id !== tripId ||
        !isResourceCurrent(resourceKey) ||
        kickedRef.current
      ) {
        return;
      }

      switch (event.type) {
        case 'chat.subscribed': {
          const snapshot = snapshotRef.current;
          if (
            !focusedRef.current ||
            snapshot.status !== 'connected' ||
            sentEpochRef.current !== snapshot.connectionEpoch
          ) {
            return;
          }
          ackedEpochRef.current = snapshot.connectionEpoch;
          rejectedEpochRef.current = null;
          catchUpRequestedEpochRef.current = snapshot.connectionEpoch;
          setSubscriptionStatus('subscribed');
          clearNonterminalRoomError();
          ensureAITypingVisual(snapshot.connectionEpoch);
          if (stateRef.current.roomStatus === 'ready') {
            void runCatchUp(snapshot.connectionEpoch);
          }
          return;
        }
        case 'chat.unsubscribed': {
          const snapshot = snapshotRef.current;
          const rejectedCurrentAttempt =
            rejectedEpochRef.current === snapshot.connectionEpoch;
          const activeCatchUp = catchUpRunRef.current;
          if (activeCatchUp !== null) {
            activeCatchUp.controller.abort();
            if (catchUpRunRef.current === activeCatchUp) {
              catchUpRunRef.current = null;
              dispatch({ type: 'CATCHUP_PHASE', resourceKey, phase: null });
            }
          }
          ackedEpochRef.current = null;
          catchUpRequestedEpochRef.current = null;
          disposeAITypingVisual();
          if (focusedRef.current && !rejectedCurrentAttempt) {
            if (sentEpochRef.current === snapshot.connectionEpoch) {
              setSubscriptionStatus('subscribing');
            } else {
              setSubscriptionStatus('waiting');
              attemptSubscribe();
            }
          }
          return;
        }
        case 'chat.message':
          dispatch({
            type: 'UPSERT',
            resourceKey,
            messages: [event.message],
          });
          return;
        case 'chat.message_deleted':
          if (deleteLocksRef.current.has(event.message.id)) {
            const priorProof = liveDeleteProofsRef.current.get(event.message.id);
            if (
              priorProof === undefined ||
              event.message.change_sequence >
                priorProof.message.change_sequence
            ) {
              liveDeleteProofsRef.current.set(event.message.id, {
                message: event.message,
              });
            }
          }
          dispatch({
            type: 'PATCH_KNOWN',
            resourceKey,
            messages: [event.message],
          });
          return;
        case 'chat.reaction_update':
          if (reactionLocksRef.current.has(event.message_id)) {
            const priorProof = liveReactionProofsRef.current.get(
              event.message_id,
            );
            if (
              priorProof === undefined ||
              event.change_sequence > priorProof.changeSequence
            ) {
              liveReactionProofsRef.current.set(event.message_id, {
                reactions: event.reactions,
                changeSequence: event.change_sequence,
                updatedAt: event.updated_at,
              });
            }
          }
          dispatch({
            type: 'REACTION_PATCH',
            resourceKey,
            messageId: event.message_id,
            reactions: event.reactions,
            changeSequence: event.change_sequence,
            updatedAt: event.updated_at,
          });
          return;
        case 'chat.kicked':
          kickRoom('You no longer have access to this trip chat.');
          return;
        case 'chat.error': {
          if (ACCESS_LOST_ERROR_CODES.has(event.error_code)) {
            kickRoom(event.detail, event.error_code);
            return;
          }
          if (event.error_code === TERMINAL_ERROR_CODE) {
            const error = localFailure(
              event.detail,
              TERMINAL_ERROR_CODE,
              409,
            );
            invalidateMutationOwnership();
            dispatch({
              type: 'TERMINAL_LOCK',
              resourceKey,
              error,
              requestVersion: stateRef.current.version,
            });
          }
          setCurrentRoomError(roomError(event.error_code, event.detail));
          const snapshot = snapshotRef.current;
          const pendingCurrentAttempt =
            focusedRef.current &&
            snapshot.status === 'connected' &&
            sentEpochRef.current === snapshot.connectionEpoch &&
            ackedEpochRef.current !== snapshot.connectionEpoch;
          if (pendingCurrentAttempt) {
            rejectedEpochRef.current = snapshot.connectionEpoch;
            setSubscriptionStatus('rejected');
          }
          return;
        }
        case 'chat.ai_typing_started': {
          const active = aiTypingControllerRef.current;
          const snapshot = snapshotRef.current;
          if (
            active === null ||
            active.resourceKey !== resourceKey ||
            active.focusGeneration !== focusGenerationRef.current ||
            !focusedRef.current ||
            snapshot.status !== 'connected' ||
            active.connectionEpoch !== snapshot.connectionEpoch ||
            ackedEpochRef.current !== snapshot.connectionEpoch
          ) {
            return;
          }
          active.controller.start(
            event.interaction_id,
            event.requested_by_user_id,
          );
          return;
        }
        case 'chat.ai_typing_stopped': {
          const active = aiTypingControllerRef.current;
          const snapshot = snapshotRef.current;
          if (
            active === null ||
            active.resourceKey !== resourceKey ||
            active.focusGeneration !== focusGenerationRef.current ||
            !focusedRef.current ||
            snapshot.status !== 'connected' ||
            active.connectionEpoch !== snapshot.connectionEpoch ||
            ackedEpochRef.current !== snapshot.connectionEpoch
          ) {
            return;
          }
          active.controller.stop(event.interaction_id);
          return;
        }
      }
    });
  }, [
    accessGranted,
    attemptSubscribe,
    clearNonterminalRoomError,
    dispatch,
    disposeAITypingVisual,
    ensureAITypingVisual,
    invalidateMutationOwnership,
    isResourceCurrent,
    kickRoom,
    realtime,
    resourceKey,
    runCatchUp,
    tripId,
  ]);

  const mutationBlockedFailure = useCallback((): ChatApiFailure | null => {
    if (
      activeResourceKeyRef.current !== resourceKey ||
      stateRef.current.resourceKey !== resourceKey
    ) {
      return localFailure(
        'Chat is switching trips. Wait for the new conversation to load.',
        'CHAT_NOT_READY',
      );
    }
    if (accessStatus !== 'granted' || state.roomStatus === 'kicked') {
      return localFailure(
        'You no longer have access to this trip chat.',
        'FORBIDDEN',
        403,
      );
    }
    if (subscriptionStatus === 'rejected') {
      return localFailure(
        currentRoomError?.detail ?? 'This chat room is not subscribed.',
        currentRoomError?.errorCode ?? SUBSCRIPTION_LIMIT_ERROR_CODE,
      );
    }
    if (state.roomStatus !== 'ready') {
      return localFailure(
        'Chat is not ready yet.',
        'CHAT_NOT_READY',
      );
    }
    if (
      state.terminalLocked ||
      tripDetail.detail?.trip.status === 'COMPLETED' ||
      tripDetail.detail?.trip.status === 'CANCELLED'
    ) {
      return localFailure('This trip chat is read-only.', TERMINAL_ERROR_CODE, 409);
    }
    return null;
  }, [
    accessStatus,
    currentRoomError,
    resourceKey,
    state.roomStatus,
    state.terminalLocked,
    subscriptionStatus,
    tripDetail.detail?.trip.status,
  ]);

  const retryInitialLoad = useCallback(async () => {
    if (accessStatus === 'error') {
      clearNonterminalRoomError();
      await refreshTripDetail('initial');
      return;
    }
    if (
      accessStatus === 'granted' &&
      stateRef.current.roomStatus === 'error'
    ) {
      await loadInitialHistory();
    }
  }, [
    accessStatus,
    clearNonterminalRoomError,
    loadInitialHistory,
    refreshTripDetail,
  ]);

  const loadOlder = useCallback(async () => {
    const current = stateRef.current;
    if (
      activeResourceKeyRef.current !== resourceKey ||
      current.resourceKey !== resourceKey ||
      accessGrantedRef.current === false ||
      current.roomStatus === 'kicked' ||
      olderLoadControllerRef.current !== null ||
      current.isLoadingOlder ||
      !current.hasMoreOlder ||
      current.nextOlderCursor === null
    ) {
      return;
    }
    const controller = registerController();
    olderLoadControllerRef.current = controller;
    const requestVersion = current.version;
    dispatch({ type: 'OLDER_START', resourceKey });
    try {
      const response = await listChatHistory(
        tripId,
        { cursor: current.nextOlderCursor, limit: HISTORY_PAGE_SIZE },
        controller.signal,
      );
      if (controller.signal.aborted || !isResourceCurrent(resourceKey)) return;
      dispatch({
        type: 'OLDER_RESOLVED',
        resourceKey,
        messages: response.results,
        nextCursor: response.next_cursor,
        requestVersion,
      });
    } catch (caught: unknown) {
      if (controller.signal.aborted || !isResourceCurrent(resourceKey)) return;
      const error = normalizeChatApiError(caught);
      if (isAccessLost(error)) {
        kickRoom(error.message, error.errorCode ?? 'FORBIDDEN');
      } else {
        dispatch({
          type: 'OLDER_FAILED',
          resourceKey,
          error,
          requestVersion,
        });
      }
    } finally {
      releaseController(controller);
      if (olderLoadControllerRef.current === controller) {
        olderLoadControllerRef.current = null;
      }
    }
  }, [
    dispatch,
    isResourceCurrent,
    kickRoom,
    registerController,
    releaseController,
    resourceKey,
    tripId,
  ]);

  const performSend = useCallback(
    async (
      content: string,
      clientMessageId: string,
      retry: boolean,
    ): Promise<ChatSendOutcome> => {
      const blocked = mutationBlockedFailure();
      if (blocked !== null) return { kind: 'blocked', error: blocked };
      if (sendLocksRef.current.has(clientMessageId)) {
        return {
          kind: 'failed',
          clientMessageId,
          error: localFailure(
            'This message is already being sent.',
            'SEND_IN_PROGRESS',
          ),
        };
      }

      const ownershipToken = Symbol('chat-send');
      sendLocksRef.current.set(clientMessageId, ownershipToken);
      const ownsAttempt = () =>
        sendLocksRef.current.get(clientMessageId) === ownershipToken;
      const controller = registerController();
      mutationControllersRef.current.add(controller);
      const requestVersion = stateRef.current.version;
      if (retry) {
        dispatch({ type: 'RETRY_PENDING', resourceKey, cid: clientMessageId });
      } else if (user) {
        dispatch({
          type: 'ADD_PENDING',
          resourceKey,
          message: createOptimisticMessage(
            tripId,
            user,
            content,
            clientMessageId,
          ),
        });
      }

      try {
        const response = await sendChatMessage(
          tripId,
          { content, clientMessageId },
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          !isResourceCurrent(resourceKey) ||
          !ownsAttempt()
        ) {
          return {
            kind: 'failed',
            clientMessageId,
            error: localFailure('Message send was cancelled.', 'SEND_CANCELLED'),
          };
        }
        dispatch({
          type: 'CONFIRM_PENDING',
          resourceKey,
          cid: clientMessageId,
          message: response.message,
          requestVersion,
        });
        return { kind: response.disposition, clientMessageId };
      } catch (caught: unknown) {
        const error = normalizeChatApiError(caught);
        if (
          controller.signal.aborted ||
          !isResourceCurrent(resourceKey) ||
          !ownsAttempt()
        ) {
          return { kind: 'failed', clientMessageId, error };
        }
        if (hasConfirmedClientId(stateRef.current, clientMessageId)) {
          return {
            kind: retry ? 'replayed' : 'created',
            clientMessageId,
          };
        }
        if (error.errorCode === TERMINAL_ERROR_CODE || isAccessLost(error)) {
          if (retry && !isAccessLost(error)) {
            dispatch({
              type: 'FAIL_PENDING',
              resourceKey,
              cid: clientMessageId,
              error,
              requestVersion,
            });
          } else {
            dispatch({
              type: 'BLOCK_PENDING',
              resourceKey,
              cid: clientMessageId,
              error,
              requestVersion,
            });
          }
          applyAuthoritativeFailure(error);
          return retry && !isAccessLost(error)
            ? { kind: 'failed', clientMessageId, error }
            : { kind: 'blocked', error };
        }
        if (isBlockedSend(error)) {
          dispatch(
            retry
              ? {
                  type: 'FAIL_PENDING',
                  resourceKey,
                  cid: clientMessageId,
                  error,
                  requestVersion,
                }
              : {
                  type: 'BLOCK_PENDING',
                  resourceKey,
                  cid: clientMessageId,
                  error,
                  requestVersion,
                },
          );
          return retry
            ? { kind: 'failed', clientMessageId, error }
            : { kind: 'blocked', error };
        }
        dispatch({
          type: 'FAIL_PENDING',
          resourceKey,
          cid: clientMessageId,
          error,
          requestVersion,
        });
        return { kind: 'failed', clientMessageId, error };
      } finally {
        if (ownsAttempt()) {
          sendLocksRef.current.delete(clientMessageId);
        }
        mutationControllersRef.current.delete(controller);
        releaseController(controller);
      }
    },
    [
      applyAuthoritativeFailure,
      dispatch,
      isResourceCurrent,
      mutationBlockedFailure,
      registerController,
      releaseController,
      resourceKey,
      tripId,
      user,
    ],
  );

  const sendMessage = useCallback(
    async (rawContent: string): Promise<ChatSendOutcome> => {
      const content = rawContent.trim();
      if (content.length === 0 || content.length > 2_000) {
        return {
          kind: 'blocked',
          error: localFailure(
            content.length === 0
              ? 'Message cannot be empty.'
              : 'Message cannot exceed 2000 characters.',
            'INVALID_CONTENT',
            400,
          ),
        };
      }
      return performSend(content, createChatClientMessageId(), false);
    },
    [performSend],
  );

  const retryPending = useCallback(
    async (clientMessageId: string): Promise<ChatSendOutcome> => {
      const pending = selectPendingByClientId(
        stateRef.current,
        clientMessageId,
      );
      if (pending === null) {
        return {
          kind: 'blocked',
          error: localFailure(
            'This message is no longer available to retry.',
            'MESSAGE_NOT_PENDING',
          ),
        };
      }
      return performSend(pending.content, clientMessageId, true);
    },
    [performSend],
  );

  const toggleReaction = useCallback(
    async (
      messageId: string,
      emoji: AllowedReactionEmoji,
    ): Promise<ChatMutationOutcome> => {
      const blocked = mutationBlockedFailure();
      if (blocked !== null) return { kind: 'rejected', error: blocked };
      if (!user || reactionLocksRef.current.has(messageId)) {
        const error = localFailure(
          'This reaction is already being updated.',
          'REACTION_IN_PROGRESS',
        );
        return { kind: 'rejected', error };
      }
      const message = selectMessageById(stateRef.current, messageId);
      if (message === null || message.id.startsWith('optimistic:')) {
        const error = localFailure(
          'This message is not available for reactions.',
          'MESSAGE_NOT_AVAILABLE',
        );
        return { kind: 'rejected', error };
      }

      const operationId = createChatClientMessageId();
      const startMessageVersion = selectMessageVersion(
        stateRef.current,
        messageId,
      );
      liveReactionProofsRef.current.delete(messageId);
      const startChangeSequence = message.change_sequence;
      const requestVersion = stateRef.current.version;
      const existingReaction = message.reactions.find((reaction) =>
        reaction.reacted_by_ids.includes(user.id),
      );
      const removing = existingReaction?.emoji === emoji;
      const optimisticReactions = optimisticReactionSnapshot(
        message.reactions,
        user.id,
        emoji,
      );
      const ownershipToken = Symbol('chat-reaction');
      reactionLocksRef.current.set(messageId, ownershipToken);
      const ownsAttempt = () =>
        reactionLocksRef.current.get(messageId) === ownershipToken;
      dispatch({
        type: 'REACTION_START',
        resourceKey,
        messageId,
        operationId,
        optimisticReactions,
      });
      const controller = registerController();
      mutationControllersRef.current.add(controller);

      try {
        const result = removing
          ? await removeChatReaction(
              tripId,
              messageId,
              emoji,
              controller.signal,
            )
          : await addChatReaction(
              tripId,
              messageId,
              emoji,
              controller.signal,
            );
        if (
          controller.signal.aborted ||
          !isResourceCurrent(resourceKey) ||
          !ownsAttempt()
        ) {
          return {
            kind: 'rejected',
            error: localFailure('Reaction update was cancelled.', 'REACTION_CANCELLED'),
          };
        }
        dispatch({
          type: 'REACTION_SUCCESS',
          resourceKey,
          messageId,
          operationId,
          reactions: result.reactions,
          changeSequence: result.change_sequence,
          updatedAt: result.updated_at,
          requestVersion,
          startMessageVersion,
        });
        return { kind: 'applied' };
      } catch (caught: unknown) {
        const error = normalizeChatApiError(caught);
        const liveProof = ownsAttempt()
          ? liveReactionProofsRef.current.get(messageId)
          : undefined;
        const livePushConfirmed =
          liveProof !== undefined &&
          liveProof.changeSequence > startChangeSequence &&
          confirmsReactionOutcome(
            liveProof.reactions,
            user.id,
            emoji,
            removing,
          );
        if (
          !controller.signal.aborted &&
          isResourceCurrent(resourceKey) &&
          ownsAttempt() &&
          liveProof !== undefined &&
          livePushConfirmed &&
          error.errorCode !== TERMINAL_ERROR_CODE &&
          !isAccessLost(error)
        ) {
          dispatch({
            type: 'REACTION_SUCCESS',
            resourceKey,
            messageId,
            operationId,
            reactions: liveProof.reactions,
            changeSequence: liveProof.changeSequence,
            updatedAt: liveProof.updatedAt,
            requestVersion,
            startMessageVersion,
          });
          return { kind: 'applied' };
        }
        if (
          !controller.signal.aborted &&
          isResourceCurrent(resourceKey) &&
          ownsAttempt()
        ) {
          dispatch({
            type: 'REACTION_FAIL',
            resourceKey,
            messageId,
            operationId,
            error,
            requestVersion,
            startMessageVersion,
          });
          applyAuthoritativeFailure(error, messageId);
        }
        return { kind: 'rejected', error };
      } finally {
        if (ownsAttempt()) {
          reactionLocksRef.current.delete(messageId);
          liveReactionProofsRef.current.delete(messageId);
        }
        mutationControllersRef.current.delete(controller);
        releaseController(controller);
      }
    },
    [
      applyAuthoritativeFailure,
      dispatch,
      isResourceCurrent,
      mutationBlockedFailure,
      registerController,
      releaseController,
      resourceKey,
      tripId,
      user,
    ],
  );

  const deleteMessage = useCallback(
    async (
      messageId: string,
      mode: DeleteChatMessageMode,
    ): Promise<ChatMutationOutcome> => {
      const blocked = mutationBlockedFailure();
      if (blocked !== null) return { kind: 'rejected', error: blocked };
      if (deleteLocksRef.current.has(messageId)) {
        const error = localFailure(
          'This message is already being removed.',
          'DELETE_IN_PROGRESS',
        );
        return { kind: 'rejected', error };
      }
      const ownershipToken = Symbol('chat-delete');
      deleteLocksRef.current.set(messageId, ownershipToken);
      const ownsAttempt = () =>
        deleteLocksRef.current.get(messageId) === ownershipToken;
      liveDeleteProofsRef.current.delete(messageId);
      const startChangeSequence =
        selectMessageById(stateRef.current, messageId)?.change_sequence ?? -1;
      dispatch({ type: 'DELETE_START', resourceKey, messageId });
      const controller = registerController();
      mutationControllersRef.current.add(controller);
      const requestVersion = stateRef.current.version;
      try {
        const result = await deleteChatMessage(
          tripId,
          messageId,
          mode,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          !isResourceCurrent(resourceKey) ||
          !ownsAttempt()
        ) {
          return {
            kind: 'rejected',
            error: localFailure('Message removal was cancelled.', 'DELETE_CANCELLED'),
          };
        }
        if (result.mode === 'for_me') {
          dispatch({
            type: 'HIDE_MESSAGES',
            resourceKey,
            messageIds: result.hidden_message_ids,
            requestVersion,
          });
        } else {
          dispatch({
            type: 'DELETE_SUCCESS',
            resourceKey,
            message: result.message,
            requestVersion,
          });
        }
        return { kind: 'applied' };
      } catch (caught: unknown) {
        const error = normalizeChatApiError(caught);
        const liveDeleteProof = ownsAttempt()
          ? liveDeleteProofsRef.current.get(messageId)
          : undefined;
        const liveTombstoneConfirmed =
          mode === 'for_everyone' &&
          liveDeleteProof !== undefined &&
          liveDeleteProof.message.change_sequence > startChangeSequence &&
          liveDeleteProof.message.is_deleted_for_everyone;
        if (
          !controller.signal.aborted &&
          isResourceCurrent(resourceKey) &&
          ownsAttempt() &&
          liveTombstoneConfirmed &&
          error.errorCode !== TERMINAL_ERROR_CODE &&
          !isAccessLost(error)
        ) {
          return { kind: 'applied' };
        }
        if (
          !controller.signal.aborted &&
          isResourceCurrent(resourceKey) &&
          ownsAttempt()
        ) {
          applyAuthoritativeFailure(error, messageId);
        }
        return { kind: 'rejected', error };
      } finally {
        const stillOwnsAttempt = ownsAttempt();
        if (stillOwnsAttempt) {
          deleteLocksRef.current.delete(messageId);
          liveDeleteProofsRef.current.delete(messageId);
        }
        mutationControllersRef.current.delete(controller);
        releaseController(controller);
        if (stillOwnsAttempt && isResourceCurrent(resourceKey)) {
          dispatch({
            type: 'DELETE_END',
            resourceKey,
            messageId,
            requestVersion,
          });
        }
      }
    },
    [
      applyAuthoritativeFailure,
      dispatch,
      isResourceCurrent,
      mutationBlockedFailure,
      registerController,
      releaseController,
      resourceKey,
      tripId,
    ],
  );

  const hideMessagesForMe = useCallback(
    async (messageIds: readonly string[]): Promise<ChatMutationOutcome> => {
      const blocked = mutationBlockedFailure();
      if (blocked !== null) return { kind: 'rejected', error: blocked };
      if (hideLockRef.current !== null) {
        const error = localFailure(
          'Messages are already being hidden.',
          'HIDE_IN_PROGRESS',
        );
        return { kind: 'rejected', error };
      }
      if (messageIds.length < 1 || messageIds.length > 100) {
        const error = localFailure(
          'Select between 1 and 100 messages.',
          'INVALID_MESSAGE_IDS',
          400,
        );
        return { kind: 'rejected', error };
      }
      const ownershipToken = Symbol('chat-hide');
      hideLockRef.current = ownershipToken;
      const ownsAttempt = () => hideLockRef.current === ownershipToken;
      dispatch({ type: 'HIDE_START', resourceKey });
      const controller = registerController();
      mutationControllersRef.current.add(controller);
      const requestVersion = stateRef.current.version;
      try {
        const result = await hideChatMessages(
          tripId,
          messageIds,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          !isResourceCurrent(resourceKey) ||
          !ownsAttempt()
        ) {
          return {
            kind: 'rejected',
            error: localFailure('Message hiding was cancelled.', 'HIDE_CANCELLED'),
          };
        }
        dispatch({
          type: 'HIDE_MESSAGES',
          resourceKey,
          messageIds: result.hidden_message_ids,
          requestVersion,
        });
        return { kind: 'applied' };
      } catch (caught: unknown) {
        const error = normalizeChatApiError(caught);
        if (
          !controller.signal.aborted &&
          isResourceCurrent(resourceKey) &&
          ownsAttempt()
        ) {
          applyAuthoritativeFailure(error);
        }
        return { kind: 'rejected', error };
      } finally {
        const stillOwnsAttempt = ownsAttempt();
        if (stillOwnsAttempt) {
          hideLockRef.current = null;
        }
        mutationControllersRef.current.delete(controller);
        releaseController(controller);
        if (stillOwnsAttempt && isResourceCurrent(resourceKey)) {
          dispatch({ type: 'HIDE_END', resourceKey, requestVersion });
        }
      }
    },
    [
      applyAuthoritativeFailure,
      dispatch,
      isResourceCurrent,
      mutationBlockedFailure,
      registerController,
      releaseController,
      resourceKey,
      tripId,
    ],
  );

  const visibleState = state.resourceKey === resourceKey;
  const securityAllowsTranscript =
    accessStatus === 'granted' && visibleState && state.roomStatus !== 'kicked';
  const messages = useMemo(
    () => (securityAllowsTranscript ? selectTranscriptMessages(state) : []),
    [securityAllowsTranscript, state],
  );
  const terminal =
    tripStatus === 'COMPLETED' || tripStatus === 'CANCELLED' || state.terminalLocked;
  const readOnly =
    !visibleState ||
    accessStatus !== 'granted' ||
    state.roomStatus !== 'ready' ||
    terminal ||
    subscriptionStatus === 'rejected';
  const accessError =
    accessStatus === 'error'
      ? roomError(
          tripDetail.error?.errorCode ?? 'TRIP_DETAIL_FAILED',
          tripDetail.error?.message ?? 'Trip access could not be verified.',
        )
      : null;
  const transcriptRoomError = visibleState && state.roomError
    ? roomError(
        state.roomError.errorCode ?? 'CHAT_INITIAL_LOAD_FAILED',
        state.roomError.message,
      )
    : null;
  const visibleAIReconciliationError =
    aiReconciliationError?.resourceKey === resourceKey
      ? aiReconciliationError.error
      : null;
  const visibleSubscriptionStatus: ChatSubscriptionStatus =
    !visibleState
      ? 'inactive'
      : subscriptionStatus === 'inactive' || subscriptionStatus === 'rejected'
      ? subscriptionStatus
      : realtimeSnapshot.status === 'connected'
        ? subscriptionStatus
        : 'waiting';
  const visibleAITypingState =
    securityAllowsTranscript &&
    visibleSubscriptionStatus === 'subscribed' &&
    realtimeSnapshot.status === 'connected' &&
    aiTypingPresentation.resourceKey === resourceKey &&
    aiTypingPresentation.connectionEpoch === realtimeSnapshot.connectionEpoch
      ? aiTypingPresentation.state
      : EMPTY_AI_TYPING_STATE;

  return {
    currentUserId: ownerUserId,
    tripStatus,
    accessStatus,
    roomStatus:
      !visibleState || accessStatus === 'checking'
        ? 'loading'
        : accessStatus === 'error'
          ? 'error'
          : state.roomStatus === 'idle'
            ? 'loading'
            : state.roomStatus,
    subscriptionStatus: visibleSubscriptionStatus,
    roomError:
      accessError ??
      (visibleState ? currentRoomError : null) ??
      visibleAIReconciliationError ??
      transcriptRoomError,
    messages,
    pendingClientIds: visibleState ? state.pendingClientIds : EMPTY_ID_SET,
    failedClientIds: visibleState ? state.failedClientIds : EMPTY_ID_SET,
    failedByClientId: visibleState ? state.failedByClientId : EMPTY_FAILURE_MAP,
    pendingReactionMessageIds: visibleState
      ? state.pendingReactionMessageIds
      : EMPTY_ID_SET,
    pendingDeleteMessageIds: visibleState
      ? state.pendingDeleteMessageIds
      : EMPTY_ID_SET,
    hasMoreOlder: securityAllowsTranscript && state.hasMoreOlder,
    isLoadingOlder: visibleState && state.isLoadingOlder,
    olderLoadError: visibleState ? state.olderLoadError : null,
    isGapFilling: visibleState && state.isGapFilling,
    isUpdating: visibleState && state.isUpdating,
    isHidingMessages: visibleState && state.isHidingMessages,
    isReadOnly: readOnly,
    mutationError: visibleState ? state.mutationError : null,
    aiTypingState: visibleAITypingState,
    connectionStatus: realtimeSnapshot.status,
    connectionEpoch: realtimeSnapshot.connectionEpoch,
    aiReconciliationCoordinator,
    ambiguousAIDraftIds: visibleState
      ? (aiDraftObservationIndex.ambiguitySnapshots.get('current') ??
        EMPTY_ID_SET)
      : EMPTY_ID_SET,
    retryInitialLoad,
    loadOlder,
    sendMessage,
    retryPending,
    toggleReaction,
    deleteMessage,
    hideMessagesForMe,
    applyAIDraftSnapshot,
  };
}
