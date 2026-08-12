jest.mock('@/features/expenses/expenseEvents', () => ({
  publishExpenseEvent: jest.fn(async () => undefined),
}));
jest.mock('@/features/timeline/timelineEvents', () => ({
  publishTimelineEvent: jest.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import { publishExpenseEvent } from '@/features/expenses/expenseEvents';
// eslint-disable-next-line import/first
import { publishTimelineEvent } from '@/features/timeline/timelineEvents';
// eslint-disable-next-line import/first
import { KNOWN_AI_ACTION_TYPES, type AIActionDraftStatus } from '../drafts';
// eslint-disable-next-line import/first
import {
  createAIReconciliationCoordinator,
  reconcileNewlyConfirmedDraft,
  reconciliationChannelForAction,
  type AIReconciliationPublishers,
} from '../reconciliation';
// eslint-disable-next-line import/first
import { makeDraftFixture as makeDraft } from '../__fixtures__/drafts';

const TIMELINE_ACTIONS = [
  'timeline.activity.create',
  'timeline.activity.update',
  'timeline.activity.delete',
  'timeline.activity.status.update',
] as const;

const EXPENSE_ACTIONS = [
  'expense.create',
  'expense.update',
  'expense.delete',
  'expense.contribution.set',
  'settlement.finalize',
  'settlement.reopen',
  'settlement.transfer.mark_sent',
  'settlement.transfer.confirm_received',
] as const;

describe('AI draft cross-surface reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('table covers all twelve backend action types exactly once', () => {
    expect([...TIMELINE_ACTIONS, ...EXPENSE_ACTIONS]).toEqual(
      KNOWN_AI_ACTION_TYPES,
    );
  });

  it.each(TIMELINE_ACTIONS)('%s publishes timelineChanged only', async (actionType) => {
    const timeline = jest.fn(async () => undefined);
    const expenses = jest.fn(async () => undefined);
    const publishers: AIReconciliationPublishers = { timeline, expenses };
    await expect(
      reconcileNewlyConfirmedDraft({
        tripId: 'trip-1',
        previousStatus: 'READY',
        draft: makeDraft({ action_type: actionType, status: 'CONFIRMED' }),
        publishers,
      }),
    ).resolves.toBe('timeline');
    expect(timeline).toHaveBeenCalledWith('trip-1');
    expect(expenses).not.toHaveBeenCalled();
  });

  it.each(EXPENSE_ACTIONS)('%s publishes expensesChanged only', async (actionType) => {
    const timeline = jest.fn(async () => undefined);
    const expenses = jest.fn(async () => undefined);
    const publishers: AIReconciliationPublishers = { timeline, expenses };
    await expect(
      reconcileNewlyConfirmedDraft({
        tripId: 'trip-1',
        previousStatus: 'READY',
        draft: makeDraft({ action_type: actionType, status: 'CONFIRMED' }),
        publishers,
      }),
    ).resolves.toBe('expenses');
    expect(expenses).toHaveBeenCalledWith('trip-1');
    expect(timeline).not.toHaveBeenCalled();
  });

  it.each([
    'NEEDS_INFO',
    'READY',
    'CANCELLED',
    'EXPIRED',
    'FAILED',
  ] as const)('publishes nothing for %s', async (status) => {
    const timeline = jest.fn(async () => undefined);
    const expenses = jest.fn(async () => undefined);
    await reconcileNewlyConfirmedDraft({
      tripId: 'trip-1',
      previousStatus: 'READY',
      draft: makeDraft({ status }),
      publishers: { timeline, expenses },
    });
    expect(timeline).not.toHaveBeenCalled();
    expect(expenses).not.toHaveBeenCalled();
  });

  it('publishes nothing for unknown actions or an already-observed confirmation', async () => {
    const timeline = jest.fn(async () => undefined);
    const expenses = jest.fn(async () => undefined);
    const publishers = { timeline, expenses };
    await reconcileNewlyConfirmedDraft({
      tripId: 'trip-1',
      previousStatus: 'READY',
      draft: makeDraft({ action_type: 'future.action', status: 'CONFIRMED' }),
      publishers,
    });
    await reconcileNewlyConfirmedDraft({
      tripId: 'trip-1',
      previousStatus: 'CONFIRMED',
      draft: makeDraft({ status: 'CONFIRMED' }),
      publishers,
    });
    expect(reconciliationChannelForAction('future.action')).toBeNull();
    expect(timeline).not.toHaveBeenCalled();
    expect(expenses).not.toHaveBeenCalled();
  });

  it('default publishers emit the exact existing timeline/expense event contracts', async () => {
    await reconcileNewlyConfirmedDraft({
      tripId: 'trip-timeline',
      previousStatus: 'READY',
      draft: makeDraft({
        action_type: 'timeline.activity.delete',
        status: 'CONFIRMED',
      }),
    });
    await reconcileNewlyConfirmedDraft({
      tripId: 'trip-expense',
      previousStatus: 'READY',
      draft: makeDraft({
        action_type: 'settlement.transfer.mark_sent',
        status: 'CONFIRMED',
      }),
    });
    expect(publishTimelineEvent).toHaveBeenCalledWith({
      type: 'timelineChanged',
      tripId: 'trip-timeline',
    });
    expect(publishExpenseEvent).toHaveBeenCalledWith({
      type: 'expensesChanged',
      tripId: 'trip-expense',
    });
  });

  it('accepts every status type without deriving from display text', () => {
    const statuses: readonly AIActionDraftStatus[] = [
      'NEEDS_INFO',
      'READY',
      'CONFIRMED',
      'CANCELLED',
      'EXPIRED',
      'FAILED',
    ];
    expect(statuses).toHaveLength(6);
  });

  it('retains one rejected claim when an injected reconciler throws synchronously', async () => {
    const failure = new Error('Synchronous publisher failure.');
    const reconcile = jest.fn(() => {
      throw failure;
    });
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: 'user:trip-1',
      tripId: 'trip-1',
      reconcile,
    });
    const confirmed = makeDraft({ status: 'CONFIRMED' });

    const first = coordinator.reconcile({
      previousStatus: 'READY',
      draft: confirmed,
    });
    const second = coordinator.reconcile({
      previousStatus: 'READY',
      draft: confirmed,
    });

    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('routes room authority only to the currently attached reporter', () => {
    const initialReporter = jest.fn();
    const replacementReporter = jest.fn();
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: 'user:trip-1',
      tripId: 'trip-1',
      reportAuthoritativeFailure: initialReporter,
    });
    const failure = {
      kind: 'message' as const,
      message: 'This trip is read-only.',
      errorCode: 'TRIP_TERMINAL',
      status: 409,
      retryAfterMs: null,
      fieldErrors: null,
    };

    coordinator.reportAuthoritativeFailure(failure);
    coordinator.setAuthoritativeFailureReporter(replacementReporter);
    coordinator.reportAuthoritativeFailure(failure);
    coordinator.setAuthoritativeFailureReporter(null);
    coordinator.reportAuthoritativeFailure(failure);

    expect(initialReporter).toHaveBeenCalledTimes(1);
    expect(replacementReporter).toHaveBeenCalledTimes(1);
  });
});
