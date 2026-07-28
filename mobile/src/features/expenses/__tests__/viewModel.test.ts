import type { TripMember } from '@/features/trips/types';
import {
  buildExpenseDashboardRows,
  getExpenseDashboardRowKey,
} from '../viewModel';
import type {
  ExpenseDashboardResponse,
  ExpenseListItem,
  SettlementTransfer,
} from '../types';

function buildMember(
  id: string,
  displayName: string,
  identifyTag = `@${id}`,
): TripMember {
  return {
    membership_id: `membership-${id}`,
    user: {
      id,
      display_name: displayName,
      identify_tag: identifyTag,
      avatar_url: null,
    },
    role: 'MEMBER',
    joined_at: '2026-07-28T00:00:00Z',
  };
}

function buildExpense(
  id: string,
  title: string,
): ExpenseListItem {
  return {
    id,
    title,
    description: '',
    total_amount: '100.00',
    paid_amount: '0.00',
    missing_amount: '100.00',
    surplus_amount: '0.00',
    currency_code: 'USD',
    status: 'UNDERFUNDED',
    collector: {
      id: 'member-1',
      display_name: 'Member one',
      identify_tag: '@member-1',
    },
    locked: false,
  };
}

function buildTransfer(
  id: string,
  payerId: string,
  recipientId: string,
): SettlementTransfer {
  return {
    id,
    payer: {
      id: payerId,
      display_name: `Transfer ${payerId}`,
      identify_tag: `@transfer-${payerId}`,
    },
    recipient: {
      id: recipientId,
      display_name: `Transfer ${recipientId}`,
      identify_tag: `@transfer-${recipientId}`,
    },
    amount: '50.00',
    payer_marked_sent_at: null,
    recipient_confirmed_at: null,
  };
}

function buildDashboard(
  overrides: Partial<ExpenseDashboardResponse> = {},
): ExpenseDashboardResponse {
  return {
    currency_code: 'USD',
    summary: {
      total_amount: '200.00',
      paid_amount: '0.00',
      missing_amount: '200.00',
      surplus_amount: '0.00',
    },
    permissions: { can_manage_expenses: true },
    my_balance: { balance: '-100.00', surplus_held: '0.00' },
    member_balances: {},
    settlement: null,
    expenses: [],
    ...overrides,
  };
}

describe('buildExpenseDashboardRows', () => {
  it('builds one stable heterogeneous list in required row order', () => {
    const transferOne = buildTransfer(
      'transfer-1',
      'member-1',
      'departed-1',
    );
    const transferTwo = buildTransfer(
      'transfer-2',
      'departed-1',
      'member-2',
    );
    const expenseOne = buildExpense('expense-1', 'First');
    const expenseTwo = buildExpense('expense-2', 'Second');
    const dashboard = buildDashboard({
      settlement: {
        id: 'settlement-1',
        status: 'FINALIZED',
        finalized_at: '2026-07-28T00:00:00Z',
        transfers: [transferOne, transferTwo],
      },
      member_balances: {
        'member-1': { balance: '-50.00' },
        'departed-1': { balance: '50.00' },
      },
      expenses: [expenseOne, expenseTwo],
    });

    const rows = buildExpenseDashboardRows(dashboard, [
      buildMember('member-1', 'Active member'),
      buildMember('member-2', 'Second member'),
    ]);

    expect(rows).toEqual([
      {
        type: 'transfer',
        key: 'transfer:transfer-1',
        transfer: transferOne,
      },
      {
        type: 'transfer',
        key: 'transfer:transfer-2',
        transfer: transferTwo,
      },
      {
        type: 'member-balance',
        key: 'member-balance:member-1',
        userId: 'member-1',
        displayName: 'Active member',
        identifyTag: '@member-1',
        balance: '-50.00',
      },
      {
        type: 'member-balance',
        key: 'member-balance:departed-1',
        userId: 'departed-1',
        displayName: 'Transfer departed-1',
        identifyTag: '@transfer-departed-1',
        balance: '50.00',
      },
      {
        type: 'expense',
        key: 'expense:expense-1',
        expense: expenseOne,
      },
      {
        type: 'expense',
        key: 'expense:expense-2',
        expense: expenseTwo,
      },
    ]);
  });

  it('preserves backend expense order instead of sorting client-side', () => {
    const dashboard = buildDashboard({
      expenses: [
        buildExpense('expense-new', 'Z newest'),
        buildExpense('expense-old', 'A oldest'),
      ],
    });

    expect(
      buildExpenseDashboardRows(dashboard)
        .filter((row) => row.type === 'expense')
        .map((row) => row.expense.id),
    ).toEqual(['expense-new', 'expense-old']);
  });

  it('falls back to Member and never exposes a raw user id as a name', () => {
    const rawId = '7ca6454d-c94d-4db7-a4ca-e7c6dca8fdab';
    const rows = buildExpenseDashboardRows(
      buildDashboard({
        member_balances: {
          [rawId]: { balance: '0.00' },
        },
      }),
    );
    const balanceRow = rows.find(
      (row) => row.type === 'member-balance',
    );

    expect(balanceRow).toMatchObject({
      type: 'member-balance',
      displayName: 'Member',
      identifyTag: null,
    });
    expect(
      balanceRow?.type === 'member-balance'
        ? balanceRow.displayName
        : null,
    ).not.toBe(rawId);
  });

  it('keeps the active-member name ahead of a conflicting transfer snapshot', () => {
    const rows = buildExpenseDashboardRows(
      buildDashboard({
        member_balances: {
          'member-1': { balance: '0.00' },
        },
        settlement: {
          id: 'settlement-1',
          status: 'FINALIZED',
          finalized_at: '2026-07-28T00:00:00Z',
          transfers: [
            buildTransfer('transfer-1', 'member-1', 'member-2'),
          ],
        },
      }),
      [buildMember('member-1', 'Authoritative active name')],
    );

    expect(rows[1]).toMatchObject({
      type: 'member-balance',
      displayName: 'Authoritative active name',
    });
  });

  it('adds one empty-expense row even for a finalized solo settlement', () => {
    const rows = buildExpenseDashboardRows(
      buildDashboard({
        settlement: {
          id: 'settlement-solo',
          status: 'FINALIZED',
          finalized_at: '2026-07-28T00:00:00Z',
          transfers: [],
        },
      }),
    );

    expect(rows).toEqual([
      {
        type: 'empty',
        key: 'expense:empty',
      },
    ]);
  });

  it('returns stable prefixed keys across rebuilds', () => {
    const dashboard = buildDashboard({
      member_balances: { 'member-1': { balance: '0.00' } },
      expenses: [buildExpense('expense-1', 'Dinner')],
    });
    const first = buildExpenseDashboardRows(dashboard);
    const second = buildExpenseDashboardRows(dashboard);

    expect(first.map(getExpenseDashboardRowKey)).toEqual(
      second.map(getExpenseDashboardRowKey),
    );
    expect(first.map(getExpenseDashboardRowKey)).toEqual([
      'member-balance:member-1',
      'expense:expense-1',
    ]);
  });
});
