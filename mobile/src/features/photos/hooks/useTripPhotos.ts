/**
 * Cursor-paginated trip photos with reconciliation and the D18 404 split.
 *
 * The pagination shape follows `features/friends/hooks/useCursorList`, but this
 * is a deliberate copy rather than an import: photos need semantics that list
 * does not have — a trip-level not-found state, coalesced reconciliation driven
 * by failing tiles, and a tombstone ledger that survives a refresh which started
 * before the mutation.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import {
  invalidateProtectedAsset,
  invalidateProtectedAssets,
} from '@/shared/media/protectedAssetStore';
import { listTripPhotos, tripPhotoAssetKey, tripPhotoAssetKeyPrefix } from '../api';
import {
  classifyNotFound,
  isCancelledFailure,
  toPhotoFailure,
  type PhotoFailure,
} from '../errors';
import type { TripPhoto } from '../types';

export type PhotoListStatus = 'loading' | 'ready' | 'error';
export type PhotoLoadMode = 'initial' | 'refresh' | 'silent';
export type PhotoErrorSource = 'initial' | 'refresh' | 'loadMore' | 'background' | 'mutation' | null;

interface PhotoOverride {
  version: number;
  photo?: TripPhoto;
  removed: boolean;
}

type ReconcileEvidence = 'readable' | 'unreadable' | 'unknown';

/**
 * The list contract is `-created_at, -id`. Locally merged uploads are sorted the
 * same way so a photo does not jump position the moment the server's own
 * ordering arrives.
 */
export function sortPhotosByContractOrder(photos: TripPhoto[]): TripPhoto[] {
  return [...photos].sort((left, right) => {
    if (left.created_at !== right.created_at) {
      return left.created_at < right.created_at ? 1 : -1;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? 1 : -1;
  });
}

function applyOverrides(
  serverPhotos: TripPhoto[],
  overrides: Map<string, PhotoOverride>,
  requestOverrideVersion: number,
  includeMissingAdditions: boolean,
): TripPhoto[] {
  const seen = new Set<string>();
  const reconciled: TripPhoto[] = [];

  for (const serverPhoto of serverPhotos) {
    const override = overrides.get(serverPhoto.id);
    // Only an override newer than the request can speak for it. An older one has
    // already been observed by the server and its opinion is stale.
    const active = override && override.version > requestOverrideVersion ? override : undefined;
    if (active?.removed) {
      continue;
    }
    seen.add(serverPhoto.id);
    reconciled.push(active?.photo ?? serverPhoto);
  }

  if (!includeMissingAdditions) {
    return reconciled;
  }

  const additions: TripPhoto[] = [];
  for (const [photoId, override] of overrides) {
    if (override.version > requestOverrideVersion && !override.removed && override.photo && !seen.has(photoId)) {
      additions.push(override.photo);
      seen.add(photoId);
    }
  }

  return additions.length > 0 ? sortPhotosByContractOrder([...additions, ...reconciled]) : reconciled;
}

export interface UseTripPhotosResult {
  photos: TripPhoto[];
  status: PhotoListStatus;
  error: PhotoFailure | null;
  errorSource: PhotoErrorSource;
  refreshing: boolean;
  loadingMore: boolean;
  hasNextPage: boolean;
  /** Trip is gone or no longer readable. Neutral by design — see D18. */
  tripNotFound: boolean;
  loadFirstPage: (mode: PhotoLoadMode) => Promise<void>;
  loadMore: () => Promise<void>;
  reconcile: () => Promise<void>;
  prependUploaded: (photos: TripPhoto[]) => void;
  removePhoto: (photoId: string) => void;
  markPhotoStale: (photoId: string) => void;
  handleAssetNotFound: (photoId: string, failure: PhotoFailure) => void;
}

export function useTripPhotos(tripId: string | undefined): UseTripPhotosResult {
  const [stateTripId, setStateTripId] = useState(tripId);
  const [photos, setPhotos] = useState<TripPhoto[]>([]);
  const [status, setStatus] = useState<PhotoListStatus>('loading');
  const [error, setError] = useState<PhotoFailure | null>(null);
  const [errorSource, setErrorSource] = useState<PhotoErrorSource>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [tripNotFound, setTripNotFound] = useState(false);

  const nextCursorRef = useRef<string | null>(null);
  const firstPageRequestRef = useRef(0);
  const firstPageInFlightRef = useRef(false);
  const listGenerationRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);
  const hasUsablePageRef = useRef(false);
  const overridesRef = useRef(new Map<string, PhotoOverride>());
  const overrideVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const hasLoadedOnceRef = useRef(false);
  /** One shared reconcile for every tile that reports an ambiguous 404. */
  const reconcileInFlightRef = useRef<Promise<ReconcileEvidence> | null>(null);
  const tripInvalidatedRef = useRef(false);
  const refsTripIdRef = useRef(tripId);

  if (stateTripId !== tripId) {
    // React permits a guarded render-phase adjustment when state is derived
    // from an identity prop. It restarts this component before committing, so
    // the old trip is never painted and no reset-only effect causes a second
    // visible render. The layout effect below moves imperative request state
    // before passive focus effects or external promise callbacks can proceed.
    setPhotos([]);
    setStatus('loading');
    setError(null);
    setErrorSource(null);
    setRefreshing(false);
    setLoadingMore(false);
    setHasNextPage(false);
    setTripNotFound(false);
    setStateTripId(tripId);
  }

  useLayoutEffect(() => {
    if (refsTripIdRef.current === tripId) {
      return;
    }
    refsTripIdRef.current = tripId;
    firstPageRequestRef.current += 1;
    listGenerationRef.current += 1;
    firstPageInFlightRef.current = false;
    loadMoreInFlightRef.current = false;
    nextCursorRef.current = null;
    hasUsablePageRef.current = false;
    overridesRef.current.clear();
    overrideVersionRef.current += 1;
    hasLoadedOnceRef.current = false;
    reconcileInFlightRef.current = null;
    tripInvalidatedRef.current = false;
  }, [tripId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const enterTripNotFound = useCallback(() => {
    if (tripInvalidatedRef.current) {
      // 60 tiles can report the same membership loss. Do the trip-level work
      // once instead of sixty times.
      return;
    }
    tripInvalidatedRef.current = true;
    // Invalidate every response already in flight before changing visible
    // state. A list success that started while membership was still valid must
    // not resurrect the gallery after an explicit TRIP_NOT_FOUND.
    firstPageRequestRef.current += 1;
    listGenerationRef.current += 1;
    firstPageInFlightRef.current = false;
    loadMoreInFlightRef.current = false;
    if (tripId) {
      void invalidateProtectedAssets(tripPhotoAssetKeyPrefix(tripId));
    }
    setPhotos([]);
    setHasNextPage(false);
    setRefreshing(false);
    setLoadingMore(false);
    setTripNotFound(true);
    setStatus('error');
    setErrorSource('initial');
  }, [tripId]);

  const loadFirstPage = useCallback(
    async (mode: PhotoLoadMode) => {
      if (!tripId) {
        return;
      }
      const requestId = firstPageRequestRef.current + 1;
      firstPageRequestRef.current = requestId;
      firstPageInFlightRef.current = true;
      listGenerationRef.current += 1;
      const requestOverrideVersion = overrideVersionRef.current;
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
      setError(null);
      setErrorSource(null);
      if (mode === 'initial') {
        setStatus('loading');
      } else if (mode === 'refresh') {
        setRefreshing(true);
      }

      try {
        const page = await listTripPhotos(tripId);
        if (requestId !== firstPageRequestRef.current || !mountedRef.current) {
          return;
        }
        nextCursorRef.current = page.nextCursor;
        setHasNextPage(page.nextCursor !== null);
        setPhotos(applyOverrides(page.items, overridesRef.current, requestOverrideVersion, true));
        hasUsablePageRef.current = true;
        tripInvalidatedRef.current = false;
        setTripNotFound(false);
        setStatus('ready');
      } catch (caught) {
        if (requestId !== firstPageRequestRef.current || !mountedRef.current) {
          return;
        }
        const failure = toPhotoFailure(caught);
        if (isCancelledFailure(failure)) {
          return;
        }
        if (failure.kind === 'notFound') {
          // Any 404 on the list itself is trip-level: there is no photo id in
          // this request to be stale.
          enterTripNotFound();
          return;
        }
        setError(failure);
        if (mode === 'initial' || !hasUsablePageRef.current) {
          setErrorSource('initial');
          setStatus('error');
        } else {
          setErrorSource(mode === 'refresh' ? 'refresh' : 'background');
        }
      } finally {
        if (requestId === firstPageRequestRef.current) {
          firstPageInFlightRef.current = false;
          if (mountedRef.current) {
            setRefreshing(false);
          }
        }
      }
    },
    [tripId, enterTripNotFound],
  );

  const loadMore = useCallback(async () => {
    const cursor = nextCursorRef.current;
    if (!tripId || firstPageInFlightRef.current || loadMoreInFlightRef.current || !cursor) {
      return;
    }

    const generation = listGenerationRef.current;
    const requestOverrideVersion = overrideVersionRef.current;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    setError(null);
    setErrorSource(null);

    try {
      const page = await listTripPhotos(tripId, cursor);
      if (generation !== listGenerationRef.current || !mountedRef.current) {
        return;
      }
      nextCursorRef.current = page.nextCursor;
      setHasNextPage(page.nextCursor !== null);
      setPhotos((current) => {
        const seen = new Set(current.map((photo) => photo.id));
        const appended = applyOverrides(
          page.items,
          overridesRef.current,
          requestOverrideVersion,
          false,
        ).filter((photo) => !seen.has(photo.id));
        return [...current, ...appended];
      });
    } catch (caught) {
      if (generation !== listGenerationRef.current || !mountedRef.current) {
        return;
      }
      const failure = toPhotoFailure(caught);
      if (isCancelledFailure(failure)) {
        return;
      }
      if (failure.kind === 'notFound') {
        enterTripNotFound();
        return;
      }
      // The cursor is deliberately left where it was: retry re-requests the same
      // page, and the pages already loaded stay on screen.
      setError(failure);
      setErrorSource('loadMore');
    } finally {
      if (generation === listGenerationRef.current) {
        loadMoreInFlightRef.current = false;
        if (mountedRef.current) {
          setLoadingMore(false);
        }
      }
    }
  }, [tripId, enterTripNotFound]);

  /** Silent first-page reload used by focus, foreground and after a mutation. */
  const reconcile = useCallback(() => loadFirstPage('silent'), [loadFirstPage]);

  /**
   * Runs one silent reconcile no matter how many callers ask at once, and
   * reports whether the trip is still readable.
   */
  const coalescedReconcile = useCallback((): Promise<ReconcileEvidence> => {
    if (reconcileInFlightRef.current) {
      return reconcileInFlightRef.current;
    }
    if (!tripId || tripInvalidatedRef.current) {
      return Promise.resolve('unreadable');
    }

    // This is a first-page read even though its caller only wants evidence.
    // Give it the same sequencing authority as refresh/focus: supersede an
    // older first page, invalidate any load-more append already in flight, and
    // allow a newer first page to supersede this reconcile in turn.
    const requestId = firstPageRequestRef.current + 1;
    firstPageRequestRef.current = requestId;
    firstPageInFlightRef.current = true;
    listGenerationRef.current += 1;
    loadMoreInFlightRef.current = false;
    setLoadingMore(false);
    const requestOverrideVersion = overrideVersionRef.current;

    let pending!: Promise<ReconcileEvidence>;
    pending = (async () => {
      try {
        const page = await listTripPhotos(tripId);
        if (
          requestId !== firstPageRequestRef.current ||
          !mountedRef.current
        ) {
          return 'unknown';
        }
        if (tripInvalidatedRef.current) {
          return 'unreadable';
        }
        nextCursorRef.current = page.nextCursor;
        setHasNextPage(page.nextCursor !== null);
        setPhotos(
          applyOverrides(page.items, overridesRef.current, requestOverrideVersion, true),
        );
        hasUsablePageRef.current = true;
        return 'readable';
      } catch (caught) {
        if (
          requestId !== firstPageRequestRef.current ||
          !mountedRef.current
        ) {
          return 'unknown';
        }
        const failure = toPhotoFailure(caught);
        if (failure.kind === 'notFound') {
          return 'unreadable';
        }
        // Network/5xx is genuinely no evidence. It must not be collapsed into
        // readable, because doing so tombstones a photo on an ambiguous 404.
        return 'unknown';
      } finally {
        if (requestId === firstPageRequestRef.current) {
          firstPageInFlightRef.current = false;
        }
        if (reconcileInFlightRef.current === pending) {
          reconcileInFlightRef.current = null;
        }
      }
    })();
    reconcileInFlightRef.current = pending;
    return pending;
  }, [tripId]);

  const markPhotoStale = useCallback(
    (photoId: string) => {
      overrideVersionRef.current += 1;
      overridesRef.current.set(photoId, { version: overrideVersionRef.current, removed: true });
      setPhotos((current) => current.filter((photo) => photo.id !== photoId));
      if (tripId) {
        // Explicit invalidation, not `release()`: a photo that no longer exists
        // on the server must not stay reusable in the LRU.
        void invalidateProtectedAsset(tripPhotoAssetKey(tripId, photoId, 'thumbnail'));
        void invalidateProtectedAsset(tripPhotoAssetKey(tripId, photoId, 'medium'));
      }
    },
    [tripId],
  );

  const removePhoto = markPhotoStale;

  const prependUploaded = useCallback((uploaded: TripPhoto[]) => {
    if (uploaded.length === 0) {
      return;
    }
    overrideVersionRef.current += 1;
    const version = overrideVersionRef.current;
    for (const photo of uploaded) {
      overridesRef.current.set(photo.id, { version, photo, removed: false });
    }
    setPhotos((current) => {
      const uploadedIds = new Set(uploaded.map((photo) => photo.id));
      return sortPhotosByContractOrder([
        ...uploaded,
        ...current.filter((photo) => !uploadedIds.has(photo.id)),
      ]);
    });
  }, []);

  /**
   * The D18 branch, shared by every tile, the viewer, delete and single save.
   *
   * A missing or unparseable `error_code` is not evidence of anything yet, so it
   * buys evidence first: one coalesced list request decides whether this is a
   * stale photo or a trip the user can no longer read.
   */
  const handleAssetNotFound = useCallback(
    (photoId: string, failure: PhotoFailure) => {
      const scope = classifyNotFound(failure);
      if (scope === 'photo') {
        markPhotoStale(photoId);
        return;
      }
      if (scope === 'trip') {
        enterTripNotFound();
        return;
      }
      void coalescedReconcile().then((evidence) => {
        if (!mountedRef.current) {
          return;
        }
        if (evidence === 'readable') {
          markPhotoStale(photoId);
        } else if (evidence === 'unreadable') {
          enterTripNotFound();
        }
      });
    },
    [coalescedReconcile, enterTripNotFound, markPhotoStale],
  );

  useFocusEffect(
    useCallback(() => {
      if (!tripId || tripInvalidatedRef.current) {
        return;
      }
      if (!hasLoadedOnceRef.current) {
        hasLoadedOnceRef.current = true;
        void loadFirstPage('initial');
        return;
      }
      if (firstPageInFlightRef.current) {
        // Focus and foreground can fire in the same tick; one request is enough.
        return;
      }
      void loadFirstPage('silent');
    }, [tripId, loadFirstPage]),
  );

  useAppForegroundEffect(
    useCallback(() => {
      if (!tripId || tripInvalidatedRef.current || !hasLoadedOnceRef.current) {
        return;
      }
      if (firstPageInFlightRef.current) {
        return;
      }
      void loadFirstPage('silent');
    }, [tripId, loadFirstPage]),
  );

  const stateMatchesTrip = stateTripId === tripId;

  return {
    // Effects reset the backing state after a route transition. These derived
    // guards also protect the render before that effect runs, so trip A can
    // never be painted under trip B's route identity.
    photos: stateMatchesTrip ? photos : [],
    status: stateMatchesTrip ? status : 'loading',
    error: stateMatchesTrip ? error : null,
    errorSource: stateMatchesTrip ? errorSource : null,
    refreshing: stateMatchesTrip ? refreshing : false,
    loadingMore: stateMatchesTrip ? loadingMore : false,
    hasNextPage: stateMatchesTrip ? hasNextPage : false,
    tripNotFound: stateMatchesTrip ? tripNotFound : false,
    loadFirstPage,
    loadMore,
    reconcile,
    prependUploaded,
    removePhoto,
    markPhotoStale,
    handleAssetNotFound,
  };
}
