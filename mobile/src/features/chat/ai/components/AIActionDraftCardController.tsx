import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  cancelAIActionDraft,
  getAIActionDraft,
  normalizeAIActionDraftApiError,
  patchAIActionDraft,
  type AIActionDraftApiFailure,
} from '../api';
import {
  checkConfirmStatus,
  confirmDraftAfterExplicitApproval,
  createConfirmAmbiguityState,
  DEFAULT_CONFIRM_CONTROLLER_DEPENDENCIES,
  type ConfirmAmbiguityState,
  type ConfirmControllerDependencies,
} from '../confirmController';
import {
  createAIActionDraftControllerSessionStore,
  type AIActionDraftControllerLocalState,
  type AIActionDraftControllerSession,
  type AIActionDraftControllerSessionStore,
  type AIActionDraftPersistedEdit,
  type AIActionDraftRetainedExpiredEdit,
} from '../controllerSession';
import {
  aiActionDraftMutationSnapshotIdentity,
  canonicalizeAIUuid,
  requireMatchingAIActionDraft,
  type AIActionDraft,
} from '../drafts';
import {
  createAIReconciliationCoordinator,
  reconcileNewlyConfirmedDraft,
  type AIReconciliationCoordinator,
} from '../reconciliation';
import {
  useRoomAIActionDraftControllerSessionStore,
  useRoomAIReconciliationCoordinator,
} from '../reconciliationContext';
import {
  ActionDraftCard,
  type AIActionDraftPendingOperation,
  type AIActionDraftSubmittedEdit,
} from './ActionDraftCard';

export interface AIActionDraftCardControllerProps {
  readonly tripId: string;
  readonly draft: AIActionDraft;
  readonly onDraftChanged: (draft: AIActionDraft) => void;
  readonly interactionDisabled?: boolean;
  readonly nowMs?: number;
}

interface AIActionDraftCardControllerResourceProps
  extends AIActionDraftCardControllerProps {
  readonly sessionKey: string;
  readonly sessionStore: AIActionDraftControllerSessionStore;
}

interface OperationScope {
  readonly controller: AbortController;
  readonly generation: number;
}

function localStateForDraft(
  draft: AIActionDraft,
  retainedExpiredEdit: AIActionDraftSubmittedEdit | null = null,
): AIActionDraftControllerLocalState {
  return {
    sourceVersion: aiActionDraftMutationSnapshotIdentity(draft),
    draft,
    feedback: null,
    fieldErrors: null,
    confirmState: createConfirmAmbiguityState(draft),
    retainedExpiredEdit,
  };
}

function isTerminalDraft(draft: AIActionDraft): boolean {
  return (
    draft.status === 'CONFIRMED' ||
    draft.status === 'CANCELLED' ||
    draft.status === 'EXPIRED' ||
    draft.status === 'FAILED'
  );
}

const ROOM_AUTHORITY_ERROR_CODES = new Set([
  'TRIP_TERMINAL',
  'TRIP_NOT_FOUND',
  'FORBIDDEN',
]);

function isRoomAuthoritativeFailure(
  failure: AIActionDraftApiFailure,
): boolean {
  return (
    failure.errorCode !== null &&
    ROOM_AUTHORITY_ERROR_CODES.has(failure.errorCode)
  );
}

const UNKNOWN_CONFIRM_FEEDBACK =
  'The confirmation outcome is unknown. Use Check status; do not confirm again.';

function rebindUnknownConfirmation(
  stored: AIActionDraftControllerLocalState,
  incomingDraft: AIActionDraft,
): AIActionDraftControllerLocalState {
  const message =
    stored.confirmState.message ?? stored.feedback ?? UNKNOWN_CONFIRM_FEEDBACK;
  return {
    ...stored,
    sourceVersion: aiActionDraftMutationSnapshotIdentity(incomingDraft),
    draft: incomingDraft,
    feedback: message,
    fieldErrors: null,
    confirmState: {
      ...stored.confirmState,
      kind: 'unknown',
      draft: incomingDraft,
      message,
      canCheckStatus: true,
    },
    retainedExpiredEdit: null,
  };
}

function stateForIncomingDraft(
  stored: AIActionDraftControllerLocalState,
  incomingDraft: AIActionDraft,
): AIActionDraftControllerLocalState {
  const incomingVersion = aiActionDraftMutationSnapshotIdentity(incomingDraft);
  if (stored.sourceVersion === incomingVersion) {
    return stored;
  }
  if (
    stored.confirmState.kind === 'unknown' &&
    !isTerminalDraft(incomingDraft)
  ) {
    return rebindUnknownConfirmation(stored, incomingDraft);
  }
  if (aiActionDraftMutationSnapshotIdentity(stored.draft) === incomingVersion) {
    return { ...stored, sourceVersion: incomingVersion };
  }
  return localStateForDraft(incomingDraft);
}

function sessionForIncomingDraft(
  stored: AIActionDraftControllerSession | null,
  incomingDraft: AIActionDraft,
  tripId: string,
): AIActionDraftControllerSession {
  if (stored === null) {
    return {
      localState: localStateForDraft(incomingDraft),
      retainedExpiredEdit: null,
      editor: null,
    };
  }
  const incomingVersion = aiActionDraftMutationSnapshotIdentity(incomingDraft);
  if (stored.localState.sourceVersion === incomingVersion) {
    return stored;
  }
  if (
    stored.localState.confirmState.kind === 'unknown' &&
    !isTerminalDraft(incomingDraft)
  ) {
    return {
      localState: rebindUnknownConfirmation(
        stored.localState,
        incomingDraft,
      ),
      retainedExpiredEdit: null,
      editor: null,
    };
  }
  if (
    aiActionDraftMutationSnapshotIdentity(stored.localState.draft) ===
    incomingVersion
  ) {
    return {
      ...stored,
      localState: { ...stored.localState, sourceVersion: incomingVersion },
    };
  }

  const retained = stored.retainedExpiredEdit;
  const editor = stored.editor;
  const sameResource =
    retained !== null &&
    retained.tripId === canonicalResourceId(tripId) &&
    retained.draftId === canonicalResourceId(incomingDraft.id);
  const isCorrelatedExpiry =
    incomingDraft.status === 'EXPIRED' &&
    retained !== null &&
    (retained.submittedSourceIdentity === stored.localState.sourceVersion ||
      stored.localState.draft.status === 'EXPIRED');
  const nextRetained =
    sameResource && isCorrelatedExpiry
      ? retained
      : incomingDraft.status === 'EXPIRED' &&
          editor !== null &&
          editor.tripId === canonicalResourceId(tripId) &&
          editor.draftId === canonicalResourceId(incomingDraft.id) &&
          editor.submittedSourceIdentity === stored.localState.sourceVersion
        ? editor
        : null;
  return {
    localState: localStateForDraft(incomingDraft, nextRetained),
    retainedExpiredEdit: nextRetained,
    editor: null,
  };
}

const DETACHED_CONFIRM_FEEDBACK =
  'The confirmation outcome is unknown because this draft left the visible list. Use Check status; do not confirm again.';

const INTERRUPTED_CONFIRM_FEEDBACK =
  'The confirmation outcome is unknown because newer draft information arrived before confirmation completed. Use Check status; do not confirm again.';

const INTERACTION_DISABLED_CONFIRM_FEEDBACK =
  'The confirmation outcome is unknown because draft actions became unavailable before confirmation completed. When available, use Check status; do not confirm again.';

function failClosedConfirm(
  state: AIActionDraftControllerLocalState,
  feedback: string,
): AIActionDraftControllerLocalState {
  return {
    ...state,
    feedback,
    confirmState: {
      ...state.confirmState,
      kind: 'unknown',
      draft: state.draft,
      message: feedback,
      canCheckStatus: true,
    },
  };
}

function failClosedDetachedConfirm(
  state: AIActionDraftControllerLocalState,
): AIActionDraftControllerLocalState {
  return failClosedConfirm(state, DETACHED_CONFIRM_FEEDBACK);
}

const DETACHED_PATCH_FEEDBACK =
  'The draft update was interrupted when this card left the visible list. Review the saved local values before trying again.';

const INTERACTION_DISABLED_PATCH_FEEDBACK =
  'The draft update was interrupted because draft actions became unavailable. Review the saved local values before trying again.';

function controllerResourceKey(tripId: string, draft: AIActionDraft): string {
  return JSON.stringify([
    canonicalResourceId(tripId),
    canonicalResourceId(draft.id),
  ]);
}

function canonicalResourceId(value: string): string {
  return canonicalizeAIUuid(value) ?? value.trim().toLowerCase();
}

function cancelOutcomeFeedback(
  draft: AIActionDraft,
  reconciliationFailed: boolean,
): string {
  const suffix = reconciliationFailed
    ? ' Another trip screen could not refresh automatically.'
    : '';
  if (draft.status === 'CANCELLED') {
    return 'Draft cancelled.';
  }
  if (draft.status === 'CONFIRMED') {
    return `The draft was already confirmed and could not be cancelled.${suffix}`;
  }
  if (draft.status === 'EXPIRED') {
    return 'The draft expired before it could be cancelled.';
  }
  if (draft.status === 'FAILED') {
    return 'The draft failed and was not cancelled.';
  }
  return `The draft was not cancelled. Latest status: ${draft.status}.`;
}

function AIActionDraftCardControllerResource({
  tripId,
  draft: incomingDraft,
  onDraftChanged,
  interactionDisabled = false,
  nowMs,
  sessionKey,
  sessionStore,
}: AIActionDraftCardControllerResourceProps) {
  const [initialSession] = useState<AIActionDraftControllerSession>(() => {
    return sessionForIncomingDraft(
      sessionStore.get(sessionKey),
      incomingDraft,
      tripId,
    );
  });
  const [localState, setLocalState] =
    useState<AIActionDraftControllerLocalState>(initialSession.localState);
  const localStateRef = useRef(initialSession.localState);
  const [retainedExpiredEdit, setRetainedExpiredEditState] =
    useState<AIActionDraftRetainedExpiredEdit | null>(
      initialSession.retainedExpiredEdit,
    );
  const retainedExpiredEditRef =
    useRef<AIActionDraftRetainedExpiredEdit | null>(
      initialSession.retainedExpiredEdit,
    );
  const [editor, setEditorState] =
    useState<AIActionDraftPersistedEdit | null>(initialSession.editor);
  const editorRef =
    useRef<AIActionDraftPersistedEdit | null>(initialSession.editor);
  const [pending, setPending] = useState<AIActionDraftPendingOperation>(null);
  const pendingRef = useRef<AIActionDraftPendingOperation>(null);
  const currentState = stateForIncomingDraft(localState, incomingDraft);
  const { draft, feedback, fieldErrors, confirmState } = currentState;
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const interactionDisabledRef = useRef(interactionDisabled);
  const generationRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const reportedRoomAuthorityScopesRef = useRef(
    new WeakSet<OperationScope>(),
  );
  const incomingSourceIdentity =
    aiActionDraftMutationSnapshotIdentity(incomingDraft);
  const previousIncomingDraftRef = useRef(incomingDraft);
  const activeIncomingSourceIdentityRef = useRef(incomingSourceIdentity);
  const roomReconciliationCoordinator =
    useRoomAIReconciliationCoordinator();
  const fallbackReconciliationCoordinatorRef =
    useRef<AIReconciliationCoordinator | null>(null);
  if (fallbackReconciliationCoordinatorRef.current === null) {
    const fallback = createAIReconciliationCoordinator({
      tripId,
      reconcile: reconcileNewlyConfirmedDraft,
    });
    fallback.seedConfirmedDrafts([incomingDraft]);
    fallbackReconciliationCoordinatorRef.current = fallback;
  }
  const reconciliationCoordinator =
    roomReconciliationCoordinator !== null &&
    canonicalResourceId(roomReconciliationCoordinator.tripId) ===
      canonicalResourceId(tripId)
      ? roomReconciliationCoordinator
      : fallbackReconciliationCoordinatorRef.current;

  const persistSession = useCallback(
    (
      nextLocalState: AIActionDraftControllerLocalState =
        localStateRef.current,
      nextRetainedExpiredEdit: AIActionDraftRetainedExpiredEdit | null =
        retainedExpiredEditRef.current,
      nextEditor: AIActionDraftPersistedEdit | null = editorRef.current,
    ): void => {
      localStateRef.current = nextLocalState;
      retainedExpiredEditRef.current = nextRetainedExpiredEdit;
      editorRef.current = nextEditor;
      sessionStore.set(sessionKey, {
        localState: nextLocalState,
        retainedExpiredEdit: nextRetainedExpiredEdit,
        editor: nextEditor,
      });
    },
    [sessionKey, sessionStore],
  );

  const retainExpiredEdit = (
    next: AIActionDraftRetainedExpiredEdit | null,
  ): void => {
    persistSession(localStateRef.current, next, editorRef.current);
    if (mountedRef.current) {
      setRetainedExpiredEditState(next);
    }
  };

  const setEditor = (next: AIActionDraftPersistedEdit | null): void => {
    persistSession(
      localStateRef.current,
      retainedExpiredEditRef.current,
      next,
    );
    if (mountedRef.current) {
      setEditorState(next);
    }
  };

  useLayoutEffect(() => {
    mountedRef.current = true;
    persistSession();
    return () => {
      if (pendingRef.current === 'confirm') {
        const failClosed = failClosedDetachedConfirm(localStateRef.current);
        persistSession(
          failClosed,
          retainedExpiredEditRef.current,
          editorRef.current,
        );
      } else if (pendingRef.current === 'patch') {
        persistSession(
          {
            ...localStateRef.current,
            feedback: DETACHED_PATCH_FEEDBACK,
          },
          retainedExpiredEditRef.current,
          editorRef.current,
        );
      }
      mountedRef.current = false;
      busyRef.current = false;
      pendingRef.current = null;
      generationRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, [persistSession]);

  useLayoutEffect(() => {
    if (activeIncomingSourceIdentityRef.current === incomingSourceIdentity) {
      return;
    }
    const interruptedOperation = pendingRef.current;
    activeIncomingSourceIdentityRef.current = incomingSourceIdentity;
    generationRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    busyRef.current = false;
    pendingRef.current = null;
    setPending(null);
    let nextSession = sessionForIncomingDraft(
      {
        localState: localStateRef.current,
        retainedExpiredEdit: retainedExpiredEditRef.current,
        editor: editorRef.current,
      },
      incomingDraft,
      tripId,
    );
    if (
      interruptedOperation === 'confirm' &&
      !isTerminalDraft(incomingDraft)
    ) {
      nextSession = {
        ...nextSession,
        localState: failClosedConfirm(
          nextSession.localState,
          INTERRUPTED_CONFIRM_FEEDBACK,
        ),
      };
    }
    persistSession(
      nextSession.localState,
      nextSession.retainedExpiredEdit,
      nextSession.editor,
    );
    setLocalState(nextSession.localState);
    setRetainedExpiredEditState(nextSession.retainedExpiredEdit);
    setEditorState(nextSession.editor);
  }, [incomingDraft, incomingSourceIdentity, persistSession, tripId]);

  const ownsScope = (scope: OperationScope): boolean =>
    mountedRef.current &&
    generationRef.current === scope.generation &&
    activeControllerRef.current === scope.controller;

  const isLiveScope = (scope: OperationScope): boolean =>
    ownsScope(scope) && !scope.controller.signal.aborted;

  const updateCurrentState = useCallback(
    (
      update: (
        state: AIActionDraftControllerLocalState,
      ) => AIActionDraftControllerLocalState,
    ): void => {
      if (!mountedRef.current) {
        return;
      }
      const next = update(
        stateForIncomingDraft(localStateRef.current, incomingDraft),
      );
      persistSession(
        next,
        retainedExpiredEditRef.current,
        editorRef.current,
      );
      setLocalState(next);
    },
    [incomingDraft, persistSession],
  );

  useLayoutEffect(() => {
    const becameDisabled =
      interactionDisabled && !interactionDisabledRef.current;
    interactionDisabledRef.current = interactionDisabled;
    if (!becameDisabled) {
      return;
    }

    const interruptedOperation = pendingRef.current;
    if (
      interruptedOperation === null ||
      interruptedOperation === 'check'
    ) {
      return;
    }

    generationRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    busyRef.current = false;
    pendingRef.current = null;
    setPending(null);

    if (interruptedOperation === 'confirm') {
      updateCurrentState((state) =>
        failClosedConfirm(state, INTERACTION_DISABLED_CONFIRM_FEEDBACK),
      );
    } else if (interruptedOperation === 'patch') {
      updateCurrentState((state) => ({
        ...state,
        feedback: INTERACTION_DISABLED_PATCH_FEEDBACK,
      }));
    }
  }, [interactionDisabled, updateCurrentState]);

  const reconcileConfirmedOnce = useCallback(
    (
      previousStatus: AIActionDraft['status'],
      nextDraft: AIActionDraft,
    ): Promise<void> =>
      reconciliationCoordinator
        .reconcile({ previousStatus, draft: nextDraft })
        .then(() => undefined),
    [reconciliationCoordinator],
  );

  const confirmDependencies: ConfirmControllerDependencies = {
    ...DEFAULT_CONFIRM_CONTROLLER_DEPENDENCIES,
    reconcile: async ({ previousDraft, nextDraft }) => {
      await reconcileConfirmedOnce(previousDraft.status, nextDraft);
    },
  };

  const showContractFailure = (scope: OperationScope): void => {
    if (!isLiveScope(scope)) {
      return;
    }
    updateCurrentState((state) => ({
      ...state,
      feedback: 'The AI action draft server returned an invalid response.',
    }));
  };

  const reportRoomAuthority = (
    failure: AIActionDraftApiFailure | null,
    scope: OperationScope,
  ): void => {
    if (
      failure !== null &&
      isLiveScope(scope) &&
      isRoomAuthoritativeFailure(failure) &&
      !reportedRoomAuthorityScopesRef.current.has(scope)
    ) {
      reportedRoomAuthorityScopesRef.current.add(scope);
      reconciliationCoordinator.reportAuthoritativeFailure(failure);
    }
  };

  const confirmDependenciesForScope = (
    scope: OperationScope,
  ): ConfirmControllerDependencies => ({
    ...confirmDependencies,
    normalizeError: (error, operation, requestedDraftId) => {
      const failure = confirmDependencies.normalizeError(
        error,
        operation,
        requestedDraftId,
      );
      reportRoomAuthority(failure, scope);
      return failure;
    },
    reconcile: async (options) => {
      if (!isLiveScope(scope)) {
        return;
      }
      await confirmDependencies.reconcile(options);
    },
  });

  const applyDraft = (
    next: AIActionDraft,
    requestedDraftId: string,
    scope: OperationScope,
  ): AIActionDraft | null => {
    if (!isLiveScope(scope)) {
      return null;
    }
    let matchingDraft: AIActionDraft;
    try {
      matchingDraft = requireMatchingAIActionDraft(next, requestedDraftId);
    } catch {
      showContractFailure(scope);
      return null;
    }
    updateCurrentState((state) => ({ ...state, draft: matchingDraft }));
    if (isLiveScope(scope)) {
      onDraftChanged(matchingDraft);
    }
    return matchingDraft;
  };

  const applyConfirmState = (
    next: ConfirmAmbiguityState,
    requestedDraftId: string,
    scope: OperationScope,
  ): boolean => {
    if (!isLiveScope(scope)) {
      return false;
    }
    let matchingDraft: AIActionDraft;
    try {
      matchingDraft = requireMatchingAIActionDraft(
        next.draft,
        requestedDraftId,
      );
    } catch {
      showContractFailure(scope);
      return false;
    }
    const nextFeedback = next.reconciliationFailed
      ? 'The action was confirmed, but another trip screen could not refresh automatically.'
      : next.message;
    const matchingConfirmState = { ...next, draft: matchingDraft };
    updateCurrentState((state) => ({
      ...state,
      draft: matchingDraft,
      confirmState: matchingConfirmState,
      feedback: nextFeedback,
    }));
    if (isLiveScope(scope)) {
      onDraftChanged(matchingDraft);
    }
    return true;
  };

  const begin = (
    operation: Exclude<AIActionDraftPendingOperation, null>,
  ): OperationScope | null => {
    if (
      !mountedRef.current ||
      busyRef.current ||
      interactionDisabledRef.current
    ) {
      return null;
    }
    const controller = new AbortController();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    activeControllerRef.current = controller;
    busyRef.current = true;
    pendingRef.current = operation;
    setPending(operation);
    updateCurrentState((state) => ({ ...state, feedback: null }));
    return { controller, generation };
  };

  const finish = (scope: OperationScope): void => {
    if (!ownsScope(scope)) {
      return;
    }
    activeControllerRef.current = null;
    busyRef.current = false;
    pendingRef.current = null;
    setPending(null);
  };

  const persistedEditFor = (
    current: AIActionDraft,
    edit: AIActionDraftSubmittedEdit,
  ): AIActionDraftPersistedEdit => ({
    ...edit,
    tripId: canonicalResourceId(tripId),
    draftId: canonicalResourceId(current.id),
    submittedSourceIdentity: aiActionDraftMutationSnapshotIdentity(current),
  });

  const persistEditableDraft = (
    edit: AIActionDraftSubmittedEdit | null,
  ): void => {
    setEditor(edit === null ? null : persistedEditFor(draft, edit));
  };

  const preflightMutation = async (
    current: AIActionDraft,
    permission: 'can_edit' | 'can_confirm' | 'can_cancel',
    scope: OperationScope,
  ): Promise<AIActionDraft | null> => {
    let freshDraft: AIActionDraft;
    try {
      const response = await getAIActionDraft(
        tripId,
        current.id,
        scope.controller.signal,
      );
      if (!isLiveScope(scope)) {
        return null;
      }
      freshDraft = requireMatchingAIActionDraft(response.draft, current.id);
    } catch (error: unknown) {
      if (!isLiveScope(scope)) {
        return null;
      }
      const failure = normalizeAIActionDraftApiError(
        error,
        'get',
        Date.now(),
        current.id,
      );
      reportRoomAuthority(failure, scope);
      if (failure.draft !== null) {
        let matchingFailureDraft: AIActionDraft;
        try {
          matchingFailureDraft = requireMatchingAIActionDraft(
            failure.draft,
            current.id,
          );
        } catch {
          showContractFailure(scope);
          return null;
        }
        let reconciliationFailed = false;
        try {
          await reconcileConfirmedOnce(current.status, matchingFailureDraft);
        } catch {
          reconciliationFailed = true;
        }
        if (!isLiveScope(scope)) {
          return null;
        }
        if (matchingFailureDraft.status !== 'EXPIRED') {
          retainExpiredEdit(null);
        }
        setEditor(null);
        applyDraft(matchingFailureDraft, current.id, scope);
        updateCurrentState((state) => ({
          ...state,
          draft: matchingFailureDraft,
          confirmState: createConfirmAmbiguityState(matchingFailureDraft),
          feedback: reconciliationFailed
            ? 'The action was confirmed, but another trip screen could not refresh automatically.'
            : failure.message,
        }));
        return null;
      }
      updateCurrentState((state) => ({
        ...state,
        feedback: failure.message,
      }));
      return null;
    }

    const changed =
      aiActionDraftMutationSnapshotIdentity(freshDraft) !==
      aiActionDraftMutationSnapshotIdentity(current);
    if (changed || !freshDraft[permission]) {
      let reconciliationFailed = false;
      try {
        await reconcileConfirmedOnce(current.status, freshDraft);
      } catch {
        reconciliationFailed = true;
      }
      if (!isLiveScope(scope)) {
        return null;
      }
      if (freshDraft.status !== 'EXPIRED') {
        retainExpiredEdit(null);
      }
      setEditor(null);
      const feedback = reconciliationFailed
        ? 'The draft changed on the server. The action is confirmed, but another trip screen could not refresh automatically.'
        : 'The draft changed on the server. Review the latest values before trying again.';
      applyDraft(freshDraft, current.id, scope);
      updateCurrentState((state) => ({
        ...state,
        draft: freshDraft,
        confirmState: createConfirmAmbiguityState(freshDraft),
        fieldErrors: null,
        feedback,
      }));
      return null;
    }
    return freshDraft;
  };

  const patch = async (
    current: AIActionDraft,
    payload: Readonly<Record<string, unknown>>,
    submittedEdit: AIActionDraftSubmittedEdit,
  ): Promise<void> => {
    if (!current.can_edit) {
      return;
    }
    const scope = begin('patch');
    if (scope === null) {
      return;
    }
    updateCurrentState((state) => ({ ...state, fieldErrors: null }));
    const submittedResource = persistedEditFor(current, submittedEdit);
    retainExpiredEdit(submittedResource);
    setEditor(submittedResource);
    try {
      const authoritative = await preflightMutation(
        current,
        'can_edit',
        scope,
      );
      if (authoritative === null) {
        return;
      }
      const response = await patchAIActionDraft(
        tripId,
        authoritative.id,
        payload,
        scope.controller.signal,
      );
      if (!isLiveScope(scope)) {
        return;
      }
      let responseDraft: AIActionDraft;
      try {
        responseDraft = requireMatchingAIActionDraft(
          response.draft,
          authoritative.id,
        );
      } catch {
        showContractFailure(scope);
        return;
      }
      retainExpiredEdit(null);
      setEditor(null);
      const nextConfirmState = createConfirmAmbiguityState(responseDraft);
      if (applyDraft(responseDraft, authoritative.id, scope) === null) {
        return;
      }
      updateCurrentState((state) => ({
        ...state,
        draft: responseDraft,
        confirmState: nextConfirmState,
        feedback: 'Draft updated.',
        retainedExpiredEdit: null,
      }));
    } catch (error: unknown) {
      if (!isLiveScope(scope)) {
        return;
      }
      const failure = normalizeAIActionDraftApiError(
        error,
        'patch',
        Date.now(),
        current.id,
      );
      reportRoomAuthority(failure, scope);
      let failureDraft: AIActionDraft | null = null;
      if (failure.draft !== null) {
        try {
          failureDraft = requireMatchingAIActionDraft(
            failure.draft,
            current.id,
          );
        } catch {
          failureDraft = null;
        }
      }
      const expired =
        failure.errorCode === 'AI_DRAFT_EXPIRED' ||
        failureDraft?.status === 'EXPIRED';
      if (expired) {
        const retainedResource: AIActionDraftRetainedExpiredEdit = {
          ...submittedEdit,
          tripId: canonicalResourceId(tripId),
          draftId: canonicalResourceId(current.id),
          submittedSourceIdentity:
            aiActionDraftMutationSnapshotIdentity(current),
        };
        retainExpiredEdit(retainedResource);
        setEditor(null);
        updateCurrentState((state) => ({
          ...state,
          retainedExpiredEdit: submittedEdit,
        }));
      } else {
        retainExpiredEdit(null);
        if (failureDraft !== null) {
          setEditor(null);
        }
      }
      if (failureDraft !== null) {
        applyDraft(failureDraft, current.id, scope);
      }
      updateCurrentState((state) => ({
        ...state,
        fieldErrors: failure.fieldErrors,
        feedback: expired ? null : failure.message,
      }));
    } finally {
      finish(scope);
    }
  };

  const confirm = async (current: AIActionDraft): Promise<void> => {
    if (
      !current.can_confirm ||
      (confirmState.confirmRetryAtMs !== null &&
        Date.now() < confirmState.confirmRetryAtMs)
    ) {
      return;
    }
    const scope = begin('confirm');
    if (scope === null) {
      return;
    }
    try {
      const authoritative = await preflightMutation(
        current,
        'can_confirm',
        scope,
      );
      if (authoritative === null) {
        return;
      }
      const state =
        confirmState.draft.id === authoritative.id
          ? { ...confirmState, draft: authoritative }
          : createConfirmAmbiguityState(authoritative);
      const next = await confirmDraftAfterExplicitApproval({
        dependencies: confirmDependenciesForScope(scope),
        tripId,
        state,
        signal: scope.controller.signal,
      });
      reportRoomAuthority(next.failure, scope);
      applyConfirmState(next, authoritative.id, scope);
    } finally {
      finish(scope);
    }
  };

  const cancel = async (current: AIActionDraft): Promise<void> => {
    if (!current.can_cancel) {
      return;
    }
    const scope = begin('cancel');
    if (scope === null) {
      return;
    }
    try {
      const authoritative = await preflightMutation(
        current,
        'can_cancel',
        scope,
      );
      if (authoritative === null) {
        return;
      }
      const response = await cancelAIActionDraft(
        tripId,
        authoritative.id,
        scope.controller.signal,
      );
      if (!isLiveScope(scope)) {
        return;
      }
      let responseDraft: AIActionDraft;
      try {
        responseDraft = requireMatchingAIActionDraft(
          response.draft,
          authoritative.id,
        );
      } catch {
        showContractFailure(scope);
        return;
      }
      let reconciliationFailed = false;
      if (responseDraft.status === 'CONFIRMED') {
        try {
          await reconcileConfirmedOnce(authoritative.status, responseDraft);
        } catch {
          reconciliationFailed = true;
        }
      }
      if (!isLiveScope(scope)) {
        return;
      }
      const nextConfirmState = createConfirmAmbiguityState(responseDraft);
      const nextFeedback = cancelOutcomeFeedback(
        responseDraft,
        reconciliationFailed,
      );
      if (applyDraft(responseDraft, authoritative.id, scope) === null) {
        return;
      }
      updateCurrentState((state) => ({
        ...state,
        draft: responseDraft,
        confirmState: nextConfirmState,
        feedback: nextFeedback,
      }));
    } catch (error: unknown) {
      if (!isLiveScope(scope)) {
        return;
      }
      const failure = normalizeAIActionDraftApiError(
        error,
        'cancel',
        Date.now(),
        current.id,
      );
      reportRoomAuthority(failure, scope);
      if (failure.draft !== null) {
        applyDraft(failure.draft, current.id, scope);
      }
      updateCurrentState((state) => ({
        ...state,
        feedback: failure.message,
      }));
    } finally {
      finish(scope);
    }
  };

  const checkStatus = async (): Promise<void> => {
    const scope = begin('check');
    if (scope === null) {
      return;
    }
    try {
      const next = await checkConfirmStatus({
        dependencies: confirmDependenciesForScope(scope),
        tripId,
        state: confirmState,
        signal: scope.controller.signal,
      });
      reportRoomAuthority(next.failure, scope);
      applyConfirmState(next, confirmState.draft.id, scope);
    } finally {
      finish(scope);
    }
  };

  useEffect(() => {
    const previousDraft = previousIncomingDraftRef.current;
    previousIncomingDraftRef.current = incomingDraft;
    if (
      previousDraft.status === 'CONFIRMED' ||
      incomingDraft.status !== 'CONFIRMED'
    ) {
      return;
    }
    const reconciliation = reconcileConfirmedOnce(
      previousDraft.status,
      incomingDraft,
    );
    void reconciliation.catch(() => {
      if (!mountedRef.current) {
        return;
      }
      updateCurrentState((state) => ({
        ...state,
        feedback:
          'The action was confirmed, but another trip screen could not refresh automatically.',
      }));
    });
  }, [
    incomingDraft,
    incomingSourceIdentity,
    reconcileConfirmedOnce,
    updateCurrentState,
  ]);

  const visibleRetainedExpiredEdit =
    draft.status === 'EXPIRED'
      ? (retainedExpiredEdit ?? currentState.retainedExpiredEdit)
      : currentState.retainedExpiredEdit;

  return (
    <ActionDraftCard
      confirmOutcomeUnknown={confirmState.kind === 'unknown'}
      confirmRetryAtMs={confirmState.confirmRetryAtMs}
      draft={draft}
      editableDraftEdit={draft.can_edit ? editor : null}
      feedback={feedback}
      fieldErrors={fieldErrors}
      interactionDisabled={interactionDisabled}
      nowMs={nowMs}
      onCancel={cancel}
      onCheckStatus={checkStatus}
      onConfirm={confirm}
      onEditableDraftEditChange={persistEditableDraft}
      onPatch={patch}
      pending={pending}
      retainedExpiredEdit={visibleRetainedExpiredEdit}
    />
  );
}

export function AIActionDraftCardController(
  props: AIActionDraftCardControllerProps,
) {
  const roomSessionStore =
    useRoomAIActionDraftControllerSessionStore();
  const resourceKey = controllerResourceKey(props.tripId, props.draft);
  const sessionKey = canonicalResourceId(props.draft.id);
  const fallbackSessionStore = useMemo(
    () =>
      createAIActionDraftControllerSessionStore(
        `isolated:${resourceKey}`,
      ),
    [resourceKey],
  );
  const sessionStore = roomSessionStore ?? fallbackSessionStore;
  const instanceKey = JSON.stringify([
    sessionStore.resourceKey,
    resourceKey,
  ]);

  return (
    <AIActionDraftCardControllerResource
      key={instanceKey}
      {...props}
      sessionKey={sessionKey}
      sessionStore={sessionStore}
    />
  );
}
