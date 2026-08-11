import {
  confirmAIActionDraft,
  getAIActionDraft,
  isAmbiguousConfirmFailure,
  normalizeAIActionDraftApiError,
  type AIActionDraftApiFailure,
} from './api';
import {
  requireMatchingAIActionDraft,
  type AIActionDraft,
  type AIActionDraftEnvelope,
} from './drafts';
import { reconcileNewlyConfirmedDraft } from './reconciliation';

export type ConfirmResolutionKind =
  | 'idle'
  | 'confirmed'
  | 'ready_for_explicit_confirmation'
  | 'resolved'
  | 'rejected'
  | 'unknown';

export interface ConfirmAmbiguityState {
  readonly kind: ConfirmResolutionKind;
  readonly draft: AIActionDraft;
  readonly failure: AIActionDraftApiFailure | null;
  readonly message: string | null;
  readonly canCheckStatus: boolean;
  readonly observedConfirmed: boolean;
  readonly reconciliationFailed: boolean;
  readonly confirmRetryAtMs: number | null;
}

export interface ConfirmControllerDependencies {
  readonly confirm: (
    tripId: string,
    draftId: string,
    signal?: AbortSignal,
  ) => Promise<AIActionDraftEnvelope>;
  readonly get: (
    tripId: string,
    draftId: string,
    signal?: AbortSignal,
  ) => Promise<AIActionDraftEnvelope>;
  readonly normalizeError: (
    error: unknown,
    operation: 'confirm' | 'get',
    requestedDraftId: string,
  ) => AIActionDraftApiFailure;
  readonly reconcile: (options: {
    readonly tripId: string;
    readonly previousDraft: AIActionDraft;
    readonly nextDraft: AIActionDraft;
  }) => Promise<void>;
}

export const DEFAULT_CONFIRM_CONTROLLER_DEPENDENCIES: ConfirmControllerDependencies = {
  confirm: (tripId, draftId, signal) =>
    confirmAIActionDraft(tripId, draftId, signal),
  get: (tripId, draftId, signal) => getAIActionDraft(tripId, draftId, signal),
  normalizeError: (error, operation, requestedDraftId) =>
    normalizeAIActionDraftApiError(
      error,
      operation,
      Date.now(),
      requestedDraftId,
    ),
  reconcile: async ({ tripId, previousDraft, nextDraft }) => {
    await reconcileNewlyConfirmedDraft({
      tripId,
      previousStatus: previousDraft.status,
      draft: nextDraft,
    });
  },
};

export function createConfirmAmbiguityState(
  draft: AIActionDraft,
): ConfirmAmbiguityState {
  return {
    kind: 'idle',
    draft,
    failure: null,
    message: null,
    canCheckStatus: false,
    observedConfirmed: draft.status === 'CONFIRMED',
    reconciliationFailed: false,
    confirmRetryAtMs: null,
  };
}

function retryDeadlineMs(
  failure: AIActionDraftApiFailure,
  nowMs: number,
): number | null {
  if (failure.status !== 429 || failure.retryAfterMs === null) {
    return null;
  }
  const deadline = nowMs + failure.retryAfterMs;
  return Number.isSafeInteger(deadline) && deadline > nowMs ? deadline : null;
}

function confirmFailureContext(failure: AIActionDraftApiFailure): string {
  if (failure.status !== 429 || failure.retryAfterMs === null) {
    return failure.message;
  }
  const seconds = Math.ceil(failure.retryAfterMs / 1_000);
  return `${failure.message} Retry-After: ${seconds} seconds.`;
}

function resolvedAmbiguousMessage(
  failure: AIActionDraftApiFailure,
  draft: AIActionDraft,
  kind: ConfirmResolutionKind,
): string {
  const context = confirmFailureContext(failure);
  if (kind === 'confirmed') {
    return `${context} The status check shows that the action is confirmed.`;
  }
  if (kind === 'ready_for_explicit_confirmation') {
    const retryInstruction =
      failure.status === 429 && failure.retryAfterMs !== null
        ? ' Wait for the Retry-After deadline.'
        : '';
    return `${context} The status check shows that the action is still ready. No confirmation was sent again.${retryInstruction} Review it before making a new explicit confirmation.`;
  }
  return `${context} The status check returned ${draft.status.toLowerCase()}. No confirmation was sent again.`;
}

function classifyResolvedDraft(draft: AIActionDraft): ConfirmResolutionKind {
  if (draft.status === 'CONFIRMED') {
    return 'confirmed';
  }
  if (draft.status === 'READY') {
    return 'ready_for_explicit_confirmation';
  }
  return 'resolved';
}

async function applyObservedDraft(
  tripId: string,
  state: ConfirmAmbiguityState,
  draft: AIActionDraft,
  dependencies: ConfirmControllerDependencies,
): Promise<ConfirmAmbiguityState> {
  const matchingDraft = requireMatchingAIActionDraft(draft, state.draft.id);
  let reconciliationFailed = state.reconciliationFailed;
  if (!state.observedConfirmed && matchingDraft.status === 'CONFIRMED') {
    try {
      await dependencies.reconcile({
        tripId,
        previousDraft: state.draft,
        nextDraft: matchingDraft,
      });
    } catch {
      reconciliationFailed = true;
    }
  }
  return {
    ...state,
    draft: matchingDraft,
    observedConfirmed:
      state.observedConfirmed || matchingDraft.status === 'CONFIRMED',
    reconciliationFailed,
  };
}

async function resolveWithFollowUpGet(
  tripId: string,
  state: ConfirmAmbiguityState,
  confirmFailure: AIActionDraftApiFailure,
  dependencies: ConfirmControllerDependencies,
  signal?: AbortSignal,
  nowMs: number = Date.now(),
): Promise<ConfirmAmbiguityState> {
  let nextState: ConfirmAmbiguityState = {
    ...state,
    confirmRetryAtMs: retryDeadlineMs(confirmFailure, nowMs),
  };
  if (confirmFailure.draft !== null) {
    nextState = await applyObservedDraft(
      tripId,
      nextState,
      confirmFailure.draft,
      dependencies,
    );
  }

  try {
    const response = await dependencies.get(tripId, state.draft.id, signal);
    nextState = await applyObservedDraft(
      tripId,
      nextState,
      response.draft,
      dependencies,
    );
    const kind = classifyResolvedDraft(response.draft);
    return {
      ...nextState,
      kind,
      failure: confirmFailure,
      message: resolvedAmbiguousMessage(confirmFailure, response.draft, kind),
      canCheckStatus: false,
      confirmRetryAtMs:
        kind === 'ready_for_explicit_confirmation'
          ? nextState.confirmRetryAtMs
          : null,
    };
  } catch (error: unknown) {
    const getFailure = dependencies.normalizeError(error, 'get', state.draft.id);
    if (getFailure.draft !== null) {
      nextState = await applyObservedDraft(
        tripId,
        nextState,
        getFailure.draft,
        dependencies,
      );
    }
    return {
      ...nextState,
      kind: 'unknown',
      failure: confirmFailure,
      message: `${confirmFailureContext(confirmFailure)} The confirmation outcome is unknown because the status check also failed. Use Check status; do not confirm again.`,
      canCheckStatus: true,
    };
  }
}

/**
 * Executes exactly one confirm POST after the UI has collected an explicit
 * approval. It never invokes confirm again. Ambiguous responses immediately
 * follow with GET and otherwise leave a Check status-only state.
 */
export async function confirmDraftAfterExplicitApproval(options: {
  readonly tripId: string;
  readonly state: ConfirmAmbiguityState;
  readonly dependencies?: ConfirmControllerDependencies;
  readonly signal?: AbortSignal;
  readonly nowMs?: number;
}): Promise<ConfirmAmbiguityState> {
  const dependencies =
    options.dependencies ?? DEFAULT_CONFIRM_CONTROLLER_DEPENDENCIES;
  if (!options.state.draft.can_confirm) {
    return {
      ...options.state,
      kind: 'rejected',
      message: 'The server does not allow you to confirm this draft.',
      canCheckStatus: false,
      confirmRetryAtMs: null,
    };
  }

  try {
    const response = await dependencies.confirm(
      options.tripId,
      options.state.draft.id,
      options.signal,
    );
    const nextState = await applyObservedDraft(
      options.tripId,
      options.state,
      response.draft,
      dependencies,
    );
    return {
      ...nextState,
      kind: classifyResolvedDraft(response.draft),
      failure: null,
      message: null,
      canCheckStatus: false,
      confirmRetryAtMs: null,
    };
  } catch (error: unknown) {
    const failure = dependencies.normalizeError(
      error,
      'confirm',
      options.state.draft.id,
    );
    if (isAmbiguousConfirmFailure(failure)) {
      return resolveWithFollowUpGet(
        options.tripId,
        options.state,
        failure,
        dependencies,
        options.signal,
        options.nowMs,
      );
    }

    const nextState =
      failure.draft === null
        ? options.state
        : await applyObservedDraft(
            options.tripId,
            options.state,
            failure.draft,
            dependencies,
          );
    return {
      ...nextState,
      kind: 'rejected',
      failure,
      message: failure.message,
      canCheckStatus: false,
      confirmRetryAtMs: null,
    };
  }
}

/** GET-only recovery for an unknown outcome. It cannot execute the action. */
export async function checkConfirmStatus(options: {
  readonly tripId: string;
  readonly state: ConfirmAmbiguityState;
  readonly dependencies?: ConfirmControllerDependencies;
  readonly signal?: AbortSignal;
}): Promise<ConfirmAmbiguityState> {
  const dependencies =
    options.dependencies ?? DEFAULT_CONFIRM_CONTROLLER_DEPENDENCIES;
  try {
    const response = await dependencies.get(
      options.tripId,
      options.state.draft.id,
      options.signal,
    );
    const nextState = await applyObservedDraft(
      options.tripId,
      options.state,
      response.draft,
      dependencies,
    );
    const kind = classifyResolvedDraft(response.draft);
    const originatingFailure = options.state.failure;
    return {
      ...nextState,
      kind,
      failure: null,
      message:
        kind === 'ready_for_explicit_confirmation'
          ? originatingFailure === null
            ? 'The action is still ready. Review it again before confirming.'
            : resolvedAmbiguousMessage(
                originatingFailure,
                response.draft,
                kind,
              )
          : null,
      canCheckStatus: false,
      confirmRetryAtMs:
        kind === 'ready_for_explicit_confirmation'
          ? options.state.confirmRetryAtMs
          : null,
    };
  } catch (error: unknown) {
    const failure = dependencies.normalizeError(
      error,
      'get',
      options.state.draft.id,
    );
    const nextState =
      failure.draft === null
        ? options.state
        : await applyObservedDraft(
            options.tripId,
            options.state,
            failure.draft,
            dependencies,
          );
    return {
      ...nextState,
      kind: 'unknown',
      failure: options.state.failure ?? failure,
      message:
        options.state.failure === null
          ? 'The confirmation outcome is still unknown. Check status again later.'
          : `${confirmFailureContext(options.state.failure)} The confirmation outcome is still unknown. Use Check status again later; do not confirm again.`,
      canCheckStatus: true,
    };
  }
}
