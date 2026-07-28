import type { ReactNode } from 'react';
import { Alert, View } from 'react-native';

let mockParams: Record<string, string | string[] | undefined> = {};
const mockRouter = {
  push: jest.fn(),
  dismissTo: jest.fn(),
};
const mockUseExpenseDetail = jest.fn();
const mockUseTripDetail = jest.fn();
const mockUseExpenseCompositionCoordinator = jest.fn();
const mockRefreshDetail = jest.fn();
const mockInvalidateDetail = jest.fn();
const mockRefreshTrip = jest.fn();
const mockRefreshAll = jest.fn();
const mockRequestReconcile = jest.fn();
const mockIsScreenActive = jest.fn();
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
jest.mock('../hooks/useExpenseDetail', () => ({
  useExpenseDetail: (...args: unknown[]) => mockUseExpenseDetail(...args),
}));
jest.mock('@/features/trips/hooks/useTripDetail', () => ({
  useTripDetail: (...args: unknown[]) => mockUseTripDetail(...args),
}));
jest.mock('../hooks/useExpenseCompositionCoordinator', () => ({
  useExpenseCompositionCoordinator: (...args: unknown[]) =>
    mockUseExpenseCompositionCoordinator(...args),
}));
jest.mock('../api', () => ({
  deleteExpense: jest.fn(),
  setContribution: jest.fn(),
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
import { deleteExpense, setContribution } from '../api';
// eslint-disable-next-line import/first
import { ExpenseDetailScreen } from '../screens/ExpenseDetailScreen';
// eslint-disable-next-line import/first
import type {
  ContributionResponse,
  ExpenseDetailResponse,
  ExpenseParticipant,
} from '../types';
// eslint-disable-next-line import/first
import type { TripDetailResponse, TripStatus } from '@/features/trips/types';
// eslint-disable-next-line import/first
import type { ApiError } from '@/shared/api/errors';

const mockDeleteExpense =
  deleteExpense as jest.MockedFunction<typeof deleteExpense>;
const mockSetContribution =
  setContribution as jest.MockedFunction<typeof setContribution>;

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const EXPENSE_ID = '2c1dfd8d-9c7f-43c7-9b99-71f6d1edda55';
const PAYER_ID = '7191f7c4-16f0-4fc5-996f-3264a46e7761';
const RECIPIENT_ID = '4f44f738-0f5c-4608-a0b8-fd4ca3ecacde';

function participant(
  overrides: Partial<ExpenseParticipant> = {},
): ExpenseParticipant {
  return {
    user_id: PAYER_ID,
    display_name: 'Minh',
    identify_tag: 'minh#1234',
    share_amount: '60.00',
    contributed_amount: '60.00',
    balance: '0.00',
    surplus_held: '0.00',
    ...overrides,
  };
}

function expenseDetail(
  overrides: Partial<ExpenseDetailResponse> = {},
): ExpenseDetailResponse {
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
    locked_at: null,
    created_at: '2026-07-28T00:00:00Z',
    permissions: {
      can_manage_expenses: true,
    },
    participants: [
      participant(),
      participant({
        user_id: RECIPIENT_ID,
        display_name: 'Lan',
        identify_tag: 'lan#5678',
      }),
    ],
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
    members: [],
  };
}

function detailHookState({
  detail = expenseDetail(),
  status = 'ready',
  error = null,
  refreshing = false,
}: {
  detail?: ExpenseDetailResponse | null;
  status?: 'loading' | 'ready' | 'error';
  error?: ApiError | null;
  refreshing?: boolean;
} = {}) {
  return {
    detail,
    status,
    error,
    refreshing,
    refresh: mockRefreshDetail,
    invalidate: mockInvalidateDetail,
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

function contributionResponse(
  amount: string,
  userId = PAYER_ID,
): ContributionResponse {
  return {
    id: 'contribution-1',
    user: {
      id: userId,
      display_name: userId === PAYER_ID ? 'Minh' : 'Lan',
      identify_tag: userId === PAYER_ID ? 'minh#1234' : 'lan#5678',
    },
    amount,
    updated_at: '2026-07-28T01:00:00Z',
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

let alertSpy: jest.SpyInstance;

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

async function beginContributionEdit(name = 'Minh'): Promise<void> {
  await fireEvent.press(
    screen.getByRole('button', {
      name: `Edit contribution for ${name}`,
    }),
  );
}

async function changeContribution(
  value: string,
  name = 'Minh',
): Promise<void> {
  await fireEvent.changeText(
    screen.getByLabelText(`Contribution amount for ${name}`),
    value,
  );
}

async function saveContribution(name = 'Minh'): Promise<void> {
  await fireEvent.press(
    screen.getByRole('button', {
      name: `Save contribution for ${name}`,
    }),
  );
}

describe('ExpenseDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { tripId: TRIP_ID, expenseId: EXPENSE_ID };
    mockRefreshDetail.mockResolvedValue(undefined);
    mockRefreshTrip.mockResolvedValue(undefined);
    mockRefreshAll.mockResolvedValue(undefined);
    mockRequestReconcile.mockResolvedValue(undefined);
    mockIsScreenActive.mockReturnValue(true);
    mockUseExpenseDetail.mockReturnValue(detailHookState());
    mockUseTripDetail.mockReturnValue(tripHookState());
    mockUseExpenseCompositionCoordinator.mockReturnValue({
      refreshAll: mockRefreshAll,
      requestReconcile: mockRequestReconcile,
      isScreenActive: mockIsScreenActive,
      isActiveGeneration: jest.fn(() => true),
      getGeneration: jest.fn(() => 1),
    });
    mockDeleteExpense.mockResolvedValue(undefined);
    mockSetContribution.mockImplementation(
      async (_tripId, _expenseId, userId, payload) =>
        contributionResponse(payload.amount, userId),
    );
    mockPublishExpenseEvent.mockResolvedValue(undefined);
    alertSpy = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('rejects invalid UUID route intent before hooks or APIs', async () => {
    mockParams = { tripId: TRIP_ID, expenseId: ['not-a-uuid'] };
    await render(<ExpenseDetailScreen />);

    expect(screen.getByText('Expense unavailable')).toBeTruthy();
    expect(mockUseExpenseDetail).not.toHaveBeenCalled();
    expect(mockUseTripDetail).not.toHaveBeenCalled();
    expect(mockUseExpenseCompositionCoordinator).not.toHaveBeenCalled();
    expect(mockDeleteExpense).not.toHaveBeenCalled();
    expect(mockSetContribution).not.toHaveBeenCalled();
  });

  it('canonicalizes uppercase composite UUIDs and mounts one coordinator', async () => {
    mockParams = {
      tripId: TRIP_ID.toUpperCase(),
      expenseId: EXPENSE_ID.toUpperCase(),
    };
    await render(<ExpenseDetailScreen />);

    expect(mockUseExpenseDetail).toHaveBeenCalledWith(
      TRIP_ID,
      EXPENSE_ID,
      { autoReconcile: false },
    );
    expect(mockUseTripDetail).toHaveBeenCalledWith(TRIP_ID, {
      autoReconcile: false,
    });
    expect(mockUseExpenseCompositionCoordinator).toHaveBeenCalledWith({
      tripId: TRIP_ID,
      refreshExpense: mockRefreshDetail,
      refreshTrip: mockRefreshTrip,
    });
  });

  it.each(['expense-first', 'trip-first'] as const)(
    'waits for both authoritative sources before rendering (%s)',
    async (order) => {
      if (order === 'expense-first') {
        mockUseExpenseDetail.mockReturnValue(detailHookState());
        mockUseTripDetail.mockReturnValue(
          tripHookState({ detail: null, status: 'loading' }),
        );
      } else {
        mockUseExpenseDetail.mockReturnValue(
          detailHookState({ detail: null, status: 'loading' }),
        );
        mockUseTripDetail.mockReturnValue(tripHookState());
      }
      const view = await render(<ExpenseDetailScreen />);

      expect(screen.queryByText('Participants (2)')).toBeNull();

      mockUseExpenseDetail.mockReturnValue(detailHookState());
      mockUseTripDetail.mockReturnValue(tripHookState());
      await view.rerender(<ExpenseDetailScreen />);

      expect(screen.getByText('Participants (2)')).toBeTruthy();
      expect(
        screen.getByLabelText('Contribution for Minh'),
      ).toBeTruthy();
    },
  );

  it.each([
    {
      name: 'expense permission denial',
      nextDetail: expenseDetail({
        permissions: { can_manage_expenses: false },
      }),
      nextTrip: tripDetail(),
    },
    {
      name: 'inactive membership',
      nextDetail: expenseDetail(),
      nextTrip: tripDetail({ membershipStatus: 'REMOVED' }),
    },
    {
      name: 'terminal trip',
      nextDetail: expenseDetail(),
      nextTrip: tripDetail({ status: 'COMPLETED' }),
    },
    {
      name: 'locked expense',
      nextDetail: expenseDetail({
        locked: true,
        locked_at: '2026-07-28T02:00:00Z',
      }),
      nextTrip: tripDetail(),
    },
  ])('applies deny-wins controls for $name', async ({
    nextDetail,
    nextTrip,
  }) => {
    mockUseExpenseDetail.mockReturnValue(
      detailHookState({ detail: nextDetail }),
    );
    mockUseTripDetail.mockReturnValue(
      tripHookState({ detail: nextTrip }),
    );
    await render(<ExpenseDetailScreen />);

    expect(screen.queryByRole('button', { name: 'Edit expense' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Delete expense' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Edit contribution for Minh',
      }),
    ).toBeNull();
    expect(screen.getAllByText('View only').length).toBeGreaterThan(0);
  });

  it('shows the authoritative locked timestamp in the settlement notice', async () => {
    mockUseExpenseDetail.mockReturnValue(
      detailHookState({
        detail: expenseDetail({
          locked: true,
          locked_at: '2026-07-28T02:00:00Z',
        }),
      }),
    );
    await render(<ExpenseDetailScreen />);

    expect(
      screen.getByText(
        /Settlement is finalized \(locked on .+\)\. Reopen it before editing expenses or contributions\./,
      ),
    ).toBeTruthy();
  });

  it('renders participants through the virtualized list with stable data', async () => {
    const participants = Array.from({ length: 30 }, (_, index) =>
      participant({
        user_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        display_name: `Member ${index}`,
        identify_tag: null,
      }),
    );
    mockUseExpenseDetail.mockReturnValue(
      detailHookState({
        detail: expenseDetail({ participants }),
      }),
    );
    const rendered = await render(<ExpenseDetailScreen />);

    expect(screen.getByText('Participants (30)')).toBeTruthy();
    const virtualizedDataOwner = rendered.container.queryAll(
      (instance) =>
        Array.isArray(instance.props.data) &&
        instance.props.data.length === participants.length,
    )[0];
    expect(virtualizedDataOwner?.props.data).toBe(participants);
    expect(
      virtualizedDataOwner?.props.keyboardShouldPersistTaps,
    ).toBe('handled');
  });

  it('preserves an id-keyed contribution draft across authority refresh', async () => {
    const rendered = await render(<ExpenseDetailScreen />);
    await beginContributionEdit();
    await changeContribution('199.00');

    mockUseExpenseDetail.mockReturnValue(
      detailHookState({
        detail: expenseDetail({
          permissions: { can_manage_expenses: false },
          participants: [
            participant({ contributed_amount: '80.00' }),
            participant({
              user_id: RECIPIENT_ID,
              display_name: 'Lan',
              identify_tag: 'lan#5678',
            }),
          ],
        }),
      }),
    );
    await rendered.rerender(<ExpenseDetailScreen />);

    expect(
      screen.queryByLabelText('Contribution amount for Minh'),
    ).toBeNull();
    mockUseExpenseDetail.mockReturnValue(
      detailHookState({
        detail: expenseDetail({
          participants: [
            participant({ contributed_amount: '80.00' }),
            participant({
              user_id: RECIPIENT_ID,
              display_name: 'Lan',
              identify_tag: 'lan#5678',
            }),
          ],
        }),
      }),
    );
    await rendered.rerender(<ExpenseDetailScreen />);

    expect(
      screen.getByLabelText('Contribution amount for Minh').props.value,
    ).toBe('199.00');
    expect(
      screen.getByRole('button', {
        name: 'Save contribution for Minh',
      }),
    ).toBeTruthy();
  });

  it('hydrates a row from refreshed authority before editing begins', async () => {
    const rendered = await render(<ExpenseDetailScreen />);

    mockUseExpenseDetail.mockReturnValue(
      detailHookState({
        detail: expenseDetail({
          participants: [
            participant({ contributed_amount: '80.00' }),
            participant({
              user_id: RECIPIENT_ID,
              display_name: 'Lan',
              identify_tag: 'lan#5678',
            }),
          ],
        }),
      }),
    );
    await rendered.rerender(<ExpenseDetailScreen />);
    await beginContributionEdit();

    expect(
      screen.getByLabelText('Contribution amount for Minh').props.value,
    ).toBe('80.00');
  });

  it('rejects invalid contribution strings locally', async () => {
    await render(<ExpenseDetailScreen />);
    await beginContributionEdit();
    await changeContribution('-1.00');
    await saveContribution();

    expect(mockSetContribution).not.toHaveBeenCalled();
    expect(
      screen.getByText('Enter a valid non-negative amount.'),
    ).toBeTruthy();
  });

  it.each(['0.00', '200.00'])(
    'submits canonical zero/overfunding contribution %s',
    async (amount) => {
      await render(<ExpenseDetailScreen />);
      await beginContributionEdit();
      await changeContribution(amount);
      await saveContribution();

      await waitFor(() =>
        expect(mockSetContribution).toHaveBeenCalledWith(
          TRIP_ID,
          EXPENSE_ID,
          PAYER_ID,
          { amount },
        ),
      );
      expect(mockInvalidateDetail).toHaveBeenCalledTimes(1);
      expect(mockPublishExpenseEvent).toHaveBeenCalledWith({
        type: 'expensesChanged',
        tripId: TRIP_ID,
      });
    },
  );

  it('locks duplicate contribution submits by participant id', async () => {
    const pending = deferred<ContributionResponse>();
    mockSetContribution.mockReturnValue(pending.promise);
    await render(<ExpenseDetailScreen />);
    await beginContributionEdit();
    await changeContribution('80.00');

    const save = screen.getByRole('button', {
      name: 'Save contribution for Minh',
    });
    await fireEvent.press(save);
    await fireEvent.press(save);
    expect(mockSetContribution).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(contributionResponse('80.00'));
    });
    await waitFor(() =>
      expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1),
    );
  });

  it('cleans a completed contribution lock while the mounted screen is blurred', async () => {
    const pending = deferred<ContributionResponse>();
    mockSetContribution.mockReturnValueOnce(pending.promise);
    const rendered = await render(<ExpenseDetailScreen />);
    await beginContributionEdit();
    await changeContribution('80.00');
    await saveContribution();

    mockIsScreenActive.mockReturnValue(false);
    await act(async () => {
      pending.resolve(contributionResponse('80.00'));
      await pending.promise;
    });

    await waitFor(() => {
      expect(
        screen.queryByRole('button', {
          name: 'Save contribution for Minh',
        }),
      ).toBeNull();
      expect(
        screen.getByRole('button', {
          name: 'Edit contribution for Minh',
        }).props.accessibilityState,
      ).toMatchObject({ disabled: false });
    });

    mockUseExpenseDetail.mockReturnValue(
      detailHookState({
        detail: expenseDetail({
          participants: [
            participant({ contributed_amount: '80.00' }),
            participant({
              user_id: RECIPIENT_ID,
              display_name: 'Lan',
              identify_tag: 'lan#5678',
            }),
          ],
        }),
      }),
    );
    mockIsScreenActive.mockReturnValue(true);
    await rendered.rerender(<ExpenseDetailScreen />);
    await beginContributionEdit();
    expect(
      screen.getByLabelText('Contribution amount for Minh').props.value,
    ).toBe('80.00');
  });

  it('surfaces a contribution 409 per row and publishes reconciliation', async () => {
    mockSetContribution.mockRejectedValueOnce(
      axiosErrorWith(409, {
        detail: 'Settlement is finalized.',
        error_code: 'EXPENSE_LOCKED',
      }),
    );
    await render(<ExpenseDetailScreen />);
    await beginContributionEdit();
    await changeContribution('80.00');
    await saveContribution();

    await waitFor(() =>
      expect(screen.getByText('Settlement is finalized.')).toBeTruthy(),
    );
    expect(mockPublishExpenseEvent).toHaveBeenCalledWith({
      type: 'expensesChanged',
      tripId: TRIP_ID,
    });
  });

  it('preserves complete detail through background failure and retries silently', async () => {
    mockUseExpenseDetail.mockReturnValue(
      detailHookState({
        error: {
          kind: 'message',
          message: 'Expense refresh failed.',
          status: 500,
        },
      }),
    );
    await render(<ExpenseDetailScreen />);

    expect(screen.getByText('Hotel')).toBeTruthy();
    expect(screen.getByText('Expense refresh failed.')).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Retry refreshing expense detail',
      }),
    );
    expect(mockRequestReconcile).toHaveBeenCalledWith();
  });

  it('uses explicit mode for participant-list pull refresh', async () => {
    const rendered = await render(<ExpenseDetailScreen />);
    const refreshControl = rendered.container.queryAll(
      (instance) => instance.type === 'RCTRefreshControl',
    )[0];
    if (!refreshControl) {
      throw new Error('Expected Expense Detail RefreshControl.');
    }
    await fireEvent(refreshControl, 'refresh');
    expect(mockRefreshAll).toHaveBeenCalledWith('refresh');
  });

  it('navigates to the exact edit form target', async () => {
    await render(<ExpenseDetailScreen />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Edit expense' }),
    );

    expect(mockRouter.push).toHaveBeenCalledWith(
      `/trips/${TRIP_ID}/expenses/expense-form?mode=edit&expenseId=${EXPENSE_ID}`,
    );
  });

  it('locks duplicate delete confirmation, publishes, and dismisses to dashboard', async () => {
    const pending = deferred<void>();
    mockDeleteExpense.mockReturnValue(pending.promise);
    await render(<ExpenseDetailScreen />);

    const deleteButton = screen.getByRole('button', {
      name: 'Delete expense',
    });
    await fireEvent.press(deleteButton);
    await fireEvent.press(deleteButton);
    expect(alertSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      alertAction(0, 'Delete')();
    });
    expect(mockInvalidateDetail).toHaveBeenCalledTimes(1);
    expect(mockDeleteExpense).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve();
    });
    await waitFor(() =>
      expect(mockRouter.dismissTo).toHaveBeenCalledWith(
        `/trips/${TRIP_ID}/expenses`,
      ),
    );
    expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1);
  });

  it('converges EXPENSE_NOT_FOUND delete as already deleted', async () => {
    mockDeleteExpense.mockRejectedValueOnce(
      axiosErrorWith(404, {
        detail: 'Expense not found.',
        error_code: 'EXPENSE_NOT_FOUND',
      }),
    );
    await render(<ExpenseDetailScreen />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete expense' }),
    );
    await act(async () => {
      alertAction(0, 'Delete')();
    });

    await waitFor(() =>
      expect(mockRouter.dismissTo).toHaveBeenCalledWith(
        `/trips/${TRIP_ID}/expenses`,
      ),
    );
    expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1);
  });

  it('surfaces delete conflicts, reconciles, and does not navigate', async () => {
    mockDeleteExpense.mockRejectedValueOnce(
      axiosErrorWith(409, {
        detail: 'Settlement is finalized.',
        error_code: 'EXPENSE_LOCKED',
      }),
    );
    await render(<ExpenseDetailScreen />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete expense' }),
    );
    await act(async () => {
      alertAction(0, 'Delete')();
    });

    await waitFor(() =>
      expect(screen.getByText('Settlement is finalized.')).toBeTruthy(),
    );
    expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('publishes late delete success without navigating an inactive screen', async () => {
    const pending = deferred<void>();
    mockDeleteExpense.mockReturnValue(pending.promise);
    await render(<ExpenseDetailScreen />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete expense' }),
    );
    await act(async () => {
      alertAction(0, 'Delete')();
    });
    mockIsScreenActive.mockReturnValue(false);

    await act(async () => {
      pending.resolve();
    });

    await waitFor(() =>
      expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1),
    );
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });
});
