import { StyleSheet, Text, View } from 'react-native';
import type { ApiError } from '@/shared/api/errors';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { DateField } from '@/shared/ui/DateField';
import { FormError } from '@/shared/ui/FormError';
import { Screen } from '@/shared/ui/Screen';
import { TextField } from '@/shared/ui/TextField';
import { formatDateParam, parseDateOnly } from '@/features/trips/dates';
import type {
  SectionFormDraft,
  SectionFormFieldErrors,
} from '../formModel';

interface SectionFormProps {
  mode: 'create' | 'edit';
  draft: SectionFormDraft;
  fieldErrors: SectionFormFieldErrors;
  submitError: ApiError | null;
  dateUnavailable: boolean;
  dirty: boolean;
  submitting: boolean;
  onChange: (changes: Partial<SectionFormDraft>) => void;
  onSubmit: () => void;
}

const DATE_UNAVAILABLE_MESSAGE = 'This date already has a timeline day.';
const FALLBACK_DATE = new Date(2000, 0, 1, 12, 0, 0, 0);

function dateForPicker(value: string): Date {
  const parsed = parseDateOnly(value);
  return Number.isNaN(parsed.getTime()) ? FALLBACK_DATE : parsed;
}

export function SectionForm({
  mode,
  draft,
  fieldErrors,
  submitError,
  dateUnavailable,
  dirty,
  submitting,
  onChange,
  onSubmit,
}: SectionFormProps) {
  const labelError = fieldErrors.label ?? submitError?.fieldErrors?.label;
  const dateError =
    fieldErrors.section_date ??
    (dateUnavailable ? DATE_UNAVAILABLE_MESSAGE : undefined) ??
    submitError?.fieldErrors?.section_date;
  const unchanged = mode === 'edit' && !dirty;

  return (
    <Screen
      scroll
      edges={['left', 'right', 'bottom']}
      footer={
        <>
          <FormError error={submitError} />
          {unchanged ? (
            <Text style={styles.submitHint}>Change the label or date to save.</Text>
          ) : null}
          <Button
            title={mode === 'create' ? 'Add day' : 'Save day'}
            onPress={onSubmit}
            loading={submitting}
            disabled={dateUnavailable || unchanged}
          />
        </>
      }
    >
      <View style={styles.intro}>
        <Text accessibilityRole="header" style={styles.title}>
          {mode === 'create' ? 'Add a timeline day' : 'Edit timeline day'}
        </Text>
        <Text style={styles.body}>
          Choose the date and the label shown in the trip timeline.
        </Text>
      </View>
      <TextField
        label="Label *"
        accessibilityLabel="Day label"
        value={draft.label}
        onChangeText={(label) => onChange({ label })}
        editable={!submitting}
        maxLength={120}
        error={labelError}
      />
      <View
        pointerEvents={submitting ? 'none' : 'auto'}
        style={submitting ? styles.disabledField : null}
      >
        <DateField
          label="Date *"
          value={dateForPicker(draft.section_date)}
          onChange={(date) =>
            onChange({
              section_date: Number.isNaN(date.getTime())
                ? ''
                : formatDateParam(date),
            })
          }
          error={dateError}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: spacing.xs },
  title: { ...typography.heading, color: colors.text },
  body: { ...typography.body, color: colors.textMuted },
  disabledField: { opacity: 0.55 },
  submitHint: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
