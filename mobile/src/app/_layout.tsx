import { Stack } from 'expo-router';
import { SessionProvider } from '@/features/auth/session';

export default function RootLayout() {
  return (
    <SessionProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="trips" />
        <Stack.Screen name="friends" />
        <Stack.Screen name="account" />
      </Stack>
    </SessionProvider>
  );
}
