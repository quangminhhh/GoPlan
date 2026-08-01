/** Connects the upload state machine to React, auth/trip scope and native seams. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  captureAuthTicket,
  isAuthTicketCurrent,
  subscribeAuthLifecycle,
  type AuthTicket,
} from '@/shared/api/authSessionLifecycle';
import { nativeImageCodec } from '@/shared/media/imageCodec';
import { pickImages } from '@/shared/media/pickImage';
import {
  discardAppOwnedPickerSource,
  discardAppOwnedPickerSources,
} from '@/shared/media/pickerSourceStore';
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
import { isCancelledFailure, toPhotoFailure, type PhotoFailure } from '../errors';
import {
  createUploadSession,
  type UploadSessionController,
  type UploadSnapshot,
} from '../uploadSession';
import { uploadCleanupCoordinator } from '../uploadCleanupCoordinator';
import type { TripPhoto } from '../types';
import {
  type TripPhotoScope,
  type TripPhotoScopeTicket,
} from './useTripPhotoScope';

export interface UsePhotoUploadOptions {
  tripId: string;
  /** One owner created by PhotosScreen and shared with every photo flow. */
  scope: TripPhotoScope;
  onUploaded: (photos: TripPhoto[]) => void;
  onReconcile: () => void;
  onTripNotFound: () => void;
}

export interface UsePhotoUploadResult {
  snapshot: UploadSnapshot | null;
  isOpen: boolean;
  picking: boolean;
  pickFailure: PhotoFailure | null;
  pick: () => Promise<void>;
  dismissPickFailure: () => void;
  start: () => void;
  stop: () => void;
  close: () => Promise<void>;
}

interface SessionOwner {
  session: UploadSessionController;
  scopeTicket: TripPhotoScopeTicket;
  authTicket: AuthTicket;
  workEpoch: number;
}

export function usePhotoUpload({
  tripId,
  scope: tripScope,
  onUploaded,
  onReconcile,
  onTripNotFound,
}: UsePhotoUploadOptions): UsePhotoUploadResult {
  const [snapshot, setSnapshot] = useState<UploadSnapshot | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickFailure, setPickFailure] = useState<PhotoFailure | null>(null);

  const mountedRef = useRef(true);
  const pickingRef = useRef(false);
  const runningRef = useRef(false);
  const workEpochRef = useRef(0);
  const pickOperationRef = useRef(0);
  const pickerWorkRef = useRef<Promise<void> | null>(null);
  const pendingAuthTicketRef = useRef<AuthTicket | null>(null);
  const ownerRef = useRef<SessionOwner | null>(null);

  const ownerIsCurrent = useCallback(
    (owner: SessionOwner): boolean =>
      mountedRef.current &&
      ownerRef.current === owner &&
      owner.workEpoch === workEpochRef.current &&
      tripScope.isCurrent(owner.scopeTicket) &&
      isAuthTicketCurrent(owner.authTicket),
    [tripScope],
  );

  /**
   * Synchronous front half: invalidate callbacks and abort the session before
   * yielding. The returned tail retains the A lock through picker/source/temp
   * cleanup so Trip/Session B cannot overlap it.
   */
  const invalidateOwnedWork = useCallback((): Promise<void> => {
    workEpochRef.current += 1;
    const owner = ownerRef.current;
    const pickerWork = pickerWorkRef.current;
    const cancelling = owner?.session.cancel() ?? Promise.resolve();

    if (mountedRef.current) {
      setSnapshot(null);
    }

    // Publication is synchronous. A different hook instance (including one
    // mounted for Session B) sees this tail before it can open another picker
    // or construct a session.
    const releaseOwnership = Promise.allSettled([pickerWork, cancelling]).then(() => {
      if (owner && ownerRef.current === owner) {
        ownerRef.current = null;
      }
    });
    return uploadCleanupCoordinator.publish([releaseOwnership]);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void invalidateOwnedWork();
    };
  }, [invalidateOwnedWork]);

  useEffect(
    () =>
      tripScope.subscribeInvalidation(() => {
        return invalidateOwnedWork();
      }),
    [invalidateOwnedWork, tripScope],
  );

  useEffect(() => {
    const closeIfStale = (): void => {
      const pendingTicket = pendingAuthTicketRef.current;
      const owner = ownerRef.current;
      if (
        (pendingTicket && !isAuthTicketCurrent(pendingTicket)) ||
        (owner && !isAuthTicketCurrent(owner.authTicket))
      ) {
        void invalidateOwnedWork();
      }
    };

    const unsubscribe = subscribeAuthLifecycle(closeIfStale);
    // A close may have happened between render and effect subscription.
    closeIfStale();
    return unsubscribe;
  }, [invalidateOwnedWork]);

  const pick = useCallback(async () => {
    if (pickingRef.current || runningRef.current || ownerRef.current) return;

    const scopeTicket = tripScope.capture();
    const authTicket = captureAuthTicket();
    if (!authTicket) return;

    pickingRef.current = true;
    pendingAuthTicketRef.current = authTicket;
    pickOperationRef.current += 1;
    const operation = pickOperationRef.current;
    const operationEpoch = workEpochRef.current;
    if (mountedRef.current) {
      setPicking(true);
      setPickFailure(null);
    }

    const entryIsCurrent = (): boolean =>
      mountedRef.current &&
      operationEpoch === workEpochRef.current &&
      scopeTicket.tripId === tripId &&
      tripScope.isCurrent(scopeTicket) &&
      isAuthTicketCurrent(authTicket);

    try {
      // A B-entry waits for every A cleanup already published. These waits run
      // before pickerWorkRef is installed, preventing a scope listener from
      // waiting on a picker task that is itself waiting on the scope tail.
      await uploadCleanupCoordinator.waitForCleanup();
      if (!entryIsCurrent()) return;
      await tripScope.waitForCleanup();
      if (!entryIsCurrent() || ownerRef.current) return;

      let handedToSession = false;
      const pickerWork = (async () => {
        const outcome = await pickImages();
        if (outcome.status === 'cancelled') return;

        try {
          if (!entryIsCurrent() || ownerRef.current) return;

          let owner: SessionOwner | null = null;
          const session = createUploadSession(
            { entries: outcome.entries },
            {
              preprocess: (image, target) => preprocessImage(image, target, nativeImageCodec),
              adopt: adoptUploadTempFile,
              discardTemp: discardUploadTempFile,
              discardEncoderOutput: (uri) => nativeImageCodec.discard(uri),
              discardSource: discardAppOwnedPickerSource,
              uploadBatch: (files, onProgress, signal) =>
                uploadTripPhotoBatch(
                  scopeTicket.tripId,
                  files.map((file) => ({
                    uri: file.uri,
                    name: file.name,
                    type: file.type,
                  })),
                  {
                    signal,
                    onUploadProgress: (event) =>
                      onProgress(event.loaded, event.total ?? null),
                  },
                ),
              availableBytes: uploadTempAvailableBytes,
              acquireLease: acquirePrivateTransferLease,
              onSnapshot: (next) => {
                if (owner && ownerIsCurrent(owner)) setSnapshot(next);
              },
              onUploaded: (photos) => {
                if (owner && ownerIsCurrent(owner)) onUploaded(photos);
              },
              onReconcile: () => {
                if (owner && ownerIsCurrent(owner)) onReconcile();
              },
              onTripNotFound: () => {
                if (owner && ownerIsCurrent(owner)) onTripNotFound();
              },
            },
          );
          // Construction is the atomic ownership handoff. From this point only
          // the session may delete picker sources, even if the scope turns stale
          // before React adopts the controller.
          handedToSession = true;
          owner = {
            session,
            scopeTicket,
            authTicket,
            workEpoch: operationEpoch,
          };

          if (!entryIsCurrent() || ownerRef.current) {
            await session.cancel();
            return;
          }
          ownerRef.current = owner;
          if (ownerIsCurrent(owner)) setSnapshot(session.snapshot());
        } finally {
          if (!handedToSession) {
            await discardAppOwnedPickerSources(
              outcome.entries.map((entry) => entry.ownedSourceUri),
            );
          }
        }
      })();

      pickerWorkRef.current = pickerWork;
      await pickerWork;
    } catch (caught) {
      if (entryIsCurrent()) setPickFailure(toPhotoFailure(caught));
    } finally {
      if (pickerWorkRef.current) pickerWorkRef.current = null;
      if (pendingAuthTicketRef.current === authTicket) {
        pendingAuthTicketRef.current = null;
      }
      if (pickOperationRef.current === operation) {
        pickingRef.current = false;
        if (mountedRef.current) setPicking(false);
      }
    }
  }, [tripId, tripScope, ownerIsCurrent, onUploaded, onReconcile, onTripNotFound]);

  const start = useCallback(() => {
    const owner = ownerRef.current;
    if (!owner || runningRef.current || !ownerIsCurrent(owner)) return;

    runningRef.current = true;
    void trackPrivateRequest(undefined, (signal) => owner.session.start(signal))
      .catch((caught) => {
        if (isCancelledFailure(toPhotoFailure(caught))) {
          // Background/lifecycle gate closure is resumable; the AppState or auth
          // subscriber owns the corresponding pause/terminal intent.
          return;
        }
        return owner.session.cancel().catch(() => undefined);
      })
      .finally(() => {
        runningRef.current = false;
      });
  }, [ownerIsCurrent]);

  const stop = useCallback(() => {
    ownerRef.current?.session.requestStop();
  }, []);

  const close = useCallback(async () => {
    await invalidateOwnedWork();
  }, [invalidateOwnedWork]);

  const dismissPickFailure = useCallback(() => {
    setPickFailure(null);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background') ownerRef.current?.session.requestPause();
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
