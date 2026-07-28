import type { ResolvedPlace } from '@/shared/location/types';
import type { Trip } from './types';

/** Trip.destination is max_length=200, the same cap the shared picker enforces. */
export const TRIP_DESTINATION_MAX_LENGTH = 200;

/** What a trip form holds for the destination field. */
export interface TripDestinationValue {
  /** Goes to `destination`. Trimmed at submit time, not while typing. */
  label: string;
  /** Null in manual mode. */
  place: ResolvedPlace | null;
}

/**
 * Every key is required on purpose. `Pick<UpdateTripInput, …>` would inherit the
 * optional modifiers, and an accidentally omitted key on a PATCH leaves stale
 * data in the column instead of clearing it.
 */
export interface TripDestinationFields {
  destination: string;
  destination_provider: string;
  destination_provider_id: string;
  destination_lat: number | null;
  destination_lng: number | null;
  destination_country_code: string;
}

/**
 * Hydrate the edit form from a stored trip.
 *
 * The rebuilt place is display-only: it drives the "Selected place" card and the
 * initial label, and never reaches a payload unless the user re-picks. A stored
 * trip has no separate address, so that field stays empty, and `provider` is the
 * only value ResolvedPlace admits — a row written by an older provider still
 * renders correctly, and re-picking replaces the whole place from a fresh lookup.
 */
export function destinationValueFromTrip(trip: Trip): TripDestinationValue {
  if (trip.destination_provider_id === '') {
    return { label: trip.destination, place: null };
  }

  return {
    label: trip.destination,
    place: {
      provider: 'here',
      provider_id: trip.destination_provider_id,
      label: trip.destination,
      address: '',
      lat: parseStoredCoordinate(trip.destination_lat),
      lng: parseStoredCoordinate(trip.destination_lng),
      country_code: trip.destination_country_code,
    },
  };
}

/** Adopt a verified place. */
export function destinationValueFromPlace(
  place: ResolvedPlace,
): TripDestinationValue {
  return { label: place.label, place };
}

/** Adopt typed text; always drops the structured half. */
export function manualDestinationValue(label: string): TripDestinationValue {
  return { label, place: null };
}

/**
 * All six fields, always together. A structured value writes all five columns
 * from one lookup; a manual value clears all five. There is no third shape.
 */
export function destinationFields(
  value: TripDestinationValue,
): TripDestinationFields {
  if (value.place) {
    return {
      destination: value.place.label,
      destination_provider: value.place.provider,
      destination_provider_id: value.place.provider_id,
      destination_lat: value.place.lat,
      destination_lng: value.place.lng,
      destination_country_code: value.place.country_code,
    };
  }

  return {
    destination: value.label.trim(),
    destination_provider: '',
    destination_provider_id: '',
    destination_lat: null,
    destination_lng: null,
    destination_country_code: '',
  };
}

/**
 * Django serialises DecimalField as a string, so the stored value arrives as
 * text. An unparseable one becomes null rather than NaN, which would serialise
 * back out as an invalid number.
 */
function parseStoredCoordinate(value: string | null): number | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
