const mockUseFocusEffect = jest.fn();
const mockUseAppForegroundEffect = jest.fn();
const mockSubscribeToExpenseEvents = jest.fn();
const mockSubscribeToTripEvents = jest.fn();
let mockExpenseListener:
  | ((event: {
      type: 'expensesChanged';
      tripId: string;
    }) => void | Promise<void>)
  | undefined;
let mockTripListener:
  | ((event:
      | {
          type: 'statusChanged';
          tripId: string;
          status: 'PLANNING' | 'ONGOING' | 'COMPLETED' | 'CANCELLED';
        }
      | {
          type: 'removed';
          tripId: string;
        }) => void)
  | undefined;

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | void) =>
    mockUseFocusEffect(effect),
}));

jest.mock('@/shared/hooks/useAppForegroundEffect', () => ({
  useAppForegroundEffect: (listener: () => void) =>
    mockUseAppForegroundEffect(listener),
}));

jest.mock('../expenseEvents', () => ({
  subscribeToExpenseEvents: (...args: unknown[]) =>
    mockSubscribeToExpenseEvents(...args),
}));

jest.mock('@/features/trips/tripEvents', () => ({
  subscribeToTripEvents: (...args: unknown[]) =>
    mockSubscribeToTripEvents(...args),
}));

// eslint-disable-next-line import/first
import { act, renderHook } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { useExpenseCompositionCoordinator } from '../hooks/useExpenseCompositionCoordinator';

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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

describe('useExpenseCompositionCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExpenseListener = undefined;
    mockTripListener = undefined;
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
    mockSubscribeToTripEvents.mockImplementation(
      (
        listener: (
          event:
            | {
                type: 'statusChanged';
                tripId: string;
                status:
                  | 'PLANNING'
                  | 'ONGOING'
                  | 'COMPLETED'
                  | 'CANCELLED';
              }
            | {
                type: 'removed';
                tripId: string;
              },
        ) => void,
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

  it('owns one paired load for initial focus, refocus, foreground, and matching events', async () => {
    const refreshExpense = jest.fn().mockResolvedValue(undefined);
    const refreshTrip = jest.fn().mockResolvedValue(undefined);
    const { result, unmount } = await renderHook(() =>
      useExpenseCompositionCoordinator({
        tripId: TRIP_ID,
        refreshExpense,
        refreshTrip,
      }),
    );

    let blur: (() => void) | void;
    await act(async () => {
      blur = latestFocusCallback()();
    });
    expect(refreshExpense).toHaveBeenLastCalledWith('initial');
    expect(refreshTrip).toHaveBeenLastCalledWith('initial');
    expect(refreshExpense).toHaveBeenCalledTimes(1);
    expect(refreshTrip).toHaveBeenCalledTimes(1);

    refreshExpense.mockClear();
    refreshTrip.mockClear();
    await act(async () => {
      blur?.();
      blur = latestFocusCallback()();
    });
    expect(refreshExpense).toHaveBeenCalledTimes(1);
    expect(refreshTrip).toHaveBeenCalledTimes(1);
    expect(refreshExpense).toHaveBeenLastCalledWith('silent');
    expect(refreshTrip).toHaveBeenLastCalledWith('silent');

    refreshExpense.mockClear();
    refreshTrip.mockClear();
    await act(async () => {
      latestForegroundCallback()();
    });
    expect(refreshExpense).toHaveBeenCalledTimes(1);
    expect(refreshTrip).toHaveBeenCalledTimes(1);
    expect(refreshExpense).toHaveBeenLastCalledWith('silent');

    refreshExpense.mockClear();
    refreshTrip.mockClear();
    await act(async () => {
      await mockExpenseListener?.({
        type: 'expensesChanged',
        tripId: TRIP_ID,
      });
    });
    expect(refreshExpense).toHaveBeenCalledTimes(1);
    expect(refreshTrip).toHaveBeenCalledTimes(1);
    expect(refreshTrip).toHaveBeenLastCalledWith('silent');

    refreshExpense.mockClear();
    refreshTrip.mockClear();
    await act(async () => {
      mockTripListener?.({
        type: 'statusChanged',
        tripId: 'another-trip',
        status: 'COMPLETED',
      });
    });
    expect(refreshExpense).not.toHaveBeenCalled();
    expect(refreshTrip).not.toHaveBeenCalled();

    await act(async () => {
      mockTripListener?.({
        type: 'statusChanged',
        tripId: TRIP_ID,
        status: 'COMPLETED',
      });
    });
    expect(refreshExpense).toHaveBeenCalledTimes(1);
    expect(refreshTrip).toHaveBeenCalledTimes(1);
    expect(refreshExpense).toHaveBeenLastCalledWith('silent');

    refreshExpense.mockClear();
    refreshTrip.mockClear();
    await act(async () => {
      blur?.();
      latestForegroundCallback()();
      await mockExpenseListener?.({
        type: 'expensesChanged',
        tripId: TRIP_ID,
      });
      mockTripListener?.({
        type: 'removed',
        tripId: TRIP_ID,
      });
    });
    expect(refreshExpense).not.toHaveBeenCalled();
    expect(refreshTrip).not.toHaveBeenCalled();
    expect(result.current.isScreenActive()).toBe(false);
    unmount();
  });

  it('waits for both mandatory sources during retry and pull refresh', async () => {
    const expenseRefresh = deferred<void>();
    const tripRefresh = deferred<void>();
    const refreshExpense = jest
      .fn()
      .mockReturnValue(expenseRefresh.promise);
    const refreshTrip = jest.fn().mockReturnValue(tripRefresh.promise);
    const { result, unmount } = await renderHook(() =>
      useExpenseCompositionCoordinator({
        tripId: TRIP_ID,
        refreshExpense,
        refreshTrip,
      }),
    );

    let settled = false;
    let pullPromise: Promise<void> | undefined;
    await act(async () => {
      pullPromise = result.current
        .refreshAll('refresh')
        .then(() => {
          settled = true;
        });
    });
    expect(refreshExpense).toHaveBeenCalledWith('refresh');
    expect(refreshTrip).toHaveBeenCalledWith('refresh');

    await act(async () => {
      expenseRefresh.resolve();
      await Promise.resolve();
    });
    expect(settled).toBe(false);

    await act(async () => {
      tripRefresh.resolve();
      await pullPromise;
    });
    expect(settled).toBe(true);

    refreshExpense.mockResolvedValue(undefined);
    refreshTrip.mockResolvedValue(undefined);
    refreshExpense.mockClear();
    refreshTrip.mockClear();
    await act(async () => {
      await result.current.requestReconcile(true);
    });
    expect(refreshExpense).toHaveBeenCalledWith('initial');
    expect(refreshTrip).toHaveBeenCalledWith('initial');
    unmount();
  });

  it('does not reconcile automatically when disabled but retains explicit coordinator methods', async () => {
    const refreshExpense = jest.fn().mockResolvedValue(undefined);
    const refreshTrip = jest.fn().mockResolvedValue(undefined);
    const { result, unmount } = await renderHook(() =>
      useExpenseCompositionCoordinator({
        tripId: TRIP_ID,
        refreshExpense,
        refreshTrip,
        enabled: false,
      }),
    );

    await act(async () => {
      latestFocusCallback()();
      latestForegroundCallback()();
      await mockExpenseListener?.({
        type: 'expensesChanged',
        tripId: TRIP_ID,
      });
      mockTripListener?.({
        type: 'statusChanged',
        tripId: TRIP_ID,
        status: 'ONGOING',
      });
    });
    expect(refreshExpense).not.toHaveBeenCalled();
    expect(refreshTrip).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refreshAll('refresh');
    });
    expect(refreshExpense).toHaveBeenCalledWith('refresh');
    expect(refreshTrip).toHaveBeenCalledWith('refresh');
    unmount();
  });

  it('tracks active generations across blur, refocus, and unmount', async () => {
    const refreshExpense = jest.fn().mockResolvedValue(undefined);
    const refreshTrip = jest.fn().mockResolvedValue(undefined);
    const rendered = await renderHook(() =>
      useExpenseCompositionCoordinator({
        tripId: TRIP_ID,
        refreshExpense,
        refreshTrip,
      }),
    );

    let blur: (() => void) | void;
    await act(async () => {
      blur = latestFocusCallback()();
    });
    const firstGeneration = rendered.result.current.getGeneration();
    expect(rendered.result.current.isScreenActive()).toBe(true);
    expect(
      rendered.result.current.isActiveGeneration(firstGeneration),
    ).toBe(true);

    await act(async () => {
      blur?.();
    });
    expect(rendered.result.current.isScreenActive()).toBe(false);
    expect(
      rendered.result.current.isActiveGeneration(firstGeneration),
    ).toBe(false);

    await act(async () => {
      latestFocusCallback()();
    });
    const secondGeneration = rendered.result.current.getGeneration();
    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    expect(
      rendered.result.current.isActiveGeneration(secondGeneration),
    ).toBe(true);

    await rendered.unmount();
    expect(rendered.result.current.isScreenActive()).toBe(false);
    expect(
      rendered.result.current.isActiveGeneration(secondGeneration),
    ).toBe(false);
  });
});
