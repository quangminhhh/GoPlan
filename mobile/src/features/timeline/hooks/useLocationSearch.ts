import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { lookupLocation, suggestLocations } from '../api';
import { ACTIVITY_FIELD_LIMITS } from '../formModel';
import type {
  ActivityPlacePayload,
  LocationSuggestion,
} from '../types';
import {
  buildStructuredLocation,
  type StructuredLocationValue,
} from '../viewModel';

export const LOCATION_SEARCH_DEBOUNCE_MS = 300;
export const PLACE_SEARCH_UNAVAILABLE_MESSAGE =
  'Place search is unavailable — enter the location manually.';
export const MANUAL_LOCATION_GUIDANCE =
  "We couldn't verify this place — enter the location manually.";

export type LocationSearchStatus =
  | 'idle'
  | 'debouncing'
  | 'searching'
  | 'ready'
  | 'error';
export type LocationLookupStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface StructuredLocationSelection extends StructuredLocationValue {
  location_mode: 'STRUCTURED';
}

export interface ManualLocationValue {
  location_mode: 'MANUAL';
  location_label: string;
  place: null;
}

export interface SettledLocationLookupFailure extends ManualLocationValue {
  error: ApiError;
  guidance: string;
}

export type LocationLookupResult =
  | { kind: 'success'; selection: StructuredLocationSelection }
  | { kind: 'failure'; fallback: SettledLocationLookupFailure }
  | { kind: 'stale' };

interface UseLocationSearchOptions {
  enabled?: boolean;
}

const INVALID_CANONICAL_PLACE_ERROR: ApiError = {
  kind: 'message',
  message: 'The selected place could not be verified.',
};

function isLocationSearchUnavailable(error: ApiError): boolean {
  return (
    error.status === 503 &&
    (error.errorCode === 'LOCATION_SEARCH_DISABLED' ||
      error.errorCode === 'LOCATION_SEARCH_NOT_CONFIGURED')
  );
}

function withinProviderIdLimit(suggestion: LocationSuggestion): boolean {
  return (
    Array.from(suggestion.provider_id).length <=
    ACTIVITY_FIELD_LIMITS.place_provider_id
  );
}

function staleLookupResult(): LocationLookupResult {
  return { kind: 'stale' };
}

export function useLocationSearch({
  enabled = true,
}: UseLocationSearchOptions = {}) {
  const [query, setQueryValue] = useState('');
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [searchStatus, setSearchStatus] =
    useState<LocationSearchStatus>('idle');
  const [searchError, setSearchError] = useState<ApiError | null>(null);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const [lookupStatus, setLookupStatus] =
    useState<LocationLookupStatus>('idle');
  const [lookupError, setLookupError] = useState<ApiError | null>(null);
  const [manualEntrySuggested, setManualEntrySuggested] = useState(false);

  const mountedRef = useRef(false);
  const suggestRequestIdRef = useRef(0);
  const lookupRequestIdRef = useRef(0);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestControllerRef = useRef<AbortController | null>(null);
  const lookupControllerRef = useRef<AbortController | null>(null);

  const cancelSuggest = useCallback(() => {
    suggestRequestIdRef.current += 1;
    if (suggestTimerRef.current) {
      clearTimeout(suggestTimerRef.current);
      suggestTimerRef.current = null;
    }
    suggestControllerRef.current?.abort();
    suggestControllerRef.current = null;
  }, []);

  const cancelLookup = useCallback(() => {
    lookupRequestIdRef.current += 1;
    lookupControllerRef.current?.abort();
    lookupControllerRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelSuggest();
      cancelLookup();
    };
  }, [cancelLookup, cancelSuggest]);

  useEffect(() => {
    if (!enabled) {
      cancelSuggest();
      cancelLookup();
    }
  }, [cancelLookup, cancelSuggest, enabled]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!enabled || normalizedQuery.length < 2) {
      return undefined;
    }

    const requestId = suggestRequestIdRef.current + 1;
    suggestRequestIdRef.current = requestId;
    let controller: AbortController | null = null;

    suggestTimerRef.current = setTimeout(() => {
      suggestTimerRef.current = null;
      controller = new AbortController();
      suggestControllerRef.current = controller;
      if (
        !mountedRef.current ||
        requestId !== suggestRequestIdRef.current
      ) {
        controller.abort();
        return;
      }

      setSearchStatus('searching');
      void suggestLocations(normalizedQuery, controller.signal)
        .then((results) => {
          if (
            !mountedRef.current ||
            controller?.signal.aborted ||
            requestId !== suggestRequestIdRef.current
          ) {
            return;
          }

          setSuggestions(results.filter(withinProviderIdLimit));
          setSearchError(null);
          setSearchUnavailable(false);
          setSearchStatus('ready');
        })
        .catch((caught: unknown) => {
          if (
            !mountedRef.current ||
            controller?.signal.aborted ||
            requestId !== suggestRequestIdRef.current
          ) {
            return;
          }

          const nextError = normalizeApiError(caught);
          setSearchError(nextError);
          setSearchUnavailable(isLocationSearchUnavailable(nextError));
          setSearchStatus('error');
        })
        .finally(() => {
          if (suggestControllerRef.current === controller) {
            suggestControllerRef.current = null;
          }
        });
    }, LOCATION_SEARCH_DEBOUNCE_MS);

    return () => {
      if (suggestTimerRef.current) {
        clearTimeout(suggestTimerRef.current);
        suggestTimerRef.current = null;
      }
      controller?.abort();
      if (suggestControllerRef.current === controller) {
        suggestControllerRef.current = null;
      }
      if (suggestRequestIdRef.current === requestId) {
        suggestRequestIdRef.current += 1;
      }
    };
  }, [enabled, query]);

  const setQuery = useCallback(
    (nextQuery: string) => {
      cancelSuggest();
      cancelLookup();
      setQueryValue(nextQuery);
      setSearchError(null);
      setSearchUnavailable(false);
      setLookupError(null);
      setLookupStatus('idle');
      setManualEntrySuggested(false);

      if (nextQuery.trim().length < 2) {
        setSuggestions([]);
        setSearchStatus('idle');
      } else {
        setSearchStatus('debouncing');
      }
    },
    [cancelLookup, cancelSuggest],
  );

  const clear = useCallback(() => {
    cancelSuggest();
    cancelLookup();
    setQueryValue('');
    setSuggestions([]);
    setSearchStatus('idle');
    setSearchError(null);
    setSearchUnavailable(false);
    setLookupStatus('idle');
    setLookupError(null);
    setManualEntrySuggested(false);
  }, [cancelLookup, cancelSuggest]);

  const commitLookupFailure = useCallback(
    (
      suggestion: LocationSuggestion,
      nextError: ApiError,
    ): LocationLookupResult => {
      const fallback: SettledLocationLookupFailure = {
        location_mode: 'MANUAL',
        location_label: suggestion.title,
        place: null,
        error: nextError,
        guidance: MANUAL_LOCATION_GUIDANCE,
      };
      setLookupError(nextError);
      setLookupStatus('error');
      setManualEntrySuggested(true);
      return { kind: 'failure', fallback };
    },
    [],
  );

  const selectSuggestion = useCallback(
    async (
      suggestion: LocationSuggestion,
    ): Promise<LocationLookupResult> => {
      if (!enabled || !mountedRef.current) {
        return staleLookupResult();
      }

      cancelSuggest();
      cancelLookup();
      setSuggestions([]);
      setSearchStatus('idle');
      setSearchError(null);
      setSearchUnavailable(false);
      setLookupError(null);
      setManualEntrySuggested(false);
      setLookupStatus('loading');

      const controller = new AbortController();
      lookupControllerRef.current = controller;
      const requestId = lookupRequestIdRef.current + 1;
      lookupRequestIdRef.current = requestId;

      try {
        const lookup = await lookupLocation(
          suggestion.provider_id,
          controller.signal,
        );
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          requestId !== lookupRequestIdRef.current
        ) {
          return staleLookupResult();
        }

        const value = buildStructuredLocation(suggestion, lookup);
        if (!value) {
          return commitLookupFailure(
            suggestion,
            INVALID_CANONICAL_PLACE_ERROR,
          );
        }

        setLookupStatus('ready');
        return {
          kind: 'success',
          selection: {
            location_mode: 'STRUCTURED',
            ...value,
          },
        };
      } catch (caught) {
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          requestId !== lookupRequestIdRef.current
        ) {
          return staleLookupResult();
        }
        return commitLookupFailure(suggestion, normalizeApiError(caught));
      } finally {
        if (lookupControllerRef.current === controller) {
          lookupControllerRef.current = null;
        }
      }
    },
    [
      cancelLookup,
      cancelSuggest,
      commitLookupFailure,
      enabled,
    ],
  );

  const createManualValue = useCallback(
    (existingLabel = ''): ManualLocationValue => ({
      location_mode: 'MANUAL',
      location_label: query.trim() || existingLabel,
      place: null,
    }),
    [query],
  );

  return {
    query,
    setQuery,
    clear,
    suggestions,
    searchStatus: enabled ? searchStatus : 'idle',
    searchError: enabled ? searchError : null,
    searchUnavailable: enabled ? searchUnavailable : false,
    lookupStatus: enabled ? lookupStatus : 'idle',
    lookupError: enabled ? lookupError : null,
    manualEntrySuggested: enabled ? manualEntrySuggested : false,
    selectSuggestion,
    createManualValue,
  };
}

export type PlacePickerValue = {
  location_label: string;
  place: ActivityPlacePayload | null;
};
