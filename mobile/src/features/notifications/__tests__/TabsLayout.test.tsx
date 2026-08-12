const mockUseSession = jest.fn();
const mockUnreadCount = jest.fn();
const mockLastKnownUnreadCount = jest.fn();
const mockNotificationItems = jest.fn();
const mockTabsScreen = jest.fn();

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');

  function MockTabs({ children }: { children: import('react').ReactNode }) {
    return React.createElement(View, null, children);
  }
  MockTabs.Screen = function MockTabsScreen({ name, options }: { name: string; options: Record<string, unknown> }) {
    mockTabsScreen(name, options);
    return null;
  };
  return {
    Redirect: ({ href }: { href: string }) => React.createElement(View, { testID: `redirect-${href}` }),
    Tabs: MockTabs,
  };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/features/auth/session', () => ({ useSession: () => mockUseSession() }));
jest.mock('../application/NotificationsProvider', () => ({
  useNotifications: () => ({
    items: mockNotificationItems(),
    unreadCount: mockUnreadCount(),
    lastKnownUnreadCount: mockLastKnownUnreadCount(),
  }),
}));
jest.mock('@/shared/ui/LoadingScreen', () => ({ LoadingScreen: () => null }));

// eslint-disable-next-line import/first
import { render } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import TabsLayout from '@/app/(tabs)/_layout';

function notificationsOptions(): Record<string, unknown> {
  const call = mockTabsScreen.mock.calls.find(([name]) => name === 'notifications');
  if (!call) {
    throw new Error('Expected the Notifications tab to be registered.');
  }
  return call[1] as Record<string, unknown>;
}

describe('TabsLayout notifications integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSession.mockReturnValue({
      status: 'signedIn',
      user: { id: 'user-1', requires_profile_setup: false },
    });
    mockLastKnownUnreadCount.mockReturnValue(null);
    mockNotificationItems.mockReturnValue([]);
  });

  it('caps a large unread badge from the root-owned provider', async () => {
    mockUnreadCount.mockReturnValue(120);
    await render(<TabsLayout />);

    expect(notificationsOptions()).toEqual(
      expect.objectContaining({ headerShown: false, tabBarBadge: '99+' }),
    );
  });

  it.each([0, null])('hides the badge for unread count %s', async (count) => {
    mockUnreadCount.mockReturnValue(count);
    await render(<TabsLayout />);
    expect(notificationsOptions().tabBarBadge).toBeUndefined();
  });

  it('shows a degraded dot when the exact count is unknown but unread work was previously known', async () => {
    mockUnreadCount.mockReturnValue(null);
    mockLastKnownUnreadCount.mockReturnValue(5);
    await render(<TabsLayout />);

    expect(notificationsOptions().tabBarBadge).toBe('•');
  });

  it('shows a degraded dot for a loaded unread row when count reconciliation is unavailable', async () => {
    mockUnreadCount.mockReturnValue(null);
    mockLastKnownUnreadCount.mockReturnValue(0);
    mockNotificationItems.mockReturnValue([{ id: 'notification-1', is_read: false }]);
    await render(<TabsLayout />);

    expect(notificationsOptions().tabBarBadge).toBe('•');
  });

  it('hides the degraded badge when the unknown count has only loaded read rows', async () => {
    mockUnreadCount.mockReturnValue(null);
    mockLastKnownUnreadCount.mockReturnValue(0);
    mockNotificationItems.mockReturnValue([{ id: 'notification-1', is_read: true }]);
    await render(<TabsLayout />);

    expect(notificationsOptions().tabBarBadge).toBeUndefined();
  });
});
