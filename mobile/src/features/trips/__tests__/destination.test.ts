import type { ResolvedPlace } from '@/shared/location/types';
import {
  destinationFields,
  destinationValueFromPlace,
  destinationValueFromTrip,
  manualDestinationValue,
  TRIP_DESTINATION_MAX_LENGTH,
} from '../destination';
import type { Trip } from '../types';

// The short suggestion title and the canonical lookup destination differ on
// purpose: that difference is the whole point of these expectations.
const place: ResolvedPlace = {
  provider: 'here',
  provider_id: 'canonical-here-id',
  label: 'Hội An',
  address: 'Hội An, Quảng Nam, Việt Nam',
  lat: 15.8801,
  lng: 108.338,
  country_code: 'VN',
};

function buildTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-1',
    name: 'Da Lat escape',
    destination: 'Da Lat, Vietnam',
    destination_provider: 'here',
    destination_provider_id: 'here:place:da-lat',
    destination_lat: '11.940400',
    destination_lng: '108.458300',
    destination_country_code: 'VN',
    cover_image_url: '',
    start_date: '2026-06-01',
    end_date: '2026-06-03',
    description: '',
    status: 'PLANNING',
    currency_code: 'VND',
    timezone: 'Asia/Ho_Chi_Minh',
    budget_estimate: null,
    cancelled_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('destinationValueFromPlace', () => {
  it('adopts the canonical lookup destination, not the short suggestion title', () => {
    expect(destinationValueFromPlace(place).label).toBe(
      'Hội An, Quảng Nam, Việt Nam',
    );
  });

  it('truncates a canonical destination past the 200 cap by code point', () => {
    const address = `${'🏝'.repeat(210)}`;

    const { label } = destinationValueFromPlace({ ...place, address });

    expect(Array.from(label)).toHaveLength(TRIP_DESTINATION_MAX_LENGTH);
    expect(label).toBe('🏝'.repeat(TRIP_DESTINATION_MAX_LENGTH));
  });

  it('falls back to the label when the lookup carried no canonical destination', () => {
    expect(destinationValueFromPlace({ ...place, address: '   ' }).label).toBe(
      'Hội An',
    );
  });
});

describe('destinationFields', () => {
  it('writes all five structured columns from one verified place', () => {
    expect(destinationFields(destinationValueFromPlace(place))).toEqual({
      destination: 'Hội An, Quảng Nam, Việt Nam',
      destination_provider: 'here',
      destination_provider_id: 'canonical-here-id',
      destination_lat: 15.8801,
      destination_lng: 108.338,
      destination_country_code: 'VN',
    });
  });

  it('rounds structured coordinates to the backend six-decimal contract', () => {
    expect(
      destinationFields(
        destinationValueFromPlace({
          ...place,
          lat: 15.880123789,
          lng: 108.338987654,
        }),
      ),
    ).toMatchObject({
      destination_lat: 15.880124,
      destination_lng: 108.338988,
    });
  });

  it('clears all five structured columns for a manual value', () => {
    expect(
      destinationFields(manualDestinationValue('  Nha Trang, Vietnam  ')),
    ).toEqual({
      destination: 'Nha Trang, Vietnam',
      destination_provider: '',
      destination_provider_id: '',
      destination_lat: null,
      destination_lng: null,
      destination_country_code: '',
    });
  });

  it('never emits undefined for a structured column on a manual value', () => {
    // An omitted key on a PATCH leaves the stored value in place, which is the
    // exact data corruption this milestone exists to prevent.
    const fields = destinationFields(manualDestinationValue('Sa Pa'));

    for (const value of Object.values(fields)) {
      expect(value).not.toBeUndefined();
    }
    expect(Object.keys(fields)).toHaveLength(6);
  });
});

describe('destinationValueFromTrip', () => {
  it('rebuilds a display place from a structured trip', () => {
    const value = destinationValueFromTrip(buildTrip());

    expect(value.label).toBe('Da Lat, Vietnam');
    expect(value.place).toEqual({
      provider: 'here',
      provider_id: 'here:place:da-lat',
      label: 'Da Lat, Vietnam',
      address: '',
      lat: 11.9404,
      lng: 108.4583,
      country_code: 'VN',
    });
  });

  it('treats a trip without a provider id as manual', () => {
    const value = destinationValueFromTrip(
      buildTrip({
        destination_provider: '',
        destination_provider_id: '',
        destination_lat: null,
        destination_lng: null,
        destination_country_code: '',
      }),
    );

    expect(value.label).toBe('Da Lat, Vietnam');
    expect(value.place).toBeNull();
  });

  it('keeps a structured trip whose stored coordinates are null', () => {
    const value = destinationValueFromTrip(
      buildTrip({ destination_lat: null, destination_lng: null }),
    );

    expect(value.place).not.toBeNull();
    expect(value.place?.lat).toBeNull();
    expect(value.place?.lng).toBeNull();
  });

  it('never produces NaN from an unparseable stored coordinate', () => {
    const value = destinationValueFromTrip(
      buildTrip({ destination_lat: 'not-a-number', destination_lng: '' }),
    );

    expect(value.place?.lat).toBeNull();
    expect(value.place?.lng).toBeNull();
  });
});
