/**
 * Selection mode and the bulk ZIP hand-off.
 *
 * The one subtle rule is what counts as evidence for dropping an id. A photo
 * missing from a first-page refresh is not gone — it may simply be on page
 * three. Only an authoritative answer about that specific id removes it, and a
 * bulk 404 removes nothing at all, because the server refuses the whole archive
 * without saying which id was stale (D17).
 */

import { useCallback, useRef, useState } from 'react';
import { PHOTO_BULK_DOWNLOAD_MAX_SELECTION } from '../constants';
import { downloadAndShareTripPhotoArchive, type NativePhotoActions } from '../downloads';
import { PHOTO_ERROR_MESSAGES, type PhotoFailure } from '../errors';
import type { TripPhoto } from '../types';

export type SelectionDownloadState =
  | { status: 'idle' }
  | { status: 'downloading'; bytesWritten: number; totalBytes: number | null }
  | { status: 'message'; message: string }
  | { status: 'error'; failure: PhotoFailure };

export interface UsePhotoSelectionOptions {
  tripId: string;
  photos: TripPhoto[];
  reconcile: () => Promise<void>;
  onTripNotFound: (failure: PhotoFailure) => void;
  native?: NativePhotoActions;
}

export interface UsePhotoSelectionResult {
  selectionMode: boolean;
  selectedIds: string[];
  selectedCount: number;
  download: SelectionDownloadState;
  /** Bulk requests spent this session — the budget is 30/hour. */
  requestsUsed: number;
  enterSelection: (photoId: string) => void;
  toggle: (photoId: string) => void;
  isSelected: (photoId: string) => boolean;
  selectLoaded: () => void;
  clear: () => void;
  exit: () => void;
  startDownload: () => Promise<void>;
  cancelDownload: () => void;
  dismissMessage: () => void;
}

export function usePhotoSelection({
  tripId,
  photos,
  reconcile,
  onTripNotFound,
  native,
}: UsePhotoSelectionOptions): UsePhotoSelectionResult {
  const [selectionMode, setSelectionMode] = useState(false);
  // Held as a Set for membership checks, replaced immutably so React sees it.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [download, setDownload] = useState<SelectionDownloadState>({ status: 'idle' });
  const [requestsUsed, setRequestsUsed] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const downloadingRef = useRef(false);

  const exit = useCallback(() => {
    setSelectionMode(false);
    setSelected(new Set());
    setDownload({ status: 'idle' });
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const toggle = useCallback((photoId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(photoId)) {
        next.delete(photoId);
        return next;
      }
      if (next.size >= PHOTO_BULK_DOWNLOAD_MAX_SELECTION) {
        // Enforced before the request so the server never has to.
        return current;
      }
      next.add(photoId);
      return next;
    });
    setDownload((current) => (current.status === 'idle' ? current : { status: 'idle' }));
  }, []);

  const enterSelection = useCallback(
    (photoId: string) => {
      setSelectionMode(true);
      setSelected(new Set([photoId]));
      setDownload({ status: 'idle' });
    },
    [],
  );

  const isSelected = useCallback((photoId: string) => selected.has(photoId), [selected]);

  /**
   * Selects what is on screen, not what exists on the server. The label says
   * "Select loaded" while more pages remain, so nothing implies otherwise.
   */
  const selectLoaded = useCallback(() => {
    setSelected(new Set(photos.slice(0, PHOTO_BULK_DOWNLOAD_MAX_SELECTION).map((photo) => photo.id)));
  }, [photos]);

  const cancelDownload = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const dismissMessage = useCallback(() => {
    setDownload({ status: 'idle' });
  }, []);

  const startDownload = useCallback(async () => {
    const photoIds = Array.from(selected);
    if (photoIds.length === 0 || downloadingRef.current) {
      return;
    }

    downloadingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setDownload({ status: 'downloading', bytesWritten: 0, totalBytes: null });
    setRequestsUsed((current) => current + 1);

    try {
      const outcome = await downloadAndShareTripPhotoArchive({
        tripId,
        photoIds,
        signal: controller.signal,
        ...(native ? { native } : {}),
        onProgress: (bytesWritten, totalBytes) =>
          setDownload({ status: 'downloading', bytesWritten, totalBytes }),
      });

      if (outcome.status === 'shared') {
        // `shareAsync` resolving only means the sheet closed. Whether the user
        // shared or cancelled is not knowable, so there is no success message
        // and the selection stays for a second attempt.
        setDownload({ status: 'idle' });
        return;
      }

      if (outcome.status === 'cancelled') {
        setDownload({ status: 'idle' });
        return;
      }

      if (outcome.status === 'unavailable') {
        setDownload({
          status: 'error',
          failure: { kind: 'request', message: 'Sharing is not available on this device.' },
        });
        return;
      }

      if (outcome.status === 'staleSelection') {
        // Reconcile for a fresh grid, then clear everything and ask the user to
        // choose again. Intersecting with the first page would delete valid ids
        // from deeper pages, and intersecting with stale local pages would keep
        // the very ids that caused this.
        setDownload({ status: 'message', message: PHOTO_ERROR_MESSAGES.bulkStale });
        try {
          await reconcile();
        } finally {
          setSelected(new Set());
          setSelectionMode(false);
        }
        return;
      }

      if (outcome.failure.kind === 'notFound') {
        onTripNotFound(outcome.failure);
        setSelected(new Set());
        setSelectionMode(false);
        setDownload({ status: 'idle' });
        return;
      }

      // Everything else keeps the selection so the user can retry deliberately.
      setDownload({ status: 'error', failure: outcome.failure });
    } finally {
      downloadingRef.current = false;
      controllerRef.current = null;
    }
  }, [selected, tripId, native, reconcile, onTripNotFound]);

  return {
    selectionMode,
    selectedIds: Array.from(selected),
    selectedCount: selected.size,
    download,
    requestsUsed,
    enterSelection,
    toggle,
    isSelected,
    selectLoaded,
    clear,
    exit,
    startDownload,
    cancelDownload,
    dismissMessage,
  };
}
