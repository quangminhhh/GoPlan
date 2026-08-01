import {
  getAuthSnapshot,
  subscribeAuthLifecycle,
} from '@/shared/api/authSessionLifecycle';
import {
  photoSaveTempCoordinator,
  type PhotoSaveRunHandle,
  type PhotoSaveTempCoordinator,
} from '@/shared/media/photoSaveTempStore';
import type { ProtectedTransport } from '@/shared/media/protectedAssetTypes';
import {
  arePhotoSaveTicketsCurrent,
  capturePhotoSaveTickets,
  photoSaveActionLock,
  saveOneTripPhoto,
} from './photoSave';
import type {
  PhotoLibraryAdapter,
  PhotoSaveActionLock,
  PhotoSaveCapturedTickets,
  PhotoSaveGate,
  PhotoSaveInterruption,
  PhotoSaveItemOutcome,
  PhotoSaveLedgerStatus,
  SaveOneTripPhotoOptions,
} from './photoSaveTypes';
import { nativePhotoActions } from './nativePhotoActions';
import { PHOTO_SAVE_SELECTION_MAX } from './constants';
import {
  PHOTO_ERROR_MESSAGES,
  toPhotoFailure,
  type PhotoFailure,
} from './errors';
import type { TripPhotoScope, TripPhotoScopeTicket } from './hooks/useTripPhotoScope';

export type SelectedSavePhase =
  | 'idle'
  | 'requestingPermission'
  | 'running'
  | 'stopping'
  | 'paused'
  | 'completed';

export type SelectedSaveStage = 'preparing' | 'downloading' | 'saving' | null;

export interface SaveLedgerEntry {
  readonly photoId: string;
  readonly status: PhotoSaveLedgerStatus;
  readonly failure?: PhotoFailure;
}

export interface SelectedSaveCounts {
  committed: number;
  terminalSkipped: number;
  retryableFailed: number;
  unknown: number;
  unattempted: number;
}

export interface SelectedSaveSnapshot {
  phase: SelectedSavePhase;
  stage: SelectedSaveStage;
  total: number;
  currentOrdinal: number | null;
  counts: SelectedSaveCounts;
  ledger: readonly SaveLedgerEntry[];
  failure: PhotoFailure | null;
  permissionDenied: { canAskAgain: boolean } | null;
}

export interface SelectedPhotoSaveSession {
  getSnapshot(): SelectedSaveSnapshot;
  start(): Promise<void>;
  pause(): void;
  stop(): void;
  markUnavailable(photoId: string): void;
  close(interruption?: PhotoSaveInterruption): Promise<void>;
}

export interface CreateSelectedPhotoSaveSessionOptions {
  tripId: string;
  photoIds: readonly string[];
  tripScope: TripPhotoScope;
  /** Captured by the explicit tap before any hook-level cleanup await. */
  initialCaptured?: PhotoSaveCapturedTickets;
  coordinator?: PhotoSaveTempCoordinator;
  library?: PhotoLibraryAdapter;
  transport?: ProtectedTransport;
  actionLock?: PhotoSaveActionLock;
  signal?: AbortSignal;
  onSnapshot?: (snapshot: SelectedSaveSnapshot) => void;
  /** Authoritative synchronous feed, independent from React tombstone state. */
  isPhotoUnavailable?: (photoId: string) => boolean;
  onTombstone?: (photoId: string) => void;
  onTripUnavailable?: (failure: PhotoFailure) => void;
  resolveAmbiguousNotFound?: SaveOneTripPhotoOptions['resolveAmbiguousNotFound'];
  savePhoto?: typeof saveOneTripPhoto;
}

type RunnerIntent = 'running' | 'pause' | 'stop' | 'closed';

function countsFor(ledger: readonly SaveLedgerEntry[]): SelectedSaveCounts {
  const counts: SelectedSaveCounts = {
    committed: 0,
    terminalSkipped: 0,
    retryableFailed: 0,
    unknown: 0,
    unattempted: 0,
  };
  for (const entry of ledger) {
    counts[entry.status] += 1;
  }
  return counts;
}

function unavailableFailure(): PhotoFailure {
  return {
    kind: 'notFound',
    message: PHOTO_ERROR_MESSAGES.photoGone,
    status: 404,
    errorCode: 'PHOTO_NOT_FOUND',
  };
}

function isActionable(status: PhotoSaveLedgerStatus): boolean {
  return status === 'retryableFailed' || status === 'unattempted';
}

function terminalInterruption(
  outcome: PhotoSaveItemOutcome,
): Extract<PhotoSaveInterruption, 'signOut' | 'tripUnavailable' | 'tripChanged'> | null {
  if (outcome.status !== 'unattempted') return null;
  if (
    outcome.interruption === 'signOut' ||
    outcome.interruption === 'tripUnavailable' ||
    outcome.interruption === 'tripChanged'
  ) {
    return outcome.interruption;
  }
  return null;
}

function sameAuthTicket(
  left: PhotoSaveCapturedTickets['auth'],
  right: PhotoSaveCapturedTickets['auth'],
): boolean {
  return (
    left.sessionGeneration === right.sessionGeneration &&
    left.credentialRevision === right.credentialRevision
  );
}

function unexpectedItemOutcome(
  caught: unknown,
  commitStarted: boolean,
  interruption: PhotoSaveInterruption,
): PhotoSaveItemOutcome {
  const failure = toPhotoFailure(caught);
  if (commitStarted) {
    return {
      status: 'unknown',
      failure: { ...failure, message: PHOTO_ERROR_MESSAGES.saveUnknown },
    };
  }
  if (failure.kind === 'auth') {
    return { status: 'unattempted', interruption: 'signOut', failure };
  }
  if (failure.kind === 'forbidden') {
    return { status: 'unattempted', interruption: 'tripUnavailable', failure };
  }
  if (failure.kind === 'cancelled') {
    return { status: 'unattempted', interruption, failure };
  }
  return { status: 'retryableFailed', failure };
}

/** Pure, injectable concurrency-1 selected-save runner. */
export function createSelectedPhotoSaveSession(
  options: CreateSelectedPhotoSaveSessionOptions,
): SelectedPhotoSaveSession {
  const coordinator = options.coordinator ?? photoSaveTempCoordinator;
  const library = options.library ?? nativePhotoActions;
  const actionLock = options.actionLock ?? photoSaveActionLock;
  const savePhoto = options.savePhoto ?? saveOneTripPhoto;
  const initialCaptured = options.initialCaptured ?? null;
  const worklist = Array.from(new Set(options.photoIds)).slice(
    0,
    PHOTO_SAVE_SELECTION_MAX,
  );
  const originalTripTicket: TripPhotoScopeTicket =
    initialCaptured?.trip ?? options.tripScope.capture();
  let originalAuthTicket = initialCaptured?.auth ?? null;
  let initialCapturePending = initialCaptured !== null;
  let ledger: SaveLedgerEntry[] = worklist.map((photoId) => ({
    photoId,
    status: 'unattempted',
  }));
  let phase: SelectedSavePhase = 'idle';
  let stage: SelectedSaveStage = null;
  let currentOrdinal: number | null = null;
  let failure: PhotoFailure | null = null;
  let permissionDenied: { canAskAgain: boolean } | null = null;
  let intent: RunnerIntent = 'running';
  let closeInterruption: PhotoSaveInterruption = 'cancelled';
  let runnerPromise: Promise<void> | null = null;
  let itemController: AbortController | null = null;
  let currentPhotoId: string | null = null;
  let currentCommitStarted = false;
  let closed = false;
  let subscriptionsReleased = false;
  let detachExternalSignal = (): void => undefined;

  const snapshot = (): SelectedSaveSnapshot => ({
    phase,
    stage,
    total: worklist.length,
    currentOrdinal,
    counts: countsFor(ledger),
    ledger: ledger.map((entry) => ({ ...entry })),
    failure,
    permissionDenied,
  });

  const publish = (): void => {
    try {
      options.onSnapshot?.(snapshot());
    } catch {
      // React ownership may disappear at a trip/auth boundary. Its observer
      // cannot interrupt the internal native result or cleanup tail.
    }
  };

  const updateEntry = (
    photoId: string,
    outcome: PhotoSaveItemOutcome | SaveLedgerEntry,
  ): void => {
    ledger = ledger.map((entry) =>
      entry.photoId === photoId
        ? {
            photoId,
            status: outcome.status,
            ...('failure' in outcome && outcome.failure ? { failure: outcome.failure } : {}),
          }
        : entry,
    );
  };

  const interruption = (): PhotoSaveInterruption => {
    if (intent === 'pause') return 'background';
    if (intent === 'closed') return closeInterruption;
    if (intent === 'stop') return 'cancelled';
    if (!options.tripScope.isCurrent(originalTripTicket)) return 'tripChanged';
    const auth = getAuthSnapshot();
    if (auth.phase !== 'active' && auth.phase !== 'opening') return 'signOut';
    if (coordinator.captureTicket() === null) return 'background';
    return 'cancelled';
  };

  const isRunnerOpen = (captured: PhotoSaveCapturedTickets): boolean =>
    intent === 'running' &&
    !closed &&
    options.tripScope.isCurrent(originalTripTicket) &&
    captured.trip.tripId === originalTripTicket.tripId &&
    captured.trip.generation === originalTripTicket.generation &&
    captured.trip.tripId === options.tripId &&
    originalAuthTicket !== null &&
    sameAuthTicket(captured.auth, originalAuthTicket) &&
    arePhotoSaveTicketsCurrent(captured, options.tripScope, coordinator);

  const gateFor = (captured: PhotoSaveCapturedTickets): PhotoSaveGate => ({
    isOpen: () => isRunnerOpen(captured),
    isTombstoned: (photoId) =>
      options.isPhotoUnavailable?.(photoId) === true ||
      ledger.find((entry) => entry.photoId === photoId)?.status === 'terminalSkipped',
    interruption,
  });

  const settlePhaseAfterAttempt = (): void => {
    stage = null;
    currentOrdinal = null;
    currentPhotoId = null;
    currentCommitStarted = false;
    if (intent === 'pause') {
      phase = 'paused';
    } else {
      phase = 'completed';
    }
    publish();
  };

  const runAttempt = async (): Promise<void> => {
    const releaseAction = actionLock.tryAcquire();
    if (!releaseAction) {
      return;
    }
    let run: PhotoSaveRunHandle | null = null;
    try {
      intent = 'running';
      failure = null;
      permissionDenied = null;
      phase = 'requestingPermission';
      stage = null;
      publish();

      // Capture all three tickets before the permission prompt. An action from
      // A may never adopt B's auth/trip/store generation after the await.
      const captured = initialCapturePending
        ? initialCaptured
        : capturePhotoSaveTickets(options.tripScope, coordinator);
      initialCapturePending = false;
      if (
        !captured ||
        captured.trip.tripId !== options.tripId ||
        captured.trip.tripId !== originalTripTicket.tripId ||
        captured.trip.generation !== originalTripTicket.generation
      ) {
        intent = 'closed';
        closeInterruption = options.tripScope.isCurrent(originalTripTicket)
          ? 'signOut'
          : 'tripChanged';
        settlePhaseAfterAttempt();
        return;
      }
      if (originalAuthTicket === null) {
        originalAuthTicket = captured.auth;
      }
      if (!sameAuthTicket(captured.auth, originalAuthTicket)) {
        settlePhaseAfterAttempt();
        return;
      }
      // A pre-captured action that became stale during hook-level cleanup must
      // not prompt under, or silently adopt, the now-current Session B/store.
      if (!isRunnerOpen(captured)) {
        settlePhaseAfterAttempt();
        return;
      }

      let permission: Awaited<ReturnType<PhotoLibraryAdapter['requestAddOnlyPermission']>>;
      try {
        permission = await library.requestAddOnlyPermission();
      } catch (caught) {
        failure = toPhotoFailure(caught);
        settlePhaseAfterAttempt();
        return;
      }
      if (!isRunnerOpen(captured)) {
        settlePhaseAfterAttempt();
        return;
      }
      if (!permission.granted) {
        permissionDenied = { canAskAgain: permission.canAskAgain };
        settlePhaseAfterAttempt();
        return;
      }

      try {
        run = await coordinator.beginRun(captured.store);
      } catch (caught) {
        failure = toPhotoFailure(caught);
        settlePhaseAfterAttempt();
        return;
      }
      if (!isRunnerOpen(captured)) {
        settlePhaseAfterAttempt();
        return;
      }

      phase = 'running';
      const eligible = ledger
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => isActionable(entry.status));

      for (const { entry, index } of eligible) {
        if (!isRunnerOpen(captured)) {
          break;
        }
        const latest = ledger[index];
        if (!latest || !isActionable(latest.status)) {
          continue;
        }

        currentOrdinal = index + 1;
        currentPhotoId = entry.photoId;
        currentCommitStarted = false;
        stage = 'preparing';
        itemController = new AbortController();
        publish();

        let outcome: PhotoSaveItemOutcome;
        try {
          outcome = await savePhoto({
            tripId: options.tripId,
            photoId: entry.photoId,
            captured,
            tripScope: options.tripScope,
            coordinator,
            run,
            library,
            gate: gateFor(captured),
            signal: itemController.signal,
            ...(options.transport ? { transport: options.transport } : {}),
            ...(options.onTombstone ? { onTombstone: options.onTombstone } : {}),
            ...(options.onTripUnavailable
              ? { onTripUnavailable: options.onTripUnavailable }
              : {}),
            ...(options.resolveAmbiguousNotFound
              ? { resolveAmbiguousNotFound: options.resolveAmbiguousNotFound }
              : {}),
            onStage: (nextStage) => {
              stage = nextStage;
              publish();
            },
            onCommitStarted: () => {
              currentCommitStarted = true;
            },
          });
        } catch (caught) {
          outcome = unexpectedItemOutcome(
            caught,
            currentCommitStarted,
            interruption(),
          );
        }
        itemController = null;
        const entryAfterRun = ledger[index];
        if (
          entryAfterRun?.status !== 'terminalSkipped' ||
          outcome.status === 'committed' ||
          outcome.status === 'unknown'
        ) {
          updateEntry(entry.photoId, outcome);
        }
        const effectiveEntry = ledger[index];
        if (
          effectiveEntry?.status !== 'terminalSkipped' &&
          'failure' in outcome &&
          outcome.failure
        ) {
          failure = outcome.failure;
        }
        const terminalReason = terminalInterruption(outcome);
        if (terminalReason) {
          // This session is permanently owned by its original auth/trip. A
          // later Start must not turn terminal evidence into a retry under a
          // newer session or trip. Native committed/unknown outcomes never
          // enter this branch and therefore retain boundary precedence.
          closed = true;
          intent = 'closed';
          closeInterruption = terminalReason;
        }
        publish();

        if (
          effectiveEntry?.status === 'unknown' ||
          effectiveEntry?.status === 'retryableFailed' ||
          effectiveEntry?.status === 'unattempted' ||
          intent !== 'running'
        ) {
          break;
        }
      }
      settlePhaseAfterAttempt();
    } finally {
      itemController = null;
      try {
        run?.release();
      } catch {
        // Preserve the ledger and unlock the action below when possible.
      }
      try {
        releaseAction();
      } catch {
        // An injected lock must not reject an otherwise settled session.
      }
    }
  };

  const start = (): Promise<void> => {
    if (runnerPromise || closed || worklist.length === 0) {
      return runnerPromise ?? Promise.resolve();
    }
    if (phase !== 'idle' && phase !== 'paused' && phase !== 'completed') {
      return Promise.resolve();
    }
    if (!ledger.some((entry) => isActionable(entry.status))) {
      return Promise.resolve();
    }

    let pending!: Promise<void>;
    pending = runAttempt().finally(() => {
      if (runnerPromise === pending) {
        runnerPromise = null;
      }
    });
    runnerPromise = pending;
    return pending;
  };

  const pause = (): void => {
    if (intent === 'stop' || intent === 'closed' || phase === 'completed') {
      return;
    }
    intent = 'pause';
    phase = phase === 'running' ? 'stopping' : phase;
    itemController?.abort();
    publish();
  };

  const stop = (): void => {
    if (intent === 'closed' || phase === 'completed') {
      return;
    }
    intent = 'stop';
    phase = phase === 'running' ? 'stopping' : phase;
    itemController?.abort();
    publish();
  };

  const markUnavailable = (photoId: string): void => {
    const entry = ledger.find((candidate) => candidate.photoId === photoId);
    if (!entry || entry.status === 'committed' || entry.status === 'unknown') {
      return;
    }
    if (photoId === currentPhotoId && currentCommitStarted) {
      // Native result owns the boundary once beginCommit/createAsset starts.
      return;
    }
    updateEntry(photoId, { photoId, status: 'terminalSkipped', failure: unavailableFailure() });
    if (photoId === currentPhotoId) {
      itemController?.abort();
    }
    publish();
  };

  const close = async (
    nextInterruption: PhotoSaveInterruption = 'cancelled',
  ): Promise<void> => {
    if (!closed) {
      closed = true;
      closeInterruption = nextInterruption;
      intent = 'closed';
      itemController?.abort();
      if (!runnerPromise) {
        phase = 'completed';
        stage = null;
        currentOrdinal = null;
        currentPhotoId = null;
      }
      publish();
    }
    await runnerPromise;
    releaseSubscriptions();
  };

  const unsubscribeAuth = subscribeAuthLifecycle((auth) => {
    if (
      auth.phase === 'closing' ||
      auth.phase === 'signedOut' ||
      (originalAuthTicket !== null &&
        (auth.sessionGeneration !== originalAuthTicket.sessionGeneration ||
          auth.credentialRevision !== originalAuthTicket.credentialRevision))
    ) {
      void close('signOut');
    }
  });
  const unsubscribeTrip = options.tripScope.subscribeInvalidation((previous) => {
    if (
      previous.tripId === originalTripTicket.tripId &&
      previous.generation === originalTripTicket.generation
    ) {
      return close('tripChanged');
    }
    return undefined;
  });
  const releaseSubscriptions = (): void => {
    if (subscriptionsReleased) return;
    subscriptionsReleased = true;
    unsubscribeAuth();
    unsubscribeTrip();
    detachExternalSignal();
    detachExternalSignal = () => undefined;
  };

  // Subscription publication is synchronous, but a close/change may already
  // have happened between construction and registration.
  const authAtRegistration = getAuthSnapshot();
  if (
    !options.tripScope.isCurrent(originalTripTicket) ||
    (authAtRegistration.phase !== 'active' && authAtRegistration.phase !== 'opening') ||
    (originalAuthTicket !== null &&
      (authAtRegistration.sessionGeneration !== originalAuthTicket.sessionGeneration ||
        authAtRegistration.credentialRevision !== originalAuthTicket.credentialRevision))
  ) {
    closed = true;
    intent = 'closed';
    phase = 'completed';
    closeInterruption = options.tripScope.isCurrent(originalTripTicket)
      ? 'signOut'
      : 'tripChanged';
    releaseSubscriptions();
  }

  if (options.signal && !closed) {
    if (options.signal.aborted) {
      void close('cancelled');
    } else {
      const closeFromSignal = (): void => {
        void close('cancelled');
      };
      options.signal.addEventListener('abort', closeFromSignal, {
        once: true,
      });
      detachExternalSignal = () => {
        options.signal?.removeEventListener('abort', closeFromSignal);
      };
    }
  }

  publish();
  return {
    getSnapshot: snapshot,
    start,
    pause,
    stop,
    markUnavailable,
    close,
  };
}
