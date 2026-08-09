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
  trackPrivateTransferOperation,
  waitForPrivateNetworkIdle,
} from '../privateMediaLifecycle';
import { createDeferred, flushMicrotasks } from '@test/fakeProtectedTransport';

const purgeLog: string[] = [];
let protectedPurge: () => Promise<void> = async () => {
  purgeLog.push('protected-assets');
};
let uploadPurge: () => Promise<void> = async () => {
  purgeLog.push('upload-temp');
};

registerPrivateMediaPurger('protected-assets', () => protectedPurge());
registerPrivateMediaPurger('upload-temp', () => uploadPurge());

beforeEach(() => {
  __resetPrivateMediaLifecycleForTests();
  purgeLog.length = 0;
  protectedPurge = async () => {
    purgeLog.push('protected-assets');
  };
  uploadPurge = async () => {
    purgeLog.push('upload-temp');
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
  it('invalidates protected work immediately while a held upload lease fences only upload temp', async () => {
    await startPrivateMediaSession();
    purgeLog.length = 0;
    const release = acquirePrivateTransferLease();
    const transferResult = createDeferred<void>();
    let transferAborted = false;
    const transfer = trackPrivateTransferOperation(async (signal) => {
      signal.addEventListener('abort', () => {
        transferAborted = true;
      });
      try {
        await transferResult.promise;
      } finally {
        release();
      }
    });
    let protectedAborted = false;
    const protectedWork = trackPrivateOperation(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          protectedAborted = true;
          resolve();
        });
      });
    });

    suspendPrivateMediaSession();

    // The privacy boundary is synchronous even though upload-temp is still in
    // use by the operation that already started.
    expect(isPrivateMediaSessionOpen()).toBe(false);
    expect(getPrivateMediaEpoch()).toBe(1);
    expect(protectedAborted).toBe(true);
    expect(transferAborted).toBe(false);
    expect(getPrivateTransferLeaseCount()).toBe(1);

    await protectedWork;
    await flushMicrotasks();
    expect(purgeLog).toEqual(['protected-assets']);

    transferResult.resolve();
    await transfer;
    await flushPrivateMediaPurge();

    expect(getPrivateMediaEpoch()).toBe(1);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);
  });

  it('does not cancel protected cleanup or reopen early when foreground wins before release', async () => {
    await startPrivateMediaSession();
    purgeLog.length = 0;
    const protectedStarted = createDeferred<void>();
    const protectedGate = createDeferred<void>();
    protectedPurge = async () => {
      purgeLog.push('protected-assets');
      protectedStarted.resolve();
      await protectedGate.promise;
    };
    const release = acquirePrivateTransferLease();

    suspendPrivateMediaSession();
    const resuming = resumePrivateMediaSession();
    await protectedStarted.promise;

    expect(getPrivateMediaEpoch()).toBe(1);
    expect(isPrivateMediaSessionOpen()).toBe(false);
    expect(purgeLog).toEqual(['protected-assets']);

    protectedGate.resolve();
    await flushMicrotasks();
    // The protected barrier completed, but the separate upload-temp barrier is
    // still fenced and the acquisition gate cannot admit a second transfer.
    expect(isPrivateMediaSessionOpen()).toBe(false);

    release();
    await resuming;

    expect(isPrivateMediaSessionOpen()).toBe(true);
    expect(getPrivateMediaEpoch()).toBe(1);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);
  });

  it('runs upload-temp purge after release when the lease releases before resume continues', async () => {
    await startPrivateMediaSession();
    purgeLog.length = 0;
    const release = acquirePrivateTransferLease();

    suspendPrivateMediaSession();
    const resuming = resumePrivateMediaSession();
    // Foreground intent is synchronous, but the purge-tail drain yields. Releasing
    // here exercises that hand-off rather than the already-settled resume case.
    release();
    await resuming;
    await flushPrivateMediaPurge();

    expect(isPrivateMediaSessionOpen()).toBe(true);
    expect(getPrivateMediaEpoch()).toBe(1);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);
  });

  it('handles repeated background and foreground transitions without duplicate invalidation', async () => {
    await startPrivateMediaSession();
    purgeLog.length = 0;

    suspendPrivateMediaSession();
    suspendPrivateMediaSession();
    const firstResume = resumePrivateMediaSession();
    const duplicateResume = resumePrivateMediaSession();
    await Promise.all([firstResume, duplicateResume]);

    expect(getPrivateMediaEpoch()).toBe(1);
    expect(isPrivateMediaSessionOpen()).toBe(true);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);

    suspendPrivateMediaSession();
    await resumePrivateMediaSession();

    expect(getPrivateMediaEpoch()).toBe(2);
    expect(isPrivateMediaSessionOpen()).toBe(true);
    expect(purgeLog).toEqual([
      'protected-assets',
      'upload-temp',
      'protected-assets',
      'upload-temp',
    ]);
  });

  it('purges immediately on background when nothing holds a lease', async () => {
    await startPrivateMediaSession();
    purgeLog.length = 0;

    suspendPrivateMediaSession();
    await flushPrivateMediaPurge();

    expect(getPrivateMediaEpoch()).toBe(1);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);
  });

  it('purges protected cache immediately on sign-out but fences upload temp until its request settles', async () => {
    await startPrivateMediaSession();
    purgeLog.length = 0;
    const request = createDeferred<void>();
    const appOwnedUploadTemps = new Set(['file:///goplan-photo-upload/request-body.jpg']);
    let uploadPurgeRanUnderLease = false;
    uploadPurge = async () => {
      uploadPurgeRanUnderLease = getPrivateTransferLeaseCount() > 0;
      purgeLog.push('upload-temp');
      appOwnedUploadTemps.clear();
    };

    const release = acquirePrivateTransferLease();
    let transferAborted = false;
    const operation = trackPrivateTransferOperation(async (signal) => {
      expect(signal.aborted).toBe(false);
      signal.addEventListener('abort', () => {
        transferAborted = true;
      });
      try {
        // Model a native/Axios request that observes abort but cannot release its
        // file synchronously. Its promise owns the request-body lease until the
        // underlying transport settles.
        await request.promise;
      } finally {
        expect(appOwnedUploadTemps.size).toBe(1);
        release();
      }
    });

    beginPrivateMediaShutdown();
    expect(transferAborted).toBe(true);
    await flushMicrotasks();

    expect(getPrivateMediaEpoch()).toBe(1);
    expect(purgeLog).toEqual(['protected-assets']);
    expect(appOwnedUploadTemps.size).toBe(1);
    expect(getPrivateTransferLeaseCount()).toBe(1);

    let purgeFinished = false;
    const purging = flushPrivateMediaPurge().then(() => {
      purgeFinished = true;
    });
    await flushMicrotasks();
    expect(purgeFinished).toBe(false);

    request.resolve();
    await operation;
    await purging;

    expect(uploadPurgeRanUnderLease).toBe(false);
    expect(purgeLog).toEqual(['protected-assets', 'upload-temp']);
    expect(appOwnedUploadTemps.size).toBe(0);
    expect(getPrivateTransferLeaseCount()).toBe(0);
    expect(getPrivateMediaEpoch()).toBe(1);
    await expect(waitForPrivateNetworkIdle()).resolves.toBeUndefined();
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
  it('does not open between a same-turn resume and the startup purge enqueue', async () => {
    const purgeStarted = createDeferred<void>();
    const purgeGate = createDeferred<void>();
    let gateWhenPurgeStarted: boolean | undefined;
    protectedPurge = async () => {
      gateWhenPurgeStarted = isPrivateMediaSessionOpen();
      purgeStarted.resolve();
      await purgeGate.promise;
    };

    // Do not yield between these calls. This is the AppState ordering that used
    // to let resume flush the old settled tail before start appended its purge.
    const starting = startPrivateMediaSession();
    suspendPrivateMediaSession();
    const resuming = resumePrivateMediaSession();

    await purgeStarted.promise;
    expect(gateWhenPurgeStarted).toBe(false);
    expect(isPrivateMediaSessionOpen()).toBe(false);

    purgeGate.resolve();
    await Promise.all([starting, resuming]);
    expect(isPrivateMediaSessionOpen()).toBe(true);
  });

  it('does not reopen after backgrounding while the startup purge is still running', async () => {
    const purgeGate = createDeferred<void>();
    protectedPurge = async () => {
      await purgeGate.promise;
    };

    const starting = startPrivateMediaSession();
    await flushMicrotasks();
    suspendPrivateMediaSession();
    purgeGate.resolve();
    await starting;

    expect(isPrivateMediaSessionOpen()).toBe(false);

    await resumePrivateMediaSession();
    expect(isPrivateMediaSessionOpen()).toBe(true);
  });

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

  it('does not let an old resume reopen a newer session before its purge completes', async () => {
    const oldResumePurge = createDeferred<void>();
    const newSessionPurgeStarted = createDeferred<void>();
    const newSessionPurge = createDeferred<void>();
    let purgeIndex = 0;
    protectedPurge = async () => {
      purgeIndex += 1;
      if (purgeIndex === 2) {
        await oldResumePurge.promise;
      }
      if (purgeIndex === 4) {
        newSessionPurgeStarted.resolve();
        await newSessionPurge.promise;
      }
    };

    await startPrivateMediaSession();
    suspendPrivateMediaSession();
    const oldResume = resumePrivateMediaSession();
    await flushMicrotasks();

    beginPrivateMediaShutdown();
    const newSession = startPrivateMediaSession();
    oldResumePurge.resolve();
    await newSessionPurgeStarted.promise;

    // The old resume continuation belongs to the previous activation. Even
    // though the new start has made `sessionActive` true again, it must not open
    // the gate while that new start's own purge is still running.
    expect(isPrivateMediaSessionOpen()).toBe(false);

    newSessionPurge.resolve();
    await Promise.all([oldResume, newSession]);
    expect(isPrivateMediaSessionOpen()).toBe(true);
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
