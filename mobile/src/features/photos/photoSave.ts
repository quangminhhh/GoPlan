import {
  captureAuthTicket,
  isAuthTicketCurrent,
} from '@/shared/api/authSessionLifecycle';
import { fetchProtectedResponse } from '@/shared/media/fetchProtectedAsset';
import {
  PhotoSaveTempStoreError,
  photoSaveTempCoordinator,
  type PhotoCommitFence,
  type PhotoSaveTempCoordinator,
  type PhotoSaveTempFile,
} from '@/shared/media/photoSaveTempStore';
import { trackPrivateRequest } from '@/shared/media/privateMediaLifecycle';
import {
  ProtectedAssetError,
  type ProtectedTransport,
} from '@/shared/media/protectedAssetTypes';
import { nativeProtectedTransport } from '@/shared/media/protectedTransport';
import { tripPhotoAssetPath } from './api';
import { MEDIUM_MAX_BYTES, PRIVATE_MEDIA_DISK_RESERVE_BYTES } from './constants';
import {
  classifyNotFound,
  PHOTO_ERROR_MESSAGES,
  toPhotoFailure,
  type PhotoFailure,
} from './errors';
import type { TripPhotoScope } from './hooks/useTripPhotoScope';
import { nativePhotoActions } from './nativePhotoActions';
import type {
  PhotoLibraryAdapter,
  PhotoSaveActionLock,
  PhotoSaveCapturedTickets,
  PhotoSaveGate,
  PhotoSaveInterruption,
  PhotoSaveItemOutcome,
  SaveOneTripPhotoOptions,
} from './photoSaveTypes';

const EXTENSION_BY_CONTENT_TYPE = new Map<string, string>([
  ['image/webp', '.webp'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
]);

class PhotoSaveInterruptedError extends Error {
  readonly interruption: PhotoSaveInterruption;

  constructor(interruption: PhotoSaveInterruption) {
    super('Photo save interrupted.');
    this.name = 'PhotoSaveInterruptedError';
    this.interruption = interruption;
  }
}

class PhotoSaveTombstoneError extends Error {
  constructor() {
    super('Photo is unavailable.');
    this.name = 'PhotoSaveTombstoneError';
  }
}

class DefaultPhotoSaveActionLock implements PhotoSaveActionLock {
  private locked = false;

  tryAcquire(): (() => void) | null {
    if (this.locked) {
      return null;
    }
    this.locked = true;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.locked = false;
    };
  }
}

export function createPhotoSaveActionLock(): PhotoSaveActionLock {
  return new DefaultPhotoSaveActionLock();
}

/** Shared across viewer and selection so rapid cross-surface taps prompt once. */
export const photoSaveActionLock = createPhotoSaveActionLock();

function sameStoreTicket(
  left: PhotoSaveCapturedTickets['store'] | null,
  right: PhotoSaveCapturedTickets['store'],
): boolean {
  return (
    left !== null &&
    left.storeGeneration === right.storeGeneration &&
    left.authGeneration === right.authGeneration
  );
}

export function capturePhotoSaveTickets(
  tripScope: TripPhotoScope,
  coordinator: PhotoSaveTempCoordinator = photoSaveTempCoordinator,
): PhotoSaveCapturedTickets | null {
  const auth = captureAuthTicket();
  const trip = tripScope.capture();
  const store = coordinator.captureTicket();
  if (
    !auth ||
    !store ||
    store.authGeneration !== auth.sessionGeneration ||
    !tripScope.isCurrent(trip) ||
    !isAuthTicketCurrent(auth)
  ) {
    return null;
  }
  return { auth, trip, store, runId: Symbol('photo-save-run') };
}

export function arePhotoSaveTicketsCurrent(
  captured: PhotoSaveCapturedTickets,
  tripScope: TripPhotoScope,
  coordinator: PhotoSaveTempCoordinator,
): boolean {
  return (
    isAuthTicketCurrent(captured.auth) &&
    tripScope.isCurrent(captured.trip) &&
    sameStoreTicket(coordinator.captureTicket(), captured.store)
  );
}

export function normalizedPhotoContentType(contentType: string | null): string | null {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSION_BY_CONTENT_TYPE.has(normalized) ? normalized : null;
}

export function extensionForPhotoContentType(contentType: string | null): string | null {
  const normalized = normalizedPhotoContentType(contentType);
  return normalized ? (EXTENSION_BY_CONTENT_TYPE.get(normalized) ?? null) : null;
}

export function hasPhotoSaveWriteReserve(
  availableBytes: number | null,
  nextChunkBytes: number,
  reserveBytes: number = PRIVATE_MEDIA_DISK_RESERVE_BYTES,
): boolean {
  return (
    availableBytes !== null &&
    Number.isFinite(availableBytes) &&
    availableBytes >= 0 &&
    Number.isFinite(nextChunkBytes) &&
    nextChunkBytes >= 0 &&
    availableBytes - nextChunkBytes >= reserveBytes
  );
}

export function hasPhotoSaveCommitHeadroom(
  availableBytes: number | null,
  stagedBytes: number,
  reserveBytes: number = PRIVATE_MEDIA_DISK_RESERVE_BYTES,
): boolean {
  return (
    availableBytes !== null &&
    Number.isFinite(availableBytes) &&
    availableBytes >= 0 &&
    Number.isFinite(stagedBytes) &&
    stagedBytes > 0 &&
    availableBytes >= reserveBytes + stagedBytes
  );
}

interface LinkedSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

function linkSignals(signals: readonly (AbortSignal | undefined)[]): LinkedSignal {
  const controller = new AbortController();
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const abort = (): void => controller.abort();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of activeSignals) {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

function cancelReaderOnAbort(
  signal: AbortSignal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): () => void {
  const cancel = (): void => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Reader cleanup is best effort and cannot replace the interruption.
    }
  };
  if (signal.aborted) {
    cancel();
    return () => undefined;
  }
  signal.addEventListener('abort', cancel, { once: true });
  return () => signal.removeEventListener('abort', cancel);
}

async function cancelOwnedBody(
  body: ReadableStream<Uint8Array> | null,
  reader: ReadableStreamDefaultReader<Uint8Array> | null,
): Promise<void> {
  if (reader) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the business/validation error that owns this cleanup.
    }
    return;
  }
  try {
    await body?.cancel();
  } catch {
    // Preserve the business/validation error that owns this cleanup.
  }
}

async function settleFenceBestEffort(fence: PhotoCommitFence): Promise<void> {
  try {
    await fence.settleAndDiscard();
  } catch {
    // The ledger result is already authoritative at this point.
  }
}

async function discardTempBestEffort(staged: PhotoSaveTempFile): Promise<void> {
  try {
    await staged.discard();
  } catch {
    // Cleanup cannot replace the failure that caused the discard.
  }
}

function assertActionOpen(options: SaveOneTripPhotoOptions, signal: AbortSignal): void {
  if (
    signal.aborted ||
    !options.gate.isOpen() ||
    !arePhotoSaveTicketsCurrent(
      options.captured,
      options.tripScope,
      options.coordinator,
    )
  ) {
    throw new PhotoSaveInterruptedError(options.gate.interruption());
  }
  if (options.gate.isTombstoned(options.photoId)) {
    throw new PhotoSaveTombstoneError();
  }
}

function photoUnavailableFailure(): PhotoFailure {
  return {
    kind: 'notFound',
    message: PHOTO_ERROR_MESSAGES.photoGone,
    status: 404,
    errorCode: 'PHOTO_NOT_FOUND',
  };
}

async function classifyPreCommitFailure(
  caught: unknown,
  options: SaveOneTripPhotoOptions,
  signal: AbortSignal,
): Promise<PhotoSaveItemOutcome> {
  const interrupted = (): PhotoSaveItemOutcome => ({
    status: 'unattempted',
    interruption: options.gate.interruption(),
  });
  const publishTombstone = (): void => {
    try {
      options.onTombstone?.(options.photoId);
    } catch {
      // A UI/reconcile observer cannot change the authoritative item result.
    }
  };
  const publishTripUnavailable = (failure: PhotoFailure): void => {
    try {
      options.onTripUnavailable?.(failure);
    } catch {
      // Navigation ownership cannot change the authoritative item result.
    }
  };
  const scopedResultIsCurrent = (): boolean =>
    !signal.aborted &&
    options.gate.isOpen() &&
    arePhotoSaveTicketsCurrent(
      options.captured,
      options.tripScope,
      options.coordinator,
    );

  if (caught instanceof PhotoSaveTombstoneError) {
    publishTombstone();
    return { status: 'terminalSkipped', failure: photoUnavailableFailure() };
  }
  if (caught instanceof PhotoSaveInterruptedError) {
    return { status: 'unattempted', interruption: caught.interruption };
  }
  if (caught instanceof PhotoSaveTempStoreError && caught.kind === 'cancelled') {
    return { status: 'unattempted', interruption: options.gate.interruption() };
  }

  const failure = toPhotoFailure(caught);
  if (failure.kind === 'cancelled') {
    return { status: 'unattempted', interruption: options.gate.interruption(), failure };
  }
  if (failure.kind === 'auth') {
    return { status: 'unattempted', interruption: 'signOut', failure };
  }
  if (failure.kind === 'forbidden') {
    if (!scopedResultIsCurrent()) return interrupted();
    publishTripUnavailable(failure);
    return { status: 'unattempted', interruption: 'tripUnavailable', failure };
  }
  if (failure.kind === 'notFound') {
    const scope = classifyNotFound(failure);
    if (scope === 'photo') {
      if (
        signal.aborted ||
        !options.gate.isOpen() ||
        !arePhotoSaveTicketsCurrent(
          options.captured,
          options.tripScope,
          options.coordinator,
        )
      ) {
        return interrupted();
      }
      publishTombstone();
      return { status: 'terminalSkipped', failure };
    }
    if (scope === 'trip') {
      if (!scopedResultIsCurrent()) return interrupted();
      publishTripUnavailable(failure);
      return { status: 'unattempted', interruption: 'tripUnavailable', failure };
    }
    let resolved: Awaited<
      ReturnType<NonNullable<SaveOneTripPhotoOptions['resolveAmbiguousNotFound']>>
    > | undefined;
    try {
      resolved = await options.resolveAmbiguousNotFound?.(options.photoId, failure);
    } catch (reconcileError) {
      if (
        signal.aborted ||
        !options.gate.isOpen() ||
        !arePhotoSaveTicketsCurrent(
          options.captured,
          options.tripScope,
          options.coordinator,
        )
      ) {
        return interrupted();
      }
      return { status: 'retryableFailed', failure: toPhotoFailure(reconcileError) };
    }
    if (
      signal.aborted ||
      !options.gate.isOpen() ||
      !arePhotoSaveTicketsCurrent(
        options.captured,
        options.tripScope,
        options.coordinator,
      )
    ) {
      return interrupted();
    }
    if (resolved === 'photo') {
      publishTombstone();
      return { status: 'terminalSkipped', failure };
    }
    if (resolved === 'trip') {
      publishTripUnavailable(failure);
      return { status: 'unattempted', interruption: 'tripUnavailable', failure };
    }
  }
  return { status: 'retryableFailed', failure };
}

/**
 * Stages and commits exactly one already-authorized photo.
 *
 * Permission and run-lock ownership live outside this primitive so a selected
 * run can prompt once and reuse one sequential runner. No await exists between
 * the final gate, `beginCommit`, and invoking the native mutation.
 */
export async function saveOneTripPhoto(
  options: SaveOneTripPhotoOptions,
): Promise<PhotoSaveItemOutcome> {
  const transport = options.transport ?? nativeProtectedTransport;
  const linked = linkSignals([options.signal, options.run.signal]);
  const stagedState: { current: PhotoSaveTempFile | null } = { current: null };
  let fence: PhotoCommitFence | null = null;

  try {
    assertActionOpen(options, linked.signal);
    options.onStage?.('downloading');
    const stagedResult = await trackPrivateRequest(linked.signal, async (trackedSignal) => {
      assertActionOpen(options, trackedSignal);
      const response = await fetchProtectedResponse({
        path: tripPhotoAssetPath(options.tripId, options.photoId, 'download'),
        signal: trackedSignal,
        transport,
      });
      const body = response.body;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let detachAbort = (): void => undefined;
      try {
        assertActionOpen(options, trackedSignal);
        const extension = extensionForPhotoContentType(response.headers.get('content-type'));
        if (!extension) {
          throw new ProtectedAssetError(
            'invalidContent',
            PHOTO_ERROR_MESSAGES.invalidDownload,
          );
        }

        const declaredHeader = response.headers.get('content-length');
        const declaredBytes = declaredHeader === null ? null : Number(declaredHeader);
        if (
          declaredBytes !== null &&
          (!Number.isSafeInteger(declaredBytes) ||
            declaredBytes < 0 ||
            declaredBytes > MEDIUM_MAX_BYTES)
        ) {
          throw new ProtectedAssetError(
            'invalidContent',
            PHOTO_ERROR_MESSAGES.invalidDownload,
          );
        }
        if (!body) {
          throw new ProtectedAssetError(
            'invalidContent',
            PHOTO_ERROR_MESSAGES.invalidDownload,
          );
        }

        const staged = await options.coordinator.createCurrent(
          extension,
          options.captured.store,
        );
        stagedState.current = staged;
        assertActionOpen(options, trackedSignal);
        reader = body.getReader();
        detachAbort = cancelReaderOnAbort(trackedSignal, reader);
        let received = 0;

        for (;;) {
          assertActionOpen(options, trackedSignal);
          const chunk = await reader.read();
          assertActionOpen(options, trackedSignal);
          if (chunk.done) {
            break;
          }
          const value = chunk.value;
          if (!value || value.byteLength === 0) {
            continue;
          }
          if (received + value.byteLength > MEDIUM_MAX_BYTES) {
            throw new ProtectedAssetError(
              'invalidContent',
              PHOTO_ERROR_MESSAGES.invalidDownload,
            );
          }
          if (
            !hasPhotoSaveWriteReserve(
              options.coordinator.availableBytes(),
              value.byteLength,
            )
          ) {
            throw new ProtectedAssetError('request', PHOTO_ERROR_MESSAGES.lowStorage);
          }
          // Reserve is proven immediately before each write. There is no
          // intervening async operation that could knowingly spend it first.
          await staged.sink.write(value);
          received += value.byteLength;
          assertActionOpen(options, trackedSignal);
          options.onProgress?.(received);
        }

        await staged.sink.close();
        assertActionOpen(options, trackedSignal);
        const written = staged.sink.bytesWritten();
        if (
          written <= 0 ||
          received !== written ||
          (declaredBytes !== null && declaredBytes !== written)
        ) {
          throw new ProtectedAssetError(
            'invalidContent',
            PHOTO_ERROR_MESSAGES.invalidDownload,
          );
        }
        return { uri: staged.uri, bytesWritten: written };
      } catch (error) {
        await cancelOwnedBody(body, reader);
        throw error;
      } finally {
        detachAbort();
      }
    });

    // The tracked business-network scope has ended. From here the exact staged
    // file is owned only by the dedicated PhotoKit handoff coordinator.
    assertActionOpen(options, linked.signal);
    const stat = await options.coordinator.stat(stagedResult.uri);
    if (
      !stat ||
      !Number.isFinite(stat.bytes) ||
      stat.bytes <= 0 ||
      stat.bytes !== stagedResult.bytesWritten
    ) {
      throw new ProtectedAssetError(
        'invalidContent',
        PHOTO_ERROR_MESSAGES.invalidDownload,
      );
    }
    if (
      !hasPhotoSaveCommitHeadroom(
        options.coordinator.availableBytes(),
        stat.bytes,
      )
    ) {
      throw new ProtectedAssetError('request', PHOTO_ERROR_MESSAGES.lowStorage);
    }

    assertActionOpen(options, linked.signal);
    options.onStage?.('saving');
    // Stage publication can synchronously deliver a tombstone/stop intent.
    // Re-check it before the no-await native handoff below.
    assertActionOpen(options, linked.signal);
    fence = options.coordinator.beginCommit(stagedResult.uri, options.captured.store);

    let outcome: PhotoSaveItemOutcome;
    try {
      // Invoking createAsset begins the irreversible native mutation. No gate
      // or await may be inserted between beginCommit and this call.
      const nativeCommit = options.library.createAsset(stagedResult.uri);
      try {
        options.onCommitStarted?.();
      } catch {
        // Observation is best-effort. The native promise still owns the actual
        // result once createAsset has been invoked.
      }
      try {
        await nativeCommit;
        outcome = { status: 'committed' };
      } catch (caught) {
        outcome = {
          status: 'unknown',
          failure: {
            ...toPhotoFailure(caught),
            message: PHOTO_ERROR_MESSAGES.saveUnknown,
          },
        };
      }
    } catch (caught) {
      outcome = {
        status: 'unknown',
        failure: {
          ...toPhotoFailure(caught),
          message: PHOTO_ERROR_MESSAGES.saveUnknown,
        },
      };
    } finally {
      // Record outcome before cleanup. A cleanup failure can never relabel a
      // committed or unknown native result.
      await settleFenceBestEffort(fence);
      fence = null;
      stagedState.current = null;
    }
    return outcome;
  } catch (caught) {
    return classifyPreCommitFailure(caught, options, linked.signal);
  } finally {
    linked.dispose();
    if (fence) {
      await settleFenceBestEffort(fence);
    } else if (stagedState.current) {
      await discardTempBestEffort(stagedState.current);
    }
  }
}

export type SavePhotoOutcome =
  | { status: 'saved' }
  | { status: 'permissionDenied'; canAskAgain: boolean }
  | { status: 'busy' }
  | { status: 'cancelled' }
  | { status: 'unknown'; failure: PhotoFailure }
  | { status: 'failed'; failure: PhotoFailure };

export interface SaveTripPhotoOptions {
  tripId: string;
  photoId: string;
  tripScope: TripPhotoScope;
  coordinator?: PhotoSaveTempCoordinator;
  library?: PhotoLibraryAdapter;
  transport?: ProtectedTransport;
  actionLock?: PhotoSaveActionLock;
  gate?: PhotoSaveGate;
  signal?: AbortSignal;
  onProgress?: (bytesWritten: number) => void;
  onTombstone?: (photoId: string) => void;
  onTripUnavailable?: (failure: PhotoFailure) => void;
  resolveAmbiguousNotFound?: SaveOneTripPhotoOptions['resolveAmbiguousNotFound'];
  savePhoto?: typeof saveOneTripPhoto;
}

const defaultGate: PhotoSaveGate = {
  isOpen: () => true,
  isTombstoned: () => false,
  interruption: () => 'cancelled',
};

function isSingleSaveOpen(
  options: SaveTripPhotoOptions,
  gate: PhotoSaveGate,
  captured: PhotoSaveCapturedTickets,
  coordinator: PhotoSaveTempCoordinator,
): boolean {
  return (
    !options.signal?.aborted &&
    gate.isOpen() &&
    !gate.isTombstoned(options.photoId) &&
    arePhotoSaveTicketsCurrent(captured, options.tripScope, coordinator)
  );
}

/** Explicit single-photo action using the same primitive as selected save. */
export async function saveTripPhotoToLibrary(
  options: SaveTripPhotoOptions,
): Promise<SavePhotoOutcome> {
  const coordinator = options.coordinator ?? photoSaveTempCoordinator;
  const library = options.library ?? nativePhotoActions;
  const actionLock = options.actionLock ?? photoSaveActionLock;
  const savePhoto = options.savePhoto ?? saveOneTripPhoto;
  const releaseAction = actionLock.tryAcquire();
  if (!releaseAction) {
    return { status: 'busy' };
  }

  let releaseRun: (() => void) | null = null;
  try {
    const captured = capturePhotoSaveTickets(options.tripScope, coordinator);
    if (!captured) {
      return { status: 'cancelled' };
    }

    const gate = options.gate ?? defaultGate;
    let permission: Awaited<ReturnType<PhotoLibraryAdapter['requestAddOnlyPermission']>>;
    try {
      permission = await library.requestAddOnlyPermission();
    } catch (caught) {
      if (!isSingleSaveOpen(options, gate, captured, coordinator)) {
        return { status: 'cancelled' };
      }
      return { status: 'failed', failure: toPhotoFailure(caught) };
    }
    if (!isSingleSaveOpen(options, gate, captured, coordinator)) {
      return { status: 'cancelled' };
    }
    if (!permission.granted) {
      return { status: 'permissionDenied', canAskAgain: permission.canAskAgain };
    }

    const run = await coordinator.beginRun(captured.store);
    releaseRun = run.release;
    if (!isSingleSaveOpen(options, gate, captured, coordinator)) {
      return { status: 'cancelled' };
    }
    const outcome = await savePhoto({
      tripId: options.tripId,
      photoId: options.photoId,
      captured,
      tripScope: options.tripScope,
      coordinator,
      run,
      library,
      gate,
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.onTombstone ? { onTombstone: options.onTombstone } : {}),
      ...(options.onTripUnavailable
        ? { onTripUnavailable: options.onTripUnavailable }
        : {}),
      ...(options.resolveAmbiguousNotFound
        ? { resolveAmbiguousNotFound: options.resolveAmbiguousNotFound }
        : {}),
    });

    if (outcome.status === 'committed') {
      return { status: 'saved' };
    }
    if (outcome.status === 'unknown') {
      return outcome;
    }
    if (outcome.status === 'unattempted') {
      return { status: 'cancelled' };
    }
    return { status: 'failed', failure: outcome.failure };
  } catch (caught) {
    if (caught instanceof PhotoSaveTempStoreError && caught.kind === 'busy') {
      return { status: 'busy' };
    }
    if (caught instanceof PhotoSaveTempStoreError && caught.kind === 'cancelled') {
      return { status: 'cancelled' };
    }
    return { status: 'failed', failure: toPhotoFailure(caught) };
  } finally {
    try {
      releaseRun?.();
    } catch {
      // Coordinator release is idempotent best-effort at this boundary.
    }
    try {
      releaseAction();
    } catch {
      // Do not relabel a completed save because an injected lock misbehaved.
    }
  }
}
