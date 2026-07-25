import { DatePicker, Host } from '@expo/ui/swift-ui';
import {
  accessibilityHint,
  accessibilityLabel,
  accessibilityValue,
  disabled as disabledModifier,
} from '@expo/ui/swift-ui/modifiers';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';

interface TimeFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ANCHOR_YEAR = 2000;
const ANCHOR_MONTH = 0;
const ANCHOR_DAY = 1;

function parseTime(value: string): { hours: number; minutes: number } | null {
  if (!TIME_PATTERN.test(value)) {
    return null;
  }

  const [hours, minutes] = value.split(':').map(Number);
  return { hours, minutes };
}

function createAnchoredDate(value: string): { date: Date; valid: boolean } {
  const parsed = parseTime(value);
  const date = new Date(
    ANCHOR_YEAR,
    ANCHOR_MONTH,
    ANCHOR_DAY,
    parsed?.hours ?? 0,
    parsed?.minutes ?? 0,
    0,
    0,
  );
  return { date, valid: parsed !== null };
}

function formatLocalTime(date: Date): string | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function TimeField({
  label,
  value,
  onChange,
  disabled = false,
  error,
}: TimeFieldProps) {
  const anchored = useMemo(() => createAnchoredDate(value), [value]);
  const pickerModifiers = useMemo(
    () => [
      accessibilityLabel(label),
      accessibilityValue(anchored.valid ? value : 'Not set'),
      accessibilityHint(
        disabled ? 'Time selection is unavailable.' : 'Adjust the hour and minute.',
      ),
      ...(disabled ? [disabledModifier()] : []),
    ],
    [anchored.valid, disabled, label, value],
  );
  const handleDateChange = useCallback(
    (date: Date) => {
      if (disabled) {
        return;
      }
      const nextValue = formatLocalTime(date);
      if (nextValue !== null && nextValue !== value) {
        onChange(nextValue);
      }
    },
    [disabled, onChange, value],
  );

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View
        style={[
          styles.field,
          error ? styles.fieldError : null,
          disabled ? styles.fieldDisabled : null,
        ]}
      >
        <Ionicons name="time-outline" size={20} color={colors.textMuted} />
        <Host matchContents colorScheme="light" style={styles.picker}>
          <DatePicker
            testID="time-field-picker"
            selection={anchored.date}
            onDateChange={handleDateChange}
            displayedComponents={['hourAndMinute']}
            modifiers={pickerModifiers}
          />
        </Host>
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
  wrap: { gap: spacing.xs },
  label: { ...typography.label, color: colors.text },
  field: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  fieldError: { borderColor: colors.danger },
  fieldDisabled: { opacity: 0.55 },
  picker: { minHeight: 40 },
  error: { ...typography.caption, color: colors.danger },
});
