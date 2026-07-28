import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { TextField } from '@/shared/ui/TextField';
import {
  formatExpenseMoney,
  getExpenseCurrencyScale,
} from '../money';
import type { ExpenseParticipant } from '../types';

interface ContributionEditorProps {
  participant: ExpenseParticipant;
  currencyCode: string;
  canEdit: boolean;
  isEditing: boolean;
  draftAmount: string;
  loading?: boolean;
  error?: string | null;
  amountError?: string;
  onStartEditing: (userId: string) => void;
  onDraftChange: (userId: string, value: string) => void;
  onSubmit: (userId: string) => void;
  onCancel: (userId: string) => void;
}

type ParticipantBalanceDirection = 'owes' | 'overpaid' | 'settled';

function getParticipantBalanceDirection(
  balance: string,
): ParticipantBalanceDirection {
  const trimmed = balance.trim();
  const hasValue =
    trimmed
      .replace(/^[+-]/, '')
      .replace(/[.,]/g, '')
      .replace(/0/g, '').length > 0;

  if (!hasValue) {
    return 'settled';
  }
  return trimmed.startsWith('-') ? 'owes' : 'overpaid';
}

function absoluteCanonicalAmount(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('-') || trimmed.startsWith('+')
    ? trimmed.slice(1)
    : trimmed;
}

function ActionButton({
  title,
  label,
  icon,
  disabled,
  loading = false,
  primary = false,
  onPress,
}: {
  title: string;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  disabled: boolean;
  loading?: boolean;
  primary?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        primary ? styles.primaryAction : styles.secondaryAction,
        pressed && !disabled && !loading ? styles.pressed : null,
        disabled && !loading ? styles.disabled : null,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={primary ? colors.background : colors.primary}
        />
      ) : (
        <>
          <Ionicons
            name={icon}
            size={16}
            color={primary ? colors.background : colors.primary}
          />
          <Text
            style={[
              styles.actionText,
              primary ? styles.primaryActionText : null,
            ]}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

function ContributionEditorComponent({
  participant,
  currencyCode,
  canEdit,
  isEditing,
  draftAmount,
  loading = false,
  error,
  amountError,
  onStartEditing,
  onDraftChange,
  onSubmit,
  onCancel,
}: ContributionEditorProps) {
  const direction = getParticipantBalanceDirection(participant.balance);
  const balanceAmount = formatExpenseMoney(
    absoluteCanonicalAmount(participant.balance),
    currencyCode,
  );
  const surplusHeld = participant.surplus_held ?? '0';
  const hasSurplus =
    surplusHeld
      .replace(/^[+-]/, '')
      .replace(/[.,]/g, '')
      .replace(/0/g, '').length > 0;

  const startEditing = useCallback(
    () => onStartEditing(participant.user_id),
    [onStartEditing, participant.user_id],
  );
  const changeDraft = useCallback(
    (value: string) => onDraftChange(participant.user_id, value),
    [onDraftChange, participant.user_id],
  );
  const submit = useCallback(
    () => onSubmit(participant.user_id),
    [onSubmit, participant.user_id],
  );
  const cancel = useCallback(
    () => onCancel(participant.user_id),
    [onCancel, participant.user_id],
  );

  return (
    <View
      accessibilityLabel={`Contribution for ${participant.display_name}`}
      style={styles.card}
    >
      <View style={styles.heading}>
        <View style={styles.identity}>
          <Text numberOfLines={1} style={styles.name}>
            {participant.display_name}
          </Text>
          {participant.identify_tag ? (
            <Text numberOfLines={1} style={styles.tag}>
              {participant.identify_tag}
            </Text>
          ) : null}
        </View>
        {canEdit && !isEditing ? (
          <ActionButton
            title="Edit"
            label={`Edit contribution for ${participant.display_name}`}
            icon="create-outline"
            disabled={loading}
            onPress={startEditing}
          />
        ) : !canEdit ? (
          <Text style={styles.viewOnly}>View only</Text>
        ) : null}
      </View>

      <View style={styles.metrics}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Share</Text>
          <Text style={styles.metricValue}>
            {formatExpenseMoney(
              participant.share_amount,
              currencyCode,
            )}
          </Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Contributed</Text>
          <Text style={styles.metricValue}>
            {formatExpenseMoney(
              participant.contributed_amount,
              currencyCode,
            )}
          </Text>
        </View>
        <View style={styles.metric}>
          <Text
            style={[
              styles.metricLabel,
              direction === 'overpaid' ? styles.receive : null,
              direction === 'owes' ? styles.owe : null,
            ]}
          >
            {direction === 'overpaid'
              ? 'Overpaid'
              : direction === 'owes'
                ? 'Still owes'
                : 'Settled'}
          </Text>
          <Text
            style={[
              styles.metricValue,
              direction === 'overpaid' ? styles.receive : null,
              direction === 'owes' ? styles.owe : null,
            ]}
          >
            {direction === 'overpaid' ? '+' : ''}
            {balanceAmount}
          </Text>
        </View>
      </View>

      {hasSurplus ? (
        <Text style={styles.surplus}>
          Holding{' '}
          <Text style={styles.surplusAmount}>
            {formatExpenseMoney(surplusHeld, currencyCode)}
          </Text>{' '}
          surplus
        </Text>
      ) : null}

      {canEdit && isEditing ? (
        <View style={styles.editor}>
          <TextField
            label={`Amount ${participant.display_name} contributed`}
            accessibilityLabel={`Contribution amount for ${participant.display_name}`}
            value={draftAmount}
            onChangeText={changeDraft}
            keyboardType={
              getExpenseCurrencyScale(currencyCode) === 0
                ? 'number-pad'
                : 'decimal-pad'
            }
            autoCorrect={false}
            editable={!loading}
            error={amountError}
          />
          <View style={styles.actions}>
            <View style={styles.actionSlot}>
              <ActionButton
                title="Save"
                label={`Save contribution for ${participant.display_name}`}
                icon="checkmark-outline"
                disabled={loading}
                loading={loading}
                primary
                onPress={submit}
              />
            </View>
            <View style={styles.actionSlot}>
              <ActionButton
                title="Cancel"
                label={`Cancel contribution edit for ${participant.display_name}`}
                icon="close-outline"
                disabled={loading}
                onPress={cancel}
              />
            </View>
          </View>
        </View>
      ) : null}

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export const ContributionEditor = memo(ContributionEditorComponent);

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
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
  viewOnly: {
    ...typography.label,
    color: colors.textMuted,
  },
  metrics: {
    flexDirection: 'row',
    gap: spacing.sm,
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
    ...typography.label,
    color: colors.text,
  },
  receive: { color: colors.success },
  owe: { color: colors.danger },
  surplus: {
    ...typography.caption,
    color: colors.amber,
  },
  surplusAmount: { fontWeight: '600' },
  editor: { gap: spacing.sm },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionSlot: { flex: 1 },
  action: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
  },
  primaryAction: {
    backgroundColor: colors.primary,
  },
  secondaryAction: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  actionText: {
    ...typography.label,
    color: colors.primary,
  },
  primaryActionText: { color: colors.background },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.55 },
  error: {
    ...typography.caption,
    color: colors.danger,
  },
});
