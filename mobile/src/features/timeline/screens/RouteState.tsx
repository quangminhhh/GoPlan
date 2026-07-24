import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';

interface RouteUnavailableStateProps {
  title: string;
  message: string;
}

interface RouteReadyStateProps {
  testID: string;
}

export function RouteUnavailableState({ title, message }: RouteUnavailableStateProps) {
  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
      <View style={styles.centered}>
        <Ionicons
          name={'help-circle-outline' satisfies ComponentProps<typeof Ionicons>['name']}
          size={44}
          color={colors.textMuted}
        />
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        <Text style={styles.message}>{message}</Text>
      </View>
    </SafeAreaView>
  );
}

export function RouteReadyState({ testID }: RouteReadyStateProps) {
  return (
    <View testID={testID} style={styles.ready}>
      <LoadingScreen />
    </View>
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
    gap: spacing.sm,
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
  ready: {
    flex: 1,
  },
});
