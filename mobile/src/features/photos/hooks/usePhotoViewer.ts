/**
 * Viewer state: which photo is open, deleting it, and saving it.
 *
 * The index is derived from the photo id rather than stored as a position.
 * Deleting a photo, or a page arriving underneath, shifts every position — an
 * index kept as a number would silently start pointing at a different photo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteTripPhoto } from '../api';
import { saveTripPhotoToLibrary, type NativePhotoActions, type SavePhotoOutcome } from '../downloads';
import {
  classifyNotFound,
  isCancelledFailure,
  isUncertainOutcome,
  PHOTO_ERROR_MESSAGES,
  toPhotoFailure,
  type PhotoFailure,
} from '../errors';
import type { TripPhoto } from '../types';

/** Load the next page once the viewer is this close to the end of what is loaded. */
export const VIEWER_PREFETCH_THRESHOLD = 3;

export type ViewerActionState =
  | { status: 'idle' }
  | { status: 'deleting' }
  | { status: 'saving'; bytesWritten: number }
  | { status: 'message'; message: string }
  | { status: 'error'; failure: PhotoFailure };

export interface UsePhotoViewerOptions {
  tripId: string;
  photos: TripPhoto[];
  hasNextPage: boolean;
  loadMore: () => void;
  /** Reconciles the grid when an outcome cannot be known from the response. */
  reconcile: () => Promise<void>;
  removePhoto: (photoId: string) => void;
  onAssetNotFound: (photoId: string, failure: PhotoFailure) => void;
  native?: NativePhotoActions;
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
  photos,
  hasNextPage,
  loadMore,
  reconcile,
  removePhoto,
  onAssetNotFound,
  native,
}: UsePhotoViewerOptions): UsePhotoViewerResult {
  const [requestedPhotoId, setOpenPhotoId] = useState<string | null>(null);
  const [action, setAction] = useState<ViewerActionState>({ status: 'idle' });
  /** Synchronous, so a double tap cannot start two mutations. */
  const mutatingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const currentIndex = useMemo(
    () => (requestedPhotoId === null ? -1 : photos.findIndex((photo) => photo.id === requestedPhotoId)),
    [requestedPhotoId, photos],
  );
  const currentPhoto = currentIndex >= 0 ? photos[currentIndex] : null;
  // Derived rather than reset from an effect: when the open photo disappears —
  // deleted elsewhere, or dropped by a reconcile — the viewer is closed as of
  // this render, with no extra pass showing a photo that is no longer there.
  const openPhotoId = currentPhoto ? requestedPhotoId : null;

  useEffect(() => {
    if (currentIndex < 0 || !hasNextPage) {
      return;
    }
    if (photos.length - currentIndex <= VIEWER_PREFETCH_THRESHOLD) {
      loadMore();
    }
  }, [currentIndex, photos.length, hasNextPage, loadMore]);

  const open = useCallback((photoId: string) => {
    setAction({ status: 'idle' });
    setOpenPhotoId(photoId);
  }, []);

  const close = useCallback(() => {
    setOpenPhotoId(null);
    setAction({ status: 'idle' });
  }, []);

  const goTo = useCallback((photoId: string) => {
    setAction({ status: 'idle' });
    setOpenPhotoId(photoId);
  }, []);

  /** Accessible Previous/Next, so VoiceOver does not depend on a swipe. */
  const goToOffset = useCallback(
    (offset: number) => {
      if (currentIndex < 0) {
        return;
      }
      const next = photos[currentIndex + offset];
      if (next) {
        setAction({ status: 'idle' });
        setOpenPhotoId(next.id);
      }
    },
    [currentIndex, photos],
  );

  const dismissAction = useCallback(() => {
    setAction({ status: 'idle' });
  }, []);

  const confirmDelete = useCallback(async () => {
    const photo = currentPhoto;
    if (!photo || mutatingRef.current) {
      return;
    }
    mutatingRef.current = true;
    setAction({ status: 'deleting' });

    try {
      await deleteTripPhoto(tripId, photo.id);
      removePhoto(photo.id);
      setOpenPhotoId(null);
      setAction({ status: 'message', message: 'Photo deleted.' });
    } catch (caught) {
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
        if (!mountedRef.current) {
          return;
        }
        setAction({ status: 'error', failure });
        return;
      }

      // 403 and 409 are authoritative: the server has decided, so its wording
      // stands and the item stays.
      setAction({ status: 'error', failure });
    } finally {
      mutatingRef.current = false;
    }
  }, [currentPhoto, tripId, removePhoto, reconcile, onAssetNotFound]);

  const save = useCallback(async () => {
    const photo = currentPhoto;
    if (!photo || mutatingRef.current) {
      return;
    }
    mutatingRef.current = true;
    setAction({ status: 'saving', bytesWritten: 0 });

    try {
      const outcome: SavePhotoOutcome = await saveTripPhotoToLibrary({
        tripId,
        photoId: photo.id,
        ...(native ? { native } : {}),
        onProgress: (bytesWritten) => {
          if (mountedRef.current) {
            setAction({ status: 'saving', bytesWritten });
          }
        },
      });

      if (!mountedRef.current) {
        return;
      }

      if (outcome.status === 'saved') {
        setAction({ status: 'message', message: 'Saved to Photos.' });
        return;
      }

      if (outcome.status === 'permissionDenied') {
        setAction({
          status: 'message',
          message: outcome.canAskAgain
            ? 'GoPlan needs permission to add photos to your library.'
            : 'Allow photo access for GoPlan in Settings to save photos.',
        });
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
    } finally {
      mutatingRef.current = false;
    }
  }, [currentPhoto, tripId, native, onAssetNotFound]);

  return {
    openPhotoId,
    currentIndex,
    currentPhoto,
    action,
    open,
    close,
    goTo,
    goToOffset,
    confirmDelete,
    save,
    dismissAction,
  };
}
