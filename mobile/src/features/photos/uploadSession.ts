/**
 * Bounded preprocess -> batch -> upload pipeline.
 *
 * The state machine owns every picker source after construction, keeps at most
 * one batch plus one candidate, and applies scheduling intent only after the
 * real server outcome has been recorded. Native/image/request work is always
 * allowed to settle before a file it may still be reading is discarded.
 */

import type { AppOwnedPickerSourceUri } from '@/shared/media/pickerSourceStore';
import type {
  PickedImage,
  PickedUploadEntry,
  PreprocessedImage,
  PreprocessTarget,
} from '@/shared/media/types';
import { ImagePreprocessError } from '@/shared/media/types';
import { linkAbortSignals } from '@/shared/media/privateMediaLifecycle';
import {
  addToBatch,
  emptyBatch,
  isUnsendableAlone,
  wouldExceedBatchLimits,
  type UploadBatch,
  type UploadBatchLimits,
  DEFAULT_UPLOAD_BATCH_LIMITS,
} from './batching';
import { PRIVATE_MEDIA_DISK_RESERVE_BYTES, TRIP_PHOTO_PREPROCESS_TARGET } from './constants';
import {
  isCancelledFailure,
  isTripNotFound,
  isUncertainOutcome,
  PHOTO_ERROR_MESSAGES,
  toPhotoFailure,
  type PhotoFailure,
} from './errors';
import type { TripPhoto } from './types';
import type { PreparedUpload, UploadItem, UploadItemState } from './uploadTypes';

export type UploadPhase =
  | 'idle'
  | 'selected'
  | 'preprocessing'
  | 'uploading'
  | 'paused'
  | 'complete'
  | 'partial'
  | 'throttled'
  | 'stopped'
  | 'cancelled'
  | 'tripGone';

export interface ActiveBatchProgress {
  number: number;
  itemCount: number;
  loadedBytes: number;
  totalBytes: number | null;
}

export interface UploadSnapshot {
  phase: UploadPhase;
  items: UploadItem[];
  selectedCount: number;
  processedCount: number;
  uploadedCount: number;
  rejectedCount: number;
  /** Never sent. Distinct from `unknownCount`, which may exist server-side. */
  pendingCount: number;
  unknownCount: number;
  failedCount: number;
  batchesUploaded: number;
  activeBatch: ActiveBatchProgress | null;
  error: PhotoFailure | null;
}

export type BatchOutcome =
  | { kind: 'uploaded' }
  | { kind: 'throttled'; failure: PhotoFailure }
  | { kind: 'unknown'; failure: PhotoFailure }
  | { kind: 'failed'; failure: PhotoFailure }
  | { kind: 'tripGone'; failure: PhotoFailure }
  | { kind: 'cancelled'; failure: PhotoFailure };

export interface UploadSessionDeps {
  preprocess: (image: PickedImage, target: PreprocessTarget) => Promise<PreprocessedImage>;
  adopt: (input: {
    uri: string;
    bytes: number;
    mimeType: string;
  }) => Promise<{ uri: string; bytes: number }>;
  /** Removes a file this session owns in the upload-temp namespace. */
  discardTemp: (uri: string) => Promise<void>;
  /** Removes an encoder output that was not adopted. */
  discardEncoderOutput: (uri: string) => Promise<void>;
  /** Accepts delete authority, never an arbitrary picker/read URI. */
  discardSource: (uri: AppOwnedPickerSourceUri) => Promise<void>;
  uploadBatch: (
    files: PreparedUpload[],
    onProgress: (loaded: number, total: number | null) => void,
    signal?: AbortSignal,
  ) => Promise<TripPhoto[]>;
  availableBytes: () => number | null;
  acquireLease: () => () => void;
  onSnapshot: (snapshot: UploadSnapshot) => void;
  onUploaded: (photos: TripPhoto[]) => void;
  onReconcile: () => void;
  onTripNotFound: () => void;
  limits?: UploadBatchLimits;
  target?: PreprocessTarget;
  diskReserveBytes?: number;
}

interface SourceEntry {
  id: string;
  order: number;
  image: PickedImage | null;
  ownedSourceUri: AppOwnedPickerSourceUri | null;
  item: UploadItem;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
}

type SchedulingIntent = 'running' | 'pause' | 'stop' | 'cancel';

type PreparedOutcome =
  | { kind: 'prepared'; file: PreparedUpload }
  | { kind: 'skip' }
  | { kind: 'lowStorage' }
  | { kind: 'interrupted' };

const INTENT_PRIORITY: Record<SchedulingIntent, number> = {
  running: 0,
  pause: 1,
  stop: 2,
  cancel: 3,
};

const STARTABLE_PHASES = new Set<UploadPhase>(['selected', 'paused', 'throttled']);

export interface UploadSessionController {
  snapshot(): UploadSnapshot;
  /** Runs only from an explicit Start/Resume. */
  start(signal?: AbortSignal): Promise<void>;
  /** Lets native/request work settle, then terminally stops scheduling. */
  requestStop(): void;
  /** Lets native/request work settle, then becomes explicitly resumable. */
  requestPause(): void;
  /** Terminal close. Resolves after temp and picker-source cleanup settles. */
  cancel(): Promise<void>;
}

export function createUploadSession(
  picked: { entries: PickedUploadEntry[] },
  deps: UploadSessionDeps,
): UploadSessionController {
  const limits = deps.limits ?? DEFAULT_UPLOAD_BATCH_LIMITS;
  const target = deps.target ?? TRIP_PHOTO_PREPROCESS_TARGET;
  const diskReserve = deps.diskReserveBytes ?? PRIVATE_MEDIA_DISK_RESERVE_BYTES;

  const sources: SourceEntry[] = picked.entries.map((entry, order) => {
    const id = `pick-${entry.index}`;
    const item: UploadItem =
      entry.status === 'readable'
        ? {
            id,
            index: entry.index + 1,
            fileName: entry.image.fileName,
            state: 'queued',
          }
        : {
            id,
            index: entry.index + 1,
            fileName: entry.fileName,
            state: 'rejected',
            reason: 'This photo could not be read.',
          };
    return {
      id,
      order,
      image: entry.status === 'readable' ? entry.image : null,
      ownedSourceUri: entry.ownedSourceUri,
      item,
    };
  });
  const items = sources.map((entry) => entry.item);

  let phase: UploadPhase = 'selected';
  let intent: SchedulingIntent = 'running';
  let error: PhotoFailure | null = null;
  let batchesUploaded = 0;
  let activeBatch: ActiveBatchProgress | null = null;
  let activeBatchTicket = 0;
  let runTicket = 0;
  let cursor = 0;
  let currentBatch: UploadBatch = emptyBatch();
  let inFlightBatch: UploadBatch | null = null;
  let activeRun: ActiveRun | null = null;
  let cancelPromise: Promise<void> | null = null;
  let maintenanceTail: Promise<void> = Promise.resolve();
  let maintenancePending = 0;

  const preparedById = new Map<string, PreparedUpload>();
  const sourceCleanup = new Set<Promise<void>>();

  function setState(id: string, state: UploadItemState, reason?: string): void {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    item.state = state;
    if (reason === undefined) delete item.reason;
    else item.reason = reason;
  }

  function countBy(state: UploadItemState): number {
    return items.filter((item) => item.state === state).length;
  }

  function snapshot(): UploadSnapshot {
    return {
      phase,
      items: items.map((item) => ({ ...item })),
      selectedCount: items.length,
      processedCount: items.filter(
        (item) => item.state !== 'queued' && item.state !== 'processing',
      ).length,
      uploadedCount: countBy('uploaded'),
      rejectedCount: countBy('rejected'),
      pendingCount: countBy('queued') + countBy('ready'),
      unknownCount: countBy('unknown'),
      failedCount: countBy('failed'),
      batchesUploaded,
      activeBatch: activeBatch ? { ...activeBatch } : null,
      error,
    };
  }

  function publish(): void {
    deps.onSnapshot(snapshot());
  }

  function promoteIntent(next: SchedulingIntent): void {
    if (INTENT_PRIORITY[next] > INTENT_PRIORITY[intent]) {
      intent = next;
    }
  }

  function currentIntent(signal?: AbortSignal): SchedulingIntent {
    if (signal?.aborted) {
      promoteIntent('cancel');
    }
    return intent;
  }

  function clearActiveBatchProgress(): void {
    activeBatchTicket += 1;
    activeBatch = null;
  }

  function hasRoomFor(bytes: number): boolean {
    const available = deps.availableBytes();
    return (
      typeof available === 'number' &&
      Number.isFinite(available) &&
      available >= 0 &&
      Number.isFinite(bytes) &&
      bytes >= 0 &&
      available - bytes >= diskReserve
    );
  }

  async function discardTempQuietly(uri: string): Promise<void> {
    try {
      await deps.discardTemp(uri);
    } catch {
      // Best effort. Cleanup does not rewrite the server outcome.
    }
  }

  async function discardEncoderOutputQuietly(uri: string): Promise<void> {
    try {
      await deps.discardEncoderOutput(uri);
    } catch {
      // Best effort. The encoder namespace is purgeable on the next lifecycle.
    }
  }

  function beginSourceCleanup(entry: SourceEntry): Promise<void> {
    const owned = entry.ownedSourceUri;
    if (!owned) return Promise.resolve();

    // Clear authority before the first await so two terminal paths cannot both
    // unlink the same source or keep claiming ownership while deletion runs.
    entry.ownedSourceUri = null;
    let cleanup: Promise<void>;
    try {
      cleanup = Promise.resolve(deps.discardSource(owned)).catch(() => undefined);
    } catch {
      cleanup = Promise.resolve();
    }
    sourceCleanup.add(cleanup);
    const settle = (): void => {
      sourceCleanup.delete(cleanup);
    };
    cleanup.then(settle, settle);
    return cleanup;
  }

  async function waitForSourceCleanup(): Promise<void> {
    while (sourceCleanup.size > 0) {
      await Promise.allSettled(Array.from(sourceCleanup));
    }
  }

  async function cleanupAllSources(): Promise<void> {
    const started = sources.map(beginSourceCleanup);
    await Promise.allSettled(started);
    await waitForSourceCleanup();
  }

  async function discardBatchTemps(batch: UploadBatch): Promise<void> {
    for (const file of batch.files) {
      preparedById.delete(file.id);
    }
    await Promise.all(batch.files.map((file) => discardTempQuietly(file.uri)));
  }

  function rewindTo(file: PreparedUpload): void {
    const source = sources.find((entry) => entry.id === file.id);
    if (source && source.order < cursor) cursor = source.order;
  }

  async function releaseCandidate(file: PreparedUpload): Promise<void> {
    preparedById.delete(file.id);
    setState(file.id, 'queued');
    rewindTo(file);
    await discardTempQuietly(file.uri);
  }

  async function releaseUnsentBatch(): Promise<void> {
    const stranded = currentBatch;
    currentBatch = emptyBatch();
    for (const file of stranded.files) {
      preparedById.delete(file.id);
      setState(file.id, 'queued');
      rewindTo(file);
    }
    await Promise.all(stranded.files.map((file) => discardTempQuietly(file.uri)));
  }

  function notify(callback: () => void): void {
    try {
      callback();
    } catch {
      // A presentation callback cannot reclassify an already-known API result.
    }
  }

  async function prepareNext(entry: SourceEntry, signal: AbortSignal): Promise<PreparedOutcome> {
    if (!entry.image) return { kind: 'skip' };
    if (currentIntent(signal) !== 'running') return { kind: 'interrupted' };

    if (!hasRoomFor(target.maxBytes * 2)) {
      error = { kind: 'request', message: PHOTO_ERROR_MESSAGES.lowStorage };
      return { kind: 'lowStorage' };
    }

    setState(entry.id, 'processing');
    publish();

    let encoded: PreprocessedImage;
    try {
      encoded = await deps.preprocess(entry.image, target);
    } catch (caught) {
      if (currentIntent(signal) !== 'running') {
        setState(entry.id, 'queued');
        return { kind: 'interrupted' };
      }
      const reason =
        caught instanceof ImagePreprocessError
          ? caught.message
          : 'This photo could not be prepared.';
      setState(entry.id, 'rejected', reason);
      await beginSourceCleanup(entry);
      publish();
      return { kind: 'skip' };
    }

    // Boundary 1: preprocess settled. Native work is no longer reading source.
    if (currentIntent(signal) !== 'running') {
      await discardEncoderOutputQuietly(encoded.uri);
      setState(entry.id, 'queued');
      return { kind: 'interrupted' };
    }

    // Boundary 2: immediately before ownership is adopted into upload-temp.
    if (currentIntent(signal) !== 'running') {
      await discardEncoderOutputQuietly(encoded.uri);
      setState(entry.id, 'queued');
      return { kind: 'interrupted' };
    }

    let adopted: { uri: string; bytes: number };
    try {
      adopted = await deps.adopt({
        uri: encoded.uri,
        bytes: encoded.bytes,
        mimeType: encoded.type,
      });
    } catch {
      await discardEncoderOutputQuietly(encoded.uri);
      if (currentIntent(signal) !== 'running') {
        setState(entry.id, 'queued');
        return { kind: 'interrupted' };
      }
      setState(entry.id, 'rejected', 'Could not prepare this photo.');
      await beginSourceCleanup(entry);
      publish();
      return { kind: 'skip' };
    }

    // Boundary 3: an adopt that resolved after Pause/Stop/close is never sent.
    if (currentIntent(signal) !== 'running') {
      await discardTempQuietly(adopted.uri);
      setState(entry.id, 'queued');
      return { kind: 'interrupted' };
    }

    const prepared: PreparedUpload = {
      id: entry.id,
      uri: adopted.uri,
      name: encoded.name,
      type: encoded.type,
      bytes: adopted.bytes,
      width: encoded.width,
      height: encoded.height,
    };

    if (isUnsendableAlone(prepared, limits)) {
      await discardTempQuietly(prepared.uri);
      setState(entry.id, 'rejected', 'This photo is too large to upload.');
      await beginSourceCleanup(entry);
      publish();
      return { kind: 'skip' };
    }

    preparedById.set(prepared.id, prepared);
    setState(entry.id, 'ready');
    publish();
    return { kind: 'prepared', file: prepared };
  }

  async function uploadCurrentBatch(signal: AbortSignal, ownerRunTicket: number): Promise<BatchOutcome> {
    const batch = currentBatch;
    currentBatch = emptyBatch();
    inFlightBatch = batch;
    for (const file of batch.files) setState(file.id, 'uploading');

    const progressTicket = activeBatchTicket + 1;
    activeBatchTicket = progressTicket;
    activeBatch = {
      number: batchesUploaded + 1,
      itemCount: batch.files.length,
      loadedBytes: 0,
      totalBytes: null,
    };
    phase = 'uploading';
    publish();

    try {
      const photos = await deps.uploadBatch(
        batch.files,
        (loaded, totalBytes) => {
          if (
            ownerRunTicket !== runTicket ||
            progressTicket !== activeBatchTicket ||
            !activeBatch ||
            !Number.isFinite(loaded) ||
            loaded < 0
          ) {
            return;
          }
          activeBatch.loadedBytes = loaded;
          if (
            typeof totalBytes === 'number' &&
            Number.isFinite(totalBytes) &&
            totalBytes > 0
          ) {
            activeBatch.totalBytes = totalBytes;
          }
          publish();
        },
        signal,
      );

      for (const file of batch.files) setState(file.id, 'uploaded');
      batchesUploaded += 1;
      await discardBatchTemps(batch);
      await Promise.allSettled(
        batch.files.map((file) => {
          const source = sources.find((entry) => entry.id === file.id);
          return source ? beginSourceCleanup(source) : Promise.resolve();
        }),
      );
      notify(() => deps.onUploaded(photos));
      return { kind: 'uploaded' };
    } catch (caught) {
      const failure = toPhotoFailure(caught);
      error = failure;

      if (isCancelledFailure(failure)) {
        for (const file of batch.files) setState(file.id, 'unknown');
        await discardBatchTemps(batch);
        await Promise.allSettled(
          batch.files.map((file) => {
            const source = sources.find((entry) => entry.id === file.id);
            return source ? beginSourceCleanup(source) : Promise.resolve();
          }),
        );
        notify(deps.onReconcile);
        return { kind: 'cancelled', failure };
      }

      if (isTripNotFound(failure)) {
        for (const file of batch.files) setState(file.id, 'failed', failure.message);
        await discardBatchTemps(batch);
        await Promise.allSettled(
          batch.files.map((file) => {
            const source = sources.find((entry) => entry.id === file.id);
            return source ? beginSourceCleanup(source) : Promise.resolve();
          }),
        );
        return { kind: 'tripGone', failure };
      }

      if (failure.kind === 'throttled') {
        for (const file of batch.files) setState(file.id, 'ready');
        currentBatch = batch;
        const throttled = { ...failure, message: PHOTO_ERROR_MESSAGES.uploadThrottled };
        error = throttled;
        return { kind: 'throttled', failure: throttled };
      }

      if (isUncertainOutcome(failure)) {
        for (const file of batch.files) setState(file.id, 'unknown');
        await discardBatchTemps(batch);
        await Promise.allSettled(
          batch.files.map((file) => {
            const source = sources.find((entry) => entry.id === file.id);
            return source ? beginSourceCleanup(source) : Promise.resolve();
          }),
        );
        notify(deps.onReconcile);
        return { kind: 'unknown', failure };
      }

      for (const file of batch.files) setState(file.id, 'failed', failure.message);
      await discardBatchTemps(batch);
      await Promise.allSettled(
        batch.files.map((file) => {
          const source = sources.find((entry) => entry.id === file.id);
          return source ? beginSourceCleanup(source) : Promise.resolve();
        }),
      );
      return { kind: 'failed', failure };
    } finally {
      inFlightBatch = null;
      if (progressTicket === activeBatchTicket) {
        clearActiveBatchProgress();
      }
      publish();
    }
  }

  async function finishForIntent(signal: AbortSignal): Promise<boolean> {
    const requested = currentIntent(signal);
    if (requested === 'running') return false;

    await releaseUnsentBatch();
    if (requested === 'pause') {
      phase = 'paused';
      publish();
      return true;
    }

    await cleanupAllSources();
    phase = requested === 'cancel' ? 'cancelled' : 'stopped';
    publish();
    return true;
  }

  async function finishBatchOutcome(
    outcome: BatchOutcome,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (outcome.kind === 'tripGone' && currentIntent(signal) !== 'cancel') {
      await releaseUnsentBatch();
      await cleanupAllSources();
      phase = 'tripGone';
      notify(deps.onTripNotFound);
      publish();
      return true;
    }

    if (currentIntent(signal) !== 'running' && (await finishForIntent(signal))) return true;

    if (outcome.kind === 'uploaded') return false;
    if (outcome.kind === 'throttled') {
      phase = 'throttled';
      publish();
      return true;
    }

    await releaseUnsentBatch();
    await cleanupAllSources();
    phase = outcome.kind === 'cancelled' ? 'cancelled' : 'partial';
    publish();
    return true;
  }

  async function run(signal: AbortSignal, ownerRunTicket: number): Promise<void> {
    if (maintenancePending > 0) {
      await maintenanceTail.catch(() => undefined);
    }
    if (currentIntent(signal) !== 'running') {
      await finishForIntent(signal);
      return;
    }

    let releaseLease: (() => void) | null = null;
    try {
      releaseLease = deps.acquireLease();
    } catch {
      promoteIntent('cancel');
      await finishForIntent(signal);
      return;
    }

    try {
      phase = 'preprocessing';
      publish();

      // A 429 keeps the exact prepared batch. Explicit Resume retries it before
      // preprocessing any later picker source.
      if (currentBatch.files.length > 0) {
        if (currentIntent(signal) !== 'running') {
          await finishForIntent(signal);
          return;
        }
        const outcome = await uploadCurrentBatch(signal, ownerRunTicket);
        if (await finishBatchOutcome(outcome, signal)) return;
      }

      while (cursor < sources.length) {
        if (currentIntent(signal) !== 'running') {
          await finishForIntent(signal);
          return;
        }
        const entry = sources[cursor];
        if (!entry.image) {
          cursor += 1;
          continue;
        }

        phase = 'preprocessing';
        publish();
        const prepared = await prepareNext(entry, signal);
        // Boundary 4: `prepareNext` returned; intent beats the candidate.
        if (prepared.kind === 'interrupted') {
          await finishForIntent(signal);
          return;
        }
        if (prepared.kind === 'lowStorage') {
          await releaseUnsentBatch();
          await cleanupAllSources();
          phase = 'partial';
          publish();
          return;
        }
        if (prepared.kind === 'skip') {
          cursor += 1;
          continue;
        }

        const candidate = prepared.file;
        if (
          currentBatch.files.length > 0 &&
          wouldExceedBatchLimits(currentBatch, candidate, limits)
        ) {
          // Boundary 5: immediately before every request.
          if (currentIntent(signal) !== 'running') {
            await finishForIntent(signal);
            await releaseCandidate(candidate);
            return;
          }
          const outcome = await uploadCurrentBatch(signal, ownerRunTicket);
          // Boundary 6: real server result is recorded before scheduling intent.
          if (currentIntent(signal) !== 'running' || outcome.kind !== 'uploaded') {
            await releaseCandidate(candidate);
          }
          if (await finishBatchOutcome(outcome, signal)) return;
        }

        currentBatch = addToBatch(currentBatch, candidate);
        cursor += 1;
      }

      if (currentIntent(signal) !== 'running') {
        await finishForIntent(signal);
        return;
      }
      if (currentBatch.files.length > 0) {
        const outcome = await uploadCurrentBatch(signal, ownerRunTicket);
        if (await finishBatchOutcome(outcome, signal)) return;
      }
      if (currentIntent(signal) !== 'running') {
        await finishForIntent(signal);
        return;
      }

      await cleanupAllSources();
      phase = countBy('rejected') > 0 || countBy('failed') > 0 ? 'partial' : 'complete';
      publish();
    } finally {
      releaseLease?.();
    }
  }

  function enqueueMaintenance(task: () => Promise<void>): Promise<void> {
    maintenancePending += 1;
    const queued = maintenanceTail.then(task, task);
    const settled = queued.finally(() => {
      maintenancePending -= 1;
    });
    maintenanceTail = settled.catch(() => undefined);
    return queued;
  }

  function start(externalSignal?: AbortSignal): Promise<void> {
    if (activeRun) return activeRun.promise;
    if (!STARTABLE_PHASES.has(phase) || intent === 'stop' || intent === 'cancel') {
      return Promise.resolve();
    }

    intent = 'running';
    error = null;
    runTicket += 1;
    const ownerRunTicket = runTicket;
    const controller = new AbortController();
    const linked = linkAbortSignals([controller.signal, externalSignal]);
    const record: ActiveRun = { controller, promise: Promise.resolve() };
    record.promise = run(linked.signal, ownerRunTicket).finally(() => {
      linked.dispose();
      if (activeRun === record) activeRun = null;
    });
    activeRun = record;
    return record.promise;
  }

  function requestPause(): void {
    if (
      intent === 'stop' ||
      intent === 'cancel' ||
      phase === 'complete' ||
      phase === 'partial' ||
      phase === 'stopped' ||
      phase === 'cancelled' ||
      phase === 'tripGone'
    ) {
      return;
    }
    promoteIntent('pause');
    clearActiveBatchProgress();

    if (!activeRun) {
      phase = 'paused';
      publish();
      if (currentBatch.files.length > 0) {
        void enqueueMaintenance(releaseUnsentBatch);
      }
      return;
    }
    publish();
  }

  function requestStop(): void {
    if (
      intent === 'cancel' ||
      phase === 'complete' ||
      phase === 'partial' ||
      phase === 'stopped' ||
      phase === 'cancelled' ||
      phase === 'tripGone'
    ) {
      return;
    }
    promoteIntent('stop');
    clearActiveBatchProgress();

    if (!activeRun) {
      phase = 'stopped';
      publish();
      void enqueueMaintenance(async () => {
        await releaseUnsentBatch();
        await cleanupAllSources();
      });
      return;
    }
    publish();
  }

  function cancel(): Promise<void> {
    if (cancelPromise) return cancelPromise;

    promoteIntent('cancel');
    clearActiveBatchProgress();
    runTicket += 1;
    const runToClose = activeRun;
    runToClose?.controller.abort();

    cancelPromise = (async () => {
      await runToClose?.promise.catch(() => undefined);
      await maintenanceTail.catch(() => undefined);

      // The active run owns in-flight files until its request/native promise
      // settles. At this point only unsent/map residue can remain.
      if (!inFlightBatch) {
        await releaseUnsentBatch();
        const residue = Array.from(preparedById.values());
        preparedById.clear();
        await Promise.all(residue.map((file) => discardTempQuietly(file.uri)));
      }
      await cleanupAllSources();
      phase = 'cancelled';
      publish();
    })();

    return cancelPromise;
  }

  // Unreadable entries still carry picker cleanup authority. Start their
  // best-effort cleanup immediately; terminal close waits for the tracked tail.
  for (const source of sources) {
    if (!source.image) void beginSourceCleanup(source);
  }

  return { snapshot, start, requestStop, requestPause, cancel };
}
