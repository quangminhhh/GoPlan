const mockStackScreen = jest.fn();
const mockProviderOrder = jest.fn();

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');

  function MockStack({ children }: { children: import('react').ReactNode }) {
    return React.createElement(View, null, children);
  }

  MockStack.Screen = function MockStackScreen({ name }: { name: string }) {
    mockStackScreen(name);
    return null;
  };

  return { Stack: MockStack };
});

jest.mock('@/features/auth/session', () => ({
  SessionProvider: ({ children }: { children: import('react').ReactNode }) => {
    mockProviderOrder('session');
    return children;
  },
  useSession: () => ({ user: { id: 'user-1' } }),
}));

jest.mock('@/features/realtime/application/RealtimeProvider', () => ({
  RealtimeProvider: ({ children }: { children: import('react').ReactNode }) => {
    mockProviderOrder('realtime');
    return children;
  },
}));

jest.mock('@/features/notifications/application/NotificationsProvider', () => ({
  NotificationsProvider: ({
    children,
    ownerUserId,
  }: {
    children: import('react').ReactNode;
    ownerUserId: string | null;
  }) => {
    mockProviderOrder(`notifications:${ownerUserId ?? 'none'}`);
    return children;
  },
}));

// eslint-disable-next-line import/first
import { render } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import RootLayout from '../_layout';

describe('RootLayout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('owns one session-scoped realtime and notifications provider above the root stack', async () => {
    await render(<RootLayout />);

    expect(mockProviderOrder.mock.calls.map(([name]) => name)).toEqual([
      'session',
      'realtime',
      'notifications:user-1',
    ]);
  });

  it('registers the guarded Friends native stack', async () => {
    await render(<RootLayout />);

    expect(mockStackScreen).toHaveBeenCalledWith('friends');
  });

  it('registers the guarded Account native stack', async () => {
    await render(<RootLayout />);

    expect(mockStackScreen).toHaveBeenCalledWith('account');
  });
});
