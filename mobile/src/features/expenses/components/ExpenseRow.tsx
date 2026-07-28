import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import {
  formatExpenseMoney,
  getExpenseStatusLabel,
  getExpenseStatusTone,
} from '../money';
import type { ExpenseListItem } from '../types';

interface ExpenseRowProps {
  expense: ExpenseListItem;
  disabled?: boolean;
  onPress: (expenseId: string) => void;
}

const STATUS_TOKENS = {
  warning: {
    color: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  success: {
    color: colors.success,
    backgroundColor: colors.successSoft,
  },
  danger: {
    color: colors.danger,
    backgroundColor: colors.dangerSoft,
  },
} as const;

function getStatusMessage(expense: ExpenseListItem): string {
  if (expense.status === 'UNDERFUNDED') {
    return `Missing ${formatExpenseMoney(
      expense.missing_amount,
      expense.currency_code,
    )}`;
  }
  if (expense.status === 'OVERFUNDED') {
    return `Surplus ${formatExpenseMoney(
      expense.surplus_amount,
      expense.currency_code,
    )}`;
  }
  return expense.description || 'Fully funded';
}

function ExpenseRowComponent({
  expense,
  disabled = false,
  onPress,
}: ExpenseRowProps) {
  const tone = getExpenseStatusTone(expense.status);
  const statusTokens = STATUS_TOKENS[tone];
  const openExpense = useCallback(
    () => onPress(expense.id),
    [expense.id, onPress],
  );
  const totalLabel = formatExpenseMoney(
    expense.total_amount,
    expense.currency_code,
  );
  const collectedLabel = formatExpenseMoney(
    expense.paid_amount,
    expense.currency_code,
  );
  const accessibilitySummary = [
    `Open expense ${expense.title}`,
    getExpenseStatusLabel(expense.status),
    expense.locked ? 'locked' : null,
    `total ${totalLabel}`,
    `collected ${collectedLabel}`,
    `collector ${expense.collector.display_name}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      testID={`expense-row-${expense.id}`}
      accessibilityRole="button"
      accessibilityLabel={accessibilitySummary}
      accessibilityHint="Shows expense details and participant contributions"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={openExpense}
      style={({ pressed }) => [
        styles.card,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <View style={styles.heading}>
        <View style={styles.titleBlock}>
          <View style={styles.titleLine}>
            <Text numberOfLines={1} style={styles.title}>
              {expense.title}
            </Text>
            {expense.locked ? (
              <Ionicons
                accessibilityLabel="Locked"
                name="lock-closed-outline"
                size={16}
                color={colors.textMuted}
              />
            ) : null}
          </View>
          <Text
            numberOfLines={2}
            style={[
              styles.statusMessage,
              tone === 'success' ? null : { color: statusTokens.color },
            ]}
          >
            {getStatusMessage(expense)}
          </Text>
        </View>
        <Ionicons
          name="chevron-forward"
          size={18}
          color={colors.textMuted}
        />
      </View>

      <View style={styles.amounts}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Total</Text>
          <Text style={styles.metricValue}>
            {totalLabel}
          </Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Collected</Text>
          <Text style={styles.metricValue}>
            {collectedLabel}
          </Text>
        </View>
      </View>

      <View style={styles.footer}>
        <View
          style={[
            styles.badge,
            { backgroundColor: statusTokens.backgroundColor },
          ]}
        >
          <Text style={[styles.badgeText, { color: statusTokens.color }]}>
            {getExpenseStatusLabel(expense.status)}
          </Text>
        </View>
        <View style={styles.collector}>
          <Text style={styles.collectorLabel}>Collector</Text>
          <Text numberOfLines={1} style={styles.collectorName}>
            {expense.collector.display_name}
          </Text>
          {expense.collector.identify_tag ? (
            <Text numberOfLines={1} style={styles.collectorTag}>
              {expense.collector.identify_tag}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export const ExpenseRow = memo(ExpenseRowComponent);

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
  },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.55 },
  heading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  titleBlock: {
    minWidth: 0,
    flex: 1,
    gap: spacing.xs,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  title: {
    ...typography.heading,
    minWidth: 0,
    flexShrink: 1,
    color: colors.text,
  },
  statusMessage: {
    ...typography.caption,
    color: colors.textMuted,
  },
  amounts: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  metric: {
    minWidth: 0,
    flex: 1,
    gap: spacing.xs,
  },
  metricLabel: {
    ...typography.caption,
    color: colors.textMuted,
  },
  metricValue: {
    ...typography.body,
    color: colors.text,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
  },
  badgeText: {
    ...typography.label,
  },
  collector: {
    minWidth: 0,
    flex: 1,
    alignItems: 'flex-end',
  },
  collectorLabel: {
    ...typography.caption,
    color: colors.textMuted,
  },
  collectorName: {
    ...typography.label,
    maxWidth: '100%',
    color: colors.text,
  },
  collectorTag: {
    ...typography.caption,
    maxWidth: '100%',
    color: colors.textMuted,
  },
});
