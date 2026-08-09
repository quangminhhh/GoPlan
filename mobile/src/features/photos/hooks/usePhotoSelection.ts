/** React ownership for the sequential selected-photo Save to Photos session. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  photoSaveTempCoordinator,
  type PhotoSaveTempCoordinator,
} from '@/shared/media/photoSaveTempStore';
import type { ProtectedTransport } from '@/shared/media/protectedAssetTypes';
import { PHOTO_SAVE_SELECTION_MAX } from '../constants';
import {
  arePhotoSaveTicketsCurrent,
  capturePhotoSaveTickets,
  photoSaveActionLock,
} from '../photoSave';
import {
  createSelectedPhotoSaveSession,
  type CreateSelectedPhotoSaveSessionOptions,
  type SelectedPhotoSaveSession,
  type SelectedSaveSnapshot,
} from '../selectedPhotoSaveSession';
import type {
  PhotoLibraryAdapter,
  PhotoSaveActionLock,
  PhotoSaveCapturedTickets,
} from '../photoSaveTypes';
import type { TripPhoto } from '../types';
import type { TripPhotoScope } from './useTripPhotoScope';

export interface SelectionSaveFeedback {
  kind: 'message' | 'error';
  message: string;
}

export interface UsePhotoSelectionOptions {
  tripId: string;
  photos: TripPhoto[];
  tombstonedPhotoIds: ReadonlySet<string>;
  isPhotoTombstoned: (photoId: string) => boolean;
  subscribePhotoTombstones: (listener: (photoId: string) => void) => () => void;
  scope: TripPhotoScope;
  onTombstone: (photoId: string) => void;
  onTripUnavailable: (failure: Parameters<
    NonNullable<CreateSelectedPhotoSaveSessionOptions['onTripUnavailable']>
  >[0]) => void;
  resolveAmbiguousNotFound: NonNullable<
    CreateSelectedPhotoSaveSessionOptions['resolveAmbiguousNotFound']
  >;
  library?: PhotoLibraryAdapter;
  transport?: ProtectedTransport;
  coordinator?: PhotoSaveTempCoordinator;
  actionLock?: PhotoSaveActionLock;
  captureTickets?: typeof capturePhotoSaveTickets;
  ticketsAreCurrent?: typeof arePhotoSaveTicketsCurrent;
  createSession?: typeof createSelectedPhotoSaveSession;
}

export interface UsePhotoSelectionResult {
  selectionMode: boolean;
  selectedIds: string[];
  selectedCount: number;
  saveSnapshot: SelectedSaveSnapshot | null;
  feedback: SelectionSaveFeedback | null;
  enterSelectionMode: () => void;
  enterSelection: (photoId: string) => void;
  toggle: (photoId: string) => void;
  isSelected: (photoId: string) => boolean;
  selectLoaded: () => void;
  clear: () => void;
  exit: () => void;
  startSave: () => Promise<void>;
  cancelSave: () => void;
  dismissFeedback: () => void;
}

function isMutationLocked(snapshot: SelectedSaveSnapshot | null): boolean {
  return (
    snapshot !== null &&
    (snapshot.phase === 'requestingPermission' ||
      snapshot.phase === 'running' ||
      snapshot.phase === 'stopping')
  );
}

function pendingSnapshot(photoIds: readonly string[]): SelectedSaveSnapshot {
  return {
    phase: 'running',
    stage: 'preparing',
    total: photoIds.length,
    currentOrdinal: photoIds.length > 0 ? 1 : null,
    counts: {
      committed: 0,
      terminalSkipped: 0,
      retryableFailed: 0,
      unknown: 0,
      unattempted: photoIds.length,
    },
    ledger: photoIds.map((photoId) => ({ photoId, status: 'unattempted' })),
    failure: null,
    permissionDenied: null,
  };
}

function actionableIds(snapshot: SelectedSaveSnapshot): string[] {
  return snapshot.ledger
    .filter(
      (entry) => entry.status === 'retryableFailed' || entry.status === 'unattempted',
    )
    .map((entry) => entry.photoId);
}

function resultFeedback(snapshot: SelectedSaveSnapshot): SelectionSaveFeedback {
  const { counts } = snapshot;
  const summary = [
    counts.committed > 0 ? `${counts.committed} saved` : null,
    counts.terminalSkipped > 0 ? `${counts.terminalSkipped} unavailable` : null,
    counts.retryableFailed > 0 ? `${counts.retryableFailed} failed` : null,
    counts.unknown > 0 ? `${counts.unknown} unknown` : null,
    counts.unattempted > 0 ? `${counts.unattempted} not saved` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  if (snapshot.permissionDenied) {
    return {
      kind: 'error',
      message: snapshot.permissionDenied.canAskAgain
        ? 'GoPlan needs permission to add photos to your library.'
        : 'Allow photo access for GoPlan in Settings to save photos.',
    };
  }
  if (counts.unknown > 0) {
    return {
      kind: 'error',
      message: `${summary}. ${counts.unknown} ${counts.unknown === 1 ? 'photo may' : 'photos may'} already be saved. Check Photos before trying again.`,
    };
  }
  if (counts.retryableFailed > 0) {
    return {
      kind: 'error',
      message: `${summary}. ${snapshot.failure?.message ?? 'Some photos could not be saved.'}`,
    };
  }
  if (snapshot.phase === 'paused') {
    return {
      kind: 'message',
      message: `Saving paused. ${summary}.`,
    };
  }
  if (counts.unattempted > 0) {
    return {
      kind: 'message',
      message: `Save stopped. ${summary}.`,
    };
  }
  if (counts.terminalSkipped > 0) {
    return {
      kind: 'message',
      message: `${summary}.`,
    };
  }
  return {
    kind: 'message',
    message: `Saved ${counts.committed} ${counts.committed === 1 ? 'photo' : 'photos'} to Photos.`,
  };
}

export function usePhotoSelection({
  tripId,
  photos,
  tombstonedPhotoIds,
  isPhotoTombstoned,
  subscribePhotoTombstones,
  scope,
  onTombstone,
  onTripUnavailable,
  resolveAmbiguousNotFound,
  library,
  transport,
  coordinator = photoSaveTempCoordinator,
  actionLock = photoSaveActionLock,
  captureTickets = capturePhotoSaveTickets,
  ticketsAreCurrent = arePhotoSaveTicketsCurrent,
  createSession = createSelectedPhotoSaveSession,
}: UsePhotoSelectionOptions): UsePhotoSelectionResult {
  const scopeTicket = scope.capture();
  const [stateTripId, setStateTripId] = useState(tripId);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [saveSnapshot, setSaveSnapshot] = useState<SelectedSaveSnapshot | null>(null);
  const [feedback, setFeedback] = useState<SelectionSaveFeedback | null>(null);
  const selectedRef = useRef<Set<string>>(new Set());
  const sessionRef = useRef<SelectedPhotoSaveSession | null>(null);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const pendingActionRef = useRef<{ epoch: number; release: () => void } | null>(null);
  const actionEpochRef = useRef(0);
  const mountedRef = useRef(true);

  if (stateTripId !== tripId) {
    setSelectionMode(false);
    setSelected(new Set());
    setSaveSnapshot(null);
    setFeedback(null);
    setStateTripId(tripId);
  }

  const replaceSelected = useCallback((next: Set<string>): void => {
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const clearPendingSnapshot = useCallback((): void => {
    setSaveSnapshot(null);
  }, []);

  const invalidatePendingAction = useCallback((): boolean => {
    actionEpochRef.current += 1;
    const pendingAction = pendingActionRef.current;
    pendingActionRef.current = null;
    pendingAction?.release();
    return pendingAction !== null;
  }, []);

  const applySynchronousTombstone = useCallback(
    (photoId: string): void => {
      if (!scope.isCurrent(scopeTicket)) return;

      // This runs in the producer's synchronous tombstone front half, before a
      // React render can deliver the updated Set. The session therefore aborts
      // queued/current pre-commit work in the same tick; native work that has
      // already started still keeps its committed/unknown precedence.
      sessionRef.current?.markUnavailable(photoId);
      if (!selectedRef.current.has(photoId)) return;

      const cancelledPending = invalidatePendingAction();
      if (cancelledPending) {
        startPromiseRef.current = null;
        queueMicrotask(() => {
          if (mountedRef.current && pendingActionRef.current === null) {
            clearPendingSnapshot();
          }
        });
      }

      const next = new Set(selectedRef.current);
      next.delete(photoId);
      replaceSelected(next);
      if (next.size === 0 && !sessionRef.current) {
        setSelectionMode(false);
        setFeedback({
          kind: 'message',
          message: '1 photo is no longer available.',
        });
      }
    },
    [
      clearPendingSnapshot,
      invalidatePendingAction,
      replaceSelected,
      scope,
      scopeTicket,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidatePendingAction();
      const session = sessionRef.current;
      sessionRef.current = null;
      void session?.close('cancelled');
    };
  }, [invalidatePendingAction]);

  useLayoutEffect(() => {
    selectedRef.current = new Set();
    startPromiseRef.current = null;
    invalidatePendingAction();
    const session = sessionRef.current;
    if (session && session.getSnapshot().ledger.some((entry) => entry.photoId)) {
      sessionRef.current = null;
      void session.close('tripChanged');
    }
  }, [invalidatePendingAction, tripId]);

  useLayoutEffect(
    () => subscribePhotoTombstones(applySynchronousTombstone),
    [applySynchronousTombstone, subscribePhotoTombstones],
  );

  useEffect(() => {
    const removed = Array.from(selectedRef.current).filter((photoId) =>
      tombstonedPhotoIds.has(photoId),
    );
    if (removed.length === 0) {
      return;
    }
    const cancelledPending = invalidatePendingAction();
    if (cancelledPending) {
      startPromiseRef.current = null;
      // The ownership fence must close synchronously; the derived presentation
      // can clear on the next microtask without causing a cascading effect
      // render. Guard it so a deliberate new Save tap cannot be erased.
      queueMicrotask(() => {
        if (mountedRef.current && pendingActionRef.current === null) {
          clearPendingSnapshot();
        }
      });
    }
    const next = new Set(selectedRef.current);
    for (const photoId of removed) {
      next.delete(photoId);
      sessionRef.current?.markUnavailable(photoId);
    }
    replaceSelected(next);
    if (next.size === 0 && !sessionRef.current) {
      setSelectionMode(false);
      setFeedback({
        kind: 'message',
        message: `${removed.length} ${removed.length === 1 ? 'photo is' : 'photos are'} no longer available.`,
      });
    }
  }, [clearPendingSnapshot, invalidatePendingAction, replaceSelected, tombstonedPhotoIds]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background') {
        if (invalidatePendingAction()) {
          startPromiseRef.current = null;
          setSaveSnapshot((current) =>
            current
              ? {
                  ...current,
                  phase: 'paused',
                  stage: null,
                  currentOrdinal: null,
                }
              : current,
          );
          setFeedback({ kind: 'message', message: 'Saving paused.' });
        }
        sessionRef.current?.pause();
      }
    });
    return () => subscription.remove();
  }, [invalidatePendingAction]);

  const selectionEntryIsOpen = useCallback(
    (): boolean =>
      scope.isCurrent(scopeTicket) &&
      !selectionMode &&
      !sessionRef.current &&
      !pendingActionRef.current &&
      !saveSnapshot,
    [saveSnapshot, scope, scopeTicket, selectionMode],
  );

  const enterSelectionMode = useCallback(() => {
    if (
      !selectionEntryIsOpen() ||
      !photos.some((photo) => !tombstonedPhotoIds.has(photo.id))
    ) {
      return;
    }
    setSelectionMode(true);
    replaceSelected(new Set());
    setSaveSnapshot(null);
    setFeedback(null);
  }, [photos, replaceSelected, selectionEntryIsOpen, tombstonedPhotoIds]);

  const enterSelection = useCallback(
    (photoId: string) => {
      if (!selectionEntryIsOpen() || tombstonedPhotoIds.has(photoId)) return;
      setSelectionMode(true);
      replaceSelected(new Set([photoId]));
      setSaveSnapshot(null);
      setFeedback(null);
    },
    [replaceSelected, selectionEntryIsOpen, tombstonedPhotoIds],
  );

  const toggle = useCallback(
    (photoId: string) => {
      if (
        sessionRef.current ||
        pendingActionRef.current ||
        saveSnapshot ||
        tombstonedPhotoIds.has(photoId)
      ) return;
      const next = new Set(selectedRef.current);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else if (next.size < PHOTO_SAVE_SELECTION_MAX) {
        next.add(photoId);
      }
      replaceSelected(next);
      setFeedback(null);
    },
    [replaceSelected, saveSnapshot, tombstonedPhotoIds],
  );

  const isSelected = useCallback((photoId: string) => selected.has(photoId), [selected]);

  const selectLoaded = useCallback(() => {
    if (sessionRef.current || pendingActionRef.current || saveSnapshot) return;
    const next = new Set(selectedRef.current);
    for (const photo of photos) {
      if (next.size >= PHOTO_SAVE_SELECTION_MAX) break;
      if (!tombstonedPhotoIds.has(photo.id)) next.add(photo.id);
    }
    replaceSelected(next);
  }, [photos, replaceSelected, saveSnapshot, tombstonedPhotoIds]);

  const resetSession = useCallback((interruption: 'cancelled' | 'tripChanged' = 'cancelled') => {
    invalidatePendingAction();
    const session = sessionRef.current;
    sessionRef.current = null;
    startPromiseRef.current = null;
    void session?.close(interruption);
    setSaveSnapshot(null);
  }, [invalidatePendingAction]);

  const clear = useCallback(() => {
    if (isMutationLocked(saveSnapshot)) return;
    resetSession();
    replaceSelected(new Set());
    setFeedback(null);
  }, [replaceSelected, resetSession, saveSnapshot]);

  const exit = useCallback(() => {
    resetSession();
    replaceSelected(new Set());
    setSelectionMode(false);
    setFeedback(null);
  }, [replaceSelected, resetSession]);

  const publishFinalState = useCallback(
    async (session: SelectedPhotoSaveSession, ownerTicket: typeof scopeTicket): Promise<void> => {
      const snapshot = session.getSnapshot();
      if (!mountedRef.current || !scope.isCurrent(ownerTicket) || sessionRef.current !== session) {
        return;
      }
      setSaveSnapshot(snapshot);
      const nextIds = actionableIds(snapshot);
      replaceSelected(new Set(nextIds));
      setFeedback(resultFeedback(snapshot));

      if (snapshot.phase === 'completed' && nextIds.length === 0) {
        sessionRef.current = null;
        await session.close('cancelled');
        if (!mountedRef.current || !scope.isCurrent(ownerTicket)) return;
        setSelectionMode(false);
        setSaveSnapshot(null);
      }
    },
    [replaceSelected, scope],
  );

  const startSave = useCallback((): Promise<void> => {
    if (startPromiseRef.current) return startPromiseRef.current;
    if (selectedRef.current.size === 0) return Promise.resolve();

    const ownerTicket = scopeTicket;
    const frozenIds = Array.from(selectedRef.current);
    const existingSession = sessionRef.current;

    if (existingSession) {
      // Resume/retry enters the existing state machine synchronously. Its own
      // action lock and ticket capture happen before `start()` reaches an await.
      const existingPending = existingSession
        .start()
        .then(() => publishFinalState(existingSession, ownerTicket))
        .finally(() => {
          if (startPromiseRef.current === existingPending) startPromiseRef.current = null;
        });
      startPromiseRef.current = existingPending;
      return existingPending;
    }

    // Reserve cross-surface ownership and freeze all identities at the tap,
    // before waiting for a Trip A cleanup tail. This prevents a queued action
    // from adopting a later Session/Trip/Store B.
    const releaseAction = actionLock.tryAcquire();
    if (!releaseAction) return Promise.resolve();
    const initialCaptured: PhotoSaveCapturedTickets | null = captureTickets(
      scope,
      coordinator,
    );
    if (
      !initialCaptured ||
      initialCaptured.trip.tripId !== ownerTicket.tripId ||
      initialCaptured.trip.generation !== ownerTicket.generation
    ) {
      releaseAction();
      return Promise.resolve();
    }
    let reserved = true;
    const actionEpoch = actionEpochRef.current + 1;
    actionEpochRef.current = actionEpoch;
    pendingActionRef.current = { epoch: actionEpoch, release: releaseAction };
    setSaveSnapshot(pendingSnapshot(frozenIds));
    setFeedback(null);
    const reservedActionLock: PhotoSaveActionLock = {
      tryAcquire: () => {
        if (reserved) {
          reserved = false;
          return releaseAction;
        }
        return actionLock.tryAcquire();
      },
    };

    const newPending = (async () => {
      await scope.waitForCleanup();
      if (
        !mountedRef.current ||
        !scope.isCurrent(ownerTicket) ||
        pendingActionRef.current?.epoch !== actionEpoch ||
        !ticketsAreCurrent(initialCaptured, scope, coordinator)
      ) {
        return;
      }

      let session: SelectedPhotoSaveSession | null = null;
      session = createSession({
        tripId,
        photoIds: frozenIds,
        tripScope: scope,
        coordinator,
        actionLock: reservedActionLock,
        initialCaptured,
        ...(library ? { library } : {}),
        ...(transport ? { transport } : {}),
        onTombstone,
        onTripUnavailable,
        resolveAmbiguousNotFound,
        isPhotoUnavailable: isPhotoTombstoned,
        onSnapshot: (next) => {
          if (
            mountedRef.current &&
            scope.isCurrent(ownerTicket) &&
            sessionRef.current === session
          ) {
            setSaveSnapshot(next);
          }
        },
      });
      pendingActionRef.current = null;
      sessionRef.current = session;
      setSaveSnapshot(session.getSnapshot());

      await session.start();
      await publishFinalState(session, ownerTicket);
    })().finally(() => {
      // Idempotent by the action-lock contract. This also releases a reservation
      // when stale cleanup prevented session construction/start.
      releaseAction();
      if (pendingActionRef.current?.epoch === actionEpoch) {
        pendingActionRef.current = null;
        if (mountedRef.current && scope.isCurrent(ownerTicket)) {
          setSaveSnapshot(null);
        }
      }
      if (startPromiseRef.current === newPending) startPromiseRef.current = null;
    });
    startPromiseRef.current = newPending;
    return newPending;
  }, [
    createSession,
    actionLock,
    captureTickets,
    coordinator,
    isPhotoTombstoned,
    library,
    onTombstone,
    onTripUnavailable,
    publishFinalState,
    resolveAmbiguousNotFound,
    scope,
    scopeTicket,
    ticketsAreCurrent,
    transport,
    tripId,
  ]);

  const cancelSave = useCallback(() => {
    if (invalidatePendingAction()) {
      startPromiseRef.current = null;
      setSaveSnapshot(null);
      setFeedback({
        kind: 'message',
        message: `Save stopped. ${selectedRef.current.size} not saved.`,
      });
      return;
    }
    sessionRef.current?.stop();
  }, [invalidatePendingAction]);

  const dismissFeedback = useCallback(() => setFeedback(null), []);
  const stateMatchesTrip = stateTripId === tripId;

  return {
    selectionMode: stateMatchesTrip ? selectionMode : false,
    selectedIds: stateMatchesTrip ? Array.from(selected) : [],
    selectedCount: stateMatchesTrip ? selected.size : 0,
    saveSnapshot: stateMatchesTrip ? saveSnapshot : null,
    feedback: stateMatchesTrip ? feedback : null,
    enterSelectionMode,
    enterSelection,
    toggle,
    isSelected,
    selectLoaded,
    clear,
    exit,
    startSave,
    cancelSave,
    dismissFeedback,
  };
}
