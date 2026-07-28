import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ApiError } from '@/shared/api/errors';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';

interface RouteUnavailableStateProps {
  title: string;
  message: string;
  error?: ApiError | null;
  onRetry?: () => void;
}

export function RouteUnavailableState({
  title,
  message,
  error,
  onRetry,
}: RouteUnavailableStateProps) {
  const notFound = error?.status === 404;
  const icon = (
    notFound
      ? 'help-circle-outline'
      : error
        ? 'cloud-offline-outline'
        : 'help-circle-outline'
  ) satisfies ComponentProps<typeof Ionicons>['name'];

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
      <View style={styles.centered}>
        <Ionicons name={icon} size={44} color={colors.textMuted} />
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        <Text style={styles.message}>{error?.message ?? message}</Text>
        {onRetry && !notFound ? (
          <Button title="Try again" onPress={onRetry} />
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  title: {
    ...typography.heading,
    color: colors.text,
    textAlign: 'center',
  },
  message: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
