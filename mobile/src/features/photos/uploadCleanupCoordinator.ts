/**
 * Process-wide ownership barrier for trip-photo upload native resources.
 *
 * A hook can disappear while its picker, encoder, upload temp, or session
 * cancellation is still settling. Publishing that cleanup here prevents a new
 * auth session (and therefore a new hook instance) from constructing upload
 * work on top of resources still owned by the previous session.
 */

export interface UploadCleanupCoordinator {
  /** Publishes cleanup synchronously and resolves after the complete tail. */
  publish(cleanups: readonly (PromiseLike<unknown> | null)[]): Promise<void>;
  /** Waits for a stable tail; callers must re-check auth/trip tickets after it. */
  waitForCleanup(): Promise<void>;
}

class ProcessUploadCleanupCoordinator implements UploadCleanupCoordinator {
  private cleanupTail: Promise<void> = Promise.resolve();

  publish(cleanups: readonly (PromiseLike<unknown> | null)[]): Promise<void> {
    const previousTail = this.cleanupTail;
    const pending = cleanups.filter(
      (cleanup): cleanup is PromiseLike<unknown> => cleanup !== null,
    );
    const nextTail = Promise.allSettled([previousTail, ...pending]).then(
      () => undefined,
    );
    this.cleanupTail = nextTail;
    return nextTail;
  }

  async waitForCleanup(): Promise<void> {
    for (;;) {
      const observed = this.cleanupTail;
      await observed;
      if (observed === this.cleanupTail) return;
    }
  }
}

export const uploadCleanupCoordinator: UploadCleanupCoordinator =
  new ProcessUploadCleanupCoordinator();
