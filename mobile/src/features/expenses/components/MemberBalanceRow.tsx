import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { formatExpenseMoney } from '../money';

interface MemberBalanceRowProps {
  memberName?: string | null;
  identifyTag?: string | null;
  balance: string;
  currencyCode: string;
}

type BalanceDirection = 'owe' | 'receive' | 'settled';

function getBalanceDirection(balance: string): BalanceDirection {
  const trimmed = balance.trim();
  const hasValue =
    trimmed
      .replace(/^[+-]/, '')
      .replace(/[.,]/g, '')
      .replace(/0/g, '').length > 0;

  if (!hasValue) {
    return 'settled';
  }
  return trimmed.startsWith('-') ? 'owe' : 'receive';
}

function getAbsoluteCanonicalAmount(balance: string): string {
  const trimmed = balance.trim();
  return trimmed.startsWith('-') || trimmed.startsWith('+')
    ? trimmed.slice(1)
    : trimmed;
}

function MemberBalanceRowComponent({
  memberName,
  identifyTag,
  balance,
  currencyCode,
}: MemberBalanceRowProps) {
  const safeName = memberName?.trim() || 'Member';
  const direction = getBalanceDirection(balance);
  const amount =
    direction === 'settled'
      ? 'Settled'
      : formatExpenseMoney(
          getAbsoluteCanonicalAmount(balance),
          currencyCode,
        );
  const directionLabel =
    direction === 'owe'
      ? `Owes ${amount}`
      : direction === 'receive'
        ? `Is owed ${amount}`
        : amount;

  return (
    <View
      accessible
      accessibilityLabel={`${safeName}, ${directionLabel}`}
      style={styles.row}
    >
      <View style={styles.avatar}>
        <Ionicons
          name="person-outline"
          size={18}
          color={colors.textMuted}
        />
      </View>
      <View style={styles.identity}>
        <Text numberOfLines={1} style={styles.name}>
          {safeName}
        </Text>
        {identifyTag ? (
          <Text numberOfLines={1} style={styles.tag}>
            {identifyTag}
          </Text>
        ) : null}
      </View>
      <Text
        style={[
          styles.balance,
          direction === 'receive' ? styles.receive : null,
          direction === 'owe' ? styles.owe : null,
        ]}
      >
        {directionLabel}
      </Text>
    </View>
  );
}

export const MemberBalanceRow = memo(MemberBalanceRowComponent);

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  avatar: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.full,
    backgroundColor: colors.surface,
  },
  identity: {
    minWidth: 0,
    flex: 1,
  },
  name: {
    ...typography.body,
    color: colors.text,
    fontWeight: '600',
  },
  tag: {
    ...typography.caption,
    color: colors.textMuted,
  },
  balance: {
    ...typography.label,
    maxWidth: '42%',
    flexShrink: 1,
    color: colors.text,
    textAlign: 'right',
  },
  receive: { color: colors.success },
  owe: { color: colors.danger },
});
