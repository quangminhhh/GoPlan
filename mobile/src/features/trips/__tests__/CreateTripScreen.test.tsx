import { Pressable, Text, View } from 'react-native';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };
let mockPlacePickerProps: unknown;

function mockRenderPlacePicker(props: unknown) {
  mockPlacePickerProps = props;
  return null;
}

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('../api', () => ({
  createTrip: jest.fn(),
  uploadTripCover: jest.fn(),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-image', () => {
  const { View } = jest.requireActual('react-native');
  return { Image: View };
});
jest.mock('@/shared/media/pickImage', () => ({ pickImage: jest.fn() }));
jest.mock('@/shared/media/preprocessImage', () => ({ preprocessImage: jest.fn() }));
jest.mock('@/shared/media/imageCodec', () => ({
  nativeImageCodec: { encode: jest.fn(), discard: jest.fn(async () => undefined) },
}));

// The picker owns its own debounce, abort controllers and HTTP calls; those are
// proven in src/shared/location. Mocking it keeps this suite about the payload.
jest.mock('@/shared/location/PlacePicker', () => ({
  PlacePicker: mockRenderPlacePicker,
}));

interface MockDateFieldProps {
  label: string;
  onChange: (date: Date) => void;
  error?: string;
}

function mockDateField({ label, onChange, error }: MockDateFieldProps) {
  const isStartDate = label === 'Start date';
  return (
    <View>
      <Text>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Set ${label} to June 1`}
        onPress={() => onChange(new Date(2026, 5, 1))}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Set ${label} to June ${isStartDate ? '10' : '3'}`}
        onPress={() => onChange(new Date(2026, 5, isStartDate ? 10 : 3))}
      />
      {error ? <Text>{error}</Text> : null}
    </View>
  );
}

jest.mock('@/shared/ui/DateField', () => ({ DateField: mockDateField }));

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
import { pickImage } from '@/shared/media/pickImage';
// eslint-disable-next-line import/first
import { preprocessImage } from '@/shared/media/preprocessImage';
// eslint-disable-next-line import/first
import { createTrip, uploadTripCover } from '../api';
// eslint-disable-next-line import/first
import { CreateTripScreen } from '../screens/CreateTripScreen';

const mockCreateTrip = createTrip as jest.MockedFunction<typeof createTrip>;
const mockPick = pickImage as jest.MockedFunction<typeof pickImage>;
const mockPreprocess = preprocessImage as jest.MockedFunction<typeof preprocessImage>;
const mockUploadCover = uploadTripCover as jest.MockedFunction<typeof uploadTripCover>;

const pickedImage = { uri: 'file:///cover.heic', width: 4032, height: 3024, fileName: 'IMG_9.HEIC' };
const processedImage = {
  uri: 'file:///cover.jpg',
  name: 'IMG_9.jpg',
  type: 'image/jpeg',
  width: 2560,
  height: 1440,
  bytes: 900_000,
} as const;
const UPLOADED_COVER_URL = '/media/trip-covers/8f0e.webp';

// Short suggestion title vs canonical lookup destination — the payload must take
// the canonical one, the same value the web picker persists.
const verifiedPlace: ResolvedPlace = {
  provider: 'here',
  provider_id: 'canonical-here-id',
  label: 'Hội An',
  address: 'Hội An, Quảng Nam, Việt Nam',
  lat: 15.8801,
  lng: 108.338,
  country_code: 'VN',
};

const emptyDestinationFields = {
  destination_provider: '',
  destination_provider_id: '',
  destination_lat: null,
  destination_lng: null,
  destination_country_code: '',
};

function currentPickerProps(): ComponentProps<typeof PlacePicker> {
  if (!mockPlacePickerProps) {
    throw new Error('Expected PlacePicker to be rendered.');
  }
  return mockPlacePickerProps as ComponentProps<typeof PlacePicker>;
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

async function fillRequiredFields(): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText('Trip name'), '  Summer escape  ');
  await fireEvent.changeText(screen.getByLabelText('Destination'), '  Da Lat, Vietnam  ');
}

describe('CreateTripScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlacePickerProps = undefined;
  });

  it('submits optional values and replaces the route with the created trip detail', async () => {
    mockCreateTrip.mockResolvedValue({ id: 'trip-123' } as never);

    await render(<CreateTripScreen />);
    await fillRequiredFields();
    await fireEvent.changeText(screen.getByLabelText('Description'), '  Mountain air  ');
    await fireEvent.changeText(screen.getByLabelText('Budget estimate'), ' 5000000.00 ');
    await fireEvent.press(screen.getByLabelText('Currency USD'));
    await fireEvent.press(screen.getByLabelText('Set Start date to June 1'));
    await fireEvent.press(screen.getByLabelText('Set End date to June 3'));
    await fireEvent.press(screen.getByText('Create trip'));

    await waitFor(() =>
      expect(mockCreateTrip).toHaveBeenCalledWith({
        name: 'Summer escape',
        destination: 'Da Lat, Vietnam',
        ...emptyDestinationFields,
        start_date: '2026-06-01',
        end_date: '2026-06-03',
        description: 'Mountain air',
        budget_estimate: '5000000.00',
        currency_code: 'USD',
      }),
    );
    expect(mockRouter.replace).toHaveBeenCalledWith('/trips/trip-123');
  });

  it('sends every structured field from one verified place', async () => {
    mockCreateTrip.mockResolvedValue({ id: 'trip-123' } as never);

    await render(<CreateTripScreen />);
    await fireEvent.changeText(screen.getByLabelText('Trip name'), 'Hoi An trip');
    await act(async () => {
      currentPickerProps().onSelectPlace(verifiedPlace);
    });
    await fireEvent.press(screen.getByLabelText('Set Start date to June 1'));
    await fireEvent.press(screen.getByLabelText('Set End date to June 3'));
    await fireEvent.press(screen.getByText('Create trip'));

    await waitFor(() =>
      expect(mockCreateTrip).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: 'Hội An, Quảng Nam, Việt Nam',
          destination_provider: 'here',
          destination_provider_id: 'canonical-here-id',
          destination_lat: 15.8801,
          destination_lng: 108.338,
          destination_country_code: 'VN',
        }),
      ),
    );
  });

  it('sends explicitly empty structured fields for a manual destination', async () => {
    mockCreateTrip.mockResolvedValue({ id: 'trip-123' } as never);

    await render(<CreateTripScreen />);
    await fillRequiredFields();
    await fireEvent.press(screen.getByText('Create trip'));

    await waitFor(() => expect(mockCreateTrip).toHaveBeenCalled());
    const payload = mockCreateTrip.mock.calls[0]?.[0];
    // An omitted key is not the same as an empty one on the server side, so the
    // manual path must state every column rather than leaving it undefined.
    expect(payload).toMatchObject({
      destination: 'Da Lat, Vietnam',
      ...emptyDestinationFields,
    });
    for (const field of Object.keys(emptyDestinationFields)) {
      expect(payload).toHaveProperty(field);
    }
  });

  it('degrades to manual entry and still submits after a lookup failure', async () => {
    mockCreateTrip.mockResolvedValue({ id: 'trip-123' } as never);

    await render(<CreateTripScreen />);
    await fireEvent.changeText(screen.getByLabelText('Trip name'), 'Fallback trip');
    await act(async () => {
      currentPickerProps().onLookupFailure({
        label: 'Unverified suggestion',
        error: { kind: 'network', message: 'Cannot reach the server.' },
        guidance: 'Enter the location manually.',
      });
    });
    await fireEvent.press(screen.getByText('Create trip'));

    await waitFor(() =>
      expect(mockCreateTrip).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: 'Unverified suggestion',
          ...emptyDestinationFields,
        }),
      ),
    );
  });

  it('sends the uploaded cover url with the created trip', async () => {
    mockCreateTrip.mockResolvedValue({ id: 'trip-123' } as never);
    mockPick.mockResolvedValue({ status: 'picked', image: pickedImage });
    mockPreprocess.mockResolvedValue(processedImage);
    mockUploadCover.mockResolvedValue(UPLOADED_COVER_URL);

    await render(<CreateTripScreen />);
    await fillRequiredFields();
    await fireEvent.press(screen.getByLabelText('Choose photo'));
    await waitFor(() => expect(mockUploadCover).toHaveBeenCalledWith(processedImage));
    await fireEvent.press(screen.getByText('Create trip'));

    await waitFor(() =>
      expect(mockCreateTrip).toHaveBeenCalledWith(
        expect.objectContaining({ cover_image_url: UPLOADED_COVER_URL }),
      ),
    );
  });

  it('omits cover_image_url entirely when no cover was chosen', async () => {
    mockCreateTrip.mockResolvedValue({ id: 'trip-123' } as never);

    await render(<CreateTripScreen />);
    await fillRequiredFields();
    await fireEvent.press(screen.getByText('Create trip'));

    await waitFor(() => expect(mockCreateTrip).toHaveBeenCalled());
    expect(mockCreateTrip.mock.calls[0]?.[0]).not.toHaveProperty('cover_image_url');
  });

  it('blocks submit until an in-flight cover upload settles', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: pickedImage });
    mockPreprocess.mockResolvedValue(processedImage);
    mockUploadCover.mockImplementation(() => new Promise(() => undefined));

    await render(<CreateTripScreen />);
    await fillRequiredFields();
    await fireEvent.press(screen.getByLabelText('Choose photo'));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create trip' }).props.accessibilityState,
      ).toEqual(expect.objectContaining({ disabled: true })),
    );
    expect(screen.getByText('Wait for the cover upload to finish.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Create trip'));
    expect(mockCreateTrip).not.toHaveBeenCalled();
  });

  it('keeps submit available when place search is unavailable', async () => {
    await render(<CreateTripScreen />);
    await fillRequiredFields();

    // The picker renders its own unavailable notice; what matters here is that
    // the form never depends on it.
    expect(
      screen.getByRole('button', { name: 'Create trip' }).props
        .accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: false }));
  });

  it('blocks a local end-date-before-start-date submission', async () => {
    await render(<CreateTripScreen />);
    await fillRequiredFields();
    await fireEvent.press(screen.getByLabelText('Set Start date to June 10'));
    await fireEvent.press(screen.getByLabelText('Set End date to June 1'));
    await fireEvent.press(screen.getByText('Create trip'));

    expect(await screen.findByText('End date must be on or after the start date.')).toBeTruthy();
    expect(mockCreateTrip).not.toHaveBeenCalled();
  });

  it('renders DRF field errors beside their corresponding fields', async () => {
    mockCreateTrip.mockRejectedValue(
      axiosErrorWith(400, {
        destination_lat: ['Ensure that there are no more than 6 decimal places.'],
        budget_estimate: ['A non-negative number is required.'],
        currency_code: ['Unsupported trip currency code.'],
      }),
    );

    await render(<CreateTripScreen />);
    await fillRequiredFields();
    await fireEvent.press(screen.getByText('Create trip'));

    expect(
      await screen.findByText(
        'Ensure that there are no more than 6 decimal places.',
      ),
    ).toBeTruthy();
    expect(await screen.findByText('A non-negative number is required.')).toBeTruthy();
    expect(await screen.findByText('Unsupported trip currency code.')).toBeTruthy();
  });

  it('renders the backend business-error message', async () => {
    mockCreateTrip.mockRejectedValue(
      axiosErrorWith(409, {
        detail: 'This trip cannot be created right now.',
        error_code: 'TRIP_CONFLICT',
      }),
    );

    await render(<CreateTripScreen />);
    await fillRequiredFields();
    await fireEvent.press(screen.getByText('Create trip'));

    expect(await screen.findByText('This trip cannot be created right now.')).toBeTruthy();
  });

  it('renders the generic error for a non-API failure', async () => {
    mockCreateTrip.mockRejectedValue(new Error('offline'));

    await render(<CreateTripScreen />);
    await fillRequiredFields();
    await fireEvent.press(screen.getByText('Create trip'));

    expect(await screen.findByText('Something went wrong. Please try again.')).toBeTruthy();
  });
});
