const mockStackScreen = jest.fn();

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
  SessionProvider: ({ children }: { children: import('react').ReactNode }) => children,
}));

// eslint-disable-next-line import/first
import { render } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import RootLayout from '../_layout';

describe('RootLayout', () => {
  it('registers the guarded Friends native stack', async () => {
    await render(<RootLayout />);

    expect(mockStackScreen).toHaveBeenCalledWith('friends');
  });

  it('registers the guarded Account native stack', async () => {
    await render(<RootLayout />);

    expect(mockStackScreen).toHaveBeenCalledWith('account');
  });
});
