import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import type { TimelineSection } from '../types';
import { formatSectionDate } from '../viewModel';

interface SectionGroupProps {
  section: TimelineSection;
  canEdit?: boolean;
  canDelete?: boolean;
  onEdit?: (section: TimelineSection) => void;
  onDelete?: (section: TimelineSection) => void;
}

function SectionGroupComponent({
  section,
  canEdit = false,
  canDelete = false,
  onEdit,
  onDelete,
}: SectionGroupProps) {
  const editSection = useCallback(() => {
    onEdit?.(section);
  }, [onEdit, section]);
  const deleteSection = useCallback(() => {
    onDelete?.(section);
  }, [onDelete, section]);

  return (
    <View style={styles.header}>
      <View style={styles.copy}>
        <View style={styles.labelRow}>
          <Text accessibilityRole="header" style={styles.title}>
            {section.label}
          </Text>
          <View
            style={[
              styles.rangeBadge,
              section.is_in_trip_range
                ? styles.inRangeBadge
                : styles.outOfRangeBadge,
            ]}
          >
            <Text
              style={[
                styles.rangeText,
                section.is_in_trip_range
                  ? styles.inRangeText
                  : styles.outOfRangeText,
              ]}
            >
              {section.is_in_trip_range ? 'Trip date' : 'Outside trip'}
            </Text>
          </View>
        </View>
        <Text style={styles.date}>{formatSectionDate(section.section_date)}</Text>
      </View>

      {(canEdit && onEdit) || (canDelete && onDelete) ? (
        <View style={styles.actions}>
          {canEdit && onEdit ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${section.label}`}
              hitSlop={spacing.sm}
              onPress={editSection}
              style={({ pressed }) => [
                styles.actionButton,
                pressed ? styles.pressed : null,
              ]}
            >
              <Ionicons name="create-outline" size={18} color={colors.primary} />
            </Pressable>
          ) : null}
          {canDelete && onDelete ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${section.label}`}
              hitSlop={spacing.sm}
              onPress={deleteSection}
              style={({ pressed }) => [
                styles.actionButton,
                pressed ? styles.pressed : null,
              ]}
            >
              <Ionicons name="trash-outline" size={18} color={colors.danger} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export const SectionGroup = memo(SectionGroupComponent);

const styles = StyleSheet.create({
  header: {
    minHeight: 84,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  copy: { flex: 1, gap: spacing.xs },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  title: { ...typography.heading, color: colors.text, flexShrink: 1 },
  date: { ...typography.caption, color: colors.textMuted },
  rangeBadge: {
    minHeight: 24,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.full,
  },
  inRangeBadge: { backgroundColor: colors.successSoft },
  outOfRangeBadge: { backgroundColor: colors.completedSoft },
  rangeText: { ...typography.label },
  inRangeText: { color: colors.success },
  outOfRangeText: { color: colors.completedText },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  actionButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  pressed: { opacity: 0.55 },
});
