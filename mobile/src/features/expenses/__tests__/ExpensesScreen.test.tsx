import type { ReactNode } from 'react';
import { Alert, View } from 'react-native';

let mockParams: Record<string, string | string[] | undefined> = {};
const mockRouter = { push: jest.fn() };
const mockUseSession = jest.fn();
const mockUseExpenseDashboard = jest.fn();
const mockUseTripDetail = jest.fn();
const mockUseExpenseCompositionCoordinator = jest.fn();
const mockRefreshDashboard = jest.fn();
const mockInvalidateDashboard = jest.fn();
const mockRefreshTrip = jest.fn();
const mockRefreshAll = jest.fn();
const mockRequestReconcile = jest.fn();
const mockPublishExpenseEvent = jest.fn();

function mockRenderStackScreen({
  options,
}: {
  options: {
    headerRight?: () => ReactNode;
  };
}) {
  return <View>{options.headerRight?.()}</View>;
}

jest.mock('expo-router', () => ({
  Stack: { Screen: mockRenderStackScreen },
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/features/auth/session', () => ({
  useSession: () => mockUseSession(),
}));
jest.mock('../hooks/useExpenseDashboard', () => ({
  useExpenseDashboard: (...args: unknown[]) =>
    mockUseExpenseDashboard(...args),
}));
jest.mock('@/features/trips/hooks/useTripDetail', () => ({
  useTripDetail: (...args: unknown[]) => mockUseTripDetail(...args),
}));
jest.mock('../hooks/useExpenseCompositionCoordinator', () => ({
  useExpenseCompositionCoordinator: (...args: unknown[]) =>
    mockUseExpenseCompositionCoordinator(...args),
}));
jest.mock('../api', () => ({
  finalizeSettlement: jest.fn(),
  reopenSettlement: jest.fn(),
  markTransferSent: jest.fn(),
  confirmTransferReceived: jest.fn(),
}));
jest.mock('../expenseEvents', () => ({
  publishExpenseEvent: (...args: unknown[]) =>
    mockPublishExpenseEvent(...args),
}));

// eslint-disable-next-line import/first
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import {
  confirmTransferReceived,
  finalizeSettlement,
  markTransferSent,
  reopenSettlement,
} from '../api';
// eslint-disable-next-line import/first
import { ExpensesScreen } from '../screens/ExpensesScreen';
// eslint-disable-next-line import/first
import type {
  ExpenseDashboardResponse,
  ExpenseListItem,
  SettlementTransfer,
  TripSettlement,
} from '../types';
// eslint-disable-next-line import/first
import type { TripDetailResponse, TripStatus } from '@/features/trips/types';
// eslint-disable-next-line import/first
import type { ApiError } from '@/shared/api/errors';

const mockFinalizeSettlement =
  finalizeSettlement as jest.MockedFunction<typeof finalizeSettlement>;
const mockReopenSettlement =
  reopenSettlement as jest.MockedFunction<typeof reopenSettlement>;
const mockMarkTransferSent =
  markTransferSent as jest.MockedFunction<typeof markTransferSent>;
const mockConfirmTransferReceived =
  confirmTransferReceived as jest.MockedFunction<
    typeof confirmTransferReceived
  >;
let alertSpy: jest.SpyInstance;

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const EXPENSE_ID = '2c1dfd8d-9c7f-43c7-9b99-71f6d1edda55';
const TRANSFER_ID = 'a11957b3-3329-4fcf-9c7b-673a51c1d8a7';
const PAYER_ID = '7191f7c4-16f0-4fc5-996f-3264a46e7761';
const RECIPIENT_ID = '4f44f738-0f5c-4608-a0b8-fd4ca3ecacde';
const OTHER_USER_ID = '6a40735b-a4e3-41de-a153-f5ef23c49733';

function expense(
  overrides: Partial<ExpenseListItem> = {},
): ExpenseListItem {
  return {
    id: EXPENSE_ID,
    title: 'Hotel',
    description: 'Two nights',
    total_amount: '120.00',
    paid_amount: '120.00',
    missing_amount: '0.00',
    surplus_amount: '0.00',
    currency_code: 'USD',
    status: 'FUNDED',
    collector: {
      id: PAYER_ID,
      display_name: 'Minh',
      identify_tag: 'minh#1234',
    },
    locked: false,
    ...overrides,
  };
}

function transfer(
  overrides: Partial<SettlementTransfer> = {},
): SettlementTransfer {
  return {
    id: TRANSFER_ID,
    payer: {
      id: PAYER_ID,
      display_name: 'Minh',
      identify_tag: 'minh#1234',
    },
    recipient: {
      id: RECIPIENT_ID,
      display_name: 'Lan',
      identify_tag: 'lan#5678',
    },
    amount: '60.00',
    payer_marked_sent_at: null,
    recipient_confirmed_at: null,
    ...overrides,
  };
}

function settlement(
  overrides: Partial<TripSettlement> = {},
): TripSettlement {
  return {
    id: 'settlement-1',
    status: 'FINALIZED',
    finalized_at: '2026-07-28T00:00:00Z',
    transfers: [transfer()],
    ...overrides,
  };
}

function dashboard(
  overrides: Partial<ExpenseDashboardResponse> = {},
): ExpenseDashboardResponse {
  return {
    currency_code: 'USD',
    summary: {
      total_amount: '120.00',
      paid_amount: '120.00',
      missing_amount: '0.00',
      surplus_amount: '0.00',
    },
    permissions: {
      can_manage_expenses: true,
    },
    my_balance: {
      balance: '0.00',
      surplus_held: '0.00',
    },
    member_balances: {
      [PAYER_ID]: { balance: '60.00' },
      [RECIPIENT_ID]: { balance: '-60.00' },
    },
    settlement: null,
    expenses: [expense()],
    ...overrides,
  };
}

function tripDetail({
  status = 'PLANNING',
  membershipStatus = 'ACTIVE',
}: {
  status?: TripStatus;
  membershipStatus?: TripDetailResponse['my_membership']['status'];
} = {}): TripDetailResponse {
  return {
    trip: {
      id: TRIP_ID,
      name: 'Da Nang weekend',
      destination: 'Da Nang, Vietnam',
      destination_provider: '',
      destination_provider_id: '',
      destination_lat: null,
      destination_lng: null,
      destination_country_code: 'VN',
      cover_image_url: '',
      start_date: '2026-08-01',
      end_date: '2026-08-03',
      description: '',
      status,
      currency_code: 'USD',
      timezone: 'Asia/Ho_Chi_Minh',
      budget_estimate: null,
      cancelled_at: null,
      created_at: '2026-01-01T00:00:00Z',
    },
    my_membership: {
      role: 'CAPTAIN',
      status: membershipStatus,
      joined_at: '2026-01-01T00:00:00Z',
    },
    members: [
      {
        membership_id: 'membership-1',
        user: {
          id: PAYER_ID,
          display_name: 'Minh',
          identify_tag: 'minh#1234',
          avatar_url: null,
        },
        role: 'CAPTAIN',
        joined_at: '2026-01-01T00:00:00Z',
      },
      {
        membership_id: 'membership-2',
        user: {
          id: RECIPIENT_ID,
          display_name: 'Lan',
          identify_tag: 'lan#5678',
          avatar_url: null,
        },
        role: 'MEMBER',
        joined_at: '2026-01-02T00:00:00Z',
      },
    ],
  };
}

function dashboardHookState({
  nextDashboard = dashboard(),
  status = 'ready',
  error = null,
  refreshing = false,
}: {
  nextDashboard?: ExpenseDashboardResponse | null;
  status?: 'loading' | 'ready' | 'error';
  error?: ApiError | null;
  refreshing?: boolean;
} = {}) {
  return {
    dashboard: nextDashboard,
    status,
    error,
    refreshing,
    refresh: mockRefreshDashboard,
    invalidate: mockInvalidateDashboard,
  };
}

function tripHookState({
  detail = tripDetail(),
  status = 'ready',
  error = null,
  refreshing = false,
}: {
  detail?: TripDetailResponse | null;
  status?: 'loading' | 'ready' | 'error';
  error?: ApiError | null;
  refreshing?: boolean;
} = {}) {
  return {
    detail,
    status,
    error,
    refreshing,
    refresh: mockRefreshTrip,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function axiosErrorWith(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, {
    status,
    statusText: '',
    headers: {},
    config,
    data,
  });
}

type AlertButton = {
  text?: string;
  onPress?: () => void;
};

function alertAction(callIndex: number, text: string): () => void {
  const buttons = alertSpy.mock.calls[callIndex]?.[2] as
    | AlertButton[]
    | undefined;
  const action = buttons?.find((button) => button.text === text)?.onPress;
  if (!action) {
    throw new Error(`Expected alert action "${text}".`);
  }
  return action;
}

describe('ExpensesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { tripId: TRIP_ID };
    mockUseSession.mockReturnValue({ user: { id: PAYER_ID } });
    mockRefreshDashboard.mockResolvedValue(undefined);
    mockRefreshTrip.mockResolvedValue(undefined);
    mockRefreshAll.mockResolvedValue(undefined);
    mockRequestReconcile.mockResolvedValue(undefined);
    mockUseExpenseDashboard.mockReturnValue(dashboardHookState());
    mockUseTripDetail.mockReturnValue(tripHookState());
    mockUseExpenseCompositionCoordinator.mockReturnValue({
      refreshAll: mockRefreshAll,
      requestReconcile: mockRequestReconcile,
      isScreenActive: jest.fn(() => true),
      isActiveGeneration: jest.fn(() => true),
      getGeneration: jest.fn(() => 1),
    });
    mockFinalizeSettlement.mockResolvedValue(settlement());
    mockReopenSettlement.mockResolvedValue(
      settlement({ status: 'REOPENED', transfers: [] }),
    );
    mockMarkTransferSent.mockResolvedValue(
      transfer({ payer_marked_sent_at: '2026-07-28T01:00:00Z' }),
    );
    mockConfirmTransferReceived.mockResolvedValue(
      transfer({
        payer_marked_sent_at: '2026-07-28T01:00:00Z',
        recipient_confirmed_at: '2026-07-28T02:00:00Z',
      }),
    );
    mockPublishExpenseEvent.mockResolvedValue(undefined);
    alertSpy = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('rejects invalid trip UUIDs before mounting hooks or APIs', async () => {
    mockParams = { tripId: 'not-a-uuid' };
    await render(<ExpensesScreen />);

    expect(screen.getByText('Expenses unavailable')).toBeTruthy();
    expect(mockUseExpenseDashboard).not.toHaveBeenCalled();
    expect(mockUseTripDetail).not.toHaveBeenCalled();
    expect(mockUseExpenseCompositionCoordinator).not.toHaveBeenCalled();
    expect(mockFinalizeSettlement).not.toHaveBeenCalled();
  });

  it('canonicalizes an uppercase trip UUID and composes both hooks with one coordinator', async () => {
    mockParams = { tripId: TRIP_ID.toUpperCase() };
    await render(<ExpensesScreen />);

    expect(mockUseExpenseDashboard).toHaveBeenCalledWith(TRIP_ID, {
      autoReconcile: false,
    });
    expect(mockUseTripDetail).toHaveBeenCalledWith(TRIP_ID, {
      autoReconcile: false,
    });
    expect(mockUseExpenseCompositionCoordinator).toHaveBeenCalledWith({
      tripId: TRIP_ID,
      refreshExpense: mockRefreshDashboard,
      refreshTrip: mockRefreshTrip,
    });
  });

  it.each(['dashboard-first', 'trip-first'] as const)(
    'waits for both authoritative sources before rendering (%s)',
    async (order) => {
      if (order === 'dashboard-first') {
        mockUseExpenseDashboard.mockReturnValue(dashboardHookState());
        mockUseTripDetail.mockReturnValue(
          tripHookState({ detail: null, status: 'loading' }),
        );
      } else {
        mockUseExpenseDashboard.mockReturnValue(
          dashboardHookState({
            nextDashboard: null,
            status: 'loading',
          }),
        );
        mockUseTripDetail.mockReturnValue(tripHookState());
      }
      const view = await render(<ExpensesScreen />);

      expect(screen.queryByLabelText('Expense summary')).toBeNull();

      mockUseExpenseDashboard.mockReturnValue(dashboardHookState());
      mockUseTripDetail.mockReturnValue(tripHookState());
      await view.rerender(<ExpensesScreen />);

      expect(screen.getByLabelText('Expense summary')).toBeTruthy();
      expect(screen.getByText('Hotel')).toBeTruthy();
    },
  );

  it.each([
    {
      name: 'dashboard permission denial',
      nextDashboard: dashboard({
        permissions: { can_manage_expenses: false },
      }),
      nextTripDetail: tripDetail(),
    },
    {
      name: 'inactive current membership',
      nextDashboard: dashboard(),
      nextTripDetail: tripDetail({ membershipStatus: 'REMOVED' }),
    },
    {
      name: 'terminal trip lifecycle',
      nextDashboard: dashboard(),
      nextTripDetail: tripDetail({ status: 'COMPLETED' }),
    },
  ])('applies deny-wins controls for $name', async ({
    nextDashboard,
    nextTripDetail,
  }) => {
    mockUseExpenseDashboard.mockReturnValue(
      dashboardHookState({ nextDashboard }),
    );
    mockUseTripDetail.mockReturnValue(
      tripHookState({ detail: nextTripDetail }),
    );
    await render(<ExpensesScreen />);

    expect(screen.queryByRole('button', { name: 'Add expense' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Finalize settlement' }),
    ).toBeNull();
    expect(screen.getByText('Hotel')).toBeTruthy();
  });

  it('preserves complete content through background errors and retries silently', async () => {
    mockUseExpenseDashboard.mockReturnValue(
      dashboardHookState({
        error: {
          kind: 'message',
          message: 'Dashboard refresh failed.',
          status: 500,
        },
      }),
    );
    mockUseTripDetail.mockReturnValue(
      tripHookState({
        error: {
          kind: 'network',
          message: 'Trip refresh failed.',
        },
      }),
    );
    await render(<ExpensesScreen />);

    expect(screen.getByText('Hotel')).toBeTruthy();
    expect(screen.getByText('Dashboard refresh failed.')).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Retry refreshing expenses',
      }),
    );
    expect(mockRequestReconcile).toHaveBeenCalledWith();
  });

  it('uses coordinator-owned retry and pull refresh modes', async () => {
    mockUseExpenseDashboard.mockReturnValue(
      dashboardHookState({
        nextDashboard: null,
        status: 'error',
        error: {
          kind: 'message',
          message: 'Expense service failed.',
          status: 500,
        },
      }),
    );
    const view = await render(<ExpensesScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Try again' }),
    );
    expect(mockRequestReconcile).toHaveBeenCalledWith(true);

    mockUseExpenseDashboard.mockReturnValue(dashboardHookState());
    await view.rerender(<ExpensesScreen />);
    const refreshControl = view.container.queryAll(
      (instance) => instance.type === 'RCTRefreshControl',
    )[0];
    if (!refreshControl) {
      throw new Error('Expected Expenses RefreshControl.');
    }
    await fireEvent(refreshControl, 'refresh');
    expect(mockRefreshAll).toHaveBeenCalledWith('refresh');
  });

  it('navigates to create and detail using the canonical trip key', async () => {
    await render(<ExpensesScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Add expense' }),
    );
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Open expense Hotel, Funded, total $120.00, collected $120.00, collector Minh',
      }),
    );

    expect(mockRouter.push).toHaveBeenNthCalledWith(
      1,
      `/trips/${TRIP_ID}/expenses/expense-form?mode=create`,
    );
    expect(mockRouter.push).toHaveBeenNthCalledWith(
      2,
      `/trips/${TRIP_ID}/expenses/${EXPENSE_ID}`,
    );
  });

  it('locks duplicate finalize confirmation and publishes after success', async () => {
    const pending = deferred<TripSettlement>();
    mockFinalizeSettlement.mockReturnValue(pending.promise);
    await render(<ExpensesScreen />);

    const finalizeButton = screen.getByRole('button', {
      name: 'Finalize settlement',
    });
    await fireEvent.press(finalizeButton);
    await fireEvent.press(finalizeButton);
    expect(alertSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      alertAction(0, 'Finalize')();
    });
    expect(mockInvalidateDashboard).toHaveBeenCalledTimes(1);
    expect(mockFinalizeSettlement).toHaveBeenCalledTimes(1);
    expect(mockFinalizeSettlement).toHaveBeenCalledWith(TRIP_ID);

    await act(async () => {
      pending.resolve(settlement());
    });
    await waitFor(() =>
      expect(mockPublishExpenseEvent).toHaveBeenCalledWith({
        type: 'expensesChanged',
        tripId: TRIP_ID,
      }),
    );
  });

  it('surfaces a finalize 409 verbatim and publishes reconciliation', async () => {
    mockFinalizeSettlement.mockRejectedValueOnce(
      axiosErrorWith(409, {
        detail: 'All expenses must be fully funded before settlement.',
        error_code: 'SETTLEMENT_UNDERFUNDED',
      }),
    );
    await render(<ExpensesScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Finalize settlement' }),
    );
    await act(async () => {
      alertAction(0, 'Finalize')();
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          'All expenses must be fully funded before settlement.',
        ),
      ).toBeTruthy(),
    );
    expect(mockPublishExpenseEvent).toHaveBeenCalledWith({
      type: 'expensesChanged',
      tripId: TRIP_ID,
    });
  });

  it('keeps finalized solo settlement and Reopen visible without transfer rows', async () => {
    mockUseExpenseDashboard.mockReturnValue(
      dashboardHookState({
        nextDashboard: dashboard({
          settlement: settlement({ transfers: [] }),
        }),
      }),
    );
    await render(<ExpensesScreen />);

    expect(screen.getByText('Settlement finalized')).toBeTruthy();
    expect(
      screen.getByText('No transfers are needed for this settlement.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Reopen settlement' }),
    ).toBeTruthy();
    expect(screen.queryByText('Transfers')).toBeNull();
    expect(screen.queryByRole('button', { name: 'I sent it' })).toBeNull();
  });

  it('locks duplicate reopen callbacks and publishes after success', async () => {
    const pending = deferred<TripSettlement>();
    mockReopenSettlement.mockReturnValue(pending.promise);
    mockUseExpenseDashboard.mockReturnValue(
      dashboardHookState({
        nextDashboard: dashboard({ settlement: settlement() }),
      }),
    );
    await render(<ExpensesScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Reopen settlement' }),
    );
    const reopen = alertAction(0, 'Reopen');
    await act(async () => {
      reopen();
      reopen();
    });

    expect(mockReopenSettlement).toHaveBeenCalledTimes(1);
    expect(mockReopenSettlement).toHaveBeenCalledWith(TRIP_ID);
    await act(async () => {
      pending.resolve(settlement({ status: 'REOPENED' }));
    });
    await waitFor(() =>
      expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1),
    );
  });

  it('surfaces a reopen 409 verbatim and publishes reconciliation', async () => {
    mockReopenSettlement.mockRejectedValueOnce(
      axiosErrorWith(409, {
        detail: 'Settlement is no longer finalized.',
        error_code: 'SETTLEMENT_NOT_FINALIZED',
      }),
    );
    mockUseExpenseDashboard.mockReturnValue(
      dashboardHookState({
        nextDashboard: dashboard({ settlement: settlement() }),
      }),
    );
    await render(<ExpensesScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Reopen settlement' }),
    );
    await act(async () => {
      alertAction(0, 'Reopen')();
    });

    await waitFor(() =>
      expect(
        screen.getByText('Settlement is no longer finalized.'),
      ).toBeTruthy(),
    );
    expect(mockPublishExpenseEvent).toHaveBeenCalledWith({
      type: 'expensesChanged',
      tripId: TRIP_ID,
    });
  });

  it.each([
    {
      name: 'payer on a completed trip',
      viewerId: PAYER_ID,
      nextTransfer: transfer(),
      button: 'I sent it',
    },
    {
      name: 'recipient on a cancelled trip after payer sent',
      viewerId: RECIPIENT_ID,
      nextTransfer: transfer({
        payer_marked_sent_at: '2026-07-28T01:00:00Z',
      }),
      button: 'I received it',
    },
  ])(
    'keeps transfer role action independent of terminal gate: $name',
    async ({ viewerId, nextTransfer, button }) => {
      mockUseSession.mockReturnValue({ user: { id: viewerId } });
      mockUseTripDetail.mockReturnValue(
        tripHookState({
          detail: tripDetail({
            status: button === 'I sent it' ? 'COMPLETED' : 'CANCELLED',
          }),
        }),
      );
      mockUseExpenseDashboard.mockReturnValue(
        dashboardHookState({
          nextDashboard: dashboard({
            settlement: settlement({ transfers: [nextTransfer] }),
          }),
        }),
      );
      await render(<ExpensesScreen />);

      expect(screen.getByRole('button', { name: button })).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Reopen settlement' }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Add expense' }),
      ).toBeNull();
    },
  );

  it.each([
    ['unrelated viewer', OTHER_USER_ID],
    ['unresolved viewer', null],
  ])('shows tracking only for %s', async (_name, viewerId) => {
    mockUseSession.mockReturnValue({
      user: viewerId ? { id: viewerId } : null,
    });
    mockUseExpenseDashboard.mockReturnValue(
      dashboardHookState({
        nextDashboard: dashboard({ settlement: settlement() }),
      }),
    );
    await render(<ExpensesScreen />);

    expect(screen.getByText('Tracking')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I sent it' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'I received it' }),
    ).toBeNull();
  });

  it('locks duplicate transfer confirmations per transfer id', async () => {
    const pending = deferred<SettlementTransfer>();
    mockMarkTransferSent.mockReturnValue(pending.promise);
    mockUseExpenseDashboard.mockReturnValue(
      dashboardHookState({
        nextDashboard: dashboard({ settlement: settlement() }),
      }),
    );
    await render(<ExpensesScreen />);

    const sentButton = screen.getByRole('button', { name: 'I sent it' });
    await fireEvent.press(sentButton);
    await fireEvent.press(sentButton);
    expect(alertSpy).toHaveBeenCalledTimes(2);

    const firstConfirm = alertAction(0, 'Confirm');
    const secondConfirm = alertAction(1, 'Confirm');
    await act(async () => {
      firstConfirm();
      secondConfirm();
    });
    expect(mockMarkTransferSent).toHaveBeenCalledTimes(1);
    expect(mockMarkTransferSent).toHaveBeenCalledWith(
      TRIP_ID,
      TRANSFER_ID,
    );

    await act(async () => {
      pending.resolve(
        transfer({ payer_marked_sent_at: '2026-07-28T01:00:00Z' }),
      );
    });
    await waitFor(() =>
      expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1),
    );
  });

  it('surfaces transfer 409 per row and publishes reconciliation', async () => {
    mockConfirmTransferReceived.mockRejectedValueOnce(
      axiosErrorWith(409, {
        detail: 'The payer has not marked this transfer as sent.',
        error_code: 'TRANSFER_NOT_SENT',
      }),
    );
    mockUseSession.mockReturnValue({ user: { id: RECIPIENT_ID } });
    mockUseExpenseDashboard.mockReturnValue(
      dashboardHookState({
        nextDashboard: dashboard({
          settlement: settlement({
            transfers: [
              transfer({
                payer_marked_sent_at: '2026-07-28T01:00:00Z',
              }),
            ],
          }),
        }),
      }),
    );
    await render(<ExpensesScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'I received it' }),
    );
    await act(async () => {
      alertAction(0, 'Confirm')();
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          'The payer has not marked this transfer as sent.',
        ),
      ).toBeTruthy(),
    );
    expect(mockPublishExpenseEvent).toHaveBeenCalledWith({
      type: 'expensesChanged',
      tripId: TRIP_ID,
    });
  });
});
