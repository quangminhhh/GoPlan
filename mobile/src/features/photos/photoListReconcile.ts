import type { TripPhoto } from './types';

/**
 * Merges a refreshed first cursor page without treating its absence as a
 * deletion signal for photos that were already loaded from deeper pages.
 *
 * The fresh page is authoritative for duplicate payloads and ordering within
 * the prefix. Existing tail items keep their relative order. Only an explicit
 * tombstone may remove an id.
 */
export function mergeTripPhotoFirstPage(
  current: readonly TripPhoto[],
  freshFirstPage: readonly TripPhoto[],
  tombstonedPhotoIds: ReadonlySet<string> = new Set<string>(),
): TripPhoto[] {
  const seen = new Set<string>();
  const merged: TripPhoto[] = [];

  for (const photo of freshFirstPage) {
    if (tombstonedPhotoIds.has(photo.id) || seen.has(photo.id)) {
      continue;
    }
    seen.add(photo.id);
    merged.push(photo);
  }

  for (const photo of current) {
    if (tombstonedPhotoIds.has(photo.id) || seen.has(photo.id)) {
      continue;
    }
    seen.add(photo.id);
    merged.push(photo);
  }

  return merged;
}
