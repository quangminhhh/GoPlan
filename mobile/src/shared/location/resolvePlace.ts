import type { PlaceSuggestion, ResolvedPlace, ResolvedPlaceLookup } from './types';

/**
 * The tightest backend cap across every consumer of this module (decision D5).
 * They coincide for timeline activities and trip destinations, so a per-caller
 * prop would be configuration with exactly one possible value.
 */
export const MAX_PLACE_LABEL_LENGTH = 200;
export const MAX_PLACE_ADDRESS_LENGTH = 255;
export const MAX_PROVIDER_ID_LENGTH = 255;

/** Backend limits count characters, and an emoji is one character there too. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function truncateCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('');
}

/**
 * Turn a suggestion plus its canonical lookup into a verified place.
 *
 * Returns null when the lookup carries no usable canonical id — the suggestion's
 * own id is never a fallback, because a suggestion id is not stable enough to
 * store. A null result is what makes the caller degrade to manual entry.
 */
export function resolvePlace(
  suggestion: PlaceSuggestion,
  lookup: ResolvedPlaceLookup,
): ResolvedPlace | null {
  const canonicalProviderId = lookup.destination_provider_id;
  if (
    typeof canonicalProviderId !== 'string' ||
    canonicalProviderId.trim().length === 0 ||
    codePointLength(canonicalProviderId) > MAX_PROVIDER_ID_LENGTH
  ) {
    return null;
  }

  return {
    provider: 'here',
    provider_id: canonicalProviderId,
    label: truncateCodePoints(suggestion.title, MAX_PLACE_LABEL_LENGTH),
    address: truncateCodePoints(
      lookup.destination ?? suggestion.subtitle,
      MAX_PLACE_ADDRESS_LENGTH,
    ),
    lat: lookup.destination_lat ?? null,
    lng: lookup.destination_lng ?? null,
    // Trip.destination_country_code is max_length=2, so anything else would turn
    // an otherwise valid place into a 400. A missing optional attribute of one
    // canonical place is not a half-populated place (decision D6).
    country_code:
      lookup.destination_country_code?.length === 2
        ? lookup.destination_country_code
        : '',
  };
}
