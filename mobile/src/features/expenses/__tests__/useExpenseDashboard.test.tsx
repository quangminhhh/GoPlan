const mockUseFocusEffect = jest.fn();
const mockUseAppForegroundEffect = jest.fn();

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | void) =>
    mockUseFocusEffect(effect),
}));

jest.mock('@/shared/hooks/useAppForegroundEffect', () => ({
  useAppForegroundEffect: (listener: () => void) =>
    mockUseAppForegroundEffect(listener),
}));

jest.mock('../api', () => ({
  getExpenseDashboard: jest.fn(),
}));

// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { getExpenseDashboard } from '../api';
// eslint-disable-next-line import/first
import { publishExpenseEvent } from '../expenseEvents';
// eslint-disable-next-line import/first
import { useExpenseDashboard } from '../hooks/useExpenseDashboard';
// eslint-disable-next-line import/first
import type { ExpenseDashboardResponse } from '../types';

const mockGetExpenseDashboard =
  getExpenseDashboard as jest.MockedFunction<typeof getExpenseDashboard>;

function expenseDashboard(title: string): ExpenseDashboardResponse {
  return {
    currency_code: 'USD',
    summary: {
      total_amount: '120.00',
      paid_amount: '90.00',
      missing_amount: '30.00',
      surplus_amount: '0.00',
    },
    permissions: {
      can_manage_expenses: true,
    },
    my_balance: {
      balance: '-30.00',
      surplus_held: '0.00',
    },
    member_balances: {
      'user-1': {
        balance: '-30.00',
      },
      'user-2': {
        balance: '30.00',
      },
    },
    settlement: null,
    expenses: [
      {
        id: 'expense-1',
        title,
        description: '',
        total_amount: '120.00',
        paid_amount: '90.00',
        missing_amount: '30.00',
        surplus_amount: '0.00',
        currency_code: 'USD',
        status: 'UNDERFUNDED',
        collector: {
          id: 'user-1',
          display_name: 'Minh',
          identify_tag: 'minh#1234',
        },
        locked: false,
      },
    ],
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
    throw new Error('Expected useAppForegroundEffect to register a callback.');
  }
  return callback;
}

describe('useExpenseDashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads initially on focus and silently reconciles complete data', async () => {
    const silent = deferred<ExpenseDashboardResponse>();
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Hotel'))
      .mockReturnValueOnce(silent.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() =>
      expect(result.current.dashboard?.expenses[0]?.title).toBe('Hotel'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.refreshing).toBe(false);
    expect(result.current.dashboard?.expenses[0]?.title).toBe('Hotel');

    await act(async () => {
      silent.resolve(expenseDashboard('Updated hotel'));
    });
    expect(result.current.dashboard?.expenses[0]?.title).toBe(
      'Updated hotel',
    );
    unmount();
  });

  it('sets refreshing only for explicit refresh and keeps data visible', async () => {
    const explicit = deferred<ExpenseDashboardResponse>();
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Hotel'))
      .mockReturnValueOnce(explicit.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      void result.current.refresh('refresh');
    });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.dashboard?.expenses[0]?.title).toBe('Hotel');

    await act(async () => {
      explicit.resolve(expenseDashboard('Refreshed hotel'));
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.dashboard?.expenses[0]?.title).toBe(
      'Refreshed hotel',
    );
    unmount();
  });

  it('lets a newer silent request own an older explicit refresh completion', async () => {
    const explicit = deferred<ExpenseDashboardResponse>();
    const silent = deferred<ExpenseDashboardResponse>();
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Hotel'))
      .mockReturnValueOnce(explicit.promise)
      .mockReturnValueOnce(silent.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      void result.current.refresh('refresh');
      void result.current.refresh('silent');
    });
    await act(async () => {
      explicit.resolve(expenseDashboard('Stale explicit'));
    });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.dashboard?.expenses[0]?.title).toBe('Hotel');

    await act(async () => {
      silent.resolve(expenseDashboard('Latest silent'));
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.dashboard?.expenses[0]?.title).toBe(
      'Latest silent',
    );
    unmount();
  });

  it('lets a newer explicit refresh own an older silent completion', async () => {
    const silent = deferred<ExpenseDashboardResponse>();
    const explicit = deferred<ExpenseDashboardResponse>();
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Hotel'))
      .mockReturnValueOnce(silent.promise)
      .mockReturnValueOnce(explicit.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      void result.current.refresh('silent');
      void result.current.refresh('refresh');
    });
    await act(async () => {
      silent.resolve(expenseDashboard('Stale silent'));
    });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.dashboard?.expenses[0]?.title).toBe('Hotel');

    await act(async () => {
      explicit.resolve(expenseDashboard('Latest explicit'));
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.dashboard?.expenses[0]?.title).toBe(
      'Latest explicit',
    );
    unmount();
  });

  it('ignores stale catch and finally branches after a newer request starts', async () => {
    const stale = deferred<ExpenseDashboardResponse>();
    const latest = deferred<ExpenseDashboardResponse>();
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Hotel'))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      void result.current.refresh('refresh');
      void result.current.refresh('silent');
    });
    await act(async () => {
      stale.reject(axiosErrorWith(500, { detail: 'Stale failure.' }));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(true);

    await act(async () => {
      latest.resolve(expenseDashboard('Latest'));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(false);
    unmount();
  });

  it('retains complete data after a non-404 background failure', async () => {
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Hotel'))
      .mockRejectedValueOnce(
        axiosErrorWith(500, {
          detail: 'Expenses are temporarily unavailable.',
        }),
      );
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      latestForegroundCallback()();
    });

    await waitFor(() =>
      expect(result.current.error?.message).toBe(
        'Expenses are temporarily unavailable.',
      ),
    );
    expect(result.current.status).toBe('ready');
    expect(result.current.dashboard?.expenses[0]?.title).toBe('Hotel');
    unmount();
  });

  it('retains complete data for an unrelated generic 404', async () => {
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Hotel'))
      .mockRejectedValueOnce(
        axiosErrorWith(404, {
          detail: 'An unrelated resource was not found.',
          error_code: 'UNRELATED_NOT_FOUND',
        }),
      );
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      latestForegroundCallback()();
    });

    await waitFor(() => expect(result.current.error?.status).toBe(404));
    expect(result.current.status).toBe('ready');
    expect(result.current.dashboard?.expenses[0]?.title).toBe('Hotel');
    unmount();
  });

  it('clears complete data for a relevant TRIP_NOT_FOUND response', async () => {
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Hotel'))
      .mockRejectedValueOnce(
        axiosErrorWith(404, {
          detail: 'Trip not found.',
          error_code: 'TRIP_NOT_FOUND',
        }),
      );
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      latestForegroundCallback()();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.dashboard).toBeNull();
    expect(result.current.error).toMatchObject({
      message: 'Trip not found.',
      errorCode: 'TRIP_NOT_FOUND',
      status: 404,
    });
    unmount();
  });

  it('reconciles only same-trip expense events while focused', async () => {
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Hotel'))
      .mockResolvedValueOnce(expenseDashboard('Event update'));
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await publishExpenseEvent({
        type: 'expensesChanged',
        tripId: 'trip-2',
      });
    });
    expect(mockGetExpenseDashboard).toHaveBeenCalledTimes(1);

    await act(async () => {
      await publishExpenseEvent({
        type: 'expensesChanged',
        tripId: 'trip-1',
      });
    });
    await waitFor(() =>
      expect(result.current.dashboard?.expenses[0]?.title).toBe(
        'Event update',
      ),
    );
    expect(mockGetExpenseDashboard).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('ignores event and foreground reconciliation while blurred then loads once on refocus', async () => {
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Hotel'))
      .mockResolvedValueOnce(expenseDashboard('Refocused'));
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    let blur: (() => void) | void;
    await act(async () => {
      blur = latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      blur?.();
      latestForegroundCallback()();
      await publishExpenseEvent({
        type: 'expensesChanged',
        tripId: 'trip-1',
      });
    });
    expect(mockGetExpenseDashboard).toHaveBeenCalledTimes(1);

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() =>
      expect(result.current.dashboard?.expenses[0]?.title).toBe('Refocused'),
    );
    expect(mockGetExpenseDashboard).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not own focus, foreground, or events when auto reconciliation is disabled', async () => {
    mockGetExpenseDashboard.mockResolvedValue(
      expenseDashboard('Manual load'),
    );
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1', { autoReconcile: false }),
    );

    await act(async () => {
      latestFocusCallback()();
      latestForegroundCallback()();
      await publishExpenseEvent({
        type: 'expensesChanged',
        tripId: 'trip-1',
      });
    });
    expect(mockGetExpenseDashboard).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refresh('initial');
    });
    expect(result.current.dashboard?.expenses[0]?.title).toBe(
      'Manual load',
    );
    unmount();
  });

  it('invalidates a coordinator request when a non-reconciling screen blurs', async () => {
    const pending = deferred<ExpenseDashboardResponse>();
    mockGetExpenseDashboard.mockReturnValue(pending.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1', { autoReconcile: false }),
    );

    let cleanup: (() => void) | void;
    await act(async () => {
      cleanup = latestFocusCallback()();
      void result.current.refresh('initial');
    });
    await act(async () => {
      cleanup?.();
      pending.resolve(expenseDashboard('Stale'));
    });

    expect(result.current.dashboard).toBeNull();
    expect(result.current.status).toBe('loading');
    unmount();
  });

  it('hides the old trip immediately and ignores its late completion after a key change', async () => {
    const first = deferred<ExpenseDashboardResponse>();
    const second = deferred<ExpenseDashboardResponse>();
    mockGetExpenseDashboard
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender, unmount } = await renderHook(
      ({ tripId }: { tripId: string }) => useExpenseDashboard(tripId),
      { initialProps: { tripId: 'trip-1' } },
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await rerender({ tripId: 'trip-2' });
    expect(result.current.dashboard).toBeNull();
    expect(result.current.status).toBe('loading');

    await act(async () => {
      latestFocusCallback()();
      first.resolve(expenseDashboard('Wrong trip'));
    });
    expect(result.current.dashboard).toBeNull();

    await act(async () => {
      second.resolve(expenseDashboard('Right trip'));
    });
    expect(result.current.dashboard?.expenses[0]?.title).toBe('Right trip');
    expect(mockGetExpenseDashboard).toHaveBeenNthCalledWith(1, 'trip-1');
    expect(mockGetExpenseDashboard).toHaveBeenNthCalledWith(2, 'trip-2');
    unmount();
  });

  it('makes no feature request when the trip id is missing', async () => {
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard(undefined),
    );

    await act(async () => {
      latestFocusCallback()();
    });

    expect(mockGetExpenseDashboard).not.toHaveBeenCalled();
    expect(result.current.dashboard).toBeNull();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatchObject({
      errorCode: 'TRIP_NOT_FOUND',
      status: 404,
    });
    unmount();
  });

  it('mutation invalidation prevents a pre-mutation success from overwriting reconciliation', async () => {
    const preMutation = deferred<ExpenseDashboardResponse>();
    const postMutation = deferred<ExpenseDashboardResponse>();
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Before mutation'))
      .mockReturnValueOnce(preMutation.promise)
      .mockReturnValueOnce(postMutation.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      void result.current.refresh('silent');
      result.current.invalidate();
      void result.current.refresh('silent');
    });
    await act(async () => {
      preMutation.resolve(expenseDashboard('Stale before mutation'));
    });
    expect(result.current.dashboard?.expenses[0]?.title).toBe(
      'Before mutation',
    );

    await act(async () => {
      postMutation.resolve(expenseDashboard('After mutation'));
    });
    expect(result.current.dashboard?.expenses[0]?.title).toBe(
      'After mutation',
    );
    unmount();
  });

  it('mutation invalidation suppresses stale catch and finally without a reload', async () => {
    const preMutation = deferred<ExpenseDashboardResponse>();
    mockGetExpenseDashboard
      .mockResolvedValueOnce(expenseDashboard('Before mutation'))
      .mockReturnValueOnce(preMutation.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDashboard('trip-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      void result.current.refresh('refresh');
    });
    expect(result.current.refreshing).toBe(true);

    await act(async () => {
      result.current.invalidate();
      preMutation.reject(
        axiosErrorWith(404, {
          detail: 'Trip not found.',
          error_code: 'TRIP_NOT_FOUND',
        }),
      );
    });

    expect(result.current.refreshing).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.dashboard?.expenses[0]?.title).toBe(
      'Before mutation',
    );
    unmount();
  });
});
