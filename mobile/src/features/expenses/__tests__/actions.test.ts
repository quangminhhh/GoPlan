import type { TripStatus } from '@/features/trips/types';
import {
  getExpenseDashboardActions,
  getExpenseItemActions,
} from '../actions';
import type { TripSettlement } from '../types';

const TRIP_STATUSES: readonly TripStatus[] = [
  'PLANNING',
  'ONGOING',
  'COMPLETED',
  'CANCELLED',
];

const FINALIZED_SETTLEMENT: TripSettlement = {
  id: 'settlement-1',
  status: 'FINALIZED',
  finalized_at: '2026-07-28T00:00:00Z',
  transfers: [],
};

const DASHBOARD_CASES = [false, true].flatMap((canManageExpenses) =>
  TRIP_STATUSES.flatMap((tripStatus) =>
    [null, FINALIZED_SETTLEMENT].flatMap((settlement) =>
      [0, 1].map((expenseCount) => ({
        canManageExpenses,
        tripStatus,
        settlement,
        expenseCount,
      })),
    ),
  ),
);

const ITEM_CASES = [false, true].flatMap((canManageExpenses) =>
  TRIP_STATUSES.flatMap((tripStatus) =>
    [false, true].map((locked) => ({
      canManageExpenses,
      tripStatus,
      locked,
    })),
  ),
);

describe('getExpenseDashboardActions', () => {
  it.each(DASHBOARD_CASES)(
    'covers canManage=$canManageExpenses status=$tripStatus finalized=$settlement expenseCount=$expenseCount',
    ({ canManageExpenses, tripStatus, settlement, expenseCount }) => {
      const isTerminal =
        tripStatus === 'COMPLETED' || tripStatus === 'CANCELLED';
      const isFinalized = settlement !== null;
      const canMutate = canManageExpenses && !isTerminal;

      expect(
        getExpenseDashboardActions({
          canManageExpenses,
          tripStatus,
          settlement,
          expenseCount,
        }),
      ).toEqual({
        canAddExpense: canMutate && !isFinalized,
        canFinalize:
          canMutate && !isFinalized && expenseCount > 0,
        canReopen: canMutate && isFinalized,
      });
    },
  );

  it('executes all 32 required dashboard combinations', () => {
    expect(DASHBOARD_CASES).toHaveLength(32);
  });

  it('ignores an inconsistent client-derived captain guess', () => {
    const staleClientRole = {
      canManageExpenses: false,
      tripStatus: 'PLANNING' as const,
      settlement: null,
      expenseCount: 1,
      isCaptain: true,
    };

    expect(getExpenseDashboardActions(staleClientRole)).toEqual({
      canAddExpense: false,
      canFinalize: false,
      canReopen: false,
    });
  });

  it('does not treat an impossible reopened dashboard object as finalized', () => {
    expect(
      getExpenseDashboardActions({
        canManageExpenses: true,
        tripStatus: 'PLANNING',
        settlement: {
          ...FINALIZED_SETTLEMENT,
          status: 'REOPENED',
        },
        expenseCount: 1,
      }),
    ).toEqual({
      canAddExpense: true,
      canFinalize: true,
      canReopen: false,
    });
  });
});

describe('getExpenseItemActions', () => {
  it.each(ITEM_CASES)(
    'covers canManage=$canManageExpenses status=$tripStatus locked=$locked',
    ({ canManageExpenses, tripStatus, locked }) => {
      const isTerminal =
        tripStatus === 'COMPLETED' || tripStatus === 'CANCELLED';
      const expected = canManageExpenses && !isTerminal && !locked;

      expect(
        getExpenseItemActions({
          canManageExpenses,
          tripStatus,
          locked,
        }),
      ).toEqual({
        canEditExpense: expected,
        canEditContributions: expected,
      });
    },
  );

  it('executes all 16 required item combinations', () => {
    expect(ITEM_CASES).toHaveLength(16);
  });

  it('ignores an inconsistent client-derived captain guess', () => {
    const staleClientRole = {
      canManageExpenses: false,
      tripStatus: 'PLANNING' as const,
      locked: false,
      isCaptain: true,
    };

    expect(getExpenseItemActions(staleClientRole)).toEqual({
      canEditExpense: false,
      canEditContributions: false,
    });
  });
});
