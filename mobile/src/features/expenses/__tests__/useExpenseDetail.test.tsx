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
  getExpenseDetail: jest.fn(),
}));

// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { getExpenseDetail } from '../api';
// eslint-disable-next-line import/first
import { publishExpenseEvent } from '../expenseEvents';
// eslint-disable-next-line import/first
import { useExpenseDetail } from '../hooks/useExpenseDetail';
// eslint-disable-next-line import/first
import type { ExpenseDetailResponse } from '../types';

const mockGetExpenseDetail =
  getExpenseDetail as jest.MockedFunction<typeof getExpenseDetail>;

function expenseDetail(
  title: string,
  id = 'expense-1',
): ExpenseDetailResponse {
  return {
    id,
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
    locked_at: null,
    created_at: '2026-07-28T00:00:00Z',
    permissions: {
      can_manage_expenses: true,
    },
    participants: [
      {
        user_id: 'user-1',
        display_name: 'Minh',
        identify_tag: 'minh#1234',
        share_amount: '60.00',
        contributed_amount: '90.00',
        balance: '30.00',
        surplus_held: '0.00',
      },
      {
        user_id: 'user-2',
        display_name: 'Lan',
        identify_tag: 'lan#5678',
        share_amount: '60.00',
        contributed_amount: '0.00',
        balance: '-60.00',
        surplus_held: '0.00',
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

describe('useExpenseDetail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads initially on focus and silently reconciles complete data', async () => {
    const silent = deferred<ExpenseDetailResponse>();
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Hotel'))
      .mockReturnValueOnce(silent.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.detail?.title).toBe('Hotel'));

    await act(async () => {
      latestFocusCallback()();
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.refreshing).toBe(false);
    expect(result.current.detail?.title).toBe('Hotel');

    await act(async () => {
      silent.resolve(expenseDetail('Updated hotel'));
    });
    expect(result.current.detail?.title).toBe('Updated hotel');
    unmount();
  });

  it('sets refreshing only for explicit refresh and keeps data visible', async () => {
    const explicit = deferred<ExpenseDetailResponse>();
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Hotel'))
      .mockReturnValueOnce(explicit.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      void result.current.refresh('refresh');
    });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.detail?.title).toBe('Hotel');

    await act(async () => {
      explicit.resolve(expenseDetail('Refreshed hotel'));
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.detail?.title).toBe('Refreshed hotel');
    unmount();
  });

  it('lets a newer silent request own an older explicit refresh completion', async () => {
    const explicit = deferred<ExpenseDetailResponse>();
    const silent = deferred<ExpenseDetailResponse>();
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Hotel'))
      .mockReturnValueOnce(explicit.promise)
      .mockReturnValueOnce(silent.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
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
      explicit.resolve(expenseDetail('Stale explicit'));
    });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.detail?.title).toBe('Hotel');

    await act(async () => {
      silent.resolve(expenseDetail('Latest silent'));
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.detail?.title).toBe('Latest silent');
    unmount();
  });

  it('lets a newer explicit refresh own an older silent completion', async () => {
    const silent = deferred<ExpenseDetailResponse>();
    const explicit = deferred<ExpenseDetailResponse>();
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Hotel'))
      .mockReturnValueOnce(silent.promise)
      .mockReturnValueOnce(explicit.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
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
      silent.resolve(expenseDetail('Stale silent'));
    });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.detail?.title).toBe('Hotel');

    await act(async () => {
      explicit.resolve(expenseDetail('Latest explicit'));
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.detail?.title).toBe('Latest explicit');
    unmount();
  });

  it('ignores stale catch and finally branches after a newer request starts', async () => {
    const stale = deferred<ExpenseDetailResponse>();
    const latest = deferred<ExpenseDetailResponse>();
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Hotel'))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
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
      latest.resolve(expenseDetail('Latest'));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(false);
    unmount();
  });

  it('retains complete data after a non-404 background failure', async () => {
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Hotel'))
      .mockRejectedValueOnce(
        axiosErrorWith(500, {
          detail: 'Expense is temporarily unavailable.',
        }),
      );
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
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
        'Expense is temporarily unavailable.',
      ),
    );
    expect(result.current.status).toBe('ready');
    expect(result.current.detail?.title).toBe('Hotel');
    unmount();
  });

  it('retains complete data for an unrelated generic 404', async () => {
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Hotel'))
      .mockRejectedValueOnce(
        axiosErrorWith(404, {
          detail: 'An unrelated resource was not found.',
          error_code: 'UNRELATED_NOT_FOUND',
        }),
      );
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
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
    expect(result.current.detail?.title).toBe('Hotel');
    unmount();
  });

  it.each([
    ['TRIP_NOT_FOUND', 'Trip not found.'],
    ['EXPENSE_NOT_FOUND', 'Expense not found.'],
  ])(
    'clears complete data for relevant %s responses',
    async (errorCode, message) => {
      mockGetExpenseDetail
        .mockResolvedValueOnce(expenseDetail('Hotel'))
        .mockRejectedValueOnce(
          axiosErrorWith(404, {
            detail: message,
            error_code: errorCode,
          }),
        );
      const { result, unmount } = await renderHook(() =>
        useExpenseDetail('trip-1', 'expense-1'),
      );

      await act(async () => {
        latestFocusCallback()();
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));
      await act(async () => {
        latestForegroundCallback()();
      });

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.detail).toBeNull();
      expect(result.current.error).toMatchObject({
        message,
        errorCode,
        status: 404,
      });
      unmount();
    },
  );

  it('reconciles for every same-trip expense event and ignores other trips', async () => {
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Hotel'))
      .mockResolvedValueOnce(expenseDetail('Event update'));
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
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
    expect(mockGetExpenseDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      await publishExpenseEvent({
        type: 'expensesChanged',
        tripId: 'trip-1',
      });
    });
    await waitFor(() =>
      expect(result.current.detail?.title).toBe('Event update'),
    );
    expect(mockGetExpenseDetail).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('ignores event and foreground reconciliation while blurred then loads once on refocus', async () => {
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Hotel'))
      .mockResolvedValueOnce(expenseDetail('Refocused'));
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
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
    expect(mockGetExpenseDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() =>
      expect(result.current.detail?.title).toBe('Refocused'),
    );
    expect(mockGetExpenseDetail).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not own focus, foreground, or events when auto reconciliation is disabled', async () => {
    mockGetExpenseDetail.mockResolvedValue(expenseDetail('Manual load'));
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1', {
        autoReconcile: false,
      }),
    );

    await act(async () => {
      latestFocusCallback()();
      latestForegroundCallback()();
      await publishExpenseEvent({
        type: 'expensesChanged',
        tripId: 'trip-1',
      });
    });
    expect(mockGetExpenseDetail).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refresh('initial');
    });
    expect(result.current.detail?.title).toBe('Manual load');
    unmount();
  });

  it('invalidates a coordinator request when a non-reconciling screen blurs', async () => {
    const pending = deferred<ExpenseDetailResponse>();
    mockGetExpenseDetail.mockReturnValue(pending.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1', {
        autoReconcile: false,
      }),
    );

    let cleanup: (() => void) | void;
    await act(async () => {
      cleanup = latestFocusCallback()();
      void result.current.refresh('initial');
    });
    await act(async () => {
      cleanup?.();
      pending.resolve(expenseDetail('Stale'));
    });

    expect(result.current.detail).toBeNull();
    expect(result.current.status).toBe('loading');
    unmount();
  });

  it('isolates the composite key when only the expense id changes', async () => {
    const first = deferred<ExpenseDetailResponse>();
    const second = deferred<ExpenseDetailResponse>();
    mockGetExpenseDetail
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender, unmount } = await renderHook(
      ({
        tripId,
        expenseId,
      }: {
        tripId: string;
        expenseId: string;
      }) => useExpenseDetail(tripId, expenseId),
      {
        initialProps: {
          tripId: 'trip-1',
          expenseId: 'expense-1',
        },
      },
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await rerender({ tripId: 'trip-1', expenseId: 'expense-2' });
    expect(result.current.detail).toBeNull();
    expect(result.current.status).toBe('loading');

    await act(async () => {
      latestFocusCallback()();
      first.resolve(expenseDetail('Wrong expense', 'expense-1'));
    });
    expect(result.current.detail).toBeNull();

    await act(async () => {
      second.resolve(expenseDetail('Right expense', 'expense-2'));
    });
    expect(result.current.detail).toMatchObject({
      id: 'expense-2',
      title: 'Right expense',
    });
    expect(mockGetExpenseDetail).toHaveBeenNthCalledWith(
      1,
      'trip-1',
      'expense-1',
    );
    expect(mockGetExpenseDetail).toHaveBeenNthCalledWith(
      2,
      'trip-1',
      'expense-2',
    );
    unmount();
  });

  it('isolates the composite key when only the trip id changes', async () => {
    const first = deferred<ExpenseDetailResponse>();
    const second = deferred<ExpenseDetailResponse>();
    mockGetExpenseDetail
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender, unmount } = await renderHook(
      ({
        tripId,
        expenseId,
      }: {
        tripId: string;
        expenseId: string;
      }) => useExpenseDetail(tripId, expenseId),
      {
        initialProps: {
          tripId: 'trip-1',
          expenseId: 'expense-1',
        },
      },
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await rerender({ tripId: 'trip-2', expenseId: 'expense-1' });
    expect(result.current.detail).toBeNull();

    await act(async () => {
      latestFocusCallback()();
      first.reject(
        axiosErrorWith(404, {
          detail: 'Expense not found.',
          error_code: 'EXPENSE_NOT_FOUND',
        }),
      );
    });
    expect(result.current.detail).toBeNull();
    expect(result.current.error).toBeNull();

    await act(async () => {
      second.resolve(expenseDetail('Right trip'));
    });
    expect(result.current.detail?.title).toBe('Right trip');
    expect(mockGetExpenseDetail).toHaveBeenNthCalledWith(
      2,
      'trip-2',
      'expense-1',
    );
    unmount();
  });

  it.each([
    [undefined, 'expense-1'],
    ['trip-1', undefined],
    [undefined, undefined],
  ])(
    'makes no feature request for incomplete key (%s, %s)',
    async (tripId, expenseId) => {
      const { result, unmount } = await renderHook(() =>
        useExpenseDetail(tripId, expenseId),
      );

      await act(async () => {
        latestFocusCallback()();
      });

      expect(mockGetExpenseDetail).not.toHaveBeenCalled();
      expect(result.current.detail).toBeNull();
      expect(result.current.status).toBe('error');
      expect(result.current.error).toMatchObject({
        errorCode: 'EXPENSE_NOT_FOUND',
        status: 404,
      });
      unmount();
    },
  );

  it('mutation invalidation prevents a pre-mutation success from overwriting reconciliation', async () => {
    const preMutation = deferred<ExpenseDetailResponse>();
    const postMutation = deferred<ExpenseDetailResponse>();
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Before mutation'))
      .mockReturnValueOnce(preMutation.promise)
      .mockReturnValueOnce(postMutation.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
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
      preMutation.resolve(expenseDetail('Stale before mutation'));
    });
    expect(result.current.detail?.title).toBe('Before mutation');

    await act(async () => {
      postMutation.resolve(expenseDetail('After mutation'));
    });
    expect(result.current.detail?.title).toBe('After mutation');
    unmount();
  });

  it('mutation invalidation suppresses stale catch and finally without a reload', async () => {
    const preMutation = deferred<ExpenseDetailResponse>();
    mockGetExpenseDetail
      .mockResolvedValueOnce(expenseDetail('Before mutation'))
      .mockReturnValueOnce(preMutation.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseDetail('trip-1', 'expense-1'),
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
          detail: 'Expense not found.',
          error_code: 'EXPENSE_NOT_FOUND',
        }),
      );
    });

    expect(result.current.refreshing).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.detail?.title).toBe('Before mutation');
    unmount();
  });
});
