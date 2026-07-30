import {
  __resetPrivateMediaLifecycleForTests,
  acquirePrivateTransferLease,
  beginPrivateMediaShutdown,
  endPrivateMediaSession,
  flushPrivateMediaPurge,
  getPrivateMediaEpoch,
  getPrivateMediaGeneration,
  getPrivateTransferLeaseCount,
  isPrivateMediaSessionOpen,
  registerPrivateMediaPurger,
  resumePrivateMediaSession,
  startPrivateMediaSession,
  subscribeToPrivateMediaGeneration,
  suspendPrivateMediaSession,
  trackPrivateOperation,
  waitForPrivateNetworkIdle,
} from '../privateMediaLifecycle';
import { createDeferred, flushMicrotasks } from '@test/fakeProtectedTransport';

const purgeLog: string[] = [];
let protectedPurge: () => Promise<void> = async () => {
  purgeLog.push('protected-assets');
};

registerPrivateMediaPurger('protected-assets', () => protectedPurge());
registerPrivateMediaPurger('upload-temp', async () => {
  purgeLog.push('upload-temp');
});

beforeEach(() => {
  __resetPrivateMediaLifecycleForTests();
  purgeLog.length = 0;
  protectedPurge = async () => {
    purgeLog.push('protected-assets');
  };
});

describe('session gate', () => {
  it('starts closed and refuses work until a session is opened', async () => {
    expect(isPrivateMediaSessionOpen()).toBe(false);

    await expect(trackPrivateOperation(async () => 'never')).rejects.toMatchObject({
      kind: 'cancelled',
    });
  });

  it('purges both namespaces before opening the gate', async () => {
    const opened: boolean[] = [];
    protectedPurge = async () => {
      opened.push(isPrivateMediaSessionOpen());
      purgeLog.push('protected-assets');
    };

    await startPrivateMediaSession();

    // Startup cleanup must complete before any protected route can render.
    expect(opened).toEqual([false]);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);
    expect(isPrivateMediaSessionOpen()).toBe(true);
  });

  it('runs the whole shutdown front half synchronously', async () => {
    await startPrivateMediaSession();
    const epochBefore = getPrivateMediaEpoch();
    const generationBefore = getPrivateMediaGeneration();

    let abortedSynchronously = false;
    const gate = createDeferred<void>();
    void trackPrivateOperation(async (signal) => {
      signal.addEventListener('abort', () => {
        abortedSynchronously = true;
      });
      await gate.promise;
      return null;
    }).catch(() => undefined);
    await flushMicrotasks();

    beginPrivateMediaShutdown();

    // No awaits in between: by the time control returns, the epoch has moved,
    // the gate is shut and every controller is aborted — so nothing in flight
    // can still observe the old epoch and commit.
    expect(getPrivateMediaEpoch()).toBe(epochBefore + 1);
    expect(getPrivateMediaGeneration()).toBe(generationBefore + 1);
    expect(isPrivateMediaSessionOpen()).toBe(false);
    expect(abortedSynchronously).toBe(true);

    gate.resolve();
    await flushPrivateMediaPurge();
  });
});

describe('private network activity barrier', () => {
  it('waits for an operation that is already running, including its nested retry', async () => {
    await startPrivateMediaSession();
    const firstAttempt = createDeferred<void>();
    const retry = createDeferred<void>();
    let finished = false;

    const operation = trackPrivateOperation(async () => {
      await firstAttempt.promise;
      // Stands in for the Axios interceptor refreshing and replaying the request
      // inside the same operation promise.
      await retry.promise;
      finished = true;
      return 'done';
    });

    beginPrivateMediaShutdown();
    let idle = false;
    const waiting = waitForPrivateNetworkIdle().then(() => {
      idle = true;
    });

    firstAttempt.resolve();
    await flushMicrotasks();
    expect(idle).toBe(false);

    retry.resolve();
    await waiting;

    expect(idle).toBe(true);
    expect(finished).toBe(true);
    await expect(operation).resolves.toBe('done');
  });

  it('never starts activity of its own', async () => {
    await startPrivateMediaSession();
    await expect(waitForPrivateNetworkIdle()).resolves.toBeUndefined();
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);
  });

  it('unregisters an operation once it settles', async () => {
    await startPrivateMediaSession();
    await trackPrivateOperation(async () => 'value');

    let idle = false;
    await waitForPrivateNetworkIdle().then(() => {
      idle = true;
    });
    expect(idle).toBe(true);
  });

  it('unregisters an operation that rejects', async () => {
    await startPrivateMediaSession();
    await expect(
      trackPrivateOperation(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(waitForPrivateNetworkIdle()).resolves.toBeUndefined();
  });
});

describe('transfer leases', () => {
  it('defers a background purge while a transfer holds files it still needs', async () => {
    await startPrivateMediaSession();
    purgeLog.length = 0;
    const release = acquirePrivateTransferLease();

    suspendPrivateMediaSession();

    // New work is refused, but the epoch has not moved and nothing was deleted:
    // an upload mid-batch keeps its temp files.
    expect(isPrivateMediaSessionOpen()).toBe(false);
    expect(getPrivateMediaEpoch()).toBe(0);
    expect(purgeLog).toEqual([]);

    release();
    await flushPrivateMediaPurge();

    expect(getPrivateMediaEpoch()).toBe(1);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);
  });

  it('cancels a deferred purge when the app foregrounds before the lease releases', async () => {
    await startPrivateMediaSession();
    purgeLog.length = 0;
    const release = acquirePrivateTransferLease();

    suspendPrivateMediaSession();
    await resumePrivateMediaSession();
    release();
    await flushPrivateMediaPurge();

    expect(isPrivateMediaSessionOpen()).toBe(true);
    expect(getPrivateMediaEpoch()).toBe(0);
    expect(purgeLog).toEqual([]);
  });

  it('purges immediately on background when nothing holds a lease', async () => {
    await startPrivateMediaSession();
    purgeLog.length = 0;

    suspendPrivateMediaSession();
    await flushPrivateMediaPurge();

    expect(getPrivateMediaEpoch()).toBe(1);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);
  });

  it('lets sign-out override an active lease', async () => {
    await startPrivateMediaSession();
    purgeLog.length = 0;
    const release = acquirePrivateTransferLease();

    beginPrivateMediaShutdown();
    await flushPrivateMediaPurge();

    expect(getPrivateMediaEpoch()).toBe(1);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);

    // Releasing afterwards must not run a second front half.
    release();
    await flushPrivateMediaPurge();
    expect(getPrivateMediaEpoch()).toBe(1);
  });

  it('refuses a new lease once the gate is closed', async () => {
    await startPrivateMediaSession();
    suspendPrivateMediaSession();

    expect(() => acquirePrivateTransferLease()).toThrow(
      expect.objectContaining({ kind: 'cancelled' }),
    );
    expect(getPrivateTransferLeaseCount()).toBe(0);
  });

  it('counts a double release only once', async () => {
    await startPrivateMediaSession();
    const release = acquirePrivateTransferLease();
    expect(getPrivateTransferLeaseCount()).toBe(1);

    release();
    release();

    expect(getPrivateTransferLeaseCount()).toBe(0);
  });
});

describe('foreground ordering', () => {
  it('settles the deferred purge, then opens the gate, then publishes the generation', async () => {
    await startPrivateMediaSession();
    const events: string[] = [];
    const purgeGate = createDeferred<void>();
    protectedPurge = async () => {
      events.push('purge-start');
      await purgeGate.promise;
      events.push('purge-end');
    };
    subscribeToPrivateMediaGeneration(() => {
      events.push(`generation:gate=${isPrivateMediaSessionOpen()}`);
    });

    suspendPrivateMediaSession();
    const resuming = resumePrivateMediaSession();
    await flushMicrotasks();

    // The gate is still shut while cleanup runs, so a mounted image cannot slip
    // a request in between the purge and the reacquire signal.
    expect(isPrivateMediaSessionOpen()).toBe(false);

    purgeGate.resolve();
    await resuming;

    expect(events).toEqual([
      'generation:gate=false',
      'purge-start',
      'purge-end',
      'generation:gate=true',
    ]);
  });

  it('does not reopen the gate after sign-out', async () => {
    await startPrivateMediaSession();
    beginPrivateMediaShutdown();

    await resumePrivateMediaSession();

    expect(isPrivateMediaSessionOpen()).toBe(false);
  });
});

describe('serialized purge queue', () => {
  it('never runs cleanup from the old session concurrently with the new one', async () => {
    const events: string[] = [];
    const slowPurge = createDeferred<void>();
    let purgeIndex = 0;
    protectedPurge = async () => {
      purgeIndex += 1;
      const label = `purge-${purgeIndex}`;
      events.push(`${label}:start`);
      if (purgeIndex === 2) {
        await slowPurge.promise;
      }
      events.push(`${label}:end`);
    };

    await startPrivateMediaSession();
    beginPrivateMediaShutdown();

    const startingSessionB = startPrivateMediaSession();
    await flushMicrotasks();

    // Session B has not opened its gate while session A's cleanup is unfinished.
    expect(isPrivateMediaSessionOpen()).toBe(false);

    slowPurge.resolve();
    await startingSessionB;

    expect(isPrivateMediaSessionOpen()).toBe(true);
    expect(events).toEqual([
      'purge-1:start',
      'purge-1:end',
      'purge-2:start',
      'purge-2:end',
      'purge-3:start',
      'purge-3:end',
    ]);
  });

  it('keeps draining when a purger throws', async () => {
    protectedPurge = async () => {
      throw new Error('cache directory busy');
    };

    await startPrivateMediaSession();

    expect(isPrivateMediaSessionOpen()).toBe(true);
    expect(purgeLog).toEqual(['upload-temp']);
  });
});

describe('endPrivateMediaSession', () => {
  it('closes the gate, waits for existing activity and drains the purge', async () => {
    await startPrivateMediaSession();
    const gate = createDeferred<void>();
    let settled = false;
    const operation = trackPrivateOperation(async () => {
      await gate.promise;
      settled = true;
      return null;
    });
    purgeLog.length = 0;

    const ending = endPrivateMediaSession();
    await flushMicrotasks();
    expect(settled).toBe(false);

    gate.resolve();
    await ending;

    expect(settled).toBe(true);
    expect(isPrivateMediaSessionOpen()).toBe(false);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);
    await expect(operation).resolves.toBeNull();
  });
});
