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
  getTimeline: jest.fn(),
}));

// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { getTimeline } from '../api';
// eslint-disable-next-line import/first
import { useTimeline } from '../hooks/useTimeline';
// eslint-disable-next-line import/first
import { publishTimelineEvent } from '../timelineEvents';
// eslint-disable-next-line import/first
import type { TimelineResponse } from '../types';

const mockGetTimeline = getTimeline as jest.MockedFunction<typeof getTimeline>;

function timeline(label: string): TimelineResponse {
  return {
    trip_timezone: 'Asia/Ho_Chi_Minh',
    permissions: {
      can_edit_timeline: true,
      can_manage_custom_types: true,
      can_create_sections: true,
    },
    system_types: [],
    custom_types: [],
    sections: [
      {
        id: 'section-1',
        section_date: '2026-08-01',
        label,
        is_label_custom: true,
        is_in_trip_range: true,
        position: 1,
        activities: [],
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

describe('useTimeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads initially on focus and silently reconciles complete data', async () => {
    const silent = deferred<TimelineResponse>();
    mockGetTimeline
      .mockResolvedValueOnce(timeline('Arrival'))
      .mockReturnValueOnce(silent.promise);
    const { result, unmount } = await renderHook(() => useTimeline('trip-1'));

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() =>
      expect(result.current.timeline?.sections[0]?.label).toBe('Arrival'),
    );

    await act(async () => {
      latestFocusCallback()();
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.refreshing).toBe(false);
    expect(result.current.timeline?.sections[0]?.label).toBe('Arrival');

    await act(async () => {
      silent.resolve(timeline('Updated arrival'));
    });
    expect(result.current.timeline?.sections[0]?.label).toBe('Updated arrival');
    unmount();
  });

  it('sets refreshing only for explicit refresh and keeps complete data visible', async () => {
    const explicit = deferred<TimelineResponse>();
    mockGetTimeline
      .mockResolvedValueOnce(timeline('Arrival'))
      .mockReturnValueOnce(explicit.promise);
    const { result, unmount } = await renderHook(() => useTimeline('trip-1'));

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      void result.current.refresh('refresh');
    });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.timeline?.sections[0]?.label).toBe('Arrival');

    await act(async () => {
      explicit.resolve(timeline('Refreshed'));
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.timeline?.sections[0]?.label).toBe('Refreshed');
    unmount();
  });

  it('lets a newer silent request own refresh completion and stale finally cleanup', async () => {
    const explicit = deferred<TimelineResponse>();
    const silent = deferred<TimelineResponse>();
    mockGetTimeline
      .mockResolvedValueOnce(timeline('Arrival'))
      .mockReturnValueOnce(explicit.promise)
      .mockReturnValueOnce(silent.promise);
    const { result, unmount } = await renderHook(() => useTimeline('trip-1'));

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      void result.current.refresh('refresh');
      void result.current.refresh('silent');
    });
    await act(async () => {
      explicit.resolve(timeline('Stale refresh'));
    });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.timeline?.sections[0]?.label).toBe('Arrival');

    await act(async () => {
      silent.resolve(timeline('Latest silent'));
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.timeline?.sections[0]?.label).toBe('Latest silent');
    unmount();
  });

  it('ignores stale catch and finally branches after a newer request starts', async () => {
    const stale = deferred<TimelineResponse>();
    const latest = deferred<TimelineResponse>();
    mockGetTimeline
      .mockResolvedValueOnce(timeline('Arrival'))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);
    const { result, unmount } = await renderHook(() => useTimeline('trip-1'));

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
      latest.resolve(timeline('Latest'));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(false);
    unmount();
  });

  it('retains a complete timeline after a non-404 foreground failure', async () => {
    mockGetTimeline
      .mockResolvedValueOnce(timeline('Arrival'))
      .mockRejectedValueOnce(
        axiosErrorWith(500, { detail: 'Timeline is temporarily unavailable.' }),
      );
    const { result, unmount } = await renderHook(() => useTimeline('trip-1'));

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      latestForegroundCallback()();
    });

    await waitFor(() =>
      expect(result.current.error?.message).toBe(
        'Timeline is temporarily unavailable.',
      ),
    );
    expect(result.current.status).toBe('ready');
    expect(result.current.timeline?.sections[0]?.label).toBe('Arrival');
    unmount();
  });

  it('clears a complete timeline when the current trip becomes unavailable', async () => {
    mockGetTimeline
      .mockResolvedValueOnce(timeline('Arrival'))
      .mockRejectedValueOnce(
        axiosErrorWith(404, {
          detail: 'Trip not found.',
          error_code: 'TRIP_NOT_FOUND',
        }),
      );
    const { result, unmount } = await renderHook(() => useTimeline('trip-1'));

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      latestForegroundCallback()();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.timeline).toBeNull();
    expect(result.current.error).toMatchObject({
      message: 'Trip not found.',
      errorCode: 'TRIP_NOT_FOUND',
      status: 404,
    });
    unmount();
  });

  it('reconciles only same-trip timeline events', async () => {
    mockGetTimeline
      .mockResolvedValueOnce(timeline('Arrival'))
      .mockResolvedValueOnce(timeline('Event update'));
    const { result, unmount } = await renderHook(() => useTimeline('trip-1'));

    await act(async () => {
      latestFocusCallback()();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await publishTimelineEvent({
        type: 'timelineChanged',
        tripId: 'trip-2',
      });
    });
    expect(mockGetTimeline).toHaveBeenCalledTimes(1);

    await act(async () => {
      await publishTimelineEvent({
        type: 'timelineChanged',
        tripId: 'trip-1',
      });
    });
    await waitFor(() =>
      expect(result.current.timeline?.sections[0]?.label).toBe('Event update'),
    );
    expect(mockGetTimeline).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not own focus, foreground, or events when auto reconciliation is disabled', async () => {
    mockGetTimeline.mockResolvedValue(timeline('Manual load'));
    const { result, unmount } = await renderHook(() =>
      useTimeline('trip-1', { autoReconcile: false }),
    );

    await act(async () => {
      latestFocusCallback()();
      latestForegroundCallback()();
      await publishTimelineEvent({
        type: 'timelineChanged',
        tripId: 'trip-1',
      });
    });
    expect(mockGetTimeline).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refresh('initial');
    });
    expect(result.current.timeline?.sections[0]?.label).toBe('Manual load');
    unmount();
  });

  it('invalidates a pending coordinator request when the screen blurs', async () => {
    const pending = deferred<TimelineResponse>();
    mockGetTimeline.mockReturnValue(pending.promise);
    const { result, unmount } = await renderHook(() =>
      useTimeline('trip-1', { autoReconcile: false }),
    );

    let cleanup: (() => void) | void;
    await act(async () => {
      cleanup = latestFocusCallback()();
      void result.current.refresh('initial');
    });
    await act(async () => {
      cleanup?.();
      pending.resolve(timeline('Stale'));
    });

    expect(result.current.timeline).toBeNull();
    expect(result.current.status).toBe('loading');
    unmount();
  });

  it('hides the old resource immediately and ignores its late completion after a key change', async () => {
    const first = deferred<TimelineResponse>();
    const second = deferred<TimelineResponse>();
    mockGetTimeline
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender, unmount } = await renderHook(
      ({ tripId }: { tripId: string }) => useTimeline(tripId),
      { initialProps: { tripId: 'trip-1' } },
    );

    await act(async () => {
      latestFocusCallback()();
    });
    await rerender({ tripId: 'trip-2' });
    expect(result.current.timeline).toBeNull();
    expect(result.current.status).toBe('loading');

    await act(async () => {
      latestFocusCallback()();
      first.resolve(timeline('Wrong trip'));
    });
    expect(result.current.timeline).toBeNull();

    await act(async () => {
      second.resolve(timeline('Right trip'));
    });
    expect(result.current.timeline?.sections[0]?.label).toBe('Right trip');
    unmount();
  });

  it('mutation invalidation prevents a pre-mutation response from overwriting reconciliation', async () => {
    const preMutation = deferred<TimelineResponse>();
    const postMutation = deferred<TimelineResponse>();
    mockGetTimeline
      .mockResolvedValueOnce(timeline('Before mutation'))
      .mockReturnValueOnce(preMutation.promise)
      .mockReturnValueOnce(postMutation.promise);
    const { result, unmount } = await renderHook(() => useTimeline('trip-1'));

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
      preMutation.resolve(timeline('Stale before mutation'));
    });
    expect(result.current.timeline?.sections[0]?.label).toBe('Before mutation');

    await act(async () => {
      postMutation.resolve(timeline('After mutation'));
    });
    expect(result.current.timeline?.sections[0]?.label).toBe('After mutation');
    unmount();
  });
});
