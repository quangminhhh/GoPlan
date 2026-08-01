/**
 * Viewer state: which photo is open, deleting it, and saving it.
 *
 * The index is derived from the photo id rather than stored as a position.
 * Deleting a photo, or a page arriving underneath, shifts every position — an
 * index kept as a number would silently start pointing at a different photo.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { deleteTripPhoto } from '../api';
import { saveTripPhotoToLibrary, type SavePhotoOutcome } from '../photoSave';
import type { PhotoLibraryAdapter } from '../photoSaveTypes';
import {
  classifyNotFound,
  isCancelledFailure,
  isUncertainOutcome,
  PHOTO_ERROR_MESSAGES,
  toPhotoFailure,
  type PhotoFailure,
} from '../errors';
import type { TripPhoto } from '../types';
import type { TripPhotoScope } from './useTripPhotoScope';

/** Load the next page once the viewer is this close to the end of what is loaded. */
export const VIEWER_PREFETCH_THRESHOLD = 3;

interface ViewerOperationBarrier {
  readonly operation: number;
  readonly promise: Promise<void>;
  resolve(): void;
}

function createViewerOperationBarrier(operation: number): ViewerOperationBarrier {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    operation,
    promise,
    resolve: () => {
      resolvePromise?.();
      resolvePromise = null;
    },
  };
}

export type ViewerActionState =
  | { status: 'idle' }
  | { status: 'deleting' }
  | { status: 'saving'; bytesWritten: number }
  | { status: 'permissionDenied'; canAskAgain: boolean }
  | { status: 'message'; message: string }
  | { status: 'error'; failure: PhotoFailure };

export interface UsePhotoViewerOptions {
  tripId: string;
  scope: TripPhotoScope;
  photos: TripPhoto[];
  hasNextPage: boolean;
  loadMore: () => void;
  /** Reconciles the grid when an outcome cannot be known from the response. */
  reconcile: () => Promise<void>;
  removePhoto: (photoId: string) => void;
  /** Reads the authoritative ref before React collection state can commit. */
  isPhotoTombstoned: (photoId: string) => boolean;
  onAssetNotFound: (photoId: string, failure: PhotoFailure) => void;
  onTripUnavailable: (failure: PhotoFailure) => void;
  resolveAmbiguousNotFound: (
    photoId: string,
    failure: PhotoFailure,
  ) => Promise<'photo' | 'trip' | 'unknown'>;
  library?: PhotoLibraryAdapter;
}

export interface UsePhotoViewerResult {
  openPhotoId: string | null;
  currentIndex: number;
  currentPhoto: TripPhoto | null;
  action: ViewerActionState;
  open: (photoId: string) => void;
  close: () => void;
  goTo: (photoId: string) => void;
  goToOffset: (offset: number) => void;
  confirmDelete: () => Promise<void>;
  save: () => Promise<void>;
  dismissAction: () => void;
}

export function usePhotoViewer({
  tripId,
  scope,
  photos,
  hasNextPage,
  loadMore,
  reconcile,
  removePhoto,
  isPhotoTombstoned,
  onAssetNotFound,
  onTripUnavailable,
  resolveAmbiguousNotFound,
  library,
}: UsePhotoViewerOptions): UsePhotoViewerResult {
  const scopeTicket = scope.capture();
  const [stateTripId, setStateTripId] = useState(tripId);
  const [requestedPhotoId, setOpenPhotoId] = useState<string | null>(null);
  const [action, setAction] = useState<ViewerActionState>({ status: 'idle' });
  /** Synchronous, so a double tap cannot start two mutations. */
  const mutatingRef = useRef(false);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const operationBarrierRef = useRef<ViewerOperationBarrier | null>(null);
  const availablePhotoIdsRef = useRef<ReadonlySet<string>>(
    new Set(photos.map((photo) => photo.id)),
  );

  if (stateTripId !== tripId) {
    setOpenPhotoId(null);
    setAction({ status: 'idle' });
    setStateTripId(tripId);
  }

  useLayoutEffect(() => {
    // The save primitive reads this gate after every pre-native await. Keep the
    // authoritative committed collection in a ref so a removal that lands
    // while permission/download is pending wins before PhotoKit handoff.
    availablePhotoIdsRef.current = new Set(photos.map((photo) => photo.id));
  }, [photos]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      mutatingRef.current = false;
    };
  }, []);

  useEffect(
    () =>
      scope.subscribeInvalidation(() => {
        const cleanup = operationBarrierRef.current?.promise;
        operationRef.current += 1;
        controllerRef.current?.abort();
        controllerRef.current = null;
        mutatingRef.current = false;
        return cleanup;
      }),
    [scope],
  );

  const currentIndex = useMemo(
    () => (requestedPhotoId === null ? -1 : photos.findIndex((photo) => photo.id === requestedPhotoId)),
    [requestedPhotoId, photos],
  );
  if (stateTripId === tripId && requestedPhotoId !== null && currentIndex < 0) {
    // Clear the intent itself during the guarded render restart. Otherwise a
    // removed id can reopen later when pagination or an upload reintroduces it.
    setOpenPhotoId(null);
  }
  const currentPhoto = currentIndex >= 0 ? photos[currentIndex] : null;
  // Derived rather than reset from an effect: when the open photo disappears —
  // deleted elsewhere, or dropped by a reconcile — the viewer is closed as of
  // this render, with no extra pass showing a photo that is no longer there.
  const openPhotoId = currentPhoto ? requestedPhotoId : null;

  useEffect(() => {
    if (
      currentIndex < 0 ||
      !hasNextPage ||
      !scope.isCurrent(scopeTicket)
    ) {
      return;
    }
    if (photos.length - currentIndex <= VIEWER_PREFETCH_THRESHOLD) {
      loadMore();
    }
  }, [currentIndex, photos.length, hasNextPage, loadMore, scope, scopeTicket]);

  const open = useCallback((photoId: string) => {
    if (!scope.isCurrent(scopeTicket)) return;
    setAction({ status: 'idle' });
    setOpenPhotoId(photoId);
  }, [scope, scopeTicket]);

  const close = useCallback(() => {
    if (!scope.isCurrent(scopeTicket)) return;
    setOpenPhotoId(null);
    setAction({ status: 'idle' });
  }, [scope, scopeTicket]);

  const goTo = useCallback((photoId: string) => {
    if (!scope.isCurrent(scopeTicket)) return;
    setAction({ status: 'idle' });
    setOpenPhotoId(photoId);
  }, [scope, scopeTicket]);

  /** Accessible Previous/Next, so VoiceOver does not depend on a swipe. */
  const goToOffset = useCallback(
    (offset: number) => {
      if (currentIndex < 0 || !scope.isCurrent(scopeTicket)) {
        return;
      }
      const next = photos[currentIndex + offset];
      if (next) {
        setAction({ status: 'idle' });
        setOpenPhotoId(next.id);
      }
    },
    [currentIndex, photos, scope, scopeTicket],
  );

  const dismissAction = useCallback(() => {
    if (!scope.isCurrent(scopeTicket)) return;
    setAction({ status: 'idle' });
  }, [scope, scopeTicket]);

  const confirmDelete = useCallback(async () => {
    const photo = currentPhoto;
    const ownerTicket = scopeTicket;
    if (!photo || mutatingRef.current || !scope.isCurrent(ownerTicket)) {
      return;
    }
    mutatingRef.current = true;
    operationRef.current += 1;
    const operation = operationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = (): boolean =>
      mountedRef.current &&
      operation === operationRef.current &&
      scope.isCurrent(ownerTicket);
    setAction({ status: 'deleting' });

    try {
      await deleteTripPhoto(tripId, photo.id, controller.signal);
      if (!isCurrent()) return;
      removePhoto(photo.id);
      setOpenPhotoId(null);
      setAction({ status: 'message', message: 'Photo deleted.' });
    } catch (caught) {
      if (!isCurrent()) return;
      const failure = toPhotoFailure(caught);

      if (isCancelledFailure(failure)) {
        setAction({ status: 'idle' });
        return;
      }

      if (failure.kind === 'notFound') {
        const scope = classifyNotFound(failure);
        if (scope === 'photo') {
          // Already gone. Remove and close, but do not announce a deletion this
          // request did not perform.
          removePhoto(photo.id);
          setOpenPhotoId(null);
          setAction({ status: 'idle' });
          return;
        }
        onAssetNotFound(photo.id, failure);
        setOpenPhotoId(null);
        setAction({ status: 'idle' });
        return;
      }

      if (isUncertainOutcome(failure)) {
        // The delete may or may not have happened. Ask the server rather than
        // guessing, and never show a success message on the strength of a
        // connection error.
        await reconcile();
        if (!isCurrent()) {
          return;
        }
        setAction({ status: 'error', failure });
        return;
      }

      // 403 and 409 are authoritative: the server has decided, so its wording
      // stands and the item stays.
      setAction({ status: 'error', failure });
    } finally {
      if (operation === operationRef.current) {
        mutatingRef.current = false;
        controllerRef.current = null;
      }
    }
  }, [
    currentPhoto,
    tripId,
    removePhoto,
    reconcile,
    onAssetNotFound,
    scope,
    scopeTicket,
  ]);

  const save = useCallback(async () => {
    const photo = currentPhoto;
    const ownerTicket = scopeTicket;
    if (!photo || mutatingRef.current || !scope.isCurrent(ownerTicket)) {
      return;
    }
    mutatingRef.current = true;
    operationRef.current += 1;
    const operation = operationRef.current;
    const isCurrent = (): boolean =>
      mountedRef.current &&
      operation === operationRef.current &&
      scope.isCurrent(ownerTicket);

    // Do not publish this operation as cleanup while it is itself waiting for
    // the previous scope tail; doing so would make an A→B invalidation append a
    // promise that waits on itself. Capture first, await, then re-check before
    // atomically installing the new operation barrier.
    try {
      await scope.waitForCleanup();
    } catch {
      // Scope cleanup callbacks are best effort. Ticket ownership below is the
      // authoritative gate even if an injected cleanup tail rejects.
    }
    if (
      !isCurrent() ||
      isPhotoTombstoned(photo.id) ||
      !availablePhotoIdsRef.current.has(photo.id)
    ) {
      if (operation === operationRef.current) mutatingRef.current = false;
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    const operationBarrier = createViewerOperationBarrier(operation);
    operationBarrierRef.current = operationBarrier;
    const gate = {
      // Availability is deliberately separate from operation ownership. Once
      // createAsset has been invoked the native result must remain
      // committed/unknown even if this photo is removed in the meantime.
      isOpen: isCurrent,
      isTombstoned: (photoId: string): boolean =>
        photoId === photo.id &&
        (isPhotoTombstoned(photoId) || !availablePhotoIdsRef.current.has(photoId)),
      interruption: () =>
        scope.isCurrent(ownerTicket) ? ('cancelled' as const) : ('tripChanged' as const),
    };
    setAction({ status: 'saving', bytesWritten: 0 });

    try {
      const outcome: SavePhotoOutcome = await saveTripPhotoToLibrary({
        tripId,
        photoId: photo.id,
        tripScope: scope,
        signal: controller.signal,
        gate,
        ...(library ? { library } : {}),
        onProgress: (bytesWritten) => {
          if (isCurrent()) setAction({ status: 'saving', bytesWritten });
        },
        onTombstone: (photoId) => {
          if (isCurrent()) removePhoto(photoId);
        },
        onTripUnavailable: (failure) => {
          if (isCurrent()) onTripUnavailable(failure);
        },
        resolveAmbiguousNotFound,
      });

      if (!isCurrent()) {
        return;
      }

      if (outcome.status === 'saved') {
        setAction({ status: 'message', message: 'Saved to Photos.' });
        return;
      }

      if (outcome.status === 'permissionDenied') {
        setAction({ status: 'permissionDenied', canAskAgain: outcome.canAskAgain });
        return;
      }

      if (outcome.status === 'busy' || outcome.status === 'cancelled') {
        setAction({ status: 'idle' });
        return;
      }

      if (outcome.status === 'unknown') {
        setAction({ status: 'error', failure: outcome.failure });
        return;
      }

      const { failure } = outcome;
      if (isCancelledFailure(failure)) {
        setAction({ status: 'idle' });
        return;
      }
      if (failure.kind === 'notFound') {
        onAssetNotFound(photo.id, failure);
        setOpenPhotoId(null);
        setAction({ status: 'idle' });
        return;
      }
      setAction({
        status: 'error',
        failure:
          failure.kind === 'throttled'
            ? { ...failure, message: PHOTO_ERROR_MESSAGES.downloadThrottled }
            : failure,
      });
    } catch (caught) {
      if (!isCurrent()) {
        return;
      }
      const failure = toPhotoFailure(caught);
      if (isCancelledFailure(failure)) {
        setAction({ status: 'idle' });
        return;
      }
      if (failure.kind === 'notFound') {
        onAssetNotFound(photo.id, failure);
        setOpenPhotoId(null);
        setAction({ status: 'idle' });
        return;
      }
      setAction({
        status: 'error',
        failure:
          failure.kind === 'throttled'
            ? { ...failure, message: PHOTO_ERROR_MESSAGES.downloadThrottled }
            : failure,
      });
    } finally {
      operationBarrier.resolve();
      if (operationBarrierRef.current === operationBarrier) {
        operationBarrierRef.current = null;
      }
      if (operation === operationRef.current) {
        mutatingRef.current = false;
        controllerRef.current = null;
      }
    }
  }, [
    currentPhoto,
    tripId,
    scope,
    scopeTicket,
    library,
    isPhotoTombstoned,
    removePhoto,
    resolveAmbiguousNotFound,
    onAssetNotFound,
    onTripUnavailable,
  ]);

  return {
    openPhotoId: stateTripId === tripId ? openPhotoId : null,
    currentIndex: stateTripId === tripId ? currentIndex : -1,
    currentPhoto: stateTripId === tripId ? currentPhoto : null,
    action: stateTripId === tripId ? action : { status: 'idle' },
    open,
    close,
    goTo,
    goToOffset,
    confirmDelete,
    save,
    dismissAction,
  };
}
