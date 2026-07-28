import { useRouter } from 'expo-router';
import { type PropsWithChildren, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { DateField } from '@/shared/ui/DateField';
import { FormError } from '@/shared/ui/FormError';
import { Screen } from '@/shared/ui/Screen';
import { TextField } from '@/shared/ui/TextField';
import { createTrip } from '../api';
import { DestinationField } from '../components/DestinationField';
import { formatDateParam } from '../dates';
import { destinationFields, type TripDestinationValue } from '../destination';
import { TRIP_CURRENCY_CODES } from '../options';
import type { CreateTripInput } from '../types';

function FormSection({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

export function CreateTripScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [destination, setDestination] = useState<TripDestinationValue>({
    label: '',
    place: null,
  });
  const [startDate, setStartDate] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date());
  const [description, setDescription] = useState('');
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('VND');
  const [dateError, setDateError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = Boolean(name.trim() && destination.label.trim());

  function onStartDateChange(date: Date) {
    setStartDate(date);
    setDateError(undefined);
    if (endDate < date) {
      setEndDate(date);
    }
  }

  async function onSubmit() {
    setError(null);
    setDateError(undefined);
    const start = formatDateParam(startDate);
    const end = formatDateParam(endDate);
    if (end < start) {
      setDateError('End date must be on or after the start date.');
      return;
    }
    const input: CreateTripInput = {
      name: name.trim(),
      ...destinationFields(destination),
      start_date: start,
      end_date: end,
      currency_code: currency,
    };
    const trimmedDescription = description.trim();
    if (trimmedDescription) {
      input.description = trimmedDescription;
    }
    const trimmedBudget = budget.trim();
    if (trimmedBudget) {
      input.budget_estimate = trimmedBudget;
    }
    setSubmitting(true);
    try {
      const trip = await createTrip(input);
      router.replace(`/trips/${trip.id}`);
    } catch (err) {
      setError(normalizeApiError(err));
      setSubmitting(false);
    }
  }

  return (
    <Screen
      scroll
      edges={['left', 'right', 'bottom']}
      footer={
        <>
          <FormError error={error} />
          {!canSubmit ? <Text style={styles.submitHint}>Add a trip name and destination to continue.</Text> : null}
          <Button title="Create trip" onPress={onSubmit} loading={submitting} disabled={!canSubmit} />
        </>
      }
    >
      <View style={styles.intro}>
        <Text style={styles.introTitle}>Start with the essentials</Text>
        <Text style={styles.introBody}>You can add plans, expenses, and friends after creating the trip.</Text>
        <Text style={styles.requiredHint}>Fields marked * are required.</Text>
      </View>

      <FormSection title="Basics">
        <TextField
          label="Trip name *"
          accessibilityLabel="Trip name"
          placeholder="Weekend in Da Lat"
          value={name}
          onChangeText={setName}
          maxLength={120}
          error={error?.fieldErrors?.name}
        />
        <DestinationField
          value={destination}
          onChange={setDestination}
          error={error?.fieldErrors?.destination}
        />
      </FormSection>

      <FormSection title="Dates">
        <DateField
          label="Start date"
          value={startDate}
          onChange={onStartDateChange}
          error={error?.fieldErrors?.start_date}
        />
        <DateField
          label="End date"
          value={endDate}
          onChange={(date) => {
            setEndDate(date);
            setDateError(undefined);
          }}
          minimumDate={startDate}
          error={dateError ?? error?.fieldErrors?.end_date}
        />
      </FormSection>

      <FormSection title="Optional details">
        <TextField
          label="Description"
          accessibilityLabel="Description"
          placeholder="What do you want everyone to know?"
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={3}
          error={error?.fieldErrors?.description}
        />
        <TextField
          label="Budget estimate"
          accessibilityLabel="Budget estimate"
          placeholder="0"
          value={budget}
          onChangeText={setBudget}
          keyboardType="decimal-pad"
          error={error?.fieldErrors?.budget_estimate}
        />
        <View style={styles.currencyGroup}>
          <View style={styles.currencyHeading}>
            <Text style={styles.currencyLabel}>Currency</Text>
            <Text style={styles.currencyHint}>Swipe for more</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.currencyRow}>
            {TRIP_CURRENCY_CODES.map((code) => (
              <Pressable
                key={code}
                accessibilityRole="button"
                accessibilityLabel={`Currency ${code}`}
                accessibilityState={{ selected: currency === code }}
                onPress={() => setCurrency(code)}
                style={[styles.chip, currency === code && styles.chipSelected]}
              >
                <Text style={[styles.chipText, currency === code && styles.chipTextSelected]}>{code}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {error?.fieldErrors?.currency_code ? (
            <Text style={styles.currencyError}>{error.fieldErrors.currency_code}</Text>
          ) : null}
        </View>
      </FormSection>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: spacing.xs },
  introTitle: { ...typography.heading, color: colors.text },
  introBody: { ...typography.body, color: colors.textMuted },
  requiredHint: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  section: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
  },
  sectionTitle: { ...typography.heading, color: colors.text },
  currencyGroup: { gap: spacing.sm },
  currencyHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  currencyLabel: { ...typography.label, color: colors.text },
  currencyHint: { ...typography.caption, color: colors.textMuted },
  currencyRow: { gap: spacing.sm },
  currencyError: { ...typography.caption, color: colors.danger },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.background,
  },
  chipSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  chipText: { ...typography.label, color: colors.textMuted },
  chipTextSelected: { color: colors.primary },
  submitHint: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
});
