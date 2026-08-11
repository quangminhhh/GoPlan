export const AI_TYPING_VISUAL_TIMEOUT_MS = 120_000;

export interface AITypingInteraction {
  readonly interactionId: string;
  readonly requestedByUserId: string | null;
  readonly startedAtMs: number;
  readonly visualExpiresAtMs: number;
}

export interface AITypingState {
  readonly active: AITypingInteraction | null;
}

export type AITypingEvent =
  | {
      readonly type: 'started';
      readonly interactionId: string;
      readonly requestedByUserId: string | null;
      readonly nowMs: number;
    }
  | {
      readonly type: 'stopped';
      readonly interactionId: string;
    }
  | {
      readonly type: 'visual_timeout';
      readonly interactionId: string;
      readonly nowMs: number;
    };

export const EMPTY_AI_TYPING_STATE: AITypingState = { active: null };

export function reduceAITypingState(
  state: AITypingState,
  event: AITypingEvent,
): AITypingState {
  if (event.type === 'started') {
    return {
      active: {
        interactionId: event.interactionId,
        requestedByUserId: event.requestedByUserId,
        startedAtMs: event.nowMs,
        visualExpiresAtMs: event.nowMs + AI_TYPING_VISUAL_TIMEOUT_MS,
      },
    };
  }

  if (state.active?.interactionId !== event.interactionId) {
    return state;
  }

  if (event.type === 'stopped') {
    return EMPTY_AI_TYPING_STATE;
  }

  return event.nowMs >= state.active.visualExpiresAtMs
    ? EMPTY_AI_TYPING_STATE
    : state;
}

export interface AITypingTimerScheduler {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface AITypingVisualController {
  readonly getState: () => AITypingState;
  readonly start: (
    interactionId: string,
    requestedByUserId: string | null,
  ) => void;
  readonly stop: (interactionId: string) => void;
  readonly dispose: () => void;
}

/**
 * Timer and clock injection make correlation and the 120-second fallback fully
 * deterministic. The fallback changes visual state only; it never calls a
 * server API or emits a stopped event.
 */
export function createAITypingVisualController(options: {
  readonly scheduler: AITypingTimerScheduler;
  readonly now: () => number;
  readonly onChange: (state: AITypingState) => void;
}): AITypingVisualController {
  let state = EMPTY_AI_TYPING_STATE;
  let timeoutHandle: unknown = null;

  const cancelTimeout = (): void => {
    if (timeoutHandle !== null) {
      options.scheduler.clear(timeoutHandle);
      timeoutHandle = null;
    }
  };

  const publish = (next: AITypingState): void => {
    if (next === state) {
      return;
    }
    state = next;
    options.onChange(state);
  };

  return {
    getState: () => state,
    start: (interactionId, requestedByUserId) => {
      cancelTimeout();
      const nowMs = options.now();
      publish(
        reduceAITypingState(state, {
          type: 'started',
          interactionId,
          requestedByUserId,
          nowMs,
        }),
      );
      timeoutHandle = options.scheduler.set(() => {
        timeoutHandle = null;
        publish(
          reduceAITypingState(state, {
            type: 'visual_timeout',
            interactionId,
            nowMs: options.now(),
          }),
        );
      }, AI_TYPING_VISUAL_TIMEOUT_MS);
    },
    stop: (interactionId) => {
      const next = reduceAITypingState(state, {
        type: 'stopped',
        interactionId,
      });
      if (next !== state) {
        cancelTimeout();
        publish(next);
      }
    },
    dispose: () => {
      cancelTimeout();
    },
  };
}
