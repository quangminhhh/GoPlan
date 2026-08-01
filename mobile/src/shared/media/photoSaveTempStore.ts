import type { ProtectedFileSink, ProtectedFileStore } from './protectedAssetTypes';
import {
  createOpaqueFileName,
  nativePhotoSaveFileStore,
} from './protectedTransport';

export interface PhotoSaveStoreTicket {
  readonly storeGeneration: number;
  readonly authGeneration: number;
}

export interface PhotoSaveRunHandle {
  readonly ticket: PhotoSaveStoreTicket;
  /** Aborted synchronously by background/sign-out. */
  readonly signal: AbortSignal;
  release(): void;
}

export interface PhotoSaveTempFile {
  readonly uri: string;
  readonly sink: ProtectedFileSink;
  discard(): Promise<void>;
}

export interface PhotoCommitFence {
  settleAndDiscard(): Promise<void>;
}

export interface PhotoSaveTempCoordinator {
  bootstrap(): Promise<void>;
  activateSession(authGeneration: number, foreground: boolean): PhotoSaveStoreTicket;
  captureTicket(): PhotoSaveStoreTicket | null;
  beginRun(expected: PhotoSaveStoreTicket): Promise<PhotoSaveRunHandle>;
  suspend(reason: 'background' | 'signOut'): void;
  resume(authGeneration: number): PhotoSaveStoreTicket;
  createCurrent(
    extension: string,
    expected: PhotoSaveStoreTicket,
  ): Promise<PhotoSaveTempFile>;
  availableBytes(): number | null;
  stat(uri: string): Promise<{ bytes: number } | null>;
  beginCommit(uri: string, expected: PhotoSaveStoreTicket): PhotoCommitFence;
}

export type PhotoSaveTempStoreErrorKind = 'busy' | 'cancelled' | 'invalidCommit';

export class PhotoSaveTempStoreError extends Error {
  readonly kind: PhotoSaveTempStoreErrorKind;

  constructor(kind: PhotoSaveTempStoreErrorKind, message: string) {
    super(message);
    this.name = 'PhotoSaveTempStoreError';
    this.kind = kind;
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface RunRecord {
  readonly ticket: PhotoSaveStoreTicket;
  readonly controller: AbortController;
  readonly released: Deferred;
  isReleased: boolean;
}

interface CreationRecord {
  readonly ticket: PhotoSaveStoreTicket;
  readonly done: Deferred;
  invalidated: boolean;
}

interface CurrentFileRecord {
  readonly ticket: PhotoSaveStoreTicket;
  readonly sink: ProtectedFileSink;
  discardPromise: Promise<void> | null;
}

interface CommitFenceRecord {
  readonly current: CurrentFileRecord;
  readonly done: Deferred;
  settlePromise: Promise<void> | null;
}

const CANCELLED_MESSAGE = 'This photo save is no longer active.';
const BUSY_MESSAGE = 'Another photo save is already active.';
const INVALID_COMMIT_MESSAGE = 'The staged photo is not current.';

function createDeferred(): Deferred {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
      resolvePromise = null;
    },
  };
}

function sameTicket(
  left: PhotoSaveStoreTicket | null,
  right: PhotoSaveStoreTicket,
): boolean {
  return (
    left !== null &&
    left.storeGeneration === right.storeGeneration &&
    left.authGeneration === right.authGeneration
  );
}

function cancelledError(): PhotoSaveTempStoreError {
  return new PhotoSaveTempStoreError('cancelled', CANCELLED_MESSAGE);
}

/**
 * Owns the one file that may cross the native PhotoKit commit boundary.
 *
 * This coordinator is intentionally independent from `privateMediaLifecycle`:
 * general cache/upload purges must continue while PhotoKit still reads this
 * namespace, and an unrelated generic transfer lease must not delay its abort.
 */
export class DefaultPhotoSaveTempCoordinator implements PhotoSaveTempCoordinator {
  private readonly store: ProtectedFileStore;

  private storeGeneration = 0;
  private activeTicket: PhotoSaveStoreTicket | null = null;
  private gateOpen = false;
  private bootstrapTail: Promise<void> | null = null;

  private storageCleanupTail: Promise<void> = Promise.resolve();
  private storageCleanupRevision = 0;
  private retiredRunTail: Promise<void> = Promise.resolve();
  private retiredRunRevision = 0;

  private activeRun: RunRecord | null = null;
  private creating: CreationRecord | null = null;
  private current: CurrentFileRecord | null = null;
  private fence: CommitFenceRecord | null = null;

  constructor(store: ProtectedFileStore = nativePhotoSaveFileStore) {
    this.store = store;
  }

  bootstrap(): Promise<void> {
    if (!this.bootstrapTail) {
      this.bootstrapTail = this.store.purgeAll().catch(() => undefined);
    }
    return this.bootstrapTail;
  }

  activateSession(authGeneration: number, foreground: boolean): PhotoSaveStoreTicket {
    if (
      this.activeTicket?.authGeneration === authGeneration &&
      this.gateOpen === foreground
    ) {
      return this.activeTicket;
    }

    const ticket = this.nextTicket(authGeneration);
    this.activeTicket = ticket;
    this.gateOpen = foreground;
    this.retireCurrentWork();
    return ticket;
  }

  captureTicket(): PhotoSaveStoreTicket | null {
    return this.gateOpen ? this.activeTicket : null;
  }

  async beginRun(expected: PhotoSaveStoreTicket): Promise<PhotoSaveRunHandle> {
    this.assertCurrent(expected);
    if (this.hasCurrentWorkFor(expected)) {
      throw new PhotoSaveTempStoreError('busy', BUSY_MESSAGE);
    }

    await this.waitForStorageCleanup();
    await this.waitForRetiredRuns();
    this.assertCurrent(expected);
    if (this.activeRun || this.creating || this.current || this.fence) {
      throw new PhotoSaveTempStoreError('busy', BUSY_MESSAGE);
    }

    const record: RunRecord = {
      ticket: expected,
      controller: new AbortController(),
      released: createDeferred(),
      isReleased: false,
    };
    this.activeRun = record;

    return {
      ticket: expected,
      signal: record.controller.signal,
      release: () => this.releaseRun(record),
    };
  }

  suspend(_reason: 'background' | 'signOut'): void {
    if (!this.activeTicket && !this.gateOpen) {
      return;
    }

    this.storeGeneration += 1;
    this.activeTicket = null;
    this.gateOpen = false;
    this.retireCurrentWork();
  }

  resume(authGeneration: number): PhotoSaveStoreTicket {
    return this.activateSession(authGeneration, true);
  }

  async createCurrent(
    extension: string,
    expected: PhotoSaveStoreTicket,
  ): Promise<PhotoSaveTempFile> {
    this.assertRunCurrent(expected);
    if (this.creating || this.current || this.fence) {
      throw new PhotoSaveTempStoreError('busy', BUSY_MESSAGE);
    }

    await this.waitForStorageCleanup();
    this.assertRunCurrent(expected);
    if (this.creating || this.current || this.fence) {
      throw new PhotoSaveTempStoreError('busy', BUSY_MESSAGE);
    }

    const creation: CreationRecord = {
      ticket: expected,
      done: createDeferred(),
      invalidated: false,
    };
    this.creating = creation;

    let sink: ProtectedFileSink | null = null;
    try {
      sink = await this.store.createSink(createOpaqueFileName(extension));
      if (
        creation.invalidated ||
        this.creating !== creation ||
        !sameTicket(this.activeTicket, expected) ||
        !this.gateOpen ||
        !this.isRunCurrent(expected)
      ) {
        await sink.discard().catch(() => undefined);
        throw cancelledError();
      }

      const current: CurrentFileRecord = {
        ticket: expected,
        sink,
        discardPromise: null,
      };
      this.creating = null;
      this.current = current;
      return {
        uri: sink.uri,
        sink,
        discard: () => this.discardTempFile(current),
      };
    } catch (error) {
      if (
        creation.invalidated ||
        !sameTicket(this.activeTicket, expected) ||
        !this.gateOpen
      ) {
        throw cancelledError();
      }
      throw error;
    } finally {
      if (this.creating === creation) {
        this.creating = null;
      }
      creation.done.resolve();
    }
  }

  availableBytes(): number | null {
    return this.store.availableBytes();
  }

  async stat(uri: string): Promise<{ bytes: number } | null> {
    if (this.current?.sink.uri !== uri) {
      return null;
    }
    return this.store.stat(uri);
  }

  beginCommit(uri: string, expected: PhotoSaveStoreTicket): PhotoCommitFence {
    this.assertRunCurrent(expected);
    const current = this.current;
    if (
      !current ||
      current.sink.uri !== uri ||
      !sameTicket(current.ticket, expected) ||
      this.fence
    ) {
      throw new PhotoSaveTempStoreError('invalidCommit', INVALID_COMMIT_MESSAGE);
    }

    const record: CommitFenceRecord = {
      current,
      done: createDeferred(),
      settlePromise: null,
    };
    this.fence = record;
    return {
      settleAndDiscard: () => this.settleCommitFence(record),
    };
  }

  private nextTicket(authGeneration: number): PhotoSaveStoreTicket {
    this.storeGeneration += 1;
    return { storeGeneration: this.storeGeneration, authGeneration };
  }

  private assertCurrent(expected: PhotoSaveStoreTicket): void {
    if (!this.gateOpen || !sameTicket(this.activeTicket, expected)) {
      throw cancelledError();
    }
  }

  private isRunCurrent(expected: PhotoSaveStoreTicket): boolean {
    return (
      this.activeRun !== null &&
      !this.activeRun.isReleased &&
      !this.activeRun.controller.signal.aborted &&
      sameTicket(this.activeRun.ticket, expected)
    );
  }

  private hasCurrentWorkFor(expected: PhotoSaveStoreTicket): boolean {
    return (
      (this.activeRun !== null && sameTicket(this.activeRun.ticket, expected)) ||
      (this.creating !== null && sameTicket(this.creating.ticket, expected)) ||
      (this.current !== null && sameTicket(this.current.ticket, expected)) ||
      (this.fence !== null && sameTicket(this.fence.current.ticket, expected))
    );
  }

  private assertRunCurrent(expected: PhotoSaveStoreTicket): void {
    this.assertCurrent(expected);
    if (!this.isRunCurrent(expected)) {
      throw cancelledError();
    }
  }

  private releaseRun(record: RunRecord): void {
    if (record.isReleased) {
      return;
    }
    record.isReleased = true;
    if (this.activeRun === record) {
      this.activeRun = null;
    }
    record.released.resolve();

    if (this.creating && sameTicket(this.creating.ticket, record.ticket)) {
      const creation = this.creating;
      creation.invalidated = true;
      this.creating = null;
      this.queueStorageCleanup([creation.done.promise]);
    }
    if (this.current && sameTicket(this.current.ticket, record.ticket) && !this.fence) {
      const current = this.current;
      this.current = null;
      this.queueStorageCleanup([this.discardCurrent(current)]);
    }
  }

  private retireCurrentWork(): void {
    const storageDependencies: Promise<void>[] = [];

    if (this.activeRun) {
      const run = this.activeRun;
      this.activeRun = null;
      run.controller.abort();
      this.retiredRunRevision += 1;
      this.retiredRunTail = Promise.allSettled([
        this.retiredRunTail,
        run.released.promise,
      ]).then(() => undefined);
    }

    if (this.creating) {
      const creation = this.creating;
      creation.invalidated = true;
      this.creating = null;
      storageDependencies.push(creation.done.promise);
    }

    if (this.current) {
      if (this.fence?.current === this.current) {
        storageDependencies.push(this.fence.done.promise);
      } else {
        const current = this.current;
        this.current = null;
        storageDependencies.push(this.discardCurrent(current));
      }
    }

    this.queueStorageCleanup(storageDependencies);
  }

  private queueStorageCleanup(dependencies: Promise<void>[]): void {
    this.storageCleanupRevision += 1;
    const previous = this.storageCleanupTail;
    this.storageCleanupTail = (async () => {
      await previous.catch(() => undefined);
      await Promise.allSettled(dependencies);
      await this.store.purgeAll().catch(() => undefined);
    })();
  }

  private async waitForStorageCleanup(): Promise<void> {
    await this.bootstrap();
    let observedRevision = -1;
    while (observedRevision !== this.storageCleanupRevision) {
      observedRevision = this.storageCleanupRevision;
      await this.storageCleanupTail.catch(() => undefined);
    }
  }

  private async waitForRetiredRuns(): Promise<void> {
    let observedRevision = -1;
    while (observedRevision !== this.retiredRunRevision) {
      observedRevision = this.retiredRunRevision;
      await this.retiredRunTail;
    }
  }

  private discardCurrent(current: CurrentFileRecord): Promise<void> {
    if (!current.discardPromise) {
      current.discardPromise = current.sink.discard().catch(() => undefined);
    }
    return current.discardPromise;
  }

  private discardTempFile(current: CurrentFileRecord): Promise<void> {
    if (this.fence?.current === current) {
      return this.fence.done.promise;
    }
    if (this.current === current) {
      this.current = null;
    }
    return this.discardCurrent(current);
  }

  private settleCommitFence(record: CommitFenceRecord): Promise<void> {
    if (!record.settlePromise) {
      record.settlePromise = (async () => {
        try {
          if (this.current === record.current) {
            this.current = null;
          }
          await this.discardCurrent(record.current);
        } finally {
          if (this.fence === record) {
            this.fence = null;
          }
          record.done.resolve();
        }
        // A background/sign-out transition may have queued a namespace purge
        // behind this exact-file fence. Settling owns that tail as well.
        await this.waitForStorageCleanup();
      })();
    }
    return record.settlePromise;
  }
}

export function createPhotoSaveTempCoordinator(
  store: ProtectedFileStore = nativePhotoSaveFileStore,
): PhotoSaveTempCoordinator {
  return new DefaultPhotoSaveTempCoordinator(store);
}

export const photoSaveTempCoordinator = createPhotoSaveTempCoordinator();
