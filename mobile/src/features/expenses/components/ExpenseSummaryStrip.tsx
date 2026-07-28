import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import {
  formatExpenseMoney,
  getExpenseFundingPercent,
  getUserBalanceLabel,
} from '../money';
import type { ExpenseMoneySummary } from '../types';

interface ExpenseSummaryStripProps {
  summary: ExpenseMoneySummary;
  myBalance: {
    balance: string;
    surplus_held?: string;
  };
  currencyCode: string;
}

type BalanceDirection = 'owe' | 'receive' | 'settled';

function isCanonicalZero(value: string): boolean {
  const unsigned = value.trim().replace(/^[+-]/, '');
  return unsigned.replace(/[.,]/g, '').replace(/0/g, '').length === 0;
}

function getBalanceDirection(balance: string): BalanceDirection {
  if (isCanonicalZero(balance)) {
    return 'settled';
  }
  return balance.trim().startsWith('-') ? 'owe' : 'receive';
}

export function ExpenseSummaryStrip({
  summary,
  myBalance,
  currencyCode,
}: ExpenseSummaryStripProps) {
  const fundingPercent = getExpenseFundingPercent(summary);
  const balanceDirection = getBalanceDirection(myBalance.balance);
  const hasSurplusHeld = !isCanonicalZero(myBalance.surplus_held ?? '0');
  const stats = [
    {
      label: 'Total expenses',
      value: formatExpenseMoney(summary.total_amount, currencyCode),
    },
    {
      label: 'Collected',
      value: formatExpenseMoney(summary.paid_amount, currencyCode),
    },
    {
      label: 'Missing',
      value: formatExpenseMoney(summary.missing_amount, currencyCode),
    },
    {
      label: 'Surplus',
      value: formatExpenseMoney(summary.surplus_amount, currencyCode),
    },
  ] as const;

  return (
    <View accessibilityLabel="Expense summary" style={styles.card}>
      <View style={styles.stats}>
        {stats.map((stat) => (
          <View key={stat.label} style={styles.stat}>
            <Text style={styles.label}>{stat.label}</Text>
            <Text style={styles.value}>
              {stat.value}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.balance}>
        <Text style={styles.label}>My balance</Text>
        <Text
          style={[
            styles.balanceValue,
            balanceDirection === 'receive' ? styles.receive : null,
            balanceDirection === 'owe' ? styles.owe : null,
          ]}
        >
          {getUserBalanceLabel(myBalance.balance, currencyCode)}
        </Text>
        {hasSurplusHeld ? (
          <Text style={styles.surplus}>
            Holding{' '}
            <Text style={styles.emphasis}>
              {formatExpenseMoney(
                myBalance.surplus_held ?? '0',
                currencyCode,
              )}
            </Text>{' '}
            in group surplus
          </Text>
        ) : null}
      </View>

      <View style={styles.progressSection}>
        <View style={styles.progressHeading}>
          <Text style={styles.label}>Collection progress</Text>
          <Text style={styles.progressValue}>
            {Math.round(fundingPercent)}%
          </Text>
        </View>
        <View
          accessible
          accessibilityLabel={`Collection progress ${Math.round(fundingPercent)} percent`}
          accessibilityRole="progressbar"
          accessibilityValue={{
            min: 0,
            max: 100,
            now: Math.round(fundingPercent),
          }}
          style={styles.progressTrack}
        >
          <View
            style={[
              styles.progressFill,
              {
                width: `${fundingPercent}%`,
                minWidth: fundingPercent > 0 ? spacing.xs : 0,
              },
            ]}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  stat: {
    minWidth: '40%',
    flexGrow: 1,
    gap: spacing.xs,
  },
  label: {
    ...typography.label,
    color: colors.textMuted,
  },
  value: {
    ...typography.body,
    color: colors.text,
    fontWeight: '600',
  },
  balance: {
    gap: spacing.xs,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  balanceValue: {
    ...typography.heading,
    color: colors.text,
  },
  receive: { color: colors.success },
  owe: { color: colors.danger },
  surplus: {
    ...typography.caption,
    color: colors.amber,
  },
  emphasis: { fontWeight: '600' },
  progressSection: {
    gap: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  progressHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  progressValue: {
    ...typography.label,
    color: colors.text,
  },
  progressTrack: {
    height: spacing.xs,
    overflow: 'hidden',
    borderRadius: radii.full,
    backgroundColor: colors.surface,
  },
  progressFill: {
    height: '100%',
    borderRadius: radii.full,
    backgroundColor: colors.primary,
  },
});
