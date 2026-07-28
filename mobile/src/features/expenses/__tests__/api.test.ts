jest.mock('@/shared/api/client', () => ({
  apiClient: {
    delete: jest.fn(),
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { apiClient } from '@/shared/api/client';
// eslint-disable-next-line import/first
import {
  confirmTransferReceived,
  createExpense,
  deleteExpense,
  finalizeSettlement,
  getExpenseDashboard,
  getExpenseDetail,
  markTransferSent,
  reopenSettlement,
  setContribution,
  updateExpense,
} from '../api';

const mockDelete = apiClient.delete as jest.MockedFunction<
  typeof apiClient.delete
>;
const mockGet = apiClient.get as jest.MockedFunction<typeof apiClient.get>;
const mockPatch = apiClient.patch as jest.MockedFunction<
  typeof apiClient.patch
>;
const mockPost = apiClient.post as jest.MockedFunction<typeof apiClient.post>;

describe('expense api', () => {
  beforeEach(() => jest.clearAllMocks());

  it('gets the raw dashboard with cancellation support', async () => {
    const controller = new AbortController();
    const dashboard = {
      currency_code: 'VND',
      summary: {
        total_amount: '100000',
        paid_amount: '0',
        missing_amount: '100000',
        surplus_amount: '0',
      },
      permissions: { can_manage_expenses: true },
      my_balance: { balance: '-50000', surplus_held: '0' },
      member_balances: {},
      settlement: null,
      expenses: [],
    };
    mockGet.mockResolvedValue({ data: dashboard } as never);

    await expect(
      getExpenseDashboard('trip-1', controller.signal),
    ).resolves.toBe(dashboard);
    expect(mockGet).toHaveBeenCalledWith('/trips/trip-1/expenses', {
      signal: controller.signal,
    });
  });

  it('gets the raw expense detail with cancellation support', async () => {
    const controller = new AbortController();
    const detail = { id: 'expense-1', participants: [] };
    mockGet.mockResolvedValue({ data: detail } as never);

    await expect(
      getExpenseDetail('trip-1', 'expense-1', controller.signal),
    ).resolves.toBe(detail);
    expect(mockGet).toHaveBeenCalledWith(
      '/trips/trip-1/expenses/expense-1',
      { signal: controller.signal },
    );
  });

  it('creates an expense and returns the raw create response', async () => {
    const payload = {
      title: 'Hotel',
      description: 'Deposit',
      total_amount: '120.00',
      collector_id: 'user-1',
    };
    const created = {
      id: 'expense-1',
      ...payload,
      currency_code: 'USD',
      locked_at: null,
      created_at: '2026-07-28T00:00:00Z',
    };
    mockPost.mockResolvedValue({ data: created } as never);

    await expect(createExpense('trip-1', payload)).resolves.toBe(created);
    expect(mockPost).toHaveBeenCalledWith(
      '/trips/trip-1/expenses',
      payload,
    );
  });

  it('updates an expense and returns the full raw detail response', async () => {
    const payload = { title: 'New hotel', total_amount: '200.00' };
    const detail = {
      id: 'expense-1',
      title: 'New hotel',
      participants: [],
    };
    mockPatch.mockResolvedValue({ data: detail } as never);

    await expect(
      updateExpense('trip-1', 'expense-1', payload),
    ).resolves.toBe(detail);
    expect(mockPatch).toHaveBeenCalledWith(
      '/trips/trip-1/expenses/expense-1',
      payload,
    );
  });

  it('deletes an expense and returns void for HTTP 204', async () => {
    mockDelete.mockResolvedValue({ data: undefined } as never);

    await expect(
      deleteExpense('trip-1', 'expense-1'),
    ).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledWith(
      '/trips/trip-1/expenses/expense-1',
    );
  });

  it('sets a participant contribution and returns the raw response', async () => {
    const payload = { amount: '0' };
    const contribution = {
      id: 'contribution-1',
      user: {
        id: 'user-1',
        display_name: 'Minh',
        identify_tag: '@minh',
      },
      amount: '0',
      updated_at: '2026-07-28T00:00:00Z',
    };
    mockPatch.mockResolvedValue({ data: contribution } as never);

    await expect(
      setContribution(
        'trip-1',
        'expense-1',
        'user-1',
        payload,
      ),
    ).resolves.toBe(contribution);
    expect(mockPatch).toHaveBeenCalledWith(
      '/trips/trip-1/expenses/expense-1/contributions/user-1',
      payload,
    );
  });

  it('finalizes settlement with no request body and returns the raw settlement', async () => {
    const settlement = {
      id: 'settlement-1',
      status: 'FINALIZED',
      finalized_at: '2026-07-28T00:00:00Z',
      transfers: [],
    };
    mockPost.mockResolvedValue({ data: settlement } as never);

    await expect(finalizeSettlement('trip-1')).resolves.toBe(settlement);
    expect(mockPost).toHaveBeenCalledWith(
      '/trips/trip-1/settlement/finalize',
    );
  });

  it('reopens settlement with no request body and returns the raw settlement', async () => {
    const settlement = {
      id: 'settlement-1',
      status: 'REOPENED',
      finalized_at: '2026-07-28T00:00:00Z',
      transfers: [],
    };
    mockPost.mockResolvedValue({ data: settlement } as never);

    await expect(reopenSettlement('trip-1')).resolves.toBe(settlement);
    expect(mockPost).toHaveBeenCalledWith(
      '/trips/trip-1/settlement/reopen',
    );
  });

  it('marks a transfer sent with no request body and returns the raw transfer', async () => {
    const transfer = {
      id: 'transfer-1',
      payer_marked_sent_at: '2026-07-28T00:00:00Z',
    };
    mockPost.mockResolvedValue({ data: transfer } as never);

    await expect(
      markTransferSent('trip-1', 'transfer-1'),
    ).resolves.toBe(transfer);
    expect(mockPost).toHaveBeenCalledWith(
      '/trips/trip-1/settlement/transfers/transfer-1/sent',
    );
  });

  it('confirms a transfer received with no request body and returns the raw transfer', async () => {
    const transfer = {
      id: 'transfer-1',
      recipient_confirmed_at: '2026-07-28T00:00:00Z',
    };
    mockPost.mockResolvedValue({ data: transfer } as never);

    await expect(
      confirmTransferReceived('trip-1', 'transfer-1'),
    ).resolves.toBe(transfer);
    expect(mockPost).toHaveBeenCalledWith(
      '/trips/trip-1/settlement/transfers/transfer-1/received',
    );
  });
});
