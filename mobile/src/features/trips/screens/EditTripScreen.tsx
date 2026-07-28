import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { type PropsWithChildren, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { DateField } from '@/shared/ui/DateField';
import { FormError } from '@/shared/ui/FormError';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { Screen } from '@/shared/ui/Screen';
import { TextField } from '@/shared/ui/TextField';
import { updateTrip } from '../api';
import { CoverImageField } from '../components/CoverImageField';
import { DestinationField } from '../components/DestinationField';
import { formatDateParam, parseDateOnly } from '../dates';
import {
  destinationFields,
  destinationValueFromTrip,
  type TripDestinationValue,
} from '../destination';
import { useTripCoverUpload } from '../hooks/useTripCoverUpload';
import { useTripDetail } from '../hooks/useTripDetail';
import { getTimezoneOptions, TRIP_CURRENCY_CODES } from '../options';
import { publishTripEvent } from '../tripEvents';
import type { TripDetailResponse, UpdateTripInput } from '../types';

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

function EditUnavailable({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.centered}>
        <Ionicons name="lock-closed-outline" size={44} color={colors.textMuted} />
        <Text style={styles.sectionTitle}>Trip cannot be edited</Text>
        <Text style={styles.centeredText}>{message}</Text>
        <Button title="Back to trip" onPress={onBack} />
      </View>
    </SafeAreaView>
  );
}

function EditTripForm({ detail }: { detail: TripDetailResponse }) {
  const router = useRouter();
  const original = detail.trip;
  const [name, setName] = useState(original.name);
  const [destination, setDestination] = useState<TripDestinationValue>(() =>
    destinationValueFromTrip(original),
  );
  const [destinationTouched, setDestinationTouched] = useState(false);
  const [startDate, setStartDate] = useState(() => parseDateOnly(original.start_date));
  const [endDate, setEndDate] = useState(() => parseDateOnly(original.end_date));
  const [description, setDescription] = useState(original.description);
  const [budget, setBudget] = useState(original.budget_estimate ?? '');
  const [currency, setCurrency] = useState(original.currency_code);
  const [timezone, setTimezone] = useState(original.timezone);
  const [dateError, setDateError] = useState<string | undefined>();
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const cover = useTripCoverUpload(original.cover_image_url);
  const timezoneOptions = getTimezoneOptions(original.timezone);
  const canSubmit = Boolean(name.trim() && destination.label.trim());

  function onDestinationChange(next: TripDestinationValue) {
    setDestinationTouched(true);
    setDestination(next);
  }

  function onStartDateChange(date: Date) {
    setStartDate(date);
    setDateError(undefined);
    if (endDate < date) {
      setEndDate(date);
    }
  }

  async function onSubmit() {
    if (submitLockRef.current) {
      return;
    }

    setError(null);
    setDateError(undefined);
    const start = formatDateParam(startDate);
    const end = formatDateParam(endDate);
    if (end < start) {
      setDateError('End date must be on or after the start date.');
      return;
    }

    const trimmedBudget = budget.trim();
    const input: UpdateTripInput = {
      name: name.trim(),
      start_date: start,
      end_date: end,
      description: description.trim(),
      budget_estimate: trimmedBudget || null,
      currency_code: currency,
      timezone,
    };
    // Destination is omitted entirely unless the user changed it. A PATCH that
    // never mentions destination cannot clear the stored coordinates, which is
    // the one failure mode here that produces no error and no visible symptom.
    if (destinationTouched) {
      Object.assign(input, destinationFields(destination));
    }
    // '' after Remove clears the cover, a new URL replaces it, and an untouched
    // cover is never mentioned at all.
    if (cover.changed) {
      input.cover_image_url = cover.coverUrl;
    }

    submitLockRef.current = true;
    setSubmitting(true);
    try {
      const updated = await updateTrip(original.id, input);
      publishTripEvent({ type: 'updated', trip: updated });
      router.dismissTo(`/trips/${original.id}`);
    } catch (caught) {
      setError(normalizeApiError(caught));
    } finally {
      submitLockRef.current = false;
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
          {cover.busy ? <Text style={styles.submitHint}>Wait for the cover upload to finish.</Text> : null}
          <Button
            title="Save changes"
            onPress={onSubmit}
            loading={submitting}
            disabled={!canSubmit || cover.busy}
          />
        </>
      }
    >
      <FormSection title="Basics">
        <TextField
          label="Trip name *"
          accessibilityLabel="Trip name"
          value={name}
          onChangeText={setName}
          maxLength={120}
          error={error?.fieldErrors?.name}
        />
        <DestinationField
          value={destination}
          onChange={onDestinationChange}
          error={error?.fieldErrors?.destination}
        />
      </FormSection>

      <FormSection title="Cover photo">
        <CoverImageField
          coverUrl={cover.coverUrl}
          status={cover.status}
          error={cover.error ?? error?.fieldErrors?.cover_image_url ?? null}
          onChoose={() => void cover.chooseCover()}
          onRemove={cover.removeCover}
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

      <FormSection title="Details">
        <TextField
          label="Description"
          accessibilityLabel="Description"
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={3}
          maxLength={180}
          error={error?.fieldErrors?.description}
        />
        <TextField
          label="Budget estimate"
          accessibilityLabel="Budget estimate"
          value={budget}
          onChangeText={setBudget}
          keyboardType="decimal-pad"
          error={error?.fieldErrors?.budget_estimate}
        />
        <View style={styles.optionGroup}>
          <Text style={styles.optionLabel}>Currency</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.optionRow}>
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
            <Text style={styles.optionError}>{error.fieldErrors.currency_code}</Text>
          ) : null}
        </View>
        <View style={styles.optionGroup}>
          <Text style={styles.optionLabel}>Timezone</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.optionRow}>
            {timezoneOptions.map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={`Timezone ${value}`}
                accessibilityState={{ selected: timezone === value }}
                onPress={() => setTimezone(value)}
                style={[styles.chip, timezone === value && styles.chipSelected]}
              >
                <Text style={[styles.chipText, timezone === value && styles.chipTextSelected]}>{value}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {error?.fieldErrors?.timezone ? <Text style={styles.optionError}>{error.fieldErrors.timezone}</Text> : null}
        </View>
      </FormSection>
    </Screen>
  );
}

export function EditTripScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const router = useRouter();
  const { detail, status, error, refresh } = useTripDetail(tripId);
  const backToTrip = () => router.dismissTo(`/trips/${tripId}`);

  if (status === 'loading') {
    return <LoadingScreen />;
  }

  if (status === 'error' || !detail) {
    const notFound = error?.status === 404;
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centered}>
          <Ionicons name={notFound ? 'help-circle-outline' : 'cloud-offline-outline'} size={44} color={colors.textMuted} />
          <Text style={styles.sectionTitle}>{notFound ? 'Trip not found' : 'Could not load trip'}</Text>
          <Text style={styles.centeredText}>
            {notFound ? 'This trip does not exist or you are not a member of it.' : error?.message}
          </Text>
          {notFound ? null : <Button title="Try again" onPress={() => void refresh('initial')} />}
        </View>
      </SafeAreaView>
    );
  }

  const { trip, my_membership: membership } = detail;
  if (membership.status !== 'ACTIVE' || membership.role !== 'CAPTAIN') {
    return <EditUnavailable message="Only the active trip captain can edit trip information." onBack={backToTrip} />;
  }
  if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED') {
    return <EditUnavailable message="Completed and cancelled trips can no longer be edited." onBack={backToTrip} />;
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Edit Trip' }} />
      <EditTripForm key={trip.id} detail={detail} />
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.lg },
  centeredText: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
  section: { gap: spacing.md, padding: spacing.md, borderRadius: radii.lg, backgroundColor: colors.surface },
  sectionTitle: { ...typography.heading, color: colors.text },
  optionGroup: { gap: spacing.sm },
  optionLabel: { ...typography.label, color: colors.text },
  optionRow: { gap: spacing.sm },
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.background,
  },
  chipSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  chipText: { ...typography.label, color: colors.textMuted },
  chipTextSelected: { color: colors.primary },
  optionError: { ...typography.caption, color: colors.danger },
  submitHint: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
});
