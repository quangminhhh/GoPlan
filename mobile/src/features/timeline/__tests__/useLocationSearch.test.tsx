jest.mock('../api', () => ({
  lookupLocation: jest.fn(),
  suggestLocations: jest.fn(),
}));

// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import { act, renderHook } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { lookupLocation, suggestLocations } from '../api';
// eslint-disable-next-line import/first
import {
  LOCATION_SEARCH_DEBOUNCE_MS,
  MANUAL_LOCATION_GUIDANCE,
  useLocationSearch,
} from '../hooks/useLocationSearch';
// eslint-disable-next-line import/first
import type {
  LocationSuggestion,
  ResolvedLocationLookup,
} from '../types';

const mockSuggestLocations = suggestLocations as jest.MockedFunction<
  typeof suggestLocations
>;
const mockLookupLocation = lookupLocation as jest.MockedFunction<
  typeof lookupLocation
>;

const suggestion: LocationSuggestion = {
  provider: 'here',
  provider_id: 'suggestion-id',
  title: 'Da Nang International Airport',
  subtitle: 'Da Nang, Vietnam',
};

const lookup: ResolvedLocationLookup = {
  destination: 'Duy Tan, Hoa Thuan Tay, Da Nang, Vietnam',
  destination_provider: 'here',
  destination_provider_id: 'canonical-id',
  destination_lat: 16.0439,
  destination_lng: 108.199,
  destination_country_code: 'VN',
};

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

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function setQuery(
  result: { current: ReturnType<typeof useLocationSearch> },
  query: string,
) {
  await act(async () => {
    result.current.setQuery(query);
  });
}

async function advanceDebounce(milliseconds = LOCATION_SEARCH_DEBOUNCE_MS) {
  await act(async () => {
    jest.advanceTimersByTime(milliseconds);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useLocationSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits 300 ms and ignores queries shorter than two trimmed characters', async () => {
    mockSuggestLocations.mockResolvedValue([]);
    const { result, unmount } = await renderHook(() => useLocationSearch());

    await setQuery(result, ' a ');
    await advanceDebounce(LOCATION_SEARCH_DEBOUNCE_MS + 1);
    expect(mockSuggestLocations).not.toHaveBeenCalled();
    expect(result.current.searchStatus).toBe('idle');

    await setQuery(result, '  Da  ');
    expect(result.current.searchStatus).toBe('debouncing');
    await advanceDebounce(LOCATION_SEARCH_DEBOUNCE_MS - 1);
    expect(mockSuggestLocations).not.toHaveBeenCalled();

    await advanceDebounce(1);
    expect(mockSuggestLocations).toHaveBeenCalledWith(
      'Da',
      expect.any(AbortSignal),
    );
    expect(result.current.searchStatus).toBe('ready');
    unmount();
  });

  it('drops opaque provider ids over 255 code points without truncating valid ids', async () => {
    const validId = 'a'.repeat(255);
    const invalidId = 'b'.repeat(256);
    mockSuggestLocations.mockResolvedValue([
      { ...suggestion, provider_id: validId },
      { ...suggestion, provider_id: invalidId, title: 'Unpickable result' },
    ]);
    const { result, unmount } = await renderHook(() => useLocationSearch());

    await setQuery(result, 'Da Nang');
    await advanceDebounce();

    expect(result.current.suggestions).toEqual([
      { ...suggestion, provider_id: validId },
    ]);
    expect(result.current.suggestions[0]?.provider_id).toHaveLength(255);
    unmount();
  });

  it.each([
    'LOCATION_SEARCH_DISABLED',
    'LOCATION_SEARCH_NOT_CONFIGURED',
  ])('marks 503 %s as unavailable for manual degradation', async (errorCode) => {
    mockSuggestLocations.mockRejectedValue(
      axiosErrorWith(503, {
        detail: 'Place search is unavailable.',
        error_code: errorCode,
      }),
    );
    const { result, unmount } = await renderHook(() => useLocationSearch());

    await setQuery(result, 'Da Nang');
    await advanceDebounce();

    expect(result.current.searchUnavailable).toBe(true);
    expect(result.current.searchError).toMatchObject({
      status: 503,
      errorCode,
    });
    expect(result.current.searchStatus).toBe('error');
    unmount();
  });

  it('retains the current input but clears stale suggestions after a 429 response', async () => {
    mockSuggestLocations
      .mockResolvedValueOnce([suggestion])
      .mockRejectedValueOnce(
        axiosErrorWith(429, { detail: 'Provider quota reached.' }),
      );
    const { result, unmount } = await renderHook(() => useLocationSearch());

    await setQuery(result, 'Da');
    await advanceDebounce();
    expect(result.current.suggestions).toEqual([suggestion]);

    await setQuery(result, 'Da Nang');
    expect(result.current.suggestions).toEqual([]);
    await advanceDebounce();

    expect(result.current.query).toBe('Da Nang');
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.searchError).toMatchObject({
      kind: 'throttled',
      status: 429,
    });
    unmount();
  });

  it('clears old suggestions as soon as a different searchable query is entered', async () => {
    mockSuggestLocations.mockResolvedValue([suggestion]);
    const { result, unmount } = await renderHook(() => useLocationSearch());

    await setQuery(result, 'Da');
    await advanceDebounce();
    expect(result.current.suggestions).toEqual([suggestion]);

    await setQuery(result, 'Hanoi');

    expect(result.current.query).toBe('Hanoi');
    expect(result.current.searchStatus).toBe('debouncing');
    expect(result.current.suggestions).toEqual([]);
    unmount();
  });

  it('aborts an older suggest request and lets only the latest request update state', async () => {
    const first = deferred<LocationSuggestion[]>();
    const second = deferred<LocationSuggestion[]>();
    const latestSuggestion = {
      ...suggestion,
      provider_id: 'latest-id',
      title: 'Latest place',
    };
    mockSuggestLocations
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, unmount } = await renderHook(() => useLocationSearch());

    await setQuery(result, 'Da');
    await advanceDebounce();
    const firstSignal = mockSuggestLocations.mock.calls[0]?.[1];

    await setQuery(result, 'Da Nang');
    expect(firstSignal?.aborted).toBe(true);
    await advanceDebounce();

    await act(async () => {
      second.resolve([latestSuggestion]);
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve([suggestion]);
      await Promise.resolve();
    });

    expect(result.current.suggestions).toEqual([latestSuggestion]);
    expect(result.current.searchStatus).toBe('ready');
    unmount();
  });

  it('creates structured data only from a successful canonical lookup', async () => {
    mockLookupLocation.mockResolvedValue(lookup);
    const { result, unmount } = await renderHook(() => useLocationSearch());
    let selectionResult:
      | Awaited<ReturnType<typeof result.current.selectSuggestion>>
      | undefined;

    await act(async () => {
      selectionResult = await result.current.selectSuggestion(suggestion);
    });

    expect(mockLookupLocation).toHaveBeenCalledWith(
      suggestion.provider_id,
      expect.any(AbortSignal),
    );
    expect(selectionResult).toEqual({
      kind: 'success',
      selection: {
        location_mode: 'STRUCTURED',
        location_label: suggestion.title,
        place: {
          provider: 'here',
          provider_id: lookup.destination_provider_id,
          title: suggestion.title,
          address: lookup.destination,
          lat: lookup.destination_lat,
          lng: lookup.destination_lng,
        },
      },
    });
    expect(
      selectionResult?.kind === 'success'
        ? selectionResult.selection.place.provider_id
        : undefined,
    ).not.toBe(suggestion.provider_id);
    unmount();
  });

  it('returns stale without a failure state when lookup is aborted by new input', async () => {
    const pending = deferred<ResolvedLocationLookup>();
    mockLookupLocation.mockReturnValue(pending.promise);
    const { result, unmount } = await renderHook(() => useLocationSearch());
    let lookupPromise:
      | ReturnType<typeof result.current.selectSuggestion>
      | undefined;

    await act(async () => {
      lookupPromise = result.current.selectSuggestion(suggestion);
    });
    const lookupSignal = mockLookupLocation.mock.calls[0]?.[1];
    expect(result.current.lookupStatus).toBe('loading');

    await setQuery(result, 'Another place');
    expect(lookupSignal?.aborted).toBe(true);

    let selectionResult:
      | Awaited<ReturnType<typeof result.current.selectSuggestion>>
      | undefined;
    await act(async () => {
      pending.resolve(lookup);
      selectionResult = await lookupPromise;
    });

    expect(selectionResult).toEqual({ kind: 'stale' });
    expect(result.current.lookupStatus).toBe('idle');
    expect(result.current.lookupError).toBeNull();
    expect(result.current.manualEntrySuggested).toBe(false);
    unmount();
  });

  it('aborts lookup and returns stale when the picker becomes disabled', async () => {
    const pending = deferred<ResolvedLocationLookup>();
    mockLookupLocation.mockReturnValue(pending.promise);
    const { result, rerender, unmount } = await renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useLocationSearch({ enabled }),
      { initialProps: { enabled: true } },
    );
    let lookupPromise:
      | ReturnType<typeof result.current.selectSuggestion>
      | undefined;

    await act(async () => {
      lookupPromise = result.current.selectSuggestion(suggestion);
    });
    const lookupSignal = mockLookupLocation.mock.calls[0]?.[1];

    await rerender({ enabled: false });
    expect(lookupSignal?.aborted).toBe(true);

    let selectionResult:
      | Awaited<ReturnType<typeof result.current.selectSuggestion>>
      | undefined;
    await act(async () => {
      pending.resolve(lookup);
      selectionResult = await lookupPromise;
    });

    expect(selectionResult).toEqual({ kind: 'stale' });
    expect(result.current.lookupStatus).toBe('idle');
    expect(result.current.lookupError).toBeNull();
    unmount();
  });

  it('returns a manual fallback with the selected label after a settled lookup failure', async () => {
    mockLookupLocation.mockRejectedValue(
      axiosErrorWith(502, {
        detail: 'Could not verify this place.',
        error_code: 'LOCATION_LOOKUP_FAILED',
      }),
    );
    const { result, unmount } = await renderHook(() => useLocationSearch());
    let selectionResult:
      | Awaited<ReturnType<typeof result.current.selectSuggestion>>
      | undefined;

    await act(async () => {
      selectionResult = await result.current.selectSuggestion(suggestion);
    });

    expect(selectionResult).toEqual({
      kind: 'failure',
      fallback: {
        location_mode: 'MANUAL',
        location_label: suggestion.title,
        place: null,
        guidance: MANUAL_LOCATION_GUIDANCE,
        error: {
          kind: 'message',
          message: 'Could not verify this place.',
          status: 502,
          errorCode: 'LOCATION_LOOKUP_FAILED',
        },
      },
    });
    expect(result.current.lookupStatus).toBe('error');
    expect(result.current.manualEntrySuggested).toBe(true);
    expect(
      selectionResult?.kind === 'failure'
        ? selectionResult.fallback.place
        : undefined,
    ).toBeNull();
    unmount();
  });

  it('never falls back to the suggestion id when the canonical id is invalid', async () => {
    mockLookupLocation.mockResolvedValue({
      ...lookup,
      destination_provider_id: 'c'.repeat(256),
    });
    const { result, unmount } = await renderHook(() => useLocationSearch());
    let selectionResult:
      | Awaited<ReturnType<typeof result.current.selectSuggestion>>
      | undefined;

    await act(async () => {
      selectionResult = await result.current.selectSuggestion(suggestion);
    });

    expect(selectionResult?.kind).toBe('failure');
    expect(
      selectionResult?.kind === 'failure'
        ? selectionResult.fallback
        : undefined,
    ).toMatchObject({
      location_mode: 'MANUAL',
      location_label: suggestion.title,
      place: null,
    });
    expect(result.current.lookupStatus).toBe('error');
    unmount();
  });
});
