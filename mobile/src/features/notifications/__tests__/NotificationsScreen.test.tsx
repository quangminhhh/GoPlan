const mockUseFocusEffect = jest.fn((effect: () => void) => effect());
const mockRouter = { push: jest.fn() };
const mockUseNotifications = jest.fn();
const mockFlatListProps = jest.fn();

jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');

  interface MockItem {
    id: string;
  }

  interface MockFlatListProps {
    data: MockItem[];
    renderItem: (info: { item: MockItem }) => import('react').ReactNode;
    onRefresh: () => void;
    onEndReached: () => void;
    refreshing: boolean;
    ListEmptyComponent: import('react').ReactNode;
    ListFooterComponent: import('react').ReactNode;
  }

  function MockFlatList(props: MockFlatListProps) {
    mockFlatListProps(props);
    return React.createElement(
      View,
      null,
      props.data.length > 0
        ? props.data.map((item) =>
            React.createElement(React.Fragment, { key: item.id }, props.renderItem({ item })),
          )
        : props.ListEmptyComponent,
      props.ListFooterComponent,
    );
  }

  return { __esModule: true, default: MockFlatList };
});

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => mockUseFocusEffect(effect),
  useRouter: () => mockRouter,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../application/NotificationsProvider', () => ({
  useNotifications: () => mockUseNotifications(),
}));

// eslint-disable-next-line import/first
import { fireEvent, render, screen } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { NotificationsScreen } from '../screens/NotificationsScreen';
// eslint-disable-next-line import/first
import type { NotificationItem, NotificationsContextValue } from '../types';

const notification: NotificationItem = {
  id: 'notification-1',
  notification_type: 'TRIP_CANCELLED',
  actor: null,
  payload: { trip_id: 'trip-1', trip_name: 'Da Lat escape' },
  is_read: false,
  read_at: null,
  created_at: '2026-07-22T01:00:00Z',
};

function readyContext(overrides: Partial<NotificationsContextValue> = {}): NotificationsContextValue {
  return {
    items: [notification],
    status: 'ready',
    error: null,
    errorSource: null,
    refreshing: false,
    loadingMore: false,
    hasNextPage: false,
    unreadCount: 1,
    lastKnownUnreadCount: 1,
    markingAllRead: false,
    pendingReadIds: new Set(),
    pendingInvitationActions: new Map(),
    rowErrors: new Map(),
    globalMutationError: null,
    refreshForFocus: jest.fn().mockResolvedValue(undefined),
    refresh: jest.fn().mockResolvedValue(undefined),
    loadMore: jest.fn().mockResolvedValue(undefined),
    markRead: jest.fn().mockResolvedValue(true),
    markAllRead: jest.fn().mockResolvedValue(true),
    respondToInvitation: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function latestListProps(): { onRefresh: () => void; onEndReached: () => void } {
  const props = mockFlatListProps.mock.calls.at(-1)?.[0];
  if (!props) {
    throw new Error('Expected NotificationsScreen to render a FlatList.');
  }
  return props;
}

describe('NotificationsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNotifications.mockReturnValue(readyContext());
  });

  it('refreshes on focus, marks the row read, and navigates to a safe trip target', async () => {
    const context = readyContext();
    mockUseNotifications.mockReturnValue(context);
    await render(<NotificationsScreen />);

    expect(context.refreshForFocus).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Da Lat escape has been cancelled' }));
    expect(context.markRead).toHaveBeenCalledWith('notification-1');
    expect(mockRouter.push).toHaveBeenCalledWith('/trips/trip-1');
  });

  it('dispatches mark-all and disables it when authoritative unread count is zero', async () => {
    const context = readyContext();
    mockUseNotifications.mockReturnValue(context);
    const { rerender } = await render(<NotificationsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Mark all notifications as read' }));
    expect(context.markAllRead).toHaveBeenCalledTimes(1);

    mockUseNotifications.mockReturnValue(
      readyContext({ unreadCount: 0, items: [{ ...notification, is_read: true }] }),
    );
    await rerender(<NotificationsScreen />);
    expect(screen.getByRole('button', { name: 'Mark all notifications as read' }).props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
  });

  it('keeps mark-all available from the last known signal while the exact badge is unknown', async () => {
    mockUseNotifications.mockReturnValue(
      readyContext({
        unreadCount: null,
        lastKnownUnreadCount: 3,
        items: [{ ...notification, is_read: true }],
      }),
    );

    await render(<NotificationsScreen />);

    expect(
      screen.getByRole('button', { name: 'Mark all notifications as read' }).props
        .accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: false }));
  });

  it('delegates pull-to-refresh and guarded cursor pagination', async () => {
    const context = readyContext({ hasNextPage: true });
    mockUseNotifications.mockReturnValue(context);
    const rendered = await render(<NotificationsScreen />);
    const list = latestListProps();

    await list.onRefresh();
    await list.onEndReached();
    expect(context.refresh).toHaveBeenCalledTimes(1);
    expect(context.loadMore).toHaveBeenCalledTimes(1);

    mockUseNotifications.mockReturnValue(
      readyContext({ hasNextPage: true, errorSource: 'loadMore', error: { kind: 'network', message: 'Offline' } }),
    );
    await rendered.rerender(<NotificationsScreen />);
    await latestListProps().onEndReached();
    expect(screen.getByRole('button', { name: 'Retry loading more notifications' })).toBeTruthy();
  });

  it('keeps the ready list visible during refresh errors and retries non-destructively', async () => {
    const context = readyContext({
      errorSource: 'refresh',
      error: { kind: 'message', message: 'Refresh failed.' },
    });
    mockUseNotifications.mockReturnValue(context);
    await render(<NotificationsScreen />);

    expect(screen.getByText('Da Lat escape has been cancelled')).toBeTruthy();
    expect(screen.getByText('Refresh failed.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry refreshing notifications' }));
    expect(context.refresh).toHaveBeenCalledTimes(1);
  });

  it('renders usable first-load error and empty states', async () => {
    mockUseNotifications.mockReturnValue(
      readyContext({ status: 'error', items: [], errorSource: 'initial', error: { kind: 'network', message: 'Offline' } }),
    );
    const { rerender } = await render(<NotificationsScreen />);
    expect(screen.getByText('Could not load notifications')).toBeTruthy();
    await fireEvent.press(screen.getByText('Try again'));

    mockUseNotifications.mockReturnValue(readyContext({ items: [], unreadCount: 0 }));
    await rerender(<NotificationsScreen />);
    expect(screen.getByText('No notifications yet')).toBeTruthy();
  });
});
