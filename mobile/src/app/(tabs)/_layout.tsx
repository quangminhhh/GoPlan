import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { useSession } from '@/features/auth/session';
import { useNotifications } from '@/features/notifications/application/NotificationsProvider';
import { colors } from '@/shared/theme/tokens';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';

function TabsNavigator() {
  const { items, unreadCount, lastKnownUnreadCount } = useNotifications();
  const hasLoadedUnread = items.some((item) => !item.is_read);
  const notificationsBadge =
    unreadCount !== null
      ? unreadCount > 0
        ? unreadCount > 99
          ? '99+'
          : unreadCount
        : undefined
      : (lastKnownUnreadCount !== null && lastKnownUnreadCount > 0) || hasLoadedUnread
        ? '•'
        : undefined;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.primary, headerShown: true }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Trips',
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="airplane-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="friends"
        options={{
          title: 'Friends',
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
          headerShown: false,
          tabBarBadge: notificationsBadge,
          tabBarIcon: ({ color, size }) => <Ionicons name="notifications-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-circle-outline" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}

export default function TabsLayout() {
  const { status, user } = useSession();
  if (status === 'restoring') {
    return <LoadingScreen />;
  }
  if (status === 'signedOut') {
    return <Redirect href="/(auth)/login" />;
  }
  if (user?.requires_profile_setup) {
    return <Redirect href="/(auth)/profile-setup" />;
  }
  return <TabsNavigator />;
}
