import { Ionicons } from '@expo/vector-icons';
import { Redirect, Stack, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSession } from '@/features/auth/session';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';

interface HeaderActionProps {
  label: string;
  accessibilityLabel: string;
  showBackIcon?: boolean;
  onPress: () => void;
}

function HeaderAction({ label, accessibilityLabel, showBackIcon = false, onPress }: HeaderActionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={spacing.sm}
      onPress={onPress}
      style={({ pressed }) => [styles.headerAction, pressed && styles.headerActionPressed]}
    >
      {showBackIcon ? <Ionicons name="chevron-back" size={22} color={colors.primary} /> : null}
      <Text style={styles.headerActionText}>{label}</Text>
    </Pressable>
  );
}

export default function TripsLayout() {
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

  const leaveTripsRoute = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)');
  };

  return (
    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen
        name="create"
        options={{
          title: 'New Trip',
          presentation: 'modal',
          headerLeft: () => (
            <HeaderAction
              label="Cancel"
              accessibilityLabel="Cancel trip creation"
              onPress={leaveTripsRoute}
            />
          ),
        }}
      />
      <Stack.Screen
        name="[tripId]/index"
        options={{
          title: 'Trip',
          headerLeft: () => (
            <HeaderAction
              label="Trips"
              accessibilityLabel="Back to Trips"
              showBackIcon
              onPress={leaveTripsRoute}
            />
          ),
        }}
      />
      <Stack.Screen
        name="[tripId]/timeline/index"
        options={{
          title: 'Timeline',
        }}
      />
      <Stack.Screen
        name="[tripId]/timeline/section-form"
        options={{
          title: 'Timeline Day',
          presentation: 'formSheet',
          headerLeft: () => (
            <HeaderAction
              label="Cancel"
              accessibilityLabel="Cancel timeline day form"
              onPress={leaveTripsRoute}
            />
          ),
        }}
      />
      <Stack.Screen
        name="[tripId]/timeline/activity-form"
        options={{
          title: 'Activity',
          presentation: 'formSheet',
          headerLeft: () => (
            <HeaderAction
              label="Cancel"
              accessibilityLabel="Cancel timeline activity form"
              onPress={leaveTripsRoute}
            />
          ),
        }}
      />
      <Stack.Screen
        name="[tripId]/timeline/custom-types"
        options={{
          title: 'Custom Types',
          presentation: 'formSheet',
          headerLeft: () => (
            <HeaderAction
              label="Close"
              accessibilityLabel="Close custom types"
              onPress={leaveTripsRoute}
            />
          ),
        }}
      />
      <Stack.Screen
        name="[tripId]/expenses/index"
        options={{
          title: 'Expenses',
        }}
      />
      <Stack.Screen
        name="[tripId]/expenses/[expenseId]"
        options={{
          title: 'Expense',
        }}
      />
      <Stack.Screen
        name="[tripId]/expenses/expense-form"
        options={{
          title: 'Expense',
          presentation: 'formSheet',
          headerLeft: () => (
            <HeaderAction
              label="Cancel"
              accessibilityLabel="Cancel expense form"
              onPress={leaveTripsRoute}
            />
          ),
        }}
      />
      <Stack.Screen
        name="[tripId]/edit"
        options={{
          title: 'Edit Trip',
          presentation: 'modal',
          headerLeft: () => (
            <HeaderAction
              label="Cancel"
              accessibilityLabel="Cancel trip editing"
              onPress={leaveTripsRoute}
            />
          ),
        }}
      />
      <Stack.Screen
        name="[tripId]/invite"
        options={{
          title: 'Invite Friends',
          presentation: 'formSheet',
          headerLeft: () => (
            <HeaderAction
              label="Cancel"
              accessibilityLabel="Cancel member invitation"
              onPress={leaveTripsRoute}
            />
          ),
        }}
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
