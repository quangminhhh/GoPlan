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
import { mergeTripPhotoFirstPage } from '../photoListReconcile';
import type { TripPhoto } from '../types';
import type { AmbiguousNotFoundResolution } from '../photoSaveTypes';
import type { TripPhotoScopeController } from './useTripPhotoScope';

export type PhotoListStatus = 'loading' | 'ready' | 'error';
export type PhotoLoadMode = 'initial' | 'refresh' | 'silent';
export type PhotoErrorSource = 'initial' | 'refresh' | 'loadMore' | 'background' | 'mutation' | null;
export type PhotoTombstoneListener = (photoId: string) => void;

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
  /** Exact ids proven unavailable for the current trip generation. */
  tombstonedPhotoIds: ReadonlySet<string>;
  /** Synchronous read used by the final pre-PhotoKit commit gate. */
  isPhotoTombstoned: (photoId: string) => boolean;
  /**
   * Publishes authoritative removal before React state/effects run, allowing an
   * active download to abort and a native-boundary gate to fail in the same tick.
   */
  subscribePhotoTombstones: (listener: PhotoTombstoneListener) => () => void;
  /** Trip is gone or no longer readable. Neutral by design — see D18. */
  tripNotFound: boolean;
  loadFirstPage: (mode: PhotoLoadMode) => Promise<void>;
  loadMore: () => Promise<void>;
  retryLoadMore: () => Promise<void>;
  reconcile: () => Promise<void>;
  prependUploaded: (photos: TripPhoto[]) => void;
  removePhoto: (photoId: string) => void;
  markPhotoStale: (photoId: string) => void;
  resolveAssetNotFound: (
    photoId: string,
    failure: PhotoFailure,
  ) => Promise<AmbiguousNotFoundResolution>;
  handleAssetNotFound: (photoId: string, failure: PhotoFailure) => void;
}

export function useTripPhotos(
  tripId: string | undefined,
  scope: TripPhotoScopeController,
): UseTripPhotosResult {
  const scopeTicket = scope.capture();
  const [stateTripId, setStateTripId] = useState(tripId);
  const [photos, setPhotos] = useState<TripPhoto[]>([]);
  const [status, setStatus] = useState<PhotoListStatus>('loading');
  const [error, setError] = useState<PhotoFailure | null>(null);
  const [errorSource, setErrorSource] = useState<PhotoErrorSource>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [tripNotFound, setTripNotFound] = useState(false);
  const [tombstonedPhotoIds, setTombstonedPhotoIds] = useState<Set<string>>(
    () => new Set(),
  );
  const tombstonedPhotoIdsRef = useRef<Set<string>>(new Set());
  const tombstoneListenersRef = useRef(new Set<PhotoTombstoneListener>());

  const nextCursorRef = useRef<string | null>(null);
  const failedCursorRef = useRef<string | null>(null);
  const hasLoadedDeepPageRef = useRef(false);
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
    setTombstonedPhotoIds(new Set());
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
    failedCursorRef.current = null;
    hasLoadedDeepPageRef.current = false;
    hasUsablePageRef.current = false;
    overridesRef.current.clear();
    overrideVersionRef.current += 1;
    hasLoadedOnceRef.current = false;
    reconcileInFlightRef.current = null;
    tripInvalidatedRef.current = false;
    tombstonedPhotoIdsRef.current = new Set();
  }, [tripId]);

  useEffect(() => {
    mountedRef.current = true;
    const tombstoneListeners = tombstoneListenersRef.current;
    return () => {
      mountedRef.current = false;
      tombstoneListeners.clear();
    };
  }, []);

  const isPhotoTombstoned = useCallback(
    (photoId: string): boolean =>
      scope.isCurrent(scopeTicket) && tombstonedPhotoIdsRef.current.has(photoId),
    [scope, scopeTicket],
  );

  const subscribePhotoTombstones = useCallback(
    (listener: PhotoTombstoneListener): (() => void) => {
      tombstoneListenersRef.current.add(listener);
      return () => {
        tombstoneListenersRef.current.delete(listener);
      };
    },
    [],
  );

  const enterTripNotFound = useCallback(() => {
    if (!scope.isCurrent(scopeTicket)) {
      return;
    }
    if (tripInvalidatedRef.current) {
      // 60 tiles can report the same membership loss. Do the trip-level work
      // once instead of sixty times.
      return;
    }
    tripInvalidatedRef.current = true;
    // A list/membership terminal is an application-wide trip boundary, not only
    // a list presentation state. Close save/upload/viewer owners synchronously
    // before any of them can cross another scheduling or native-commit gate.
    scope.invalidateCurrentTrip();
    // Invalidate every response already in flight before changing visible
    // state. A list success that started while membership was still valid must
    // not resurrect the gallery after an explicit TRIP_NOT_FOUND.
    firstPageRequestRef.current += 1;
    listGenerationRef.current += 1;
    firstPageInFlightRef.current = false;
    loadMoreInFlightRef.current = false;
    failedCursorRef.current = null;
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
  }, [scope, scopeTicket, tripId]);

  const loadFirstPage = useCallback(
    async (mode: PhotoLoadMode) => {
      const entryTicket = scopeTicket;
      if (!tripId || !scope.isCurrent(entryTicket)) {
        return;
      }
      const requestId = firstPageRequestRef.current + 1;
      firstPageRequestRef.current = requestId;
      firstPageInFlightRef.current = true;
      listGenerationRef.current += 1;
      const requestOverrideVersion = overrideVersionRef.current;
      const failedCursorAtEntry = failedCursorRef.current;
      const preservePageFailure = failedCursorAtEntry !== null && mode !== 'initial';
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
      if (mode === 'initial') {
        failedCursorRef.current = null;
      }
      if (!preservePageFailure) {
        setError(null);
        setErrorSource(null);
      }
      if (mode === 'initial') {
        setStatus('loading');
      } else if (mode === 'refresh') {
        setRefreshing(true);
      }

      try {
        const page = await listTripPhotos(tripId);
        if (
          requestId !== firstPageRequestRef.current ||
          !mountedRef.current ||
          !scope.isCurrent(entryTicket)
        ) {
          return;
        }
        const fresh = applyOverrides(
          page.items,
          overridesRef.current,
          requestOverrideVersion,
          true,
        );
        if (hasLoadedDeepPageRef.current && mode !== 'initial') {
          setHasNextPage(nextCursorRef.current !== null);
          setPhotos((current) =>
            mergeTripPhotoFirstPage(current, fresh, tombstonedPhotoIdsRef.current),
          );
        } else {
          nextCursorRef.current = page.nextCursor;
          setHasNextPage(page.nextCursor !== null);
          setPhotos(fresh.filter((photo) => !tombstonedPhotoIdsRef.current.has(photo.id)));
        }
        hasUsablePageRef.current = true;
        tripInvalidatedRef.current = false;
        setTripNotFound(false);
        setStatus('ready');
        // An automatic focus/foreground reconcile may refresh page 1, but it
        // cannot silently reopen a failed deep-page frontier. A user pull-to-
        // refresh is the intentional full reconcile allowed to clear it.
        if (preservePageFailure && mode === 'refresh') {
          failedCursorRef.current = null;
          setError(null);
          setErrorSource(null);
        }
      } catch (caught) {
        if (
          requestId !== firstPageRequestRef.current ||
          !mountedRef.current ||
          !scope.isCurrent(entryTicket)
        ) {
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
        if (preservePageFailure) {
          // Keep the exact cursor and page error stable. In particular, a
          // background failure must not reclassify this as `background`, which
          // would reattach `onEndReached` and retry without a user action.
          setStatus('ready');
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
        if (requestId === firstPageRequestRef.current && scope.isCurrent(entryTicket)) {
          firstPageInFlightRef.current = false;
          if (mountedRef.current) {
            setRefreshing(false);
          }
        }
      }
    },
    [tripId, enterTripNotFound, scope, scopeTicket],
  );

  const runLoadMore = useCallback(
    async (explicitRetry: boolean) => {
      const entryTicket = scopeTicket;
      const cursor = explicitRetry ? failedCursorRef.current : nextCursorRef.current;
      if (
        !tripId ||
        !scope.isCurrent(entryTicket) ||
        firstPageInFlightRef.current ||
        loadMoreInFlightRef.current ||
        !cursor ||
        (!explicitRetry && failedCursorRef.current !== null)
      ) {
        return;
      }

      const generation = listGenerationRef.current;
      const requestOverrideVersion = overrideVersionRef.current;
      // Acquire the guard before hiding the error. Rapid Retry taps therefore
      // coalesce even though the footer disappears immediately.
      loadMoreInFlightRef.current = true;
      setLoadingMore(true);
      setError(null);
      setErrorSource(null);

      try {
        const page = await listTripPhotos(tripId, cursor);
        if (
          generation !== listGenerationRef.current ||
          !mountedRef.current ||
          !scope.isCurrent(entryTicket)
        ) {
          return;
        }
        failedCursorRef.current = null;
        hasLoadedDeepPageRef.current = true;
        nextCursorRef.current = page.nextCursor;
        setHasNextPage(page.nextCursor !== null);
        setPhotos((current) => {
          const seen = new Set(current.map((photo) => photo.id));
          const appended = applyOverrides(
            page.items,
            overridesRef.current,
            requestOverrideVersion,
            false,
          ).filter(
            (photo) => !seen.has(photo.id) && !tombstonedPhotoIdsRef.current.has(photo.id),
          );
          return [...current, ...appended];
        });
      } catch (caught) {
        if (
          generation !== listGenerationRef.current ||
          !mountedRef.current ||
          !scope.isCurrent(entryTicket)
        ) {
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
        // Retain the exact cursor. Automatic onEndReached calls are blocked
        // until the user explicitly retries this frontier.
        failedCursorRef.current = cursor;
        setError(failure);
        setErrorSource('loadMore');
      } finally {
        if (generation === listGenerationRef.current && scope.isCurrent(entryTicket)) {
          loadMoreInFlightRef.current = false;
          if (mountedRef.current) {
            setLoadingMore(false);
          }
        }
      }
    },
    [tripId, enterTripNotFound, scope, scopeTicket],
  );

  const loadMore = useCallback(() => runLoadMore(false), [runLoadMore]);
  const retryLoadMore = useCallback(() => runLoadMore(true), [runLoadMore]);

  /** Silent first-page reload used by focus, foreground and after a mutation. */
  const reconcile = useCallback(() => loadFirstPage('silent'), [loadFirstPage]);

  /**
   * Runs one silent reconcile no matter how many callers ask at once, and
   * reports whether the trip is still readable.
   */
  const coalescedReconcile = useCallback((): Promise<ReconcileEvidence> => {
    const entryTicket = scopeTicket;
    if (reconcileInFlightRef.current) {
      return reconcileInFlightRef.current;
    }
    if (!tripId || tripInvalidatedRef.current || !scope.isCurrent(entryTicket)) {
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
          !mountedRef.current ||
          !scope.isCurrent(entryTicket)
        ) {
          return 'unknown';
        }
        if (tripInvalidatedRef.current) {
          return 'unreadable';
        }
        const fresh = applyOverrides(
          page.items,
          overridesRef.current,
          requestOverrideVersion,
          true,
        );
        if (hasLoadedDeepPageRef.current) {
          setHasNextPage(nextCursorRef.current !== null);
          setPhotos((current) =>
            mergeTripPhotoFirstPage(current, fresh, tombstonedPhotoIdsRef.current),
          );
        } else {
          nextCursorRef.current = page.nextCursor;
          setHasNextPage(page.nextCursor !== null);
          setPhotos(fresh.filter((photo) => !tombstonedPhotoIdsRef.current.has(photo.id)));
        }
        hasUsablePageRef.current = true;
        return 'readable';
      } catch (caught) {
        if (
          requestId !== firstPageRequestRef.current ||
          !mountedRef.current ||
          !scope.isCurrent(entryTicket)
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
        if (requestId === firstPageRequestRef.current && scope.isCurrent(entryTicket)) {
          firstPageInFlightRef.current = false;
        }
        if (reconcileInFlightRef.current === pending) {
          reconcileInFlightRef.current = null;
        }
      }
    })();
    reconcileInFlightRef.current = pending;
    return pending;
  }, [scope, scopeTicket, tripId]);

  const markPhotoStale = useCallback(
    (photoId: string) => {
      if (!scope.isCurrent(scopeTicket)) {
        return;
      }
      overrideVersionRef.current += 1;
      overridesRef.current.set(photoId, { version: overrideVersionRef.current, removed: true });
      const newlyTombstoned = !tombstonedPhotoIdsRef.current.has(photoId);
      tombstonedPhotoIdsRef.current.add(photoId);
      if (newlyTombstoned) {
        for (const listener of Array.from(tombstoneListenersRef.current)) {
          try {
            listener(photoId);
          } catch {
            // One presentation owner cannot delay sibling native-boundary gates.
          }
        }
      }
      setTombstonedPhotoIds((current) => {
        if (current.has(photoId)) {
          return current;
        }
        const next = new Set(current);
        next.add(photoId);
        return next;
      });
      setPhotos((current) => current.filter((photo) => photo.id !== photoId));
      if (tripId) {
        // Explicit invalidation, not `release()`: a photo that no longer exists
        // on the server must not stay reusable in the LRU.
        void invalidateProtectedAsset(tripPhotoAssetKey(tripId, photoId, 'thumbnail'));
        void invalidateProtectedAsset(tripPhotoAssetKey(tripId, photoId, 'medium'));
      }
    },
    [scope, scopeTicket, tripId],
  );

  const removePhoto = markPhotoStale;

  const prependUploaded = useCallback((uploaded: TripPhoto[]) => {
    if (!scope.isCurrent(scopeTicket)) {
      return;
    }
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
  }, [scope, scopeTicket]);

  /**
   * The D18 branch, shared by every tile, the viewer, delete and single save.
   *
   * A missing or unparseable `error_code` is not evidence of anything yet, so it
   * buys evidence first: one coalesced list request decides whether this is a
   * stale photo or a trip the user can no longer read.
   */
  const resolveAssetNotFound = useCallback(
    async (
      photoId: string,
      failure: PhotoFailure,
    ): Promise<AmbiguousNotFoundResolution> => {
      const entryTicket = scopeTicket;
      if (!scope.isCurrent(entryTicket)) {
        return 'unknown';
      }
      const notFoundScope = classifyNotFound(failure);
      if (notFoundScope === 'photo') {
        markPhotoStale(photoId);
        return 'photo';
      }
      if (notFoundScope === 'trip') {
        enterTripNotFound();
        return 'trip';
      }

      const evidence = await coalescedReconcile();
      if (!mountedRef.current || !scope.isCurrent(entryTicket)) {
        return 'unknown';
      }
      if (evidence === 'readable') {
        markPhotoStale(photoId);
        return 'photo';
      }
      if (evidence === 'unreadable') {
        enterTripNotFound();
        return 'trip';
      }
      return 'unknown';
    },
    [coalescedReconcile, enterTripNotFound, markPhotoStale, scope, scopeTicket],
  );

  const handleAssetNotFound = useCallback(
    (photoId: string, failure: PhotoFailure) => {
      void resolveAssetNotFound(photoId, failure);
    },
    [resolveAssetNotFound],
  );

  useFocusEffect(
    useCallback(() => {
      if (
        !tripId ||
        tripInvalidatedRef.current ||
        !scope.isCurrent(scopeTicket)
      ) {
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
    }, [tripId, loadFirstPage, scope, scopeTicket]),
  );

  useAppForegroundEffect(
    useCallback(() => {
      if (
        !tripId ||
        tripInvalidatedRef.current ||
        !hasLoadedOnceRef.current ||
        !scope.isCurrent(scopeTicket)
      ) {
        return;
      }
      if (firstPageInFlightRef.current) {
        return;
      }
      void loadFirstPage('silent');
    }, [tripId, loadFirstPage, scope, scopeTicket]),
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
    tombstonedPhotoIds: stateMatchesTrip ? tombstonedPhotoIds : new Set<string>(),
    isPhotoTombstoned,
    subscribePhotoTombstones,
    tripNotFound: stateMatchesTrip ? tripNotFound : false,
    loadFirstPage,
    loadMore,
    retryLoadMore,
    reconcile,
    prependUploaded,
    removePhoto,
    markPhotoStale,
    resolveAssetNotFound,
    handleAssetNotFound,
  };
}
