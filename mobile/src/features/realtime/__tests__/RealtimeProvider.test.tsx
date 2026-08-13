import { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import {
  RealtimeProvider,
  useRealtimeSnapshot,
  useRealtimeTransport,
} from '../application/RealtimeProvider';
import type { RealtimeSnapshot, RealtimeTransport } from '../types';
import {
  FakeAppStateObserver,
  FakeAuthSource,
  FakeManager,
  FakeNetworkObserver,
  flushPromises,
} from '../testing/fakes';

const auth = {
  phase: 'active' as const,
  sessionGeneration: 1,
  credentialRevision: 0,
  publishedCredentialRevision: 0,
  access: 'access',
};

describe('RealtimeProvider', () => {
  it('keeps transport commands stable while publishing snapshot changes separately', async () => {
    const manager = new FakeManager();
    const authSource = new FakeAuthSource(auth);
    const appState = new FakeAppStateObserver('active');
    const network = new FakeNetworkObserver({
      availability: 'unknown',
      type: null,
    });
    const transports: RealtimeTransport[] = [];
    const snapshots: RealtimeSnapshot[] = [];

    function TransportProbe() {
      const transport = useRealtimeTransport();
      useEffect(() => {
        transports.push(transport);
      }, [transport]);
      return null;
    }

    function SnapshotProbe() {
      const snapshot = useRealtimeSnapshot();
      useEffect(() => {
        snapshots.push(snapshot);
      }, [snapshot]);
      return null;
    }

    const view = await render(
      <RealtimeProvider
        manager={manager}
        authSource={authSource}
        appStateObserver={appState}
        networkObserver={network}
      >
        <TransportProbe />
        <SnapshotProbe />
      </RealtimeProvider>,
    );
    await act(async () => {
      manager.emitSnapshot({ status: 'connected', connectionEpoch: 1 });
    });

    expect(transports).toHaveLength(1);
    expect(transports[0]?.retryConnection()).toBe(true);
    expect(manager.retryConnectionCalls).toBe(1);
    await waitFor(() => {
      expect(snapshots.at(-1)).toEqual({ status: 'connected', connectionEpoch: 1 });
    });

    await view.unmount();
    await flushPromises();
    expect(manager.events.indexOf('unsubscribeSnapshot')).toBeLessThan(
      manager.events.indexOf('disconnect:unmount'),
    );
    expect(manager.events.indexOf('disconnect:unmount')).toBeLessThan(
      manager.events.indexOf('destroy'),
    );
  });
});
