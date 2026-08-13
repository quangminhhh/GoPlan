import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  getAuthSnapshot,
  subscribeAuthLifecycle,
} from '@/shared/api/authSessionLifecycle';
import type {
  AppStateObserver,
  AuthLifecycleSource,
  NetworkObserver,
  RealtimeManager,
  RealtimeSnapshot,
  RealtimeTransport,
} from '../types';
import { nativeAppStateObserver } from '../infrastructure/app-state-observer';
import { expoNetworkObserver } from '../infrastructure/expo-network-observer';
import { createDefaultWebSocketManager } from '../infrastructure/WebSocketManager';
import { RealtimeRuntimeController } from './RealtimeRuntimeController';

const RealtimeTransportContext = createContext<RealtimeTransport | null>(null);
const RealtimeSnapshotContext = createContext<RealtimeSnapshot | null>(null);

const nativeAuthLifecycleSource: AuthLifecycleSource = {
  getSnapshot: getAuthSnapshot,
  subscribe: subscribeAuthLifecycle,
};

export interface RealtimeProviderProps extends PropsWithChildren {
  manager?: RealtimeManager;
  authSource?: AuthLifecycleSource;
  appStateObserver?: AppStateObserver;
  networkObserver?: NetworkObserver;
}

export function RealtimeProvider({
  children,
  manager: injectedManager,
  authSource = nativeAuthLifecycleSource,
  appStateObserver = nativeAppStateObserver,
  networkObserver = expoNetworkObserver,
}: RealtimeProviderProps) {
  const [manager] = useState<RealtimeManager>(
    () => injectedManager ?? createDefaultWebSocketManager(),
  );
  const [snapshot, setSnapshot] = useState<RealtimeSnapshot>(() =>
    manager.getSnapshot(),
  );
  const runtimeGenerationRef = useRef(0);

  useEffect(() => {
    runtimeGenerationRef.current += 1;
    const runtimeGeneration = runtimeGenerationRef.current;
    const unsubscribeSnapshot = manager.subscribeSnapshot(setSnapshot);
    const controller = new RealtimeRuntimeController({
      manager,
      auth: authSource,
      appState: appStateObserver,
      network: networkObserver,
    });
    controller.start();
    return () => {
      // Stop React delivery first, then invalidate transport work. Deferring
      // destroy by one microtask keeps React Strict Mode's effect replay usable;
      // a replacement effect advances the generation and cancels destruction.
      unsubscribeSnapshot();
      controller.stop();
      void Promise.resolve().then(() => {
        if (runtimeGenerationRef.current === runtimeGeneration) {
          manager.destroy();
        }
      });
    };
  }, [appStateObserver, authSource, manager, networkObserver]);

  const transport = useMemo<RealtimeTransport>(
    () => ({
      send: (message) => manager.send(message),
      retryConnection: () => manager.retryConnection(),
      subscribe: (type, listener) => manager.subscribe(type, listener),
      subscribeAll: (listener) => manager.subscribeAll(listener),
    }),
    [manager],
  );

  return (
    <RealtimeTransportContext.Provider value={transport}>
      <RealtimeSnapshotContext.Provider value={snapshot}>
        {children}
      </RealtimeSnapshotContext.Provider>
    </RealtimeTransportContext.Provider>
  );
}

export function useRealtimeTransport(): RealtimeTransport {
  const context = useContext(RealtimeTransportContext);
  if (!context) {
    throw new Error('useRealtimeTransport must be used within RealtimeProvider');
  }
  return context;
}

export function useRealtimeSnapshot(): RealtimeSnapshot {
  const context = useContext(RealtimeSnapshotContext);
  if (!context) {
    throw new Error('useRealtimeSnapshot must be used within RealtimeProvider');
  }
  return context;
}
