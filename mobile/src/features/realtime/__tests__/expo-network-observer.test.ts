import * as Network from 'expo-network';
import {
  expoNetworkObserver,
  normalizeNetworkState,
} from '../infrastructure/expo-network-observer';

describe('normalizeNetworkState', () => {
  it('treats NONE as offline', () => {
    expect(
      normalizeNetworkState({
        type: Network.NetworkStateType.NONE,
        isConnected: false,
        isInternetReachable: false,
      }),
    ).toEqual({ availability: 'offline', type: null });
  });

  it.each([
    { type: Network.NetworkStateType.UNKNOWN, isConnected: false },
    { isConnected: false, isInternetReachable: false },
  ])('does not interpret indeterminate false fields as offline', (state) => {
    expect(normalizeNetworkState(state)).toEqual({
      availability: 'unknown',
      type: null,
    });
  });

  it('uses explicit false on a known network as offline', () => {
    expect(
      normalizeNetworkState({
        type: Network.NetworkStateType.WIFI,
        isConnected: true,
        isInternetReachable: false,
      }),
    ).toEqual({ availability: 'offline', type: null });
  });

  it('preserves known online network types for handoff detection', () => {
    expect(
      normalizeNetworkState({
        type: Network.NetworkStateType.CELLULAR,
        isConnected: true,
        isInternetReachable: true,
      }),
    ).toEqual({ availability: 'online', type: 'CELLULAR' });
  });
});

describe('expoNetworkObserver', () => {
  afterEach(() => jest.restoreAllMocks());

  it('normalizes current state and removes its native listener', async () => {
    jest.spyOn(Network, 'getNetworkStateAsync').mockResolvedValue({
      type: Network.NetworkStateType.WIFI,
      isConnected: true,
      isInternetReachable: true,
    });
    const nativeListener: {
      current: ((state: Network.NetworkState) => void) | null;
    } = { current: null };
    const remove = jest.fn();
    jest.spyOn(Network, 'addNetworkStateListener').mockImplementation((listener) => {
      nativeListener.current = listener;
      return { remove };
    });
    const listener = jest.fn();

    await expect(expoNetworkObserver.getCurrent()).resolves.toEqual({
      availability: 'online',
      type: 'WIFI',
    });
    const unsubscribe = expoNetworkObserver.subscribe(listener);
    if (nativeListener.current === null) {
      throw new Error('Native listener was not registered.');
    }
    nativeListener.current({
      type: Network.NetworkStateType.CELLULAR,
      isConnected: true,
      isInternetReachable: true,
    });
    expect(listener).toHaveBeenCalledWith({
      availability: 'online',
      type: 'CELLULAR',
    });

    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
