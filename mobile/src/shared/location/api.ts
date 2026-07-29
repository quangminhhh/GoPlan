import { apiClient } from '@/shared/api/client';
import type { PlaceSuggestion, ResolvedPlaceLookup } from './types';

interface PlaceSuggestionsResponse {
  suggestions: PlaceSuggestion[];
}

export async function suggestLocations(
  query: string,
  signal?: AbortSignal,
): Promise<PlaceSuggestion[]> {
  const { data } = await apiClient.get<PlaceSuggestionsResponse>(
    '/location-search/suggest',
    {
      params: { q: query },
      signal,
    },
  );
  return data.suggestions;
}

export async function lookupLocation(
  providerId: string,
  signal?: AbortSignal,
): Promise<ResolvedPlaceLookup> {
  const { data } = await apiClient.get<ResolvedPlaceLookup>(
    '/location-search/lookup',
    {
      params: { id: providerId },
      signal,
    },
  );
  return data;
}
