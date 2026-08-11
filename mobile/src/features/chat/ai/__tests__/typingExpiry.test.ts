import { getAIActionDraftExpiry, isLocallyExpired } from '../expiry';
import {
  AI_TYPING_VISUAL_TIMEOUT_MS,
  EMPTY_AI_TYPING_STATE,
  createAITypingVisualController,
  reduceAITypingState,
  type AITypingState,
} from '../typingState';
import { makeDraftFixture as makeDraft } from '../__fixtures__/drafts';

describe('GoPlanAI typing correlation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('clears only a matching stopped event', () => {
    const first = reduceAITypingState(EMPTY_AI_TYPING_STATE, {
      type: 'started',
      interactionId: 'interaction-new',
      requestedByUserId: 'user-1',
      nowMs: 1_000,
    });
    expect(
      reduceAITypingState(first, {
        type: 'stopped',
        interactionId: 'interaction-old',
      }),
    ).toBe(first);
    expect(
      reduceAITypingState(first, {
        type: 'stopped',
        interactionId: 'interaction-new',
      }),
    ).toEqual(EMPTY_AI_TYPING_STATE);
  });

  it('uses a 120-second visual-only timeout for the matching interaction', () => {
    const changes: AITypingState[] = [];
    const controller = createAITypingVisualController({
      now: () => Date.now(),
      onChange: (state) => changes.push(state),
      scheduler: {
        set: (callback, delayMs) => setTimeout(callback, delayMs),
        clear: (handle) => {
          if (typeof handle === 'number') {
            clearTimeout(handle);
          }
        },
      },
    });

    controller.start('interaction-1', null);
    jest.advanceTimersByTime(AI_TYPING_VISUAL_TIMEOUT_MS - 1);
    expect(controller.getState().active?.interactionId).toBe('interaction-1');
    jest.advanceTimersByTime(1);
    expect(controller.getState()).toEqual(EMPTY_AI_TYPING_STATE);
    expect(changes).toHaveLength(2);
  });

  it('a late older stop and older timer cannot clear a newer interaction', () => {
    const controller = createAITypingVisualController({
      now: () => Date.now(),
      onChange: jest.fn(),
      scheduler: {
        set: (callback, delayMs) => setTimeout(callback, delayMs),
        clear: (handle) => {
          if (typeof handle === 'number') {
            clearTimeout(handle);
          }
        },
      },
    });
    controller.start('older', 'user-1');
    jest.advanceTimersByTime(60_000);
    controller.start('newer', 'user-2');
    controller.stop('older');
    jest.advanceTimersByTime(60_000);
    expect(controller.getState().active?.interactionId).toBe('newer');
    jest.advanceTimersByTime(60_000);
    expect(controller.getState().active).toBeNull();
  });
});

describe('AI action draft expiry projection', () => {
  const expiresAt = '2026-08-10T05:00:00.000Z';
  const expiresAtMs = Date.parse(expiresAt);

  it('changes an active draft at the exact boundary without mutating server state', () => {
    const draft = makeDraft({ expires_at: expiresAt });
    expect(isLocallyExpired(draft, expiresAtMs - 1)).toBe(false);
    expect(getAIActionDraftExpiry(draft, expiresAtMs - 1)).toMatchObject({
      isExpired: false,
      remainingMs: 1,
      visualStatus: 'READY',
      label: 'Expires in 1s',
    });
    expect(getAIActionDraftExpiry(draft, expiresAtMs)).toEqual({
      isExpired: true,
      remainingMs: 0,
      visualStatus: 'EXPIRED',
      label: 'Expired',
    });
    expect(draft.status).toBe('READY');
  });

  it('never rewrites an already terminal status based on its timestamp', () => {
    const cancelled = makeDraft({ status: 'CANCELLED', expires_at: expiresAt });
    expect(getAIActionDraftExpiry(cancelled, expiresAtMs + 10_000)).toMatchObject({
      isExpired: false,
      visualStatus: 'CANCELLED',
      label: 'Closed',
    });
  });
});
