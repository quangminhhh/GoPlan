let mockPlacePickerProps: unknown;

function mockRenderPlacePicker(props: unknown) {
  mockPlacePickerProps = props;
  return null;
}

jest.mock('@/shared/location/PlacePicker', () => ({
  PlacePicker: mockRenderPlacePicker,
}));

// eslint-disable-next-line import/first
import type { ComponentProps } from 'react';
// eslint-disable-next-line import/first
import { act, fireEvent, render, screen } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import type { PlacePicker } from '@/shared/location/PlacePicker';
// eslint-disable-next-line import/first
import type { ResolvedPlace } from '@/shared/location/types';
// eslint-disable-next-line import/first
import { DestinationField } from '../components/DestinationField';
// eslint-disable-next-line import/first
import type { TripDestinationValue } from '../destination';

const place: ResolvedPlace = {
  provider: 'here',
  provider_id: 'canonical-here-id',
  label: 'Hội An, Quảng Nam',
  address: 'Hội An, Quảng Nam, Việt Nam',
  lat: 15.8801,
  lng: 108.338,
  country_code: 'VN',
};

const structuredValue: TripDestinationValue = {
  label: place.label,
  place,
};

function currentPickerProps(): ComponentProps<typeof PlacePicker> {
  if (!mockPlacePickerProps) {
    throw new Error('Expected PlacePicker to be rendered.');
  }
  return mockPlacePickerProps as ComponentProps<typeof PlacePicker>;
}

describe('DestinationField', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlacePickerProps = undefined;
  });

  it('adopts a verified place as a structured destination value', async () => {
    const onChange = jest.fn();
    await render(
      <DestinationField
        value={{ label: '', place: null }}
        onChange={onChange}
      />,
    );

    await act(async () => {
      currentPickerProps().onSelectPlace(place);
    });

    expect(onChange).toHaveBeenCalledWith({ label: place.label, place });
  });

  it('drops the structured half when the user chooses manual entry', async () => {
    const onChange = jest.fn();
    await render(
      <DestinationField value={structuredValue} onChange={onChange} />,
    );

    await act(async () => {
      currentPickerProps().onUseManualEntry({ label: 'Somewhere else' });
    });

    expect(onChange).toHaveBeenCalledWith({
      label: 'Somewhere else',
      place: null,
    });
  });

  it('degrades to the suggestion label after a lookup failure', async () => {
    const onChange = jest.fn();
    await render(
      <DestinationField value={structuredValue} onChange={onChange} />,
    );

    await act(async () => {
      currentPickerProps().onLookupFailure({
        label: 'Unverified suggestion',
        error: { kind: 'network', message: 'Cannot reach the server.' },
        guidance: 'Enter the location manually.',
      });
    });

    expect(onChange).toHaveBeenCalledWith({
      label: 'Unverified suggestion',
      place: null,
    });
  });

  it('drops a stale verified place as soon as the label is typed over', async () => {
    const onChange = jest.fn();
    await render(
      <DestinationField value={structuredValue} onChange={onChange} />,
    );

    await fireEvent.changeText(
      screen.getByLabelText('Destination'),
      'Hoi An old town',
    );

    expect(onChange).toHaveBeenCalledWith({
      label: 'Hoi An old town',
      place: null,
    });
  });

  it('shows the verified place to the picker as a display-only card', async () => {
    await render(
      <DestinationField value={structuredValue} onChange={jest.fn()} />,
    );

    expect(currentPickerProps().value).toEqual({
      label: place.label,
      place: { title: place.label, address: place.address },
    });
  });

  it('renders a backend destination field error beside the manual input', async () => {
    await render(
      <DestinationField
        value={{ label: 'Da Lat', place: null }}
        error="Choose a valid destination."
        onChange={jest.fn()}
      />,
    );

    expect(screen.getByText('Choose a valid destination.')).toBeTruthy();
  });
});
