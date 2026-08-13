import type { AIActionDraftApiFailure } from '../api';
import {
  checkConfirmStatus,
  confirmDraftAfterExplicitApproval,
  createConfirmAmbiguityState,
  type ConfirmControllerDependencies,
} from '../confirmController';
import type { AIActionDraft } from '../drafts';
import { makeDraftFixture as makeDraft } from '../__fixtures__/drafts';

function failure(
  operation: 'confirm' | 'get',
  overrides: Partial<AIActionDraftApiFailure> = {},
): AIActionDraftApiFailure {
  return {
    kind: 'message',
    message: 'Request failed.',
    operation,
    errorCode: null,
    status: 409,
    retryAfterMs: null,
    fieldErrors: null,
    draft: null,
    ...overrides,
  };
}

function dependencies(options: {
  readonly confirmResult?: AIActionDraft;
  readonly confirmError?: AIActionDraftApiFailure;
  readonly getResult?: AIActionDraft;
  readonly getError?: AIActionDraftApiFailure;
}) {
  const confirm = jest.fn(async () => {
    if (options.confirmError !== undefined) {
      throw new Error('confirm failed');
    }
    return { draft: options.confirmResult ?? makeDraft({ status: 'CONFIRMED' }) };
  });
  const get = jest.fn(async () => {
    if (options.getError !== undefined) {
      throw new Error('get failed');
    }
    return { draft: options.getResult ?? makeDraft() };
  });
  const reconcile = jest.fn(async () => undefined);
  const normalizeError: ConfirmControllerDependencies['normalizeError'] = (
    _error,
    operation,
  ) => {
    if (operation === 'confirm') {
      return options.confirmError ?? failure('confirm');
    }
    return options.getError ?? failure('get');
  };
  const value: ConfirmControllerDependencies = {
    confirm,
    get,
    reconcile,
    normalizeError,
  };
  return { value, confirm, get, reconcile };
}

describe('confirm ambiguity controller', () => {
  it('confirms once and reconciles a newly CONFIRMED response', async () => {
    const draft = makeDraft();
    const deps = dependencies({
      confirmResult: makeDraft({
        status: 'CONFIRMED',
        can_confirm: false,
        can_cancel: false,
      }),
    });
    const result = await confirmDraftAfterExplicitApproval({
      tripId: 'trip-1',
      state: createConfirmAmbiguityState(draft),
      dependencies: deps.value,
    });
    expect(result.kind).toBe('confirmed');
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.get).not.toHaveBeenCalled();
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });

  it('after a timeout sends one POST, follows with GET CONFIRMED, and reconciles', async () => {
    const deps = dependencies({
      confirmError: failure('confirm', {
        kind: 'network',
        status: null,
        message: 'Cannot reach the server.',
      }),
      getResult: makeDraft({
        status: 'CONFIRMED',
        can_confirm: false,
        can_cancel: false,
      }),
    });
    const result = await confirmDraftAfterExplicitApproval({
      tripId: 'trip-1',
      state: createConfirmAmbiguityState(makeDraft()),
      dependencies: deps.value,
    });
    expect(result.kind).toBe('confirmed');
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.get).toHaveBeenCalledTimes(1);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['READY', 'ready_for_explicit_confirmation'],
    ['CANCELLED', 'resolved'],
    ['EXPIRED', 'resolved'],
    ['FAILED', 'resolved'],
    ['NEEDS_INFO', 'resolved'],
  ] as const)(
    'maps an ambiguous confirm followed by GET %s without a second POST',
    async (status, kind) => {
      const deps = dependencies({
        confirmError: failure('confirm', { status: 500 }),
        getResult: makeDraft({
          status,
          can_confirm: status === 'READY',
          can_cancel: status === 'READY' || status === 'NEEDS_INFO',
          can_edit: status === 'NEEDS_INFO',
        }),
      });
      const result = await confirmDraftAfterExplicitApproval({
        tripId: 'trip-1',
        state: createConfirmAmbiguityState(makeDraft()),
        dependencies: deps.value,
      });
      expect(result.kind).toBe(kind);
      expect(deps.confirm).toHaveBeenCalledTimes(1);
      expect(deps.get).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    failure('confirm', { status: 500 }),
    failure('confirm', { kind: 'throttled', status: 429 }),
    failure('confirm', { kind: 'network', status: null }),
    failure('confirm', { kind: 'message', status: null }),
  ])('never auto-retries ambiguous timeout/5xx/429 (%#)', async (confirmError) => {
    const deps = dependencies({
      confirmError,
      getError: failure('get', { kind: 'network', status: null }),
    });
    const result = await confirmDraftAfterExplicitApproval({
      tripId: 'trip-1',
      state: createConfirmAmbiguityState(makeDraft()),
      dependencies: deps.value,
    });
    expect(result.kind).toBe('unknown');
    expect(result.canCheckStatus).toBe(true);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.get).toHaveBeenCalledTimes(1);
  });

  it('preserves the confirm limit and Retry-After context when 429 resolves to READY', async () => {
    const deps = dependencies({
      confirmError: failure('confirm', {
        kind: 'throttled',
        status: 429,
        retryAfterMs: 90_000,
        message:
          'GoPlanAI allows 30 action confirmations per hour. Confirmation was not retried; checking the draft status is required.',
      }),
      getResult: makeDraft({
        status: 'READY',
        can_confirm: true,
        can_cancel: true,
      }),
    });
    const result = await confirmDraftAfterExplicitApproval({
      tripId: 'trip-1',
      state: createConfirmAmbiguityState(makeDraft()),
      dependencies: deps.value,
    });
    expect(result.kind).toBe('ready_for_explicit_confirmation');
    expect(result.message).toContain('30 action confirmations per hour');
    expect(result.message).toContain('90 seconds');
    expect(result.message).toContain('new explicit confirmation');
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.get).toHaveBeenCalledTimes(1);
  });

  it('retains 429 metadata and Check status when the follow-up GET also fails', async () => {
    const throttle = failure('confirm', {
      kind: 'throttled',
      status: 429,
      retryAfterMs: 30_000,
      message: 'GoPlanAI allows 30 action confirmations per hour.',
    });
    const deps = dependencies({
      confirmError: throttle,
      getError: failure('get', { kind: 'network', status: null }),
    });
    const result = await confirmDraftAfterExplicitApproval({
      tripId: 'trip-1',
      state: createConfirmAmbiguityState(makeDraft()),
      dependencies: deps.value,
      nowMs: 1_000,
    });
    expect(result.kind).toBe('unknown');
    expect(result.failure).toBe(throttle);
    expect(result.confirmRetryAtMs).toBe(31_000);
    expect(result.message).toContain('30 action confirmations per hour');
    expect(result.message).toContain('Retry-After: 30 seconds');
    expect(result.canCheckStatus).toBe(true);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.get).toHaveBeenCalledTimes(1);
  });

  it('Check status is GET-only and can resolve unknown to CONFIRMED', async () => {
    const firstDeps = dependencies({
      confirmError: failure('confirm', { kind: 'network', status: null }),
      getError: failure('get', { kind: 'network', status: null }),
    });
    const unknown = await confirmDraftAfterExplicitApproval({
      tripId: 'trip-1',
      state: createConfirmAmbiguityState(makeDraft()),
      dependencies: firstDeps.value,
    });
    const checkDeps = dependencies({
      getResult: makeDraft({
        status: 'CONFIRMED',
        can_confirm: false,
        can_cancel: false,
      }),
    });
    const resolved = await checkConfirmStatus({
      tripId: 'trip-1',
      state: unknown,
      dependencies: checkDeps.value,
    });
    expect(resolved.kind).toBe('confirmed');
    expect(checkDeps.confirm).not.toHaveBeenCalled();
    expect(checkDeps.get).toHaveBeenCalledTimes(1);
    expect(checkDeps.reconcile).toHaveBeenCalledTimes(1);
  });

  it('applies optional drafts from non-ambiguous stale/expired/forbidden/not-ready errors', async () => {
    for (const errorCode of [
      'AI_DRAFT_STALE',
      'AI_DRAFT_EXPIRED',
      'AI_DRAFT_FORBIDDEN',
      'AI_DRAFT_NOT_READY',
    ]) {
      const updated = makeDraft({
        status: errorCode === 'AI_DRAFT_EXPIRED' ? 'EXPIRED' : 'READY',
        can_confirm: errorCode !== 'AI_DRAFT_EXPIRED',
      });
      const deps = dependencies({
        confirmError: failure('confirm', {
          errorCode,
          status: errorCode === 'AI_DRAFT_FORBIDDEN' ? 403 : 409,
          draft: updated,
        }),
      });
      const result = await confirmDraftAfterExplicitApproval({
        tripId: 'trip-1',
        state: createConfirmAmbiguityState(makeDraft()),
        dependencies: deps.value,
      });
      expect(result.draft).toBe(updated);
      expect(result.kind).toBe('rejected');
      expect(deps.confirm).toHaveBeenCalledTimes(1);
      expect(deps.get).not.toHaveBeenCalled();
    }
  });

  it('does not POST when the server can_confirm authority is false', async () => {
    const deps = dependencies({});
    const result = await confirmDraftAfterExplicitApproval({
      tripId: 'trip-1',
      state: createConfirmAmbiguityState(makeDraft({ can_confirm: false })),
      dependencies: deps.value,
    });
    expect(result.kind).toBe('rejected');
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.get).not.toHaveBeenCalled();
  });
});
