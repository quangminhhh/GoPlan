import type {
  AppStateObserver,
  AuthLifecycleSource,
  ConnectivitySnapshot,
  NetworkObserver,
  PublishedAuthLifecycleSnapshot,
  RealtimeDisconnectReason,
  RealtimeManager,
  RealtimeOwner,
} from '../types';

export interface RealtimeRuntimeControllerDependencies {
  manager: RealtimeManager;
  auth: AuthLifecycleSource;
  appState: AppStateObserver;
  network: NetworkObserver;
}

function ownerFromAuth(
  snapshot: PublishedAuthLifecycleSnapshot,
): RealtimeOwner | null {
  if (
    snapshot.phase !== 'active' ||
    snapshot.access === null ||
    snapshot.publishedCredentialRevision === null ||
    snapshot.publishedCredentialRevision !== snapshot.credentialRevision
  ) {
    return null;
  }
  return {
    sessionGeneration: snapshot.sessionGeneration,
    credentialRevision: snapshot.credentialRevision,
  };
}

function sameConnectivity(
  left: ConnectivitySnapshot,
  right: ConnectivitySnapshot,
): boolean {
  return left.availability === right.availability && left.type === right.type;
}

export class RealtimeRuntimeController {
  private authSnapshot: PublishedAuthLifecycleSnapshot | null = null;
  private appIsActive = false;
  private connectivity: ConnectivitySnapshot = {
    availability: 'unknown',
    type: null,
  };
  private lastKnownOnlineType: string | null = null;
  private networkObservationVersion = 0;
  private started = false;
  private unsubscribers: (() => void)[] = [];

  constructor(private readonly dependencies: RealtimeRuntimeControllerDependencies) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubscribers = [
      this.dependencies.auth.subscribe((snapshot) => this.applyAuth(snapshot)),
      this.dependencies.appState.subscribe((state) => this.applyAppState(state)),
      this.dependencies.network.subscribe((snapshot) => {
        this.networkObservationVersion += 1;
        this.applyConnectivity(snapshot);
      }),
    ];

    // Subscribe first, then perform atomic reads so a transition between setup
    // and the initial snapshot cannot be missed.
    this.applyAuth(this.dependencies.auth.getSnapshot());
    this.applyAppState(this.dependencies.appState.getCurrent());

    const requestVersion = this.networkObservationVersion;
    void this.dependencies.network
      .getCurrent()
      .then((snapshot) => {
        if (
          this.started &&
          requestVersion === this.networkObservationVersion
        ) {
          this.applyConnectivity(snapshot);
        }
      })
      .catch(() => {
        // Unknown remains eligible; heartbeat is the fallback for observer errors.
      });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.networkObservationVersion += 1;
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.dependencies.manager.disconnect('unmount');
  }

  private applyAuth(snapshot: PublishedAuthLifecycleSnapshot): void {
    if (!this.started) return;
    this.authSnapshot = snapshot;
    this.synchronize();
  }

  private applyAppState(state: 'active' | 'inactive'): void {
    if (!this.started) return;
    const nextActive = state === 'active';
    if (this.appIsActive === nextActive) return;
    this.appIsActive = nextActive;
    this.synchronize();
  }

  private applyConnectivity(snapshot: ConnectivitySnapshot): void {
    if (!this.started || sameConnectivity(this.connectivity, snapshot)) return;

    const wasOffline = this.connectivity.availability === 'offline';
    let networkHandoff = false;

    if (snapshot.availability === 'offline') {
      this.lastKnownOnlineType = null;
    } else if (snapshot.availability === 'online' && snapshot.type !== null) {
      networkHandoff =
        !wasOffline &&
        this.lastKnownOnlineType !== null &&
        this.lastKnownOnlineType !== snapshot.type;
      this.lastKnownOnlineType = snapshot.type;
    }

    this.connectivity = snapshot;
    this.synchronize(networkHandoff);
  }

  private synchronize(networkHandoff = false): void {
    const blocked = this.blockReason();
    if (blocked !== null) {
      this.dependencies.manager.disconnect(blocked);
      return;
    }

    const auth = this.authSnapshot;
    if (auth === null) {
      this.dependencies.manager.disconnect('auth');
      return;
    }
    const owner = ownerFromAuth(auth);
    if (owner === null) {
      this.dependencies.manager.disconnect('auth');
      return;
    }

    if (networkHandoff) {
      this.dependencies.manager.restart(owner);
    } else {
      this.dependencies.manager.connect(owner);
    }
  }

  private blockReason(): RealtimeDisconnectReason | null {
    if (ownerFromAuthOrNull(this.authSnapshot) === null) return 'auth';
    if (!this.appIsActive) return 'background';
    if (this.connectivity.availability === 'offline') return 'offline';
    return null;
  }
}

function ownerFromAuthOrNull(
  snapshot: PublishedAuthLifecycleSnapshot | null,
): RealtimeOwner | null {
  return snapshot === null ? null : ownerFromAuth(snapshot);
}
