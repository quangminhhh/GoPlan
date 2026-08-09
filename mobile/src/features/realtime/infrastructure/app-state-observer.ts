import { AppState } from 'react-native';
import type { AppStateObserver, RealtimeAppState } from '../types';

function normalizeAppState(state: string): RealtimeAppState {
  return state === 'active' ? 'active' : 'inactive';
}

export const nativeAppStateObserver: AppStateObserver = {
  getCurrent() {
    return normalizeAppState(AppState.currentState);
  },
  subscribe(listener) {
    const subscription = AppState.addEventListener('change', (state) => {
      listener(normalizeAppState(state));
    });
    return () => subscription.remove();
  },
};
