import * as Network from 'expo-network';
import type { ConnectivitySnapshot, NetworkObserver } from '../types';

function normalizedType(type: Network.NetworkStateType | undefined): string | null {
  if (
    type === undefined ||
    type === Network.NetworkStateType.NONE ||
    type === Network.NetworkStateType.UNKNOWN
  ) {
    return null;
  }
  return type;
}

export function normalizeNetworkState(
  state: Network.NetworkState,
): ConnectivitySnapshot {
  if (state.type === Network.NetworkStateType.NONE) {
    return { availability: 'offline', type: null };
  }

  const type = normalizedType(state.type);
  if (
    type !== null &&
    (state.isConnected === false || state.isInternetReachable === false)
  ) {
    return { availability: 'offline', type: null };
  }

  if (state.isConnected === true || state.isInternetReachable === true) {
    return { availability: 'online', type };
  }

  // Expo reports UNKNOWN + false on some indeterminate states. The issue
  // contract deliberately keeps that eligible for heartbeat-based recovery.
  return { availability: 'unknown', type };
}

export const expoNetworkObserver: NetworkObserver = {
  async getCurrent() {
    return normalizeNetworkState(await Network.getNetworkStateAsync());
  },
  subscribe(listener) {
    const subscription = Network.addNetworkStateListener((state) => {
      listener(normalizeNetworkState(state));
    });
    return () => subscription.remove();
  },
};
