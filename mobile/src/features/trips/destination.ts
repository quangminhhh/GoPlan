import { truncateCodePoints } from '@/shared/location/resolvePlace';
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

const DESTINATION_ERROR_FIELDS = [
  'destination',
  'destination_provider',
  'destination_provider_id',
  'destination_lat',
  'destination_lng',
  'destination_country_code',
] as const;

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

/**
 * Adopt a verified place.
 *
 * A trip stores the canonical destination the HERE lookup returned, which the
 * shared place carries in `address` ("Hội An, Quảng Nam, Việt Nam") — `label` is
 * the short suggestion title ("Hội An") that the timeline wants for an activity.
 * Taking the label here would persist a label from one representation next to
 * five structured columns from another, and the same place would land in the
 * column differently on web and on mobile.
 *
 * The address is capped at 255 for the shared picker but `destination` is 200,
 * so it is re-truncated by code point — `slice` counts UTF-16 units and would
 * split an emoji in half.
 */
export function destinationValueFromPlace(
  place: ResolvedPlace,
): TripDestinationValue {
  // A place rebuilt from a stored trip has no address; so does a lookup that
  // returned no usable canonical destination.
  const canonical = place.address.trim() || place.label;

  return {
    label: truncateCodePoints(canonical, TRIP_DESTINATION_MAX_LENGTH),
    place,
  };
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
  // Both shapes submit the label the form is holding: a structured value already
  // normalised it to the canonical destination, and a hand-edited label always
  // arrives with `place` dropped, so it can never disagree with the metadata.
  const destination = value.label.trim();

  if (value.place) {
    return {
      destination,
      destination_provider: value.place.provider,
      destination_provider_id: value.place.provider_id,
      destination_lat: normalizeCoordinate(value.place.lat),
      destination_lng: normalizeCoordinate(value.place.lng),
      destination_country_code: value.place.country_code,
    };
  }

  return {
    destination,
    destination_provider: '',
    destination_provider_id: '',
    destination_lat: null,
    destination_lng: null,
    destination_country_code: '',
  };
}

/** Surface any backend error for the structured destination as one field error. */
export function destinationFieldError(
  fieldErrors: Readonly<Record<string, string>> | undefined,
): string | undefined {
  for (const field of DESTINATION_ERROR_FIELDS) {
    const message = fieldErrors?.[field];
    if (message !== undefined) {
      return message;
    }
  }
  return undefined;
}

/** Django stores both coordinates with decimal_places=6. */
function normalizeCoordinate(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(6));
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
