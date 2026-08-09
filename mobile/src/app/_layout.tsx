import { Stack } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { SessionProvider, useSession } from '@/features/auth/session';
import { NotificationsProvider } from '@/features/notifications/application/NotificationsProvider';
import { RealtimeProvider } from '@/features/realtime/application/RealtimeProvider';

function SessionBoundProviders({ children }: PropsWithChildren) {
  const { user } = useSession();
  return (
    <RealtimeProvider>
      <NotificationsProvider ownerUserId={user?.id ?? null}>
        {children}
      </NotificationsProvider>
    </RealtimeProvider>
  );
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <SessionBoundProviders>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="trips" />
          <Stack.Screen name="friends" />
          <Stack.Screen name="account" />
        </Stack>
      </SessionBoundProviders>
    </SessionProvider>
  );
}
