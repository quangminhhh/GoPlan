jest.mock('../api', () => ({
  lookupLocation: jest.fn(),
  suggestLocations: jest.fn(),
}));

// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import {
  act,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { lookupLocation, suggestLocations } from '../api';
// eslint-disable-next-line import/first
import { PlacePicker, type PlacePickerProps } from '../PlacePicker';
// eslint-disable-next-line import/first
import type {
  PlaceSuggestion,
  ResolvedPlaceLookup,
} from '../types';
// eslint-disable-next-line import/first
import {
  LOCATION_SEARCH_DEBOUNCE_MS,
  MANUAL_LOCATION_GUIDANCE,
  PLACE_SEARCH_UNAVAILABLE_MESSAGE,
} from '../useLocationSearch';

const mockSuggestLocations = suggestLocations as jest.MockedFunction<
  typeof suggestLocations
>;
const mockLookupLocation = lookupLocation as jest.MockedFunction<
  typeof lookupLocation
>;

const suggestion: PlaceSuggestion = {
  provider: 'here',
  provider_id: 'unverified-suggestion-id',
  title: 'Da Nang International Airport',
  subtitle: 'Da Nang, Vietnam',
};

const lookup: ResolvedPlaceLookup = {
  destination: 'Duy Tan, Hoa Thuan Tay, Da Nang, Vietnam',
  destination_provider: 'here',
  destination_provider_id: 'canonical-here-id',
  destination_lat: 16.0439,
  destination_lng: 108.199,
  destination_country_code: 'VN',
};

const selectedPlace: PlacePickerProps['value'] = {
  label: 'Existing Station',
  place: {
    title: 'Existing Station',
    address: 'Existing address',
  },
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
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function pickerCallbacks() {
  return {
    onSelectPlace: jest.fn(),
    onUseManualEntry: jest.fn(),
    onLookupFailure: jest.fn(),
  };
}

async function enterSearch(query: string) {
  await fireEvent.changeText(screen.getByLabelText('Search places'), query);
}

async function advanceDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(LOCATION_SEARCH_DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('PlacePicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    [
      'network',
      () => new AxiosError('Network unavailable'),
      'Cannot reach the server. Check your connection.',
    ],
    [
      'disabled 503',
      () =>
        axiosErrorWith(503, {
          detail: 'Location search is disabled.',
          error_code: 'LOCATION_SEARCH_DISABLED',
        }),
      PLACE_SEARCH_UNAVAILABLE_MESSAGE,
    ],
    [
      '429',
      () => axiosErrorWith(429, { detail: 'Request was throttled.' }),
      'Too many attempts. Please wait a moment and try again.',
    ],
  ])(
    'keeps an existing structured selection after a %s suggest failure',
    async (_caseName, createError, expectedMessage) => {
      mockSuggestLocations.mockRejectedValue(createError());
      const callbacks = pickerCallbacks();
      const rendered = await render(
        <PlacePicker
          value={selectedPlace}
          {...callbacks}
        />,
      );

      await enterSearch('Da Nang');
      await advanceDebounce();

      expect(screen.getByText('Existing Station')).toBeTruthy();
      expect(screen.getByText('Existing address')).toBeTruthy();
      expect(screen.getByText(expectedMessage)).toBeTruthy();
      expect(screen.getByLabelText('Search places').props.value).toBe(
        'Da Nang',
      );
      expect(callbacks.onSelectPlace).not.toHaveBeenCalled();
      expect(callbacks.onUseManualEntry).not.toHaveBeenCalled();
      expect(callbacks.onLookupFailure).not.toHaveBeenCalled();
      rendered.unmount();
    },
  );

  it('offers an explicit manual fallback when search is disabled', async () => {
    mockSuggestLocations.mockRejectedValue(
      axiosErrorWith(503, {
        detail: 'Location search is disabled.',
        error_code: 'LOCATION_SEARCH_NOT_CONFIGURED',
      }),
    );
    const callbacks = pickerCallbacks();
    const rendered = await render(
      <PlacePicker value={selectedPlace} {...callbacks} />,
    );

    await enterSearch('Hotel lobby');
    await advanceDebounce();
    expect(screen.getByText(PLACE_SEARCH_UNAVAILABLE_MESSAGE)).toBeTruthy();

    await fireEvent.press(
      screen.getByRole('button', { name: 'Enter location manually' }),
    );

    expect(callbacks.onUseManualEntry).toHaveBeenCalledWith({
      label: 'Hotel lobby',
    });
    expect(callbacks.onSelectPlace).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('emits only the canonical structured selection after lookup succeeds', async () => {
    mockSuggestLocations.mockResolvedValue([suggestion]);
    mockLookupLocation.mockResolvedValue(lookup);
    const callbacks = pickerCallbacks();
    const rendered = await render(
      <PlacePicker value={selectedPlace} {...callbacks} />,
    );

    await enterSearch('Da Nang');
    await advanceDebounce();
    await fireEvent.press(
      screen.getByRole('button', {
        name: `Select ${suggestion.title}`,
      }),
    );
    await flushPromises();

    expect(callbacks.onSelectPlace).toHaveBeenCalledWith({
      provider: 'here',
      provider_id: lookup.destination_provider_id,
      label: suggestion.title,
      address: lookup.destination,
      lat: lookup.destination_lat,
      lng: lookup.destination_lng,
      country_code: lookup.destination_country_code,
    });
    expect(callbacks.onLookupFailure).not.toHaveBeenCalled();
    expect(callbacks.onUseManualEntry).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Search places').props.value).toBe('');
    rendered.unmount();
  });

  it('emits a manual commit contract and guidance after settled lookup failure', async () => {
    mockSuggestLocations.mockResolvedValue([suggestion]);
    mockLookupLocation.mockRejectedValue(
      axiosErrorWith(502, {
        detail: 'Could not verify this place.',
        error_code: 'LOCATION_LOOKUP_FAILED',
      }),
    );
    const callbacks = pickerCallbacks();
    const rendered = await render(
      <PlacePicker value={selectedPlace} {...callbacks} />,
    );

    await enterSearch('Da Nang');
    await advanceDebounce();
    await fireEvent.press(
      screen.getByRole('button', {
        name: `Select ${suggestion.title}`,
      }),
    );
    await flushPromises();

    expect(callbacks.onLookupFailure).toHaveBeenCalledWith({
      label: suggestion.title,
      guidance: MANUAL_LOCATION_GUIDANCE,
      error: {
        kind: 'message',
        message: 'Could not verify this place.',
        status: 502,
        errorCode: 'LOCATION_LOOKUP_FAILED',
      },
    });
    expect(callbacks.onSelectPlace).not.toHaveBeenCalled();
    expect(callbacks.onUseManualEntry).not.toHaveBeenCalled();
    expect(screen.getByText(MANUAL_LOCATION_GUIDANCE)).toBeTruthy();
    expect(screen.queryByText(suggestion.provider_id)).toBeNull();
    rendered.unmount();
  });

  it('does not emit any commit callback for an aborted stale lookup', async () => {
    const pendingLookup = deferred<ResolvedPlaceLookup>();
    mockSuggestLocations.mockResolvedValue([suggestion]);
    mockLookupLocation.mockReturnValue(pendingLookup.promise);
    const callbacks = pickerCallbacks();
    const rendered = await render(
      <PlacePicker value={selectedPlace} {...callbacks} />,
    );

    await enterSearch('Da Nang');
    await advanceDebounce();
    await fireEvent.press(
      screen.getByRole('button', {
        name: `Select ${suggestion.title}`,
      }),
    );
    const lookupSignal = mockLookupLocation.mock.calls[0]?.[1];

    await enterSearch('Another place');
    expect(lookupSignal?.aborted).toBe(true);
    await act(async () => {
      pendingLookup.resolve(lookup);
      await Promise.resolve();
    });

    expect(callbacks.onSelectPlace).not.toHaveBeenCalled();
    expect(callbacks.onLookupFailure).not.toHaveBeenCalled();
    expect(callbacks.onUseManualEntry).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('uses the existing label when manual entry is chosen without a query', async () => {
    const callbacks = pickerCallbacks();
    const rendered = await render(
      <PlacePicker value={selectedPlace} {...callbacks} />,
    );

    await fireEvent.press(
      screen.getByRole('button', { name: 'Enter location manually' }),
    );

    expect(callbacks.onUseManualEntry).toHaveBeenCalledWith({
      label: selectedPlace?.label,
    });
    rendered.unmount();
  });
});
