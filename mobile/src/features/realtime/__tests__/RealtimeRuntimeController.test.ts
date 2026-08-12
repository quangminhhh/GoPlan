import type {
  ConnectivitySnapshot,
  PublishedAuthLifecycleSnapshot,
  RealtimeAppState,
} from '../types';
import { RealtimeRuntimeController } from '../application/RealtimeRuntimeController';
import {
  deferred,
  FakeAppStateObserver,
  FakeAuthSource,
  FakeManager,
  FakeNetworkObserver,
  flushPromises,
} from '../testing/fakes';

const ACTIVE_AUTH: PublishedAuthLifecycleSnapshot = {
  phase: 'active',
  sessionGeneration: 1,
  credentialRevision: 0,
  publishedCredentialRevision: 0,
  access: 'access-0',
};

function makeHarness(
  authSnapshot: PublishedAuthLifecycleSnapshot = ACTIVE_AUTH,
  appState: RealtimeAppState = 'active',
  networkSnapshot: ConnectivitySnapshot = {
    availability: 'unknown',
    type: null,
  },
) {
  const manager = new FakeManager();
  const auth = new FakeAuthSource(authSnapshot);
  const app = new FakeAppStateObserver(appState);
  const network = new FakeNetworkObserver(networkSnapshot);
  const controller = new RealtimeRuntimeController({ manager, auth, appState: app, network });
  return { manager, auth, app, network, controller };
}

describe('RealtimeRuntimeController', () => {
  it('connects only when active credentials have actually been published', async () => {
    const value = makeHarness({
      ...ACTIVE_AUTH,
      credentialRevision: 1,
      publishedCredentialRevision: 0,
      access: 'old-access',
    });

    value.controller.start();
    await flushPromises();
    expect(value.manager.connectCalls).toHaveLength(0);
    expect(value.manager.disconnectCalls).toContain('auth');

    value.auth.emit({
      ...ACTIVE_AUTH,
      credentialRevision: 1,
      publishedCredentialRevision: 1,
      access: 'rotated-access',
    });
    expect(value.manager.connectCalls).toContainEqual({
      sessionGeneration: 1,
      credentialRevision: 1,
    });
  });

  it('disconnects synchronously at credential rotation and reconnects after publication', async () => {
    const value = makeHarness();
    value.controller.start();
    await flushPromises();
    const connectsBeforeRotation = value.manager.connectCalls.length;

    value.auth.emit({
      ...ACTIVE_AUTH,
      credentialRevision: 1,
      publishedCredentialRevision: 0,
      access: 'access-0',
    });
    expect(value.manager.disconnectCalls.at(-1)).toBe('auth');
    expect(value.manager.connectCalls).toHaveLength(connectsBeforeRotation);

    value.auth.emit({
      ...ACTIVE_AUTH,
      credentialRevision: 1,
      publishedCredentialRevision: 1,
      access: 'access-1',
    });
    expect(value.manager.connectCalls.at(-1)).toEqual({
      sessionGeneration: 1,
      credentialRevision: 1,
    });
  });

  it('disconnects and reconnects across background and confirmed offline transitions', async () => {
    const value = makeHarness();
    value.controller.start();
    await flushPromises();

    value.app.emit('inactive');
    expect(value.manager.disconnectCalls.at(-1)).toBe('background');
    value.app.emit('active');
    expect(value.manager.connectCalls.at(-1)).toEqual({
      sessionGeneration: 1,
      credentialRevision: 0,
    });

    value.network.emit({ availability: 'offline', type: null });
    expect(value.manager.disconnectCalls.at(-1)).toBe('offline');
    const beforeOnline = value.manager.connectCalls.length;
    value.network.emit({ availability: 'online', type: 'WIFI' });
    expect(value.manager.connectCalls).toHaveLength(beforeOnline + 1);
  });

  it('restarts once for a real online network handoff and dedupes identical observations', async () => {
    const value = makeHarness(ACTIVE_AUTH, 'active', {
      availability: 'online',
      type: 'WIFI',
    });
    value.controller.start();
    await flushPromises();

    value.network.emit({ availability: 'online', type: 'WIFI' });
    expect(value.manager.restartCalls).toHaveLength(0);
    value.network.emit({ availability: 'online', type: 'CELLULAR' });
    value.network.emit({ availability: 'online', type: 'CELLULAR' });
    expect(value.manager.restartCalls).toEqual([
      { sessionGeneration: 1, credentialRevision: 0 },
    ]);
  });

  it('does not recycle the socket for indeterminate type noise around a known online path', async () => {
    const value = makeHarness(ACTIVE_AUTH, 'active', {
      availability: 'online',
      type: 'WIFI',
    });
    value.controller.start();
    await flushPromises();

    value.network.emit({ availability: 'unknown', type: null });
    value.network.emit({ availability: 'online', type: null });
    value.network.emit({ availability: 'online', type: 'WIFI' });

    expect(value.manager.restartCalls).toHaveLength(0);
    expect(value.manager.disconnectCalls).not.toContain('offline');
  });

  it('ignores a stale initial network read after a newer listener event', async () => {
    const value = makeHarness();
    const initial = deferred<ConnectivitySnapshot>();
    value.network.currentResult = initial.promise;
    value.controller.start();
    value.network.emit({ availability: 'online', type: 'WIFI' });
    const disconnectsBeforeStaleRead = value.manager.disconnectCalls.length;

    initial.resolve({ availability: 'offline', type: null });
    await flushPromises();
    expect(value.manager.disconnectCalls).toHaveLength(disconnectsBeforeStaleRead);
  });

  it('unsubscribes every source and ignores events after stop', async () => {
    const value = makeHarness();
    value.controller.start();
    await flushPromises();
    value.controller.stop();
    const callsAfterStop = value.manager.connectCalls.length;

    expect(value.auth.listenerCount).toBe(0);
    expect(value.app.listenerCount).toBe(0);
    expect(value.network.listenerCount).toBe(0);
    expect(value.manager.disconnectCalls.at(-1)).toBe('unmount');

    value.auth.emit(ACTIVE_AUTH);
    value.app.emit('active');
    value.network.emit({ availability: 'online', type: 'WIFI' });
    expect(value.manager.connectCalls).toHaveLength(callsAfterStop);
  });
});
