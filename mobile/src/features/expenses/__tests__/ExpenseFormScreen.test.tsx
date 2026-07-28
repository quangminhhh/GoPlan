import type { ComponentProps, ReactNode } from 'react';
import { View } from 'react-native';
import type { ExpenseForm } from '../components/ExpenseForm';

let mockParams: Record<string, string | string[] | undefined> = {};
const mockRouter = {
  dismissTo: jest.fn(),
};
const mockUseFocusEffect = jest.fn();
const mockUseAppForegroundEffect = jest.fn();
const mockUseExpenseDashboard = jest.fn();
const mockUseExpenseDetail = jest.fn();
const mockUseTripDetail = jest.fn();
const mockRefreshDashboard = jest.fn();
const mockInvalidateDashboard = jest.fn();
const mockRefreshDetail = jest.fn();
const mockInvalidateDetail = jest.fn();
const mockRefreshTrip = jest.fn();
const mockPublishExpenseEvent = jest.fn();
const mockSubscribeToExpenseEvents = jest.fn();
const mockSubscribeToTripEvents = jest.fn();
let mockExpenseFormProps: unknown;
let mockExpenseListener:
  | ((event: {
      type: 'expensesChanged';
      tripId: string;
    }) => void | Promise<void>)
  | undefined;
let mockTripListener:
  | ((event: {
      type: 'statusChanged';
      tripId: string;
      status: 'PLANNING' | 'ONGOING' | 'COMPLETED' | 'CANCELLED';
    }) => void)
  | undefined;
let mockLatestStackOptions:
  | {
      gestureEnabled?: boolean;
      headerLeft?: () => ReactNode;
    }
  | undefined;

function mockRenderStackScreen({
  options,
}: {
  options: {
    gestureEnabled?: boolean;
    headerLeft?: () => ReactNode;
  };
}) {
  mockLatestStackOptions = options;
  return <View>{options.headerLeft?.()}</View>;
}

function mockRenderExpenseForm(props: unknown) {
  mockExpenseFormProps = props;
  return <View testID="mock-expense-form" />;
}

jest.mock('expo-router', () => ({
  Stack: { Screen: mockRenderStackScreen },
  useFocusEffect: (effect: () => (() => void) | void) =>
    mockUseFocusEffect(effect),
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/shared/hooks/useAppForegroundEffect', () => ({
  useAppForegroundEffect: (listener: () => void) =>
    mockUseAppForegroundEffect(listener),
}));
jest.mock('../hooks/useExpenseDashboard', () => ({
  useExpenseDashboard: (...args: unknown[]) =>
    mockUseExpenseDashboard(...args),
}));
jest.mock('../hooks/useExpenseDetail', () => ({
  useExpenseDetail: (...args: unknown[]) => mockUseExpenseDetail(...args),
}));
jest.mock('@/features/trips/hooks/useTripDetail', () => ({
  useTripDetail: (...args: unknown[]) => mockUseTripDetail(...args),
}));
jest.mock('../components/ExpenseForm', () => ({
  ExpenseForm: mockRenderExpenseForm,
}));
jest.mock('../api', () => ({
  createExpense: jest.fn(),
  updateExpense: jest.fn(),
}));
jest.mock('../expenseEvents', () => ({
  publishExpenseEvent: (...args: unknown[]) =>
    mockPublishExpenseEvent(...args),
  subscribeToExpenseEvents: (...args: unknown[]) =>
    mockSubscribeToExpenseEvents(...args),
}));
jest.mock('@/features/trips/tripEvents', () => ({
  subscribeToTripEvents: (...args: unknown[]) =>
    mockSubscribeToTripEvents(...args),
}));

// eslint-disable-next-line import/first
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import { createExpense, updateExpense } from '../api';
// eslint-disable-next-line import/first
import { ExpenseFormScreen } from '../screens/ExpenseFormScreen';
// eslint-disable-next-line import/first
import type {
  ExpenseDashboardResponse,
  ExpenseDetailResponse,
  ExpenseParticipant,
  ExpenseResponse,
} from '../types';
// eslint-disable-next-line import/first
import type { TripDetailResponse, TripMember, TripStatus } from '@/features/trips/types';

const mockCreateExpense =
  createExpense as jest.MockedFunction<typeof createExpense>;
const mockUpdateExpense =
  updateExpense as jest.MockedFunction<typeof updateExpense>;

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const EXPENSE_ID = '2c1dfd8d-9c7f-43c7-9b99-71f6d1edda55';
const OTHER_EXPENSE_ID = 'a11957b3-3329-4fcf-9c7b-673a51c1d8a7';
const CAPTAIN_ID = '7191f7c4-16f0-4fc5-996f-3264a46e7761';
const MEMBER_ID = '4f44f738-0f5c-4608-a0b8-fd4ca3ecacde';
const LATE_MEMBER_ID = '6a40735b-a4e3-41de-a153-f5ef23c49733';
const DEPARTED_ID = 'fa65ed4a-f9c1-4601-9e92-c89e10e7eed1';

function member(
  id: string,
  displayName: string,
  role: TripMember['role'] = 'MEMBER',
): TripMember {
  return {
    membership_id: `membership-${id}`,
    user: {
      id,
      display_name: displayName,
      identify_tag: `${displayName.toLowerCase()}#1234`,
      avatar_url: null,
    },
    role,
    joined_at: '2026-01-01T00:00:00Z',
  };
}

function participant(
  userId: string,
  displayName: string,
): ExpenseParticipant {
  return {
    user_id: userId,
    display_name: displayName,
    identify_tag: `${displayName.toLowerCase()}#1234`,
    share_amount: '60.00',
    contributed_amount: '60.00',
    balance: '0.00',
    surplus_held: '0.00',
  };
}

function dashboard(
  overrides: Partial<ExpenseDashboardResponse> = {},
): ExpenseDashboardResponse {
  return {
    currency_code: 'USD',
    summary: {
      total_amount: '0.00',
      paid_amount: '0.00',
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
    member_balances: {},
    settlement: null,
    expenses: [],
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
      id: CAPTAIN_ID,
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
      participant(CAPTAIN_ID, 'Minh'),
      participant(MEMBER_ID, 'Lan'),
    ],
    ...overrides,
  };
}

function tripDetail({
  status = 'PLANNING',
  membershipStatus = 'ACTIVE',
  currencyCode = 'USD',
  members = [
    member(CAPTAIN_ID, 'Minh', 'CAPTAIN'),
    member(MEMBER_ID, 'Lan'),
    member(LATE_MEMBER_ID, 'New member'),
  ],
}: {
  status?: TripStatus;
  membershipStatus?: TripDetailResponse['my_membership']['status'];
  currencyCode?: string;
  members?: TripMember[];
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
      currency_code: currencyCode,
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
    members,
  };
}

function dashboardHookState(
  nextDashboard: ExpenseDashboardResponse | null = dashboard(),
) {
  return {
    dashboard: nextDashboard,
    status: nextDashboard ? ('ready' as const) : ('loading' as const),
    error: null,
    refreshing: false,
    refresh: mockRefreshDashboard,
    invalidate: mockInvalidateDashboard,
  };
}

function detailHookState(
  detail: ExpenseDetailResponse | null = expenseDetail(),
) {
  return {
    detail,
    status: detail ? ('ready' as const) : ('loading' as const),
    error: null,
    refreshing: false,
    refresh: mockRefreshDetail,
    invalidate: mockInvalidateDetail,
  };
}

function tripHookState(detail: TripDetailResponse | null = tripDetail()) {
  return {
    detail,
    status: detail ? ('ready' as const) : ('loading' as const),
    error: null,
    refreshing: false,
    refresh: mockRefreshTrip,
  };
}

function expenseResponse(
  overrides: Partial<ExpenseResponse> = {},
): ExpenseResponse {
  return {
    id: EXPENSE_ID,
    title: 'Hotel',
    description: 'Two nights',
    total_amount: '120.00',
    currency_code: 'USD',
    locked_at: null,
    created_at: '2026-07-28T00:00:00Z',
    ...overrides,
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

function currentFormProps(): ComponentProps<typeof ExpenseForm> {
  if (!mockExpenseFormProps) {
    throw new Error('Expected ExpenseForm to render.');
  }
  return mockExpenseFormProps as ComponentProps<typeof ExpenseForm>;
}

function latestFocusCallback(): () => (() => void) | void {
  const callback = mockUseFocusEffect.mock.calls.at(-1)?.[0] as
    | (() => (() => void) | void)
    | undefined;
  if (!callback) {
    throw new Error('Expected useFocusEffect to register a callback.');
  }
  return callback;
}

function latestForegroundCallback(): () => void {
  const callback = mockUseAppForegroundEffect.mock.calls.at(-1)?.[0] as
    | (() => void)
    | undefined;
  if (!callback) {
    throw new Error(
      'Expected useAppForegroundEffect to register a callback.',
    );
  }
  return callback;
}

async function focusScreen(): Promise<(() => void) | undefined> {
  let cleanup: (() => void) | undefined;
  await act(async () => {
    cleanup = latestFocusCallback()() || undefined;
  });
  return cleanup;
}

async function changeDraft(
  changes: Parameters<ComponentProps<typeof ExpenseForm>['onChange']>[0],
): Promise<void> {
  await act(async () => {
    currentFormProps().onChange(changes);
  });
}

describe('ExpenseFormScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      expenseId: EXPENSE_ID,
    };
    mockExpenseFormProps = undefined;
    mockExpenseListener = undefined;
    mockTripListener = undefined;
    mockLatestStackOptions = undefined;
    mockRefreshDashboard.mockResolvedValue(undefined);
    mockRefreshDetail.mockResolvedValue(undefined);
    mockRefreshTrip.mockResolvedValue(undefined);
    mockUseExpenseDashboard.mockReturnValue(dashboardHookState());
    mockUseExpenseDetail.mockReturnValue(detailHookState());
    mockUseTripDetail.mockReturnValue(tripHookState());
    mockCreateExpense.mockResolvedValue(expenseResponse());
    mockUpdateExpense.mockResolvedValue(expenseDetail());
    mockSubscribeToExpenseEvents.mockImplementation(
      (
        _tripId: string,
        listener: (
          event: {
            type: 'expensesChanged';
            tripId: string;
          },
        ) => void | Promise<void>,
      ) => {
        mockExpenseListener = listener;
        return () => {
          if (mockExpenseListener === listener) {
            mockExpenseListener = undefined;
          }
        };
      },
    );
    mockPublishExpenseEvent.mockImplementation(
      async (event: { type: 'expensesChanged'; tripId: string }) => {
        await mockExpenseListener?.(event);
      },
    );
    mockSubscribeToTripEvents.mockImplementation(
      (
        listener: (event: {
          type: 'statusChanged';
          tripId: string;
          status: 'PLANNING' | 'ONGOING' | 'COMPLETED' | 'CANCELLED';
        }) => void,
      ) => {
        mockTripListener = listener;
        return () => {
          if (mockTripListener === listener) {
            mockTripListener = undefined;
          }
        };
      },
    );
  });

  it('rejects contradictory or malformed route intent before mounting hooks', async () => {
    mockParams = {
      tripId: TRIP_ID,
      mode: 'create',
      expenseId: EXPENSE_ID,
    };
    await render(<ExpenseFormScreen />);

    expect(screen.getByText('Form unavailable')).toBeTruthy();
    expect(mockUseExpenseDashboard).not.toHaveBeenCalled();
    expect(mockUseExpenseDetail).not.toHaveBeenCalled();
    expect(mockUseTripDetail).not.toHaveBeenCalled();
    expect(mockCreateExpense).not.toHaveBeenCalled();
    expect(mockUpdateExpense).not.toHaveBeenCalled();
  });

  it.each(['create', 'edit'] as const)(
    'canonicalizes uppercase UUID keys and disables standalone reconciliation in %s mode',
    async (mode) => {
      mockParams =
        mode === 'create'
          ? {
              tripId: TRIP_ID.toUpperCase(),
              mode,
            }
          : {
              tripId: TRIP_ID.toUpperCase(),
              mode,
              expenseId: EXPENSE_ID.toUpperCase(),
            };
      await render(<ExpenseFormScreen />);

      expect(mockUseExpenseDashboard).toHaveBeenCalledWith(
        mode === 'create' ? TRIP_ID : undefined,
        { autoReconcile: false },
      );
      expect(mockUseExpenseDetail).toHaveBeenCalledWith(
        mode === 'edit' ? TRIP_ID : undefined,
        mode === 'edit' ? EXPENSE_ID : undefined,
        { autoReconcile: false },
      );
      expect(mockUseTripDetail).toHaveBeenCalledWith(TRIP_ID, {
        autoReconcile: false,
      });
    },
  );

  it.each([
    ['create', 'expense-first'],
    ['create', 'trip-first'],
    ['edit', 'expense-first'],
    ['edit', 'trip-first'],
  ] as const)(
    'waits for both mandatory sources in %s mode (%s)',
    async (mode, order) => {
      mockParams =
        mode === 'create'
          ? { tripId: TRIP_ID, mode }
          : { tripId: TRIP_ID, mode, expenseId: EXPENSE_ID };
      if (mode === 'create') {
        mockUseExpenseDashboard.mockReturnValue(
          dashboardHookState(
            order === 'expense-first' ? dashboard() : null,
          ),
        );
      } else {
        mockUseExpenseDetail.mockReturnValue(
          detailHookState(
            order === 'expense-first' ? expenseDetail() : null,
          ),
        );
      }
      mockUseTripDetail.mockReturnValue(
        tripHookState(order === 'trip-first' ? tripDetail() : null),
      );
      const rendered = await render(<ExpenseFormScreen />);

      expect(screen.queryByTestId('mock-expense-form')).toBeNull();

      mockUseExpenseDashboard.mockReturnValue(dashboardHookState());
      mockUseExpenseDetail.mockReturnValue(detailHookState());
      mockUseTripDetail.mockReturnValue(tripHookState());
      await rendered.rerender(<ExpenseFormScreen />);

      expect(screen.getByTestId('mock-expense-form')).toBeTruthy();
      expect(currentFormProps().mode).toBe(mode);
    },
  );

  it('hydrates edit once, preserves touched and untouched values, then rehydrates for a new identity', async () => {
    const rendered = await render(<ExpenseFormScreen />);
    expect(currentFormProps().draft).toMatchObject({
      title: 'Hotel',
      description: 'Two nights',
      total_amount: '120.00',
      collector_id: CAPTAIN_ID,
    });
    await changeDraft({ title: 'My draft' });

    mockUseExpenseDetail.mockReturnValue(
      detailHookState(
        expenseDetail({
          title: 'Server title',
          description: 'Server changed description',
        }),
      ),
    );
    mockUseTripDetail.mockReturnValue(
      tripHookState(tripDetail({ status: 'ONGOING' })),
    );
    await rendered.rerender(<ExpenseFormScreen />);

    expect(currentFormProps().draft).toMatchObject({
      title: 'My draft',
      description: 'Two nights',
      total_amount: '120.00',
      collector_id: CAPTAIN_ID,
    });

    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      expenseId: OTHER_EXPENSE_ID,
    };
    mockUseExpenseDetail.mockReturnValue(
      detailHookState(
        expenseDetail({
          id: OTHER_EXPENSE_ID,
          title: 'Dinner',
          description: 'New identity',
        }),
      ),
    );
    await rendered.rerender(<ExpenseFormScreen />);

    expect(currentFormProps().draft).toMatchObject({
      title: 'Dinner',
      description: 'New identity',
    });
  });

  it('preserves the draft while deny-wins authority disables submission', async () => {
    const rendered = await render(<ExpenseFormScreen />);
    await changeDraft({ title: 'Preserved title' });
    mockUseTripDetail.mockReturnValue(
      tripHookState(tripDetail({ membershipStatus: 'REMOVED' })),
    );
    await rendered.rerender(<ExpenseFormScreen />);

    expect(currentFormProps().draft.title).toBe('Preserved title');
    expect(currentFormProps().canSubmit).toBe(false);
    expect(currentFormProps().authorityMessage).toBe(
      'You are no longer an active member of this trip.',
    );

    mockUseTripDetail.mockReturnValue(tripHookState());
    await rendered.rerender(<ExpenseFormScreen />);
    expect(currentFormProps().draft.title).toBe('Preserved title');
    expect(currentFormProps().canSubmit).toBe(true);
  });

  it.each([
    {
      name: 'create permission revoked',
      mode: 'create' as const,
      nextDashboard: dashboard({
        permissions: { can_manage_expenses: false },
      }),
      nextDetail: expenseDetail(),
      nextTrip: tripDetail(),
      message: 'Only the trip captain can add expenses.',
    },
    {
      name: 'create currency mismatch',
      mode: 'create' as const,
      nextDashboard: dashboard(),
      nextDetail: expenseDetail(),
      nextTrip: tripDetail({ currencyCode: 'VND' }),
      message: 'Expense currency changed. Refresh before continuing.',
    },
    {
      name: 'edit locked remotely',
      mode: 'edit' as const,
      nextDashboard: dashboard(),
      nextDetail: expenseDetail({
        locked: true,
        locked_at: '2026-07-28T02:00:00Z',
      }),
      nextTrip: tripDetail(),
      message:
        'Settlement is finalized. Reopen it before editing expenses.',
    },
    {
      name: 'terminal lifecycle',
      mode: 'edit' as const,
      nextDashboard: dashboard(),
      nextDetail: expenseDetail(),
      nextTrip: tripDetail({ status: 'CANCELLED' }),
      message: 'Completed or cancelled trips cannot change expenses.',
    },
  ])('applies form deny-wins for $name', async ({
    mode,
    nextDashboard,
    nextDetail,
    nextTrip,
    message,
  }) => {
    mockParams =
      mode === 'create'
        ? { tripId: TRIP_ID, mode }
        : {
            tripId: TRIP_ID,
            mode,
            expenseId: EXPENSE_ID,
          };
    mockUseExpenseDashboard.mockReturnValue(
      dashboardHookState(nextDashboard),
    );
    mockUseExpenseDetail.mockReturnValue(detailHookState(nextDetail));
    mockUseTripDetail.mockReturnValue(tripHookState(nextTrip));
    await render(<ExpenseFormScreen />);

    expect(currentFormProps().canSubmit).toBe(false);
    expect(currentFormProps().authorityMessage).toBe(message);
  });

  it('uses all active trip members for create collectors', async () => {
    mockParams = { tripId: TRIP_ID, mode: 'create' };
    await render(<ExpenseFormScreen />);

    expect(
      currentFormProps().collectors.map((candidate) => candidate.user.id),
    ).toEqual([CAPTAIN_ID, MEMBER_ID, LATE_MEMBER_ID]);
    expect(currentFormProps().currentCollector).toBeNull();
  });

  it('intersects edit collectors with immutable participants and keeps a departed collector display-only', async () => {
    mockUseExpenseDetail.mockReturnValue(
      detailHookState(
        expenseDetail({
          collector: {
            id: DEPARTED_ID,
            display_name: 'Former member',
            identify_tag: 'former#1234',
          },
          participants: [
            participant(DEPARTED_ID, 'Former member'),
            participant(CAPTAIN_ID, 'Minh'),
          ],
        }),
      ),
    );
    await render(<ExpenseFormScreen />);

    expect(
      currentFormProps().collectors.map((candidate) => candidate.user.id),
    ).toEqual([CAPTAIN_ID]);
    expect(currentFormProps().collectors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user: expect.objectContaining({ id: LATE_MEMBER_ID }),
        }),
      ]),
    );
    expect(currentFormProps().currentCollector).toMatchObject({
      id: DEPARTED_ID,
      display_name: 'Former member',
    });
    expect(currentFormProps().draft.collector_id).toBe(DEPARTED_ID);
  });

  it('omits an unchanged departed collector from a dirty edit PATCH', async () => {
    mockUseExpenseDetail.mockReturnValue(
      detailHookState(
        expenseDetail({
          collector: {
            id: DEPARTED_ID,
            display_name: 'Former member',
            identify_tag: 'former#1234',
          },
          participants: [
            participant(DEPARTED_ID, 'Former member'),
            participant(CAPTAIN_ID, 'Minh'),
          ],
        }),
      ),
    );
    await render(<ExpenseFormScreen />);
    await focusScreen();
    await changeDraft({ title: 'Updated hotel' });
    await act(async () => {
      currentFormProps().onSubmit();
    });

    await waitFor(() =>
      expect(mockUpdateExpense).toHaveBeenCalledWith(
        TRIP_ID,
        EXPENSE_ID,
        { title: 'Updated hotel' },
      ),
    );
  });

  it('includes an explicitly selected eligible collector in PATCH', async () => {
    await render(<ExpenseFormScreen />);
    await focusScreen();
    await changeDraft({ collector_id: MEMBER_ID });

    await act(async () => {
      currentFormProps().onSubmit();
    });

    await waitFor(() =>
      expect(mockUpdateExpense).toHaveBeenCalledWith(
        TRIP_ID,
        EXPENSE_ID,
        { collector_id: MEMBER_ID },
      ),
    );
  });

  it('rejects a late active member outside the immutable participant snapshot', async () => {
    await render(<ExpenseFormScreen />);
    await focusScreen();
    await changeDraft({ collector_id: LATE_MEMBER_ID });

    await act(async () => {
      currentFormProps().onSubmit();
    });

    expect(mockUpdateExpense).not.toHaveBeenCalled();
    expect(currentFormProps().fieldErrors.collector_id).toBe(
      'Choose an eligible active trip member.',
    );
  });

  it('sends only dirty normalized edit fields', async () => {
    await render(<ExpenseFormScreen />);
    await focusScreen();
    await changeDraft({ title: '  Updated hotel  ' });

    await act(async () => {
      currentFormProps().onSubmit();
    });

    await waitFor(() =>
      expect(mockUpdateExpense).toHaveBeenCalledWith(
        TRIP_ID,
        EXPENSE_ID,
        { title: 'Updated hotel' },
      ),
    );
    expect(mockCreateExpense).not.toHaveBeenCalled();
  });

  it('creates with canonical strings and omits creator-default collector', async () => {
    mockParams = { tripId: TRIP_ID, mode: 'create' };
    await render(<ExpenseFormScreen />);
    await focusScreen();
    await changeDraft({
      title: '  Taxi  ',
      description: '  Airport ride  ',
      total_amount: '00120.50',
    });

    await act(async () => {
      currentFormProps().onSubmit();
    });

    await waitFor(() =>
      expect(mockCreateExpense).toHaveBeenCalledWith(TRIP_ID, {
        title: 'Taxi',
        description: 'Airport ride',
        total_amount: '120.50',
      }),
    );
  });

  it('locks duplicate submit and Cancel, then publishes and dismisses without self-refresh', async () => {
    const pending = deferred<ExpenseResponse>();
    mockCreateExpense.mockReturnValue(pending.promise);
    mockParams = { tripId: TRIP_ID, mode: 'create' };
    await render(<ExpenseFormScreen />);
    await focusScreen();
    mockRefreshDashboard.mockClear();
    mockRefreshTrip.mockClear();
    await changeDraft({
      title: 'Taxi',
      total_amount: '120.00',
    });

    await act(async () => {
      currentFormProps().onSubmit();
      currentFormProps().onSubmit();
    });
    await waitFor(() =>
      expect(mockCreateExpense).toHaveBeenCalledTimes(1),
    );
    expect(mockInvalidateDashboard).toHaveBeenCalledTimes(1);
    expect(currentFormProps().submitting).toBe(true);
    expect(mockLatestStackOptions?.gestureEnabled).toBe(false);
    await fireEvent.press(
      screen.getByLabelText('Cancel expense form'),
    );
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(expenseResponse({ title: 'Taxi' }));
    });

    await waitFor(() =>
      expect(mockRouter.dismissTo).toHaveBeenCalledWith(
        `/trips/${TRIP_ID}/expenses`,
      ),
    );
    expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1);
    expect(mockRefreshDashboard).not.toHaveBeenCalled();
    expect(mockRefreshTrip).not.toHaveBeenCalled();
  });

  it('refreshes both sources after active 409 without event or navigation', async () => {
    mockUpdateExpense.mockRejectedValueOnce(
      axiosErrorWith(409, {
        detail: 'Settlement is finalized.',
        error_code: 'EXPENSE_LOCKED',
      }),
    );
    await render(<ExpenseFormScreen />);
    await focusScreen();
    mockRefreshDetail.mockClear();
    mockRefreshTrip.mockClear();
    await changeDraft({ title: 'Conflict' });

    await act(async () => {
      currentFormProps().onSubmit();
    });

    await waitFor(() =>
      expect(currentFormProps().submitError?.message).toBe(
        'Settlement is finalized.',
      ),
    );
    expect(mockRefreshDetail).toHaveBeenCalledWith('silent');
    expect(mockRefreshTrip).toHaveBeenCalledWith('silent');
    expect(mockPublishExpenseEvent).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('publishes one late success after unmount without navigation', async () => {
    const pending = deferred<ExpenseResponse>();
    mockCreateExpense.mockReturnValue(pending.promise);
    mockParams = { tripId: TRIP_ID, mode: 'create' };
    const rendered = await render(<ExpenseFormScreen />);
    const blur = await focusScreen();
    await changeDraft({
      title: 'Late success',
      total_amount: '120.00',
    });
    await act(async () => {
      currentFormProps().onSubmit();
    });
    await waitFor(() =>
      expect(mockCreateExpense).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      blur?.();
    });
    await rendered.unmount();
    await act(async () => {
      pending.resolve(expenseResponse({ title: 'Late success' }));
    });

    await waitFor(() =>
      expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1),
    );
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('ignores a late failure after unmount without refresh, event, or navigation', async () => {
    const pending = deferred<ExpenseResponse>();
    mockCreateExpense.mockReturnValue(pending.promise);
    mockParams = { tripId: TRIP_ID, mode: 'create' };
    const rendered = await render(<ExpenseFormScreen />);
    const blur = await focusScreen();
    await changeDraft({
      title: 'Late failure',
      total_amount: '120.00',
    });
    await act(async () => {
      currentFormProps().onSubmit();
    });
    await waitFor(() =>
      expect(mockCreateExpense).toHaveBeenCalledTimes(1),
    );
    mockRefreshDashboard.mockClear();
    mockRefreshTrip.mockClear();

    await act(async () => {
      blur?.();
    });
    await rendered.unmount();
    await act(async () => {
      pending.reject(
        axiosErrorWith(409, {
          detail: 'Invisible conflict.',
          error_code: 'SETTLEMENT_ALREADY_FINALIZED',
        }),
      );
    });

    expect(mockRefreshDashboard).not.toHaveBeenCalled();
    expect(mockRefreshTrip).not.toHaveBeenCalled();
    expect(mockPublishExpenseEvent).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('keeps a blurred committed create terminal and dismisses on refocus without replay', async () => {
    const pending = deferred<ExpenseResponse>();
    mockCreateExpense.mockReturnValue(pending.promise);
    mockParams = { tripId: TRIP_ID, mode: 'create' };
    await render(<ExpenseFormScreen />);
    const blur = await focusScreen();
    await changeDraft({
      title: 'Committed while blurred',
      total_amount: '120.00',
    });
    await act(async () => {
      currentFormProps().onSubmit();
    });
    await waitFor(() =>
      expect(mockCreateExpense).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      blur?.();
      pending.resolve(
        expenseResponse({ title: 'Committed while blurred' }),
      );
    });
    await waitFor(() =>
      expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1),
    );
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    await act(async () => {
      currentFormProps().onSubmit();
    });
    expect(mockCreateExpense).toHaveBeenCalledTimes(1);

    await focusScreen();
    await waitFor(() =>
      expect(mockRouter.dismissTo).toHaveBeenCalledWith(
        `/trips/${TRIP_ID}/expenses`,
      ),
    );
    expect(mockCreateExpense).toHaveBeenCalledTimes(1);
  });

  it('reconciles paired sources for focus, foreground, events, retry, and pull refresh', async () => {
    await render(<ExpenseFormScreen />);
    const blur = await focusScreen();
    expect(mockRefreshDetail).toHaveBeenCalledWith('initial');
    expect(mockRefreshTrip).toHaveBeenCalledWith('initial');
    mockRefreshDetail.mockClear();
    mockRefreshTrip.mockClear();

    await act(async () => {
      latestForegroundCallback()();
    });
    expect(mockRefreshDetail).toHaveBeenCalledWith('silent');
    expect(mockRefreshTrip).toHaveBeenCalledWith('silent');
    mockRefreshDetail.mockClear();
    mockRefreshTrip.mockClear();

    await act(async () => {
      await mockExpenseListener?.({
        type: 'expensesChanged',
        tripId: TRIP_ID,
      });
    });
    expect(mockRefreshDetail).toHaveBeenCalledWith('silent');
    expect(mockRefreshTrip).toHaveBeenCalledWith('silent');
    mockRefreshDetail.mockClear();
    mockRefreshTrip.mockClear();

    await act(async () => {
      mockTripListener?.({
        type: 'statusChanged',
        tripId: 'another-trip',
        status: 'COMPLETED',
      });
    });
    expect(mockRefreshDetail).not.toHaveBeenCalled();
    expect(mockRefreshTrip).not.toHaveBeenCalled();

    await act(async () => {
      mockTripListener?.({
        type: 'statusChanged',
        tripId: TRIP_ID,
        status: 'COMPLETED',
      });
    });
    expect(mockRefreshDetail).toHaveBeenCalledWith('silent');
    expect(mockRefreshTrip).toHaveBeenCalledWith('silent');
    mockRefreshDetail.mockClear();
    mockRefreshTrip.mockClear();

    await act(async () => {
      currentFormProps().onRetryBackground?.();
    });
    expect(mockRefreshDetail).toHaveBeenCalledWith('silent');
    expect(mockRefreshTrip).toHaveBeenCalledWith('silent');
    mockRefreshDetail.mockClear();
    mockRefreshTrip.mockClear();

    await act(async () => {
      currentFormProps().onRefresh?.();
    });
    expect(mockRefreshDetail).toHaveBeenCalledWith('refresh');
    expect(mockRefreshTrip).toHaveBeenCalledWith('refresh');
    mockRefreshDetail.mockClear();
    mockRefreshTrip.mockClear();

    await act(async () => {
      blur?.();
      latestForegroundCallback()();
      await mockExpenseListener?.({
        type: 'expensesChanged',
        tripId: TRIP_ID,
      });
    });
    expect(mockRefreshDetail).not.toHaveBeenCalled();
    expect(mockRefreshTrip).not.toHaveBeenCalled();
  });
});
