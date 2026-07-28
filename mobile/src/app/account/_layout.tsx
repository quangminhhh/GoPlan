import { Ionicons } from '@expo/vector-icons';
import { Redirect, Stack, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSession } from '@/features/auth/session';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';

function HeaderBackAction({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to Profile"
      hitSlop={spacing.sm}
      onPress={onPress}
      style={({ pressed }) => [styles.headerAction, pressed && styles.headerActionPressed]}
    >
      <Ionicons name="chevron-back" size={22} color={colors.primary} />
      <Text style={styles.headerActionText}>Profile</Text>
    </Pressable>
  );
}

export default function AccountLayout() {
  const router = useRouter();
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

  const leaveAccountRoute = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/profile');
  };

  return (
    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen
        name="name"
        options={{ title: 'Edit Name', headerLeft: () => <HeaderBackAction onPress={leaveAccountRoute} /> }}
      />
      <Stack.Screen
        name="password"
        options={{ title: 'Change Password', headerLeft: () => <HeaderBackAction onPress={leaveAccountRoute} /> }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  headerAction: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: -spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  headerActionPressed: { opacity: 0.55 },
  headerActionText: { ...typography.body, color: colors.primary },
});
