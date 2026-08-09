import { memo, useCallback, useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { getTripTarget, parseNotificationPayload } from '../payloadParsers';
import type { InvitationAction, NotificationItem, ParsedNotificationPayload } from '../types';
import { TripInvitationNotificationRow } from './TripInvitationNotificationRow';

const dateTimeFormatter = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: string): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dateTimeFormatter.format(date);
}

function presentationText(parsed: ParsedNotificationPayload, actorName: string): { title: string; body: string | null } {
  switch (parsed.kind) {
    case 'friendRequest':
      return { title: `${actorName} sent you a friend request`, body: null };
    case 'friendAccepted':
      return { title: `${actorName} accepted your friend request`, body: null };
    case 'tripInvitationAccepted':
      return {
        title: `${parsed.response.responder_name ?? actorName} joined your trip`,
        body: parsed.response.trip_name,
      };
    case 'tripInvitationDeclined':
      return {
        title: `${parsed.response.responder_name ?? actorName} declined your trip invitation`,
        body: parsed.response.trip_name,
      };
    case 'tripCancelled':
      return { title: `${parsed.trip.trip_name} has been cancelled`, body: null };
    case 'tripMemberRemoved':
      return { title: `You were removed from ${parsed.trip.trip_name}`, body: null };
    case 'tripTimelineReminder':
      return {
        title: `Upcoming: ${parsed.reminder.activity_title}`,
        body: `${parsed.reminder.trip_name} · ${parsed.reminder.section_label} · ${parsed.reminder.activity_time}`,
      };
    default:
      return { title: 'You have a new notification', body: 'Details are unavailable.' };
  }
}

interface NotificationRowProps {
  notification: NotificationItem;
  readPending: boolean;
  pendingInvitationAction: InvitationAction | null;
  error: ApiError | null;
  onOpen: (notificationId: string, tripId: string | null) => void;
  onInvitationAction: (
    notificationId: string,
    invitationId: string,
    tripId: string,
    action: InvitationAction,
  ) => void;
}

export const NotificationRow = memo(function NotificationRow({
  notification,
  readPending,
  pendingInvitationAction,
  error,
  onOpen,
  onInvitationAction,
}: NotificationRowProps) {
  const parsed = useMemo(
    () => parseNotificationPayload(notification.notification_type, notification.payload),
    [notification.notification_type, notification.payload],
  );
  const actorName = notification.actor?.display_name.trim() || 'Someone';
  const timestamp = formatTimestamp(notification.created_at);
  const tripTarget = getTripTarget(parsed);
  const open = useCallback(
    () => onOpen(notification.id, tripTarget),
    [notification.id, onOpen, tripTarget],
  );

  if (parsed.kind === 'tripInvitation') {
    return (
      <TripInvitationNotificationRow
        notificationId={notification.id}
        actorName={actorName}
        invitation={parsed.invitation}
        isRead={notification.is_read}
        createdAtLabel={timestamp}
        readPending={readPending}
        pendingAction={pendingInvitationAction}
        error={error}
        onOpen={onOpen}
        onAction={onInvitationAction}
      />
    );
  }

  const presentation = presentationText(parsed, actorName);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={presentation.title}
      accessibilityValue={{ text: notification.is_read ? 'Read' : 'Unread' }}
      accessibilityState={{ busy: readPending }}
      disabled={readPending}
      onPress={open}
      style={({ pressed }) => [
        styles.card,
        notification.is_read ? styles.readCard : styles.unreadCard,
        pressed && !readPending ? styles.pressed : null,
      ]}
    >
      <View style={styles.titleRow}>
        {!notification.is_read ? <View accessible={false} style={styles.unreadDot} /> : null}
        <Text style={styles.title}>{presentation.title}</Text>
        {readPending ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      </View>
      {presentation.body ? <Text style={styles.body}>{presentation.body}</Text> : null}
      {timestamp ? <Text style={styles.timestamp}>{timestamp}</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error.message}
        </Text>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderRadius: radii.lg,
    borderCurve: 'continuous',
    backgroundColor: colors.background,
  },
  unreadCard: { borderColor: colors.primary },
  readCard: { borderColor: colors.border },
  pressed: { opacity: 0.6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  unreadDot: { width: 8, height: 8, borderRadius: radii.full, backgroundColor: colors.primary },
  title: { ...typography.body, color: colors.text, flex: 1 },
  body: { ...typography.caption, color: colors.textMuted },
  timestamp: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  errorText: { ...typography.caption, color: colors.danger, marginTop: spacing.xs },
});
