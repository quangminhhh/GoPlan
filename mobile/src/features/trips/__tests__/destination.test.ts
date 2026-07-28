import type { ResolvedPlace } from '@/shared/location/types';
import {
  destinationFields,
  destinationValueFromPlace,
  destinationValueFromTrip,
  manualDestinationValue,
} from '../destination';
import type { Trip } from '../types';

const place: ResolvedPlace = {
  provider: 'here',
  provider_id: 'canonical-here-id',
  label: 'Hội An, Quảng Nam',
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

describe('destinationFields', () => {
  it('writes all five structured columns from one verified place', () => {
    expect(destinationFields(destinationValueFromPlace(place))).toEqual({
      destination: place.label,
      destination_provider: 'here',
      destination_provider_id: 'canonical-here-id',
      destination_lat: 15.8801,
      destination_lng: 108.338,
      destination_country_code: 'VN',
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
