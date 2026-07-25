import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import {
  MAX_REMINDER_OFFSETS,
  REMINDER_PRESETS,
} from '../formModel';

interface ReminderPickerProps {
  value: readonly number[];
  enabled: boolean;
  disabled?: boolean;
  error?: string;
  onToggle: (value: number) => void;
}

export function ReminderPicker({
  value,
  enabled,
  disabled = false,
  error,
  onToggle,
}: ReminderPickerProps) {
  const blocked = disabled || !enabled;

  return (
    <View style={styles.group}>
      <View style={styles.heading}>
        <Text style={styles.label}>Reminders</Text>
        <Text style={styles.hint}>
          {enabled
            ? `Choose up to ${MAX_REMINDER_OFFSETS}`
            : 'Set a start time to enable reminders'}
        </Text>
      </View>
      <View style={styles.chips}>
        {REMINDER_PRESETS.map((preset) => {
          const selected = value.includes(preset.value);
          return (
            <Pressable
              key={preset.value}
              accessibilityRole="button"
              accessibilityLabel={`Reminder ${preset.label} before`}
              accessibilityState={{ disabled: blocked, selected }}
              disabled={blocked}
              onPress={() => onToggle(preset.value)}
              style={({ pressed }) => [
                styles.chip,
                selected ? styles.chipSelected : null,
                blocked ? styles.chipDisabled : null,
                pressed && !blocked ? styles.pressed : null,
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  selected ? styles.chipTextSelected : null,
                ]}
              >
                {preset.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  label: { ...typography.label, color: colors.text },
  hint: {
    ...typography.caption,
    color: colors.textMuted,
    flexShrink: 1,
    textAlign: 'right',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.background,
  },
  chipSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  chipDisabled: { opacity: 0.55 },
  chipText: { ...typography.label, color: colors.textMuted },
  chipTextSelected: { color: colors.primary },
  error: { ...typography.caption, color: colors.danger },
  pressed: { opacity: 0.55 },
});
