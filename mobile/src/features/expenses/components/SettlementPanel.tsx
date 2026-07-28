import { Ionicons } from '@expo/vector-icons';
import { Alert, StyleSheet, Text, View } from 'react-native';
import type { ApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import type { TripSettlement } from '../types';

interface SettlementPanelProps {
  settlement: TripSettlement;
  canReopen: boolean;
  reopening?: boolean;
  error?: ApiError | null;
  onReopen: () => void;
}

export function SettlementPanel({
  settlement,
  canReopen,
  reopening = false,
  error,
  onReopen,
}: SettlementPanelProps) {
  if (settlement.status !== 'FINALIZED') {
    return null;
  }

  const transferCount = settlement.transfers.length;
  const confirmReopen = () => {
    Alert.alert(
      'Reopen settlement?',
      'Expenses and contributions will be unlocked for editing.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reopen', onPress: onReopen },
      ],
    );
  };

  return (
    <View accessibilityLabel="Finalized settlement" style={styles.panel}>
      <View style={styles.heading}>
        <View style={styles.icon}>
          <Ionicons
            name="checkmark-circle-outline"
            size={22}
            color={colors.success}
          />
        </View>
        <View style={styles.titleBlock}>
          <Text accessibilityRole="header" style={styles.title}>
            Settlement finalized
          </Text>
          <Text style={styles.body}>
            Settlement finalized. Expenses are locked.
          </Text>
        </View>
      </View>

      <Text style={styles.transferCount}>
        {transferCount === 0
          ? 'No transfers are needed for this settlement.'
          : `${transferCount} ${transferCount === 1 ? 'transfer' : 'transfers'} to track below.`}
      </Text>

      {canReopen ? (
        <Button
          title="Reopen settlement"
          variant="secondary"
          loading={reopening}
          onPress={confirmReopen}
        />
      ) : null}

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.successSoft,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  icon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  titleBlock: {
    minWidth: 0,
    flex: 1,
    gap: spacing.xs,
  },
  title: {
    ...typography.heading,
    color: colors.text,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
  transferCount: {
    ...typography.caption,
    color: colors.textMuted,
  },
  error: {
    ...typography.caption,
    color: colors.danger,
  },
});
