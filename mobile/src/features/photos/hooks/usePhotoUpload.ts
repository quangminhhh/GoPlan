/**
 * Wires the upload state machine to React and to the real native modules.
 *
 * The machine itself lives in `uploadSession` and knows nothing about either, so
 * this hook is the only place the two meet.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { nativeImageCodec } from '@/shared/media/imageCodec';
import { pickImages } from '@/shared/media/pickImage';
import { preprocessImage } from '@/shared/media/preprocessImage';
import {
  acquirePrivateTransferLease,
  trackPrivateRequest,
} from '@/shared/media/privateMediaLifecycle';
import {
  adoptUploadTempFile,
  discardUploadTempFile,
  uploadTempAvailableBytes,
} from '@/shared/media/uploadTempStore';
import { uploadTripPhotoBatch } from '../api';
import {
  createUploadSession,
  type UploadSessionController,
  type UploadSnapshot,
} from '../uploadSession';
import {
  isCancelledFailure,
  toPhotoFailure,
  type PhotoFailure,
} from '../errors';
import type { TripPhoto } from '../types';

export interface UsePhotoUploadOptions {
  tripId: string;
  onUploaded: (photos: TripPhoto[]) => void;
  onReconcile: () => void;
  onTripNotFound: () => void;
}

export interface UsePhotoUploadResult {
  snapshot: UploadSnapshot | null;
  /** True while the sheet should be on screen. */
  isOpen: boolean;
  picking: boolean;
  pickFailure: PhotoFailure | null;
  pick: () => Promise<void>;
  dismissPickFailure: () => void;
  start: () => void;
  stop: () => void;
  close: () => Promise<void>;
}

export function usePhotoUpload({
  tripId,
  onUploaded,
  onReconcile,
  onTripNotFound,
}: UsePhotoUploadOptions): UsePhotoUploadResult {
  const [snapshot, setSnapshot] = useState<UploadSnapshot | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickFailure, setPickFailure] = useState<PhotoFailure | null>(null);
  const sessionRef = useRef<UploadSessionController | null>(null);
  const mountedRef = useRef(true);
  /** Guards a double tap on Start from running the pipeline twice. */
  const runningRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void sessionRef.current?.cancel().catch(() => undefined);
    };
  }, []);

  const publish = useCallback((next: UploadSnapshot) => {
    if (mountedRef.current) {
      setSnapshot(next);
    }
  }, []);

  const pick = useCallback(async () => {
    if (picking || runningRef.current) {
      return;
    }
    setPicking(true);
    setPickFailure(null);
    try {
      const outcome = await pickImages();
      if (!mountedRef.current || outcome.status === 'cancelled') {
        return;
      }

      const session = createUploadSession(
        { images: outcome.images, unreadable: outcome.unreadable },
        {
          preprocess: (image, target) => preprocessImage(image, target, nativeImageCodec),
          adopt: (input) => adoptUploadTempFile(input),
          discardTemp: (uri) => discardUploadTempFile(uri),
          discardEncoderOutput: (uri) => nativeImageCodec.discard(uri),
          uploadBatch: (files, onProgress, signal) =>
            uploadTripPhotoBatch(
              tripId,
              files.map((file) => ({ uri: file.uri, name: file.name, type: file.type })),
              {
                signal,
                onUploadProgress: (event) => onProgress(event.loaded, event.total ?? null),
              },
            ),
          availableBytes: () => uploadTempAvailableBytes(),
          acquireLease: acquirePrivateTransferLease,
          onSnapshot: publish,
          onUploaded,
          onReconcile,
          onTripNotFound,
        },
      );
      sessionRef.current = session;
      publish(session.snapshot());
    } catch (caught) {
      if (mountedRef.current) {
        setPickFailure(toPhotoFailure(caught));
      }
    } finally {
      if (mountedRef.current) {
        setPicking(false);
      }
    }
  }, [picking, publish, tripId, onUploaded, onReconcile, onTripNotFound]);

  /** Also serves Resume: the machine picks up where its cursor left off. */
  const start = useCallback(() => {
    const session = sessionRef.current;
    if (!session || runningRef.current) {
      return;
    }
    runningRef.current = true;
    void trackPrivateRequest(undefined, (signal) => session.start(signal))
      .catch((caught) => {
        if (isCancelledFailure(toPhotoFailure(caught))) {
          // Foreground intent and the lifecycle gate settle asynchronously. A
          // fast Resume tap can arrive while cleanup still owns the gate; that
          // is retryable and must not terminal-cancel the upload session.
          return;
        }
        return session.cancel().catch(() => undefined);
      })
      .finally(() => {
        runningRef.current = false;
      });
  }, []);

  const stop = useCallback(() => {
    sessionRef.current?.requestStop();
  }, []);

  const dismissPickFailure = useCallback(() => {
    setPickFailure(null);
  }, []);

  const close = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    try {
      await session?.cancel();
    } finally {
      if (mountedRef.current) {
        setSnapshot(null);
      }
    }
  }, []);

  /**
   * Backgrounding never starts new work. The operation already in flight is
   * allowed to settle and the session then waits for an explicit Resume, so an
   * upload cannot continue — or silently finish — while the user is elsewhere.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background') {
        sessionRef.current?.requestPause();
      }
    });
    return () => subscription.remove();
  }, []);

  return {
    snapshot,
    isOpen: snapshot !== null,
    picking,
    pickFailure,
    pick,
    dismissPickFailure,
    start,
    stop,
    close,
  };
}
