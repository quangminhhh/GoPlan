/**
 * Bounded preprocess → batch → upload pipeline (D19).
 *
 * The naive shape — preprocess everything, then upload — puts roughly 600 MiB of
 * private JPEGs on disk for a 60-photo selection. This runs one file at a time
 * instead: encode, adopt into the owned temp namespace, and upload the current
 * batch as soon as the next file would push it past a ceiling. At most one batch
 * plus one candidate exists at any moment.
 *
 * Every dependency is injected. Nothing here imports a native module, so the
 * whole state machine — partial success, a 429 mid-session, a 5xx whose outcome
 * cannot be known, backgrounding, low disk — is testable with plain objects.
 */

import type { PickedImage, PreprocessedImage, PreprocessTarget } from '@/shared/media/types';
import { ImagePreprocessError } from '@/shared/media/types';
import {
  createSessionClosedError,
  linkAbortSignals,
} from '@/shared/media/privateMediaLifecycle';
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
  isBatchingInvariantViolation,
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
  /** App backgrounded mid-session; the user has to say Resume. */
  | 'paused'
  | 'complete'
  | 'partial'
  | 'throttled'
  | 'stopped'
  | 'cancelled'
  | 'tripGone';

export interface UploadSnapshot {
  phase: UploadPhase;
  items: UploadItem[];
  selectedCount: number;
  processedCount: number;
  uploadedCount: number;
  rejectedCount: number;
  /** Never sent. Distinct from `unknownCount`, which may already exist server-side. */
  pendingCount: number;
  unknownCount: number;
  failedCount: number;
  batchesUploaded: number;
  currentBatchSize: number;
  batchBytesSent: number;
  batchBytesTotal: number | null;
  error: PhotoFailure | null;
}

export interface UploadSessionDeps {
  preprocess: (image: PickedImage, target: PreprocessTarget) => Promise<PreprocessedImage>;
  adopt: (input: { uri: string; bytes: number; mimeType: string }) => Promise<{ uri: string; bytes: number }>;
  /** Removes a file this session owns in the temp namespace. */
  discardTemp: (uri: string) => Promise<void>;
  /** Removes the encoder's own output after it has been adopted or rejected. */
  discardEncoderOutput: (uri: string) => Promise<void>;
  uploadBatch: (
    files: PreparedUpload[],
    onProgress: (loaded: number, total: number | null) => void,
    signal?: AbortSignal,
  ) => Promise<TripPhoto[]>;
  availableBytes: () => number | null;
  /** Defers a background purge for as long as the session owns temp files. */
  acquireLease: () => () => void;
  onSnapshot: (snapshot: UploadSnapshot) => void;
  /** New photos, merged into the grid as each batch lands. */
  onUploaded: (photos: TripPhoto[]) => void;
  /** Reconciles the grid after an outcome the client cannot be sure about. */
  onReconcile: () => void;
  onTripNotFound: () => void;
  limits?: UploadBatchLimits;
  target?: PreprocessTarget;
  diskReserveBytes?: number;
}

interface SourceEntry {
  id: string;
  index: number;
  image: PickedImage | null;
  item: UploadItem;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
}

export interface UploadSessionController {
  snapshot(): UploadSnapshot;
  /** Runs the pipeline. Only ever called from an explicit Start or Resume. */
  start(signal?: AbortSignal): Promise<void>;
  /** Stops scheduling after the batch that is currently in flight settles. */
  requestStop(): void;
  /** Backgrounding: same as stop, but resumable. */
  requestPause(): void;
  /** Abandons everything not yet uploaded and cleans up owned temp files. */
  cancel(): Promise<void>;
}

export function createUploadSession(
  picked: { images: PickedImage[]; unreadable: { index: number; fileName: string | null }[] },
  deps: UploadSessionDeps,
): UploadSessionController {
  const limits = deps.limits ?? DEFAULT_UPLOAD_BATCH_LIMITS;
  const target = deps.target ?? TRIP_PHOTO_PREPROCESS_TARGET;
  const diskReserve = deps.diskReserveBytes ?? PRIVATE_MEDIA_DISK_RESERVE_BYTES;

  const sources: SourceEntry[] = [];
  const items: UploadItem[] = [];

  // Numbering follows picker order and includes the unreadable assets, so
  // "photo 7 of 60" means the same thing to the user as it does to the ledger.
  const total = picked.images.length + picked.unreadable.length;
  const unreadableByIndex = new Map(picked.unreadable.map((entry) => [entry.index, entry]));
  let imageCursor = 0;
  for (let index = 0; index < total; index += 1) {
    const unreadable = unreadableByIndex.get(index);
    const id = `pick-${index}`;
    if (unreadable) {
      const item: UploadItem = {
        id,
        index: index + 1,
        fileName: unreadable.fileName,
        state: 'rejected',
        reason: 'This photo could not be read.',
      };
      items.push(item);
      sources.push({ id, index, image: null, item });
      continue;
    }
    const image = picked.images[imageCursor];
    imageCursor += 1;
    const item: UploadItem = {
      id,
      index: index + 1,
      fileName: image?.fileName ?? null,
      state: 'queued',
    };
    items.push(item);
    sources.push({ id, index, image: image ?? null, item });
  }

  let phase: UploadPhase = 'selected';
  let error: PhotoFailure | null = null;
  let batchesUploaded = 0;
  let batchBytesSent = 0;
  let batchBytesTotal: number | null = null;
  let stopRequested = false;
  let pauseRequested = false;
  let running = false;
  let terminalCancelled = false;
  let activeRun: ActiveRun | null = null;
  let cancelPromise: Promise<void> | null = null;
  let pendingPauseCleanup: Promise<void> | null = null;
  /** Index of the next source to preprocess. Survives a pause. */
  let cursor = 0;

  let currentBatch: UploadBatch = emptyBatch();
  const preparedById = new Map<string, PreparedUpload>();

  function setState(id: string, state: UploadItemState, reason?: string): void {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) {
      return;
    }
    item.state = state;
    if (reason === undefined) {
      delete item.reason;
    } else {
      item.reason = reason;
    }
  }

  function countBy(state: UploadItemState): number {
    return items.filter((item) => item.state === state).length;
  }

  function snapshot(): UploadSnapshot {
    return {
      phase,
      items: items.map((item) => ({ ...item })),
      selectedCount: total,
      processedCount: items.filter((item) => item.state !== 'queued' && item.state !== 'processing')
        .length,
      uploadedCount: countBy('uploaded'),
      rejectedCount: countBy('rejected'),
      pendingCount: countBy('queued') + countBy('ready'),
      unknownCount: countBy('unknown'),
      failedCount: countBy('failed'),
      batchesUploaded,
      currentBatchSize: currentBatch.files.length,
      batchBytesSent,
      batchBytesTotal,
      error,
    };
  }

  function publish(): void {
    deps.onSnapshot(snapshot());
  }

  /**
   * Keeps an OS reserve rather than waiting for the filesystem to say ENOSPC:
   * by then the partial file still has to be cleaned up, and the rest of the
   * device is already out of room.
   */
  function hasRoomFor(bytes: number): boolean {
    const available = deps.availableBytes();
    if (available === null) {
      // The platform cannot report free space. Proceeding is the only option;
      // the sink error path and the cleanup in `finally` are the fallback.
      return true;
    }
    return available - bytes >= diskReserve;
  }

  async function discardTempQuietly(uri: string): Promise<void> {
    try {
      await deps.discardTemp(uri);
    } catch {
      // The lifecycle namespace purge is the final cleanup barrier. A native
      // deletion failure must not reclassify a completed server upload.
    }
  }

  async function discardEncoderOutputQuietly(uri: string): Promise<void> {
    try {
      await deps.discardEncoderOutput(uri);
    } catch {
      // The encoder owns its cache namespace. Cancellation still has to settle
      // and release the transfer lease even when that native cleanup rejects.
    }
  }

  async function discardBatchTemp(batch: UploadBatch): Promise<void> {
    for (const file of batch.files) {
      preparedById.delete(file.id);
      await discardTempQuietly(file.uri);
    }
  }

  async function uploadCurrentBatch(signal?: AbortSignal): Promise<'continue' | 'stop'> {
    if (currentBatch.files.length === 0) {
      return 'continue';
    }

    const batch = currentBatch;
    currentBatch = emptyBatch();
    for (const file of batch.files) {
      setState(file.id, 'uploading');
    }
    phase = 'uploading';
    batchBytesSent = 0;
    batchBytesTotal = batch.totalBytes;
    publish();

    try {
      const photos = await deps.uploadBatch(
        batch.files,
        (loaded, totalBytes) => {
          batchBytesSent = loaded;
          batchBytesTotal = totalBytes ?? batch.totalBytes;
          publish();
        },
        signal,
      );
      if (signal?.aborted) {
        throw createSessionClosedError();
      }
      for (const file of batch.files) {
        setState(file.id, 'uploaded');
      }
      batchesUploaded += 1;
      await discardBatchTemp(batch);
      // Merged as each batch lands rather than at the end, so a session that
      // stops halfway still shows what actually arrived.
      deps.onUploaded(photos);
      publish();
      return 'continue';
    } catch (caught) {
      const failure = toPhotoFailure(caught);
      error = failure;

      if (isCancelledFailure(failure)) {
        for (const file of batch.files) {
          setState(file.id, 'unknown');
        }
        await discardBatchTemp(batch);
        phase = 'cancelled';
        publish();
        return 'stop';
      }

      if (isTripNotFound(failure)) {
        for (const file of batch.files) {
          setState(file.id, 'failed', failure.message);
        }
        await discardBatchTemp(batch);
        phase = 'tripGone';
        deps.onTripNotFound();
        publish();
        return 'stop';
      }

      if (failure.kind === 'throttled') {
        // The batch never landed, so it is pending rather than failed: the user
        // can try again once the window resets.
        for (const file of batch.files) {
          setState(file.id, 'ready');
        }
        currentBatch = batch;
        error = { ...failure, message: PHOTO_ERROR_MESSAGES.uploadThrottled };
        phase = 'throttled';
        publish();
        return 'stop';
      }

      if (isUncertainOutcome(failure)) {
        // Network, timeout or any 5xx. The upload endpoint has no idempotency
        // key and a 5xx can be raised after the rows were committed, so this
        // batch is neither a success nor a failure — and must never be retried
        // automatically.
        for (const file of batch.files) {
          setState(file.id, 'unknown');
        }
        await discardBatchTemp(batch);
        phase = 'partial';
        deps.onReconcile();
        publish();
        return 'stop';
      }

      // Deterministic 4xx. A batching invariant violation is a bug in this
      // client, so the server's own wording is shown rather than an invented
      // message, and nothing is silently re-split and retried.
      const reason = isBatchingInvariantViolation(failure) ? failure.message : failure.message;
      for (const file of batch.files) {
        setState(file.id, 'failed', reason);
      }
      await discardBatchTemp(batch);
      phase = 'partial';
      publish();
      return 'stop';
    }
  }

  async function prepareNext(
    entry: SourceEntry,
    signal?: AbortSignal,
  ): Promise<PreparedUpload | 'skip' | 'stop' | 'cancelled'> {
    if (!entry.image) {
      return 'skip';
    }

    if (!hasRoomFor(target.maxBytes * 2)) {
      // Room for one encode plus its adopted copy. Prior successes stay.
      error = { kind: 'request', message: PHOTO_ERROR_MESSAGES.lowStorage };
      return 'stop';
    }

    setState(entry.id, 'processing');
    publish();

    let encoded: PreprocessedImage;
    try {
      encoded = await deps.preprocess(entry.image, target);
      if (signal?.aborted) {
        await discardEncoderOutputQuietly(encoded.uri);
        setState(entry.id, 'queued');
        return 'cancelled';
      }
    } catch (caught) {
      if (signal?.aborted) {
        setState(entry.id, 'queued');
        return 'cancelled';
      }
      const reason =
        caught instanceof ImagePreprocessError
          ? caught.message
          : 'This photo could not be prepared.';
      setState(entry.id, 'rejected', reason);
      publish();
      return 'skip';
    }

    let adopted: { uri: string; bytes: number };
    try {
      adopted = await deps.adopt({ uri: encoded.uri, bytes: encoded.bytes, mimeType: encoded.type });
      if (signal?.aborted) {
        await discardTempQuietly(adopted.uri);
        setState(entry.id, 'queued');
        return 'cancelled';
      }
    } catch {
      // The encoder's output is still the encoder's to clean up; this file just
      // never became ready.
      await discardEncoderOutputQuietly(encoded.uri);
      setState(
        entry.id,
        signal?.aborted ? 'queued' : 'rejected',
        signal?.aborted ? undefined : 'Could not prepare this photo.',
      );
      publish();
      return signal?.aborted ? 'cancelled' : 'skip';
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
      publish();
      return 'skip';
    }

    preparedById.set(prepared.id, prepared);
    setState(entry.id, 'ready');
    publish();
    return prepared;
  }

  async function run(signal: AbortSignal): Promise<void> {
    // Claim the run before awaiting background maintenance so two fast Resume
    // taps cannot both pass the guard and start parallel pipelines.
    running = true;
    if (pendingPauseCleanup) {
      await pendingPauseCleanup;
    }
    if (signal.aborted) {
      phase = 'cancelled';
      publish();
      running = false;
      return;
    }
    stopRequested = false;
    pauseRequested = false;
    error = null;

    let releaseLease: (() => void) | null = null;
    try {
      releaseLease = deps.acquireLease();
    } catch {
      phase = 'cancelled';
      publish();
      running = false;
      return;
    }

    try {
      phase = 'preprocessing';
      publish();

      while (cursor < sources.length) {
        if (signal?.aborted) {
          await releaseUnsentBatch();
          phase = 'cancelled';
          publish();
          return;
        }
        if (stopRequested || pauseRequested) {
          break;
        }

        const entry = sources[cursor];
        cursor += 1;

        phase = 'preprocessing';
        publish();

        const prepared = await prepareNext(entry, signal);
        if (prepared === 'cancelled') {
          await releaseUnsentBatch();
          phase = 'cancelled';
          publish();
          return;
        }
        if (prepared === 'stop') {
          // Low disk. Anything already prepared for the next batch was never
          // sent, so it must not be left occupying the space that ran out.
          await releaseUnsentBatch();
          phase = 'partial';
          publish();
          return;
        }
        if (prepared === 'skip') {
          continue;
        }

        if (currentBatch.files.length > 0 && wouldExceedBatchLimits(currentBatch, prepared, limits)) {
          // Uploading before adding keeps temp residency at one batch plus this
          // one candidate.
          if ((await uploadCurrentBatch(signal)) === 'stop') {
            // The candidate was prepared after the cursor advanced but did not
            // fit the batch that just stopped (notably on 429). It is not part
            // of `currentBatch`, so explicitly discard and rewind it.
            preparedById.delete(prepared.id);
            await discardTempQuietly(prepared.uri);
            setState(prepared.id, 'queued');
            const entryIndex = sources.findIndex((source) => source.id === prepared.id);
            if (entryIndex >= 0 && entryIndex < cursor) {
              cursor = entryIndex;
            }
            if (pauseRequested && currentBatch.files.length > 0) {
              await pauseNow();
            }
            return;
          }
          if (stopRequested || pauseRequested) {
            // The candidate is prepared but unsent; it opens the next batch.
            currentBatch = addToBatch(currentBatch, prepared);
            break;
          }
        }
        currentBatch = addToBatch(currentBatch, prepared);
      }

      if (!stopRequested && !pauseRequested) {
        if ((await uploadCurrentBatch(signal)) === 'stop') {
          if (pauseRequested && currentBatch.files.length > 0) {
            await pauseNow();
          }
          return;
        }
      }

      if (pauseRequested) {
        await pauseNow();
        return;
      }

      if (stopRequested) {
        await releaseUnsentBatch();
        phase = 'stopped';
        publish();
        return;
      }

      const uploaded = countBy('uploaded');
      const rejected = countBy('rejected');
      phase = rejected > 0 && uploaded === 0 ? 'partial' : rejected > 0 ? 'partial' : 'complete';
      publish();
    } finally {
      running = false;
      releaseLease?.();
    }
  }

  /**
   * Drops everything prepared but never sent.
   *
   * A file that was encoded and adopted but not uploaded would otherwise sit in
   * the temp namespace until the next purge — for a paused session that means
   * for as long as the app stays backgrounded. Re-encoding it later is cheaper
   * than holding private bytes on disk indefinitely, so the ledger rewinds those
   * files to `queued` and the cursor goes back to the earliest of them.
   */
  async function releaseUnsentBatch(): Promise<void> {
    const stranded = currentBatch;
    currentBatch = emptyBatch();
    for (const file of stranded.files) {
      preparedById.delete(file.id);
      try {
        await discardTempQuietly(file.uri);
      } catch {
        // `discardTempQuietly` currently cannot reject. Keep the rewind guarded
        // if the cleanup implementation later grows additional bookkeeping.
      }
      setState(file.id, 'queued');
      const entryIndex = sources.findIndex((entry) => entry.id === file.id);
      if (entryIndex >= 0 && entryIndex < cursor) {
        cursor = entryIndex;
      }
    }
  }

  async function pauseNow(): Promise<void> {
    await releaseUnsentBatch();
    error = null;
    phase = 'paused';
    publish();
  }

  function start(externalSignal?: AbortSignal): Promise<void> {
    if (terminalCancelled) {
      return Promise.resolve();
    }
    if (activeRun) {
      return activeRun.promise;
    }

    const controller = new AbortController();
    const linked = linkAbortSignals([controller.signal, externalSignal]);
    const record: ActiveRun = {
      controller,
      promise: undefined as unknown as Promise<void>,
    };
    record.promise = run(linked.signal).finally(() => {
      linked.dispose();
      if (activeRun === record) {
        activeRun = null;
      }
    });
    activeRun = record;
    return record.promise;
  }

  function cancel(): Promise<void> {
    if (cancelPromise) {
      return cancelPromise;
    }

    terminalCancelled = true;
    stopRequested = true;
    pauseRequested = false;
    const runToStop = activeRun;
    // Abort synchronously. In particular, Axios sees this before `cancel()`
    // yields, while cleanup deliberately waits until the request has settled so
    // its multipart file cannot disappear underneath the native client.
    runToStop?.controller.abort();

    cancelPromise = (async () => {
      await runToStop?.promise.catch(() => undefined);
      if (pendingPauseCleanup) {
        await pendingPauseCleanup.catch(() => undefined);
      }

      const ownedByUri = new Map<string, PreparedUpload>();
      for (const file of currentBatch.files) {
        ownedByUri.set(file.uri, file);
      }
      for (const file of preparedById.values()) {
        ownedByUri.set(file.uri, file);
      }
      currentBatch = emptyBatch();
      preparedById.clear();
      for (const file of ownedByUri.values()) {
        await discardTempQuietly(file.uri);
      }

      phase = 'cancelled';
      publish();
    })();

    return cancelPromise;
  }

  return {
    snapshot,
    start,
    requestStop(): void {
      if (terminalCancelled) {
        return;
      }
      stopRequested = true;
    },
    requestPause(): void {
      if (terminalCancelled) {
        return;
      }
      pauseRequested = true;
      // A throttled run has already settled while retaining its retry batch.
      // Backgrounding after that point still has to purge and rewind those
      // paths; otherwise Resume points at files the lifecycle deleted.
      if (!running && phase === 'throttled' && !pendingPauseCleanup) {
        const cleanup = pauseNow().catch(() => undefined);
        pendingPauseCleanup = cleanup;
        void cleanup.finally(() => {
          if (pendingPauseCleanup === cleanup) {
            pendingPauseCleanup = null;
          }
        });
      }
    },
    cancel,
  };
}
