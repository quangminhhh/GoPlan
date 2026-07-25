import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useMemo, useState } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { ActivityStatusControls } from './ActivityStatusControls';
import { getTimelineIconName, getTimelineTokenColors } from '../tokenMaps';
import type {
  TimelineActivity,
  TimelineActivityStatus,
} from '../types';
import { formatActivityTime } from '../viewModel';

interface ActivityRowProps {
  activity: TimelineActivity;
  actionsDisabled?: boolean;
  onEdit?: (activityId: string) => void;
  onDelete?: (activityId: string) => void;
  onChangeStatus?: (
    activityId: string,
    nextStatus: TimelineActivityStatus,
  ) => Promise<void>;
}

interface DetailLineProps {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  value: string;
}

const STATUS_META: Record<
  TimelineActivityStatus,
  { label: string; color: string; backgroundColor: string }
> = {
  UPCOMING: {
    label: 'Upcoming',
    color: colors.completedText,
    backgroundColor: colors.completedSoft,
  },
  IN_PROGRESS: {
    label: 'In progress',
    color: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  DONE: {
    label: 'Done',
    color: colors.success,
    backgroundColor: colors.successSoft,
  },
  CANCELLED: {
    label: 'Cancelled',
    color: colors.danger,
    backgroundColor: colors.dangerSoft,
  },
};

function formatReminder(minutes: number): string {
  if (minutes % 10_080 === 0) {
    const weeks = minutes / 10_080;
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} before`;
  }
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return `${days} ${days === 1 ? 'day' : 'days'} before`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} before`;
  }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} before`;
}

function DetailLine({ icon, label, value }: DetailLineProps) {
  if (!value) {
    return null;
  }

  return (
    <View style={styles.detailLine}>
      <Ionicons name={icon} size={16} color={colors.textMuted} />
      <View style={styles.detailText}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text style={styles.detailValue}>{value}</Text>
      </View>
    </View>
  );
}

function ActivityRowComponent({
  activity,
  actionsDisabled = false,
  onEdit,
  onDelete,
  onChangeStatus,
}: ActivityRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const typeColors = getTimelineTokenColors(
    activity.activity_type?.color_token,
  );
  const typeIcon = getTimelineIconName(activity.activity_type?.icon_key);
  const typeLabel = activity.activity_type?.label || 'Other';
  const statusMeta = STATUS_META[activity.status];
  const assigneeLabel =
    activity.assignee_scope === 'EVERYONE'
      ? 'Everyone'
      : activity.assignee?.display_name ?? '';
  const locationLabel =
    activity.location.location_label || activity.location.place?.title || '';
  const reminders = useMemo(
    () => activity.reminder_offsets_minutes.map(formatReminder).join(', '),
    [activity.reminder_offsets_minutes],
  );
  const typeBadgeStyle = useMemo(
    () => ({ backgroundColor: typeColors.backgroundColor }),
    [typeColors.backgroundColor],
  );
  const typeBadgeTextStyle = useMemo(
    () => ({ color: typeColors.color }),
    [typeColors.color],
  );
  const statusBadgeStyle = useMemo(
    () => ({ backgroundColor: statusMeta.backgroundColor }),
    [statusMeta.backgroundColor],
  );
  const statusBadgeTextStyle = useMemo(
    () => ({ color: statusMeta.color }),
    [statusMeta.color],
  );

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const openExternalUrl = useCallback(async (url: string) => {
    setLinkNotice(null);
    try {
      const supported = await Linking.canOpenURL(url);
      if (!supported) {
        setLinkNotice('Could not open this link. Try again later.');
        return;
      }
      await Linking.openURL(url);
    } catch {
      setLinkNotice('Could not open this link. Try again later.');
    }
  }, []);

  const openLocation = useCallback(() => {
    const url = activity.location.open_url;
    if (url) {
      void openExternalUrl(url);
    }
  }, [activity.location.open_url, openExternalUrl]);

  const openActivityLink = useCallback(() => {
    if (activity.external_link) {
      void openExternalUrl(activity.external_link);
    }
  }, [activity.external_link, openExternalUrl]);

  const editActivity = useCallback(() => {
    onEdit?.(activity.id);
  }, [activity.id, onEdit]);

  const deleteActivity = useCallback(() => {
    onDelete?.(activity.id);
  }, [activity.id, onDelete]);

  const changeStatus = useCallback(
    (nextStatus: TimelineActivityStatus) =>
      onChangeStatus?.(activity.id, nextStatus) ?? Promise.resolve(),
    [activity.id, onChangeStatus],
  );

  return (
    <View
      style={[
        styles.card,
        activity.status === 'CANCELLED' ? styles.cancelledCard : null,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${activity.title} details`}
        accessibilityState={{ expanded }}
        onPress={toggleExpanded}
        style={({ pressed }) => [
          styles.summary,
          pressed ? styles.pressed : null,
        ]}
      >
        <View style={styles.summaryTop}>
          <View style={styles.titleBlock}>
            <Text style={styles.time}>{formatActivityTime(activity)}</Text>
            <Text style={styles.title}>{activity.title}</Text>
          </View>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={colors.textMuted}
          />
        </View>

        <View style={styles.badgeRow}>
          <View style={[styles.typeBadge, typeBadgeStyle]}>
            <Ionicons name={typeIcon} size={14} color={typeColors.color} />
            <Text style={[styles.badgeText, typeBadgeTextStyle]}>
              {typeLabel}
            </Text>
          </View>
          <View style={[styles.statusBadge, statusBadgeStyle]}>
            <Text style={[styles.badgeText, statusBadgeTextStyle]}>
              {statusMeta.label}
            </Text>
          </View>
          {assigneeLabel ? (
            <View style={styles.assignee}>
              <Ionicons
                name="person-outline"
                size={14}
                color={colors.textMuted}
              />
              <Text style={styles.assigneeText}>{assigneeLabel}</Text>
            </View>
          ) : null}
        </View>
      </Pressable>

      {locationLabel ? (
        activity.location.open_url ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open directions to ${locationLabel}`}
            onPress={openLocation}
            style={({ pressed }) => [
              styles.locationChip,
              pressed ? styles.pressed : null,
            ]}
          >
            <Ionicons name="location-outline" size={17} color={colors.primary} />
            <Text numberOfLines={2} style={styles.locationText}>
              {locationLabel}
            </Text>
            <Ionicons name="open-outline" size={15} color={colors.primary} />
          </Pressable>
        ) : (
          <View style={styles.locationChip}>
            <Ionicons name="location-outline" size={17} color={colors.primary} />
            <Text numberOfLines={2} style={styles.locationText}>
              {locationLabel}
            </Text>
          </View>
        )
      ) : null}

      {expanded ? (
        <View style={styles.details}>
          <DetailLine icon="document-text-outline" label="Note" value={activity.note} />
          <DetailLine
            icon="navigate-outline"
            label="Meeting point"
            value={activity.meeting_point}
          />
          <DetailLine
            icon="person-circle-outline"
            label="Contact"
            value={activity.contact_name}
          />
          <DetailLine
            icon="call-outline"
            label="Phone"
            value={activity.contact_phone}
          />
          <DetailLine
            icon="ticket-outline"
            label="Booking reference"
            value={activity.booking_reference}
          />
          <DetailLine
            icon="information-circle-outline"
            label="Location note"
            value={activity.location.location_note}
          />
          <DetailLine
            icon="notifications-outline"
            label="Reminders"
            value={reminders}
          />
          {activity.external_link ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Open link for ${activity.title}`}
              onPress={openActivityLink}
              style={({ pressed }) => [
                styles.externalLink,
                pressed ? styles.pressed : null,
              ]}
            >
              <Ionicons name="link-outline" size={16} color={colors.primary} />
              <Text style={styles.externalLinkText}>Open link</Text>
              <Ionicons name="open-outline" size={14} color={colors.primary} />
            </Pressable>
          ) : null}
          {onChangeStatus ? (
            <ActivityStatusControls
              activity={activity}
              disabled={actionsDisabled}
              onChangeStatus={changeStatus}
            />
          ) : null}
        </View>
      ) : null}

      {linkNotice ? (
        <View accessibilityRole="alert" style={styles.linkNotice}>
          <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
          <Text style={styles.linkNoticeText}>{linkNotice}</Text>
        </View>
      ) : null}

      {(activity.capabilities.can_edit && onEdit) ||
      (activity.capabilities.can_delete && onDelete) ? (
        <View style={styles.actionRow}>
          {activity.capabilities.can_edit && onEdit ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${activity.title}`}
              accessibilityState={{ disabled: actionsDisabled }}
              disabled={actionsDisabled}
              onPress={editActivity}
              style={({ pressed }) => [
                styles.actionButton,
                pressed || actionsDisabled ? styles.pressed : null,
              ]}
            >
              <Ionicons name="create-outline" size={16} color={colors.primary} />
              <Text style={styles.editText}>Edit</Text>
            </Pressable>
          ) : null}
          {activity.capabilities.can_delete && onDelete ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${activity.title}`}
              accessibilityState={{ disabled: actionsDisabled }}
              disabled={actionsDisabled}
              onPress={deleteActivity}
              style={({ pressed }) => [
                styles.actionButton,
                pressed || actionsDisabled ? styles.pressed : null,
              ]}
            >
              <Ionicons name="trash-outline" size={16} color={colors.danger} />
              <Text style={styles.deleteText}>Delete</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export const ActivityRow = memo(ActivityRowComponent);

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
  },
  cancelledCard: { opacity: 0.68 },
  summary: { gap: spacing.sm, padding: spacing.md },
  summaryTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  titleBlock: { flex: 1, gap: spacing.xs },
  time: { ...typography.label, color: colors.textMuted },
  title: { ...typography.body, color: colors.text, fontWeight: '600' },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  typeBadge: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.full,
  },
  statusBadge: {
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.full,
  },
  badgeText: { ...typography.label },
  assignee: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  assigneeText: { ...typography.caption, color: colors.textMuted },
  locationChip: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.primarySoft,
  },
  locationText: { ...typography.caption, color: colors.primary, flex: 1 },
  details: {
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  detailLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  detailText: { flex: 1, gap: spacing.xs },
  detailLabel: { ...typography.label, color: colors.textMuted },
  detailValue: { ...typography.body, color: colors.text },
  externalLink: {
    minHeight: 44,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  externalLinkText: { ...typography.label, color: colors.primary },
  linkNotice: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.dangerSoft,
  },
  linkNoticeText: { ...typography.caption, color: colors.danger, flex: 1 },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  actionButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  editText: { ...typography.label, color: colors.primary },
  deleteText: { ...typography.label, color: colors.danger },
  pressed: { opacity: 0.55 },
});
