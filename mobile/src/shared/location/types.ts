/**
 * Provider-neutral place search contract, shared by every feature that needs a
 * HERE-backed place. The picker and this module know nothing about the fields a
 * caller writes: timeline maps a ResolvedPlace onto activity location fields,
 * trips map it onto destination_*.
 *
 * The caps below are the tightest backend limits across both consumers and
 * coincide exactly (decision D5 of the issue #63 plan):
 *   label   200 = activity.location_label = activity.place_title = trip.destination
 *   address 255 = activity.place_address
 *   id      255 = activity.place_provider_id = trip.destination_provider_id
 */
export interface PlaceSuggestion {
  provider: 'here';
  provider_id: string;
  title: string;
  subtitle: string;
}

/** Raw shape of GET /api/location-search/lookup. */
export interface ResolvedPlaceLookup {
  destination: string;
  destination_provider: 'here';
  destination_provider_id: string;
  destination_lat: number | null;
  destination_lng: number | null;
  destination_country_code: string;
}

/** A verified place, already truncated to the shared caps. */
export interface ResolvedPlace {
  provider: 'here';
  provider_id: string;
  label: string;
  address: string;
  lat: number | null;
  lng: number | null;
  /** ISO 3166-1 alpha-2, or '' when the provider gave nothing usable. */
  country_code: string;
}
