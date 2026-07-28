import { Pressable, Text, View } from 'react-native';

const mockParams = { tripId: 'trip-123' };
const mockRouter = { dismissTo: jest.fn() };
const mockUseTripDetail = jest.fn();
const mockPublishTripEvent = jest.fn();
let mockPlacePickerProps: unknown;

function mockRenderPlacePicker(props: unknown) {
  mockPlacePickerProps = props;
  return null;
}

// The picker's own debounce/abort/HTTP behaviour is proven in
// src/shared/location; this suite is about what the PATCH carries.
jest.mock('@/shared/location/PlacePicker', () => ({
  PlacePicker: mockRenderPlacePicker,
}));

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../hooks/useTripDetail', () => ({ useTripDetail: (...args: unknown[]) => mockUseTripDetail(...args) }));
jest.mock('../tripEvents', () => ({ publishTripEvent: (...args: unknown[]) => mockPublishTripEvent(...args) }));
jest.mock('../api', () => ({ updateTrip: jest.fn() }));

interface MockDateFieldProps {
  label: string;
  onChange: (date: Date) => void;
  error?: string;
}

function MockDateField({ label, onChange, error }: MockDateFieldProps) {
  return (
    <View>
      <Text>{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Set ${label} to June 10`} onPress={() => onChange(new Date(2026, 5, 10))} />
      {error ? <Text>{error}</Text> : null}
    </View>
  );
}

jest.mock('@/shared/ui/DateField', () => ({ DateField: MockDateField }));

// eslint-disable-next-line import/first
import type { ComponentProps } from 'react';
// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import type { PlacePicker } from '@/shared/location/PlacePicker';
// eslint-disable-next-line import/first
import type { ResolvedPlace } from '@/shared/location/types';
// eslint-disable-next-line import/first
import { updateTrip } from '../api';
// eslint-disable-next-line import/first
import { EditTripScreen } from '../screens/EditTripScreen';
// eslint-disable-next-line import/first
import type { TripDetailResponse } from '../types';
// eslint-disable-next-line import/first
import type { ApiError } from '@/shared/api/errors';

const mockUpdateTrip = updateTrip as jest.MockedFunction<typeof updateTrip>;
const notFoundError: ApiError = { kind: 'message', message: 'Trip not found.', errorCode: 'TRIP_NOT_FOUND', status: 404 };

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

const detail: TripDetailResponse = {
  trip: {
    id: 'trip-123',
    name: 'Da Lat escape',
    destination: 'Da Lat, Vietnam',
    destination_provider: 'google',
    destination_provider_id: 'place-123',
    destination_lat: '11.9404',
    destination_lng: '108.4583',
    destination_country_code: 'VN',
    cover_image_url: '/media/trip-covers/da-lat.jpg',
    start_date: '2026-06-01',
    end_date: '2026-06-03',
    description: 'Mountain air',
    status: 'PLANNING',
    currency_code: 'VND',
    timezone: 'Asia/Ho_Chi_Minh',
    budget_estimate: '5000000.00',
    cancelled_at: null,
    created_at: '2026-01-01T00:00:00Z',
  },
  my_membership: { role: 'CAPTAIN', status: 'ACTIVE', joined_at: '2026-01-01T00:00:00Z' },
  members: [],
};

function readyHook(nextDetail: TripDetailResponse = detail) {
  return {
    detail: nextDetail,
    status: 'ready' as const,
    error: null,
    refresh: jest.fn().mockResolvedValue(undefined),
  };
}

const DESTINATION_KEYS = [
  'destination',
  'destination_provider',
  'destination_provider_id',
  'destination_lat',
  'destination_lng',
  'destination_country_code',
] as const;

const verifiedPlace: ResolvedPlace = {
  provider: 'here',
  provider_id: 'canonical-here-id',
  label: 'Hội An, Quảng Nam',
  address: 'Hội An, Quảng Nam, Việt Nam',
  lat: 15.8801,
  lng: 108.338,
  country_code: 'VN',
};

async function save(): Promise<void> {
  await fireEvent.press(screen.getByText('Save changes'));
}

function currentPickerProps(): ComponentProps<typeof PlacePicker> {
  if (!mockPlacePickerProps) {
    throw new Error('Expected PlacePicker to be rendered.');
  }
  return mockPlacePickerProps as ComponentProps<typeof PlacePicker>;
}

describe('EditTripScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams.tripId = 'trip-123';
    mockPlacePickerProps = undefined;
    mockUseTripDetail.mockReturnValue(readyHook());
  });

  it('sends the normalized PATCH payload, clears stale destination metadata, publishes, and dismisses', async () => {
    const updated = { ...detail.trip, name: 'Summer escape', destination: 'Nha Trang, Vietnam', description: '', budget_estimate: null };
    mockUpdateTrip.mockResolvedValue(updated);
    await render(<EditTripScreen />);
    await fireEvent.changeText(screen.getByLabelText('Trip name'), '  Summer escape  ');
    await fireEvent.changeText(screen.getByLabelText('Destination'), ' Nha Trang, Vietnam ');
    await fireEvent.changeText(screen.getByLabelText('Description'), '   ');
    await fireEvent.changeText(screen.getByLabelText('Budget estimate'), ' ');
    await fireEvent.press(screen.getByLabelText('Currency USD'));
    await fireEvent.press(screen.getByLabelText('Timezone Asia/Tokyo'));
    await save();

    await waitFor(() =>
      expect(mockUpdateTrip).toHaveBeenCalledWith('trip-123', {
        name: 'Summer escape',
        destination: 'Nha Trang, Vietnam',
        start_date: '2026-06-01',
        end_date: '2026-06-03',
        description: '',
        budget_estimate: null,
        currency_code: 'USD',
        timezone: 'Asia/Tokyo',
        destination_provider: '',
        destination_provider_id: '',
        destination_lat: null,
        destination_lng: null,
        destination_country_code: '',
      }),
    );
    expect(mockPublishTripEvent).toHaveBeenCalledWith({ type: 'updated', trip: updated });
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/trips/trip-123');
  });

  it('keeps the stored destination when only the name changes', async () => {
    mockUpdateTrip.mockResolvedValue(detail.trip);
    await render(<EditTripScreen />);
    await fireEvent.changeText(screen.getByLabelText('Trip name'), 'Renamed trip');
    await save();

    await waitFor(() => expect(mockUpdateTrip).toHaveBeenCalled());
    const payload = mockUpdateTrip.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ name: 'Renamed trip' });
    // A PATCH that mentions no destination key cannot clear the stored
    // coordinates the web client also writes.
    for (const key of DESTINATION_KEYS) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('does not clear destination metadata when the destination is unchanged', async () => {
    mockUpdateTrip.mockResolvedValue(detail.trip);
    await render(<EditTripScreen />);
    await save();

    await waitFor(() => expect(mockUpdateTrip).toHaveBeenCalled());
    const payload = mockUpdateTrip.mock.calls[0]?.[1];
    for (const key of DESTINATION_KEYS) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('writes all six destination keys after re-picking a place', async () => {
    mockUpdateTrip.mockResolvedValue(detail.trip);
    await render(<EditTripScreen />);
    await act(async () => {
      currentPickerProps().onSelectPlace(verifiedPlace);
    });
    await save();

    await waitFor(() =>
      expect(mockUpdateTrip).toHaveBeenCalledWith(
        'trip-123',
        expect.objectContaining({
          destination: 'Hội An, Quảng Nam',
          destination_provider: 'here',
          destination_provider_id: 'canonical-here-id',
          destination_lat: 15.8801,
          destination_lng: 108.338,
          destination_country_code: 'VN',
        }),
      ),
    );
  });

  it('hydrates the picker from the stored structured destination', async () => {
    await render(<EditTripScreen />);

    expect(currentPickerProps().value).toEqual({
      label: 'Da Lat, Vietnam',
      place: { title: 'Da Lat, Vietnam', address: '' },
    });
  });

  it('blocks duplicate submission while the PATCH is pending', async () => {
    mockUpdateTrip.mockImplementation(() => new Promise(() => undefined));
    await render(<EditTripScreen />);

    void fireEvent.press(screen.getByText('Save changes'));
    await waitFor(() => expect(mockUpdateTrip).toHaveBeenCalledTimes(1));
    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    expect(saveButton.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    await fireEvent.press(saveButton);
    expect(mockUpdateTrip).toHaveBeenCalledTimes(1);
  });

  it('renders backend field and business errors exactly as returned', async () => {
    mockUpdateTrip.mockRejectedValueOnce(
      axiosErrorWith(400, { destination: ['Choose a valid destination.'], timezone: ['Use a valid timezone.'] }),
    );
    await render(<EditTripScreen />);
    await save();
    expect(await screen.findByText('Choose a valid destination.')).toBeTruthy();
    expect(await screen.findByText('Use a valid timezone.')).toBeTruthy();

    mockUpdateTrip.mockRejectedValueOnce(axiosErrorWith(409, { detail: 'Trip has already been cancelled.' }));
    await save();
    expect(await screen.findByText('Trip has already been cancelled.')).toBeTruthy();
  });

  it('guards direct links for non-captains and terminal trips', async () => {
    mockUseTripDetail.mockReturnValue(
      readyHook({ ...detail, my_membership: { ...detail.my_membership, role: 'MEMBER' } }),
    );
    const { rerender } = await render(<EditTripScreen />);
    expect(screen.getByText('Only the active trip captain can edit trip information.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Back to trip'));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/trips/trip-123');

    mockUseTripDetail.mockReturnValue(readyHook({ ...detail, trip: { ...detail.trip, status: 'COMPLETED' } }));
    await rerender(<EditTripScreen />);
    expect(screen.getByText('Completed and cancelled trips can no longer be edited.')).toBeTruthy();
  });

  it('keeps the generic not-found response non-enumerating', async () => {
    mockUseTripDetail.mockReturnValue({ ...readyHook(), detail: null, status: 'error', error: notFoundError });
    await render(<EditTripScreen />);
    expect(await screen.findByText('Trip not found')).toBeTruthy();
    expect(screen.getByText('This trip does not exist or you are not a member of it.')).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
  });
});
