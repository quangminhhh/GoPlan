import { publishExpenseEvent } from '@/features/expenses/expenseEvents';
import { publishTimelineEvent } from '@/features/timeline/timelineEvents';
import type { ChatApiFailure } from '../types';
import {
  canonicalizeAIUuid,
  isKnownAIActionType,
  type AIActionDraft,
  type AIActionDraftStatus,
  type KnownAIActionType,
} from './drafts';

export type AIReconciliationChannel = 'timeline' | 'expenses';

const CHANNEL_BY_ACTION: Readonly<
  Record<KnownAIActionType, AIReconciliationChannel>
> = {
  'timeline.activity.create': 'timeline',
  'timeline.activity.update': 'timeline',
  'timeline.activity.delete': 'timeline',
  'timeline.activity.status.update': 'timeline',
  'expense.create': 'expenses',
  'expense.update': 'expenses',
  'expense.delete': 'expenses',
  'expense.contribution.set': 'expenses',
  'settlement.finalize': 'expenses',
  'settlement.reopen': 'expenses',
  'settlement.transfer.mark_sent': 'expenses',
  'settlement.transfer.confirm_received': 'expenses',
};

export interface AIReconciliationPublishers {
  readonly timeline: (tripId: string) => void | Promise<void>;
  readonly expenses: (tripId: string) => void | Promise<void>;
}

const DEFAULT_PUBLISHERS: AIReconciliationPublishers = {
  timeline: async (tripId) => {
    await publishTimelineEvent({ type: 'timelineChanged', tripId });
  },
  expenses: async (tripId) => {
    await publishExpenseEvent({ type: 'expensesChanged', tripId });
  },
};

export function reconciliationChannelForAction(
  actionType: string,
): AIReconciliationChannel | null {
  return isKnownAIActionType(actionType)
    ? CHANNEL_BY_ACTION[actionType]
    : null;
}

export async function reconcileNewlyConfirmedDraft(options: {
  readonly tripId: string;
  readonly previousStatus: AIActionDraftStatus;
  readonly draft: AIActionDraft;
  readonly publishers?: AIReconciliationPublishers;
}): Promise<AIReconciliationChannel | null> {
  if (
    options.previousStatus === 'CONFIRMED' ||
    options.draft.status !== 'CONFIRMED'
  ) {
    return null;
  }
  const channel = reconciliationChannelForAction(options.draft.action_type);
  if (channel === null) {
    return null;
  }
  const publishers = options.publishers ?? DEFAULT_PUBLISHERS;
  await publishers[channel](options.tripId);
  return channel;
}

export interface AIReconciliationCoordinator {
  readonly resourceKey: string;
  readonly tripId: string;
  readonly seedConfirmedDrafts: (
    drafts: readonly AIActionDraft[],
  ) => void;
  readonly reconcile: (options: {
    readonly previousStatus: AIActionDraftStatus | null;
    readonly draft: AIActionDraft;
  }) => Promise<AIReconciliationChannel | null>;
  /** Escalates room-level access/terminal authority discovered by a draft API. */
  readonly reportAuthoritativeFailure: (failure: ChatApiFailure) => void;
  readonly setAuthoritativeFailureReporter: (
    reporter: ((failure: ChatApiFailure) => void) | null,
  ) => void;
}

export function createAIReconciliationCoordinator(options: {
  readonly tripId: string;
  readonly resourceKey?: string;
  readonly publishers?: AIReconciliationPublishers;
  readonly reconcile?: typeof reconcileNewlyConfirmedDraft;
  readonly reportAuthoritativeFailure?: (failure: ChatApiFailure) => void;
}): AIReconciliationCoordinator {
  const claims = new Map<
    string,
    Promise<AIReconciliationChannel | null>
  >();
  let authoritativeFailureReporter =
    options.reportAuthoritativeFailure ?? (() => undefined);

  const canonicalDraftId = (draft: AIActionDraft): string =>
    canonicalizeAIUuid(draft.id) ?? draft.id.trim().toLowerCase();

  return {
    resourceKey: options.resourceKey ?? options.tripId,
    tripId: options.tripId,
    reportAuthoritativeFailure: (failure) =>
      authoritativeFailureReporter(failure),
    setAuthoritativeFailureReporter: (reporter) => {
      authoritativeFailureReporter = reporter ?? (() => undefined);
    },
    seedConfirmedDrafts: (drafts) => {
      for (const draft of drafts) {
        if (draft.status !== 'CONFIRMED') {
          continue;
        }
        const draftId = canonicalDraftId(draft);
        if (!claims.has(draftId)) {
          claims.set(draftId, Promise.resolve(null));
        }
      }
    },
    reconcile: ({ previousStatus, draft }) => {
      if (previousStatus === 'CONFIRMED' || draft.status !== 'CONFIRMED') {
        return Promise.resolve(null);
      }
      const draftId = canonicalDraftId(draft);
      const existing = claims.get(draftId);
      if (existing !== undefined) {
        return existing;
      }

      let resolveClaim: (
        channel: AIReconciliationChannel | null,
      ) => void = () => undefined;
      let rejectClaim: (error: unknown) => void = () => undefined;
      const claim = new Promise<AIReconciliationChannel | null>(
        (resolve, reject) => {
          resolveClaim = resolve;
          rejectClaim = reject;
        },
      );
      // Claim before invoking a publisher. A synchronous publisher callback
      // can therefore observe and reuse this exact in-flight Promise.
      claims.set(draftId, claim);
      const reconcile = options.reconcile ?? reconcileNewlyConfirmedDraft;
      void Promise.resolve()
        .then(() =>
          reconcile({
            tripId: options.tripId,
            previousStatus: previousStatus ?? 'READY',
            draft,
            publishers: options.publishers,
          }),
        )
        .then(resolveClaim, rejectClaim);
      return claim;
    },
  };
}
