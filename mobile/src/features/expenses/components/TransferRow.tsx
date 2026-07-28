import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import type { ApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import {
  formatExpenseMoney,
  getSettlementTransferRoleState,
} from '../money';
import type { SettlementTransfer } from '../types';

interface TransferRowProps {
  transfer: SettlementTransfer;
  currencyCode: string;
  viewerId: string | null;
  loading?: boolean;
  error?: ApiError | null;
  onMarkSent: (transferId: string) => void;
  onConfirmReceived: (transferId: string) => void;
}

interface TransferStatusProps {
  completed: boolean;
  doneLabel: string;
  pendingLabel: string;
}

function TransferStatus({
  completed,
  doneLabel,
  pendingLabel,
}: TransferStatusProps) {
  return (
    <View
      accessible
      accessibilityLabel={completed ? doneLabel : pendingLabel}
      style={[
        styles.status,
        completed ? styles.statusComplete : styles.statusPending,
      ]}
    >
      <Ionicons
        name={
          completed
            ? 'checkmark-circle-outline'
            : 'time-outline'
        }
        size={15}
        color={completed ? colors.success : colors.amber}
      />
      <Text
        style={[
          styles.statusText,
          completed ? styles.statusTextComplete : styles.statusTextPending,
        ]}
      >
        {completed ? doneLabel : pendingLabel}
      </Text>
    </View>
  );
}

function TransferPerson({
  label,
  name,
  tag,
}: {
  label: 'Payer' | 'Recipient';
  name: string;
  tag: string | null;
}) {
  return (
    <View style={styles.person}>
      <Text style={styles.personLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.personName}>
        {name}
      </Text>
      {tag ? (
        <Text numberOfLines={1} style={styles.personTag}>
          {tag}
        </Text>
      ) : null}
    </View>
  );
}

function TransferRowComponent({
  transfer,
  currencyCode,
  viewerId,
  loading = false,
  error,
  onMarkSent,
  onConfirmReceived,
}: TransferRowProps) {
  const roleState = getSettlementTransferRoleState(transfer, viewerId);
  const guidance =
    roleState.isSent && !roleState.isReceived
      ? roleState.isRecipient
        ? `${transfer.payer.display_name} marked this as sent. Confirm only after the money arrives.`
        : `Waiting for ${transfer.recipient.display_name} to confirm receipt.`
      : null;

  const confirmSent = useCallback(() => {
    Alert.alert(
      'Confirm transfer sent?',
      `You are confirming that you sent money to ${transfer.recipient.display_name}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () => onMarkSent(transfer.id),
        },
      ],
    );
  }, [
    onMarkSent,
    transfer.id,
    transfer.recipient.display_name,
  ]);

  const confirmReceived = useCallback(() => {
    Alert.alert(
      'Confirm transfer received?',
      `You are confirming that you received money from ${transfer.payer.display_name}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () => onConfirmReceived(transfer.id),
        },
      ],
    );
  }, [
    onConfirmReceived,
    transfer.id,
    transfer.payer.display_name,
  ]);

  return (
    <View
      accessibilityLabel={`${transfer.payer.display_name} pays ${transfer.recipient.display_name} ${formatExpenseMoney(
        transfer.amount,
        currencyCode,
      )}`}
      style={[
        styles.card,
        roleState.isReceived ? styles.cardComplete : null,
      ]}
    >
      <View style={styles.people}>
        <TransferPerson
          label="Payer"
          name={transfer.payer.display_name}
          tag={transfer.payer.identify_tag}
        />
        <Ionicons
          name="arrow-forward"
          size={18}
          color={colors.textMuted}
        />
        <TransferPerson
          label="Recipient"
          name={transfer.recipient.display_name}
          tag={transfer.recipient.identify_tag}
        />
      </View>

      <Text style={styles.amount}>
        {formatExpenseMoney(transfer.amount, currencyCode)}
      </Text>

      {guidance ? (
        <Text style={styles.guidance}>{guidance}</Text>
      ) : null}

      <View style={styles.statuses}>
        <TransferStatus
          completed={roleState.isSent}
          doneLabel="Sent"
          pendingLabel="Not sent"
        />
        <TransferStatus
          completed={roleState.isReceived}
          doneLabel="Received"
          pendingLabel="Not received"
        />
      </View>

      {roleState.canMarkSent ? (
        <Button
          title="I sent it"
          loading={loading}
          onPress={confirmSent}
        />
      ) : roleState.canConfirmReceived ? (
        <Button
          title="I received it"
          variant="secondary"
          loading={loading}
          onPress={confirmReceived}
        />
      ) : (
        <Text style={styles.tracking}>Tracking</Text>
      )}

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error.message}
        </Text>
      ) : null}
    </View>
  );
}

export const TransferRow = memo(TransferRowComponent);

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
  },
  cardComplete: {
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
  },
  people: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  person: {
    minWidth: 0,
    flex: 1,
  },
  personLabel: {
    ...typography.caption,
    color: colors.textMuted,
  },
  personName: {
    ...typography.label,
    color: colors.text,
  },
  personTag: {
    ...typography.caption,
    color: colors.textMuted,
  },
  amount: {
    ...typography.heading,
    color: colors.text,
    textAlign: 'right',
  },
  guidance: {
    ...typography.caption,
    padding: spacing.sm,
    borderRadius: radii.sm,
    color: colors.textMuted,
    backgroundColor: colors.surface,
  },
  statuses: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
  },
  statusComplete: { backgroundColor: colors.successSoft },
  statusPending: { backgroundColor: colors.amberSoft },
  statusText: { ...typography.label },
  statusTextComplete: { color: colors.success },
  statusTextPending: { color: colors.amber },
  tracking: {
    ...typography.label,
    color: colors.textMuted,
    textAlign: 'right',
  },
  error: {
    ...typography.caption,
    color: colors.danger,
  },
});
