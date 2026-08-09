import { memo, useCallback } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import type { InvitationAction, TripInvitationPayload } from '../types';

interface TripInvitationNotificationRowProps {
  notificationId: string;
  actorName: string;
  invitation: TripInvitationPayload;
  isRead: boolean;
  createdAtLabel: string;
  readPending: boolean;
  pendingAction: InvitationAction | null;
  error: ApiError | null;
  onOpen: (notificationId: string, tripId: string | null) => void;
  onAction: (
    notificationId: string,
    invitationId: string,
    tripId: string,
    action: InvitationAction,
  ) => void;
}

interface ActionButtonProps {
  action: InvitationAction;
  pendingAction: InvitationAction | null;
  onPress: (action: InvitationAction) => void;
}

const InvitationActionButton = memo(function InvitationActionButton({
  action,
  pendingAction,
  onPress,
}: ActionButtonProps) {
  const primary = action === 'accept';
  const title = primary ? 'Accept' : 'Decline';
  const loading = pendingAction === action;
  const disabled = pendingAction !== null;
  const press = useCallback(() => onPress(action), [action, onPress]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      onPress={press}
      style={({ pressed }) => [
        styles.actionButton,
        primary ? styles.primaryAction : styles.secondaryAction,
        pressed && !disabled ? styles.pressed : null,
        disabled && !loading ? styles.disabled : null,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={primary ? colors.background : colors.primary} />
      ) : (
        <Text style={[styles.actionText, primary ? styles.primaryActionText : styles.secondaryActionText]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
});

export const TripInvitationNotificationRow = memo(function TripInvitationNotificationRow({
  notificationId,
  actorName,
  invitation,
  isRead,
  createdAtLabel,
  readPending,
  pendingAction,
  error,
  onOpen,
  onAction,
}: TripInvitationNotificationRowProps) {
  const actionable = invitation.invitation_status === 'PENDING';
  const tripTarget = invitation.invitation_status === 'ACCEPTED' ? invitation.trip_id : null;
  const open = useCallback(
    () => onOpen(notificationId, tripTarget),
    [notificationId, onOpen, tripTarget],
  );
  const respond = useCallback(
    (action: InvitationAction) =>
      onAction(notificationId, invitation.invitation_id, invitation.trip_id, action),
    [invitation.invitation_id, invitation.trip_id, notificationId, onAction],
  );

  const resolutionLabel =
    invitation.invitation_status === 'ACCEPTED'
      ? 'You joined this trip.'
      : invitation.invitation_status === 'DECLINED'
        ? 'Invitation declined.'
        : invitation.invitation_status === 'CANCELLED'
          ? 'This invitation is no longer available.'
          : invitation.invitation_status === null
            ? 'Invitation status is unavailable.'
            : null;

  return (
    <View style={[styles.card, isRead ? styles.readCard : styles.unreadCard]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Trip invitation to ${invitation.trip_name}`}
        accessibilityValue={{ text: isRead ? 'Read' : 'Unread' }}
        accessibilityState={{ busy: readPending }}
        disabled={readPending}
        onPress={open}
        style={({ pressed }) => [styles.content, pressed && !readPending ? styles.pressed : null]}
      >
        <View style={styles.titleRow}>
          {!isRead ? <View accessible={false} style={styles.unreadDot} /> : null}
          <Text style={styles.title}>
            <Text style={styles.actor}>{actorName}</Text> invited you to a trip
          </Text>
          {readPending ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        </View>
        <Text style={styles.tripName}>{invitation.trip_name}</Text>
        <Text style={styles.meta}>{invitation.destination}</Text>
        <Text style={styles.meta}>
          {invitation.start_date} – {invitation.end_date}
        </Text>
        {createdAtLabel ? <Text style={styles.timestamp}>{createdAtLabel}</Text> : null}
      </Pressable>

      {actionable ? (
        <View style={styles.actions}>
          <InvitationActionButton action="accept" pendingAction={pendingAction} onPress={respond} />
          <InvitationActionButton action="decline" pendingAction={pendingAction} onPress={respond} />
        </View>
      ) : resolutionLabel ? (
        <Text style={invitation.invitation_status === 'ACCEPTED' ? styles.acceptedText : styles.resolutionText}>
          {resolutionLabel}
        </Text>
      ) : null}

      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error.message}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderRadius: radii.lg,
    borderCurve: 'continuous',
    backgroundColor: colors.background,
  },
  unreadCard: { borderColor: colors.primary },
  readCard: { borderColor: colors.border },
  content: { gap: spacing.xs },
  pressed: { opacity: 0.6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  unreadDot: { width: 8, height: 8, borderRadius: radii.full, backgroundColor: colors.primary },
  title: { ...typography.body, color: colors.text, flex: 1 },
  actor: { fontWeight: '600' },
  tripName: { ...typography.heading, color: colors.primary },
  meta: { ...typography.caption, color: colors.textMuted },
  timestamp: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  actions: { flexDirection: 'row', gap: spacing.sm },
  actionButton: {
    minHeight: 44,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: radii.md,
    borderCurve: 'continuous',
  },
  primaryAction: { borderColor: colors.primary, backgroundColor: colors.primary },
  secondaryAction: { borderColor: colors.border, backgroundColor: colors.background },
  disabled: { opacity: 0.45 },
  actionText: { ...typography.label },
  primaryActionText: { color: colors.background },
  secondaryActionText: { color: colors.text },
  acceptedText: { ...typography.caption, color: colors.success, fontWeight: '600' },
  resolutionText: { ...typography.caption, color: colors.textMuted },
  errorText: { ...typography.caption, color: colors.danger },
});
