import { memo, type ReactNode, useCallback, useMemo } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { FormError } from '@/shared/ui/FormError';
import { TextField } from '@/shared/ui/TextField';
import type { TripMember } from '@/features/trips/types';
import {
  ACTIVITY_FIELD_LIMITS,
  applyActivityLocationMode,
  applyActivityTimeMode,
  getSelectableCustomTypes,
  toggleActivityReminder,
  type ActivityDraftField,
  type ActivityFormDraft,
  type ActivityFormFieldErrors,
} from '../formModel';
import type {
  TimelineActivity,
  TimelineActivityTimeMode,
  TimelineCustomTypeMeta,
  TimelineSystemTypeMeta,
} from '../types';
import type { StructuredLocationValue } from '../viewModel';
import { ReminderPicker } from './ReminderPicker';
import { TimeField } from './TimeField';

const TIME_MODE_OPTIONS: readonly {
  value: TimelineActivityTimeMode;
  label: string;
}[] = [
  { value: 'AT_TIME', label: 'At time' },
  { value: 'TIME_RANGE', label: 'Time range' },
  { value: 'ALL_DAY', label: 'All day' },
  { value: 'FLEXIBLE', label: 'Flexible' },
];

export interface StructuredLocationEditorProps {
  value: StructuredLocationValue | null;
  locationLabel: string;
  disabled: boolean;
  fieldErrors: Readonly<Record<string, string>>;
  onChange: (value: StructuredLocationValue) => void;
  onUseManual: (locationLabel?: string) => void;
}

interface ActivityFormProps {
  mode: 'create' | 'edit';
  draft: ActivityFormDraft;
  initialActivity?: TimelineActivity;
  systemTypes: readonly TimelineSystemTypeMeta[];
  customTypes: readonly TimelineCustomTypeMeta[];
  members: readonly TripMember[];
  canManageCustomTypes: boolean;
  canSubmit: boolean;
  authorityMessage?: string;
  submitting: boolean;
  refreshing: boolean;
  localFieldErrors: ActivityFormFieldErrors;
  submitError: ApiError | null;
  backgroundError: ApiError | null;
  onDraftChange: (
    draft: ActivityFormDraft,
    changedFields: readonly ActivityDraftField[],
  ) => void;
  onSubmit: () => void;
  onRefresh: () => void;
  onRetryBackground: () => void;
  onManageCustomTypes: () => void;
  renderStructuredLocationEditor?: (
    props: StructuredLocationEditorProps,
  ) => ReactNode;
}

interface ChoiceChipProps {
  label: string;
  accessibilityLabel: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}

const ChoiceChip = memo(function ChoiceChip({
  label,
  accessibilityLabel,
  selected,
  disabled,
  onPress,
}: ChoiceChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected ? styles.chipSelected : null,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text
        style={[styles.chipText, selected ? styles.chipTextSelected : null]}
      >
        {label}
      </Text>
    </Pressable>
  );
});

interface CustomTypeChoiceProps {
  item: TimelineCustomTypeMeta;
  selected: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
}

const CustomTypeChoice = memo(function CustomTypeChoice({
  item,
  selected,
  disabled,
  onSelect,
}: CustomTypeChoiceProps) {
  const select = useCallback(() => onSelect(item.id), [item.id, onSelect]);
  return (
    <ChoiceChip
      label={`${item.name}${item.is_active ? '' : ' · inactive'}`}
      accessibilityLabel={`Custom type ${item.name}${item.is_active ? '' : ', inactive'}`}
      selected={selected}
      disabled={disabled}
      onPress={select}
    />
  );
});

interface MemberChoiceProps {
  item: TripMember;
  selected: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
}

const MemberChoice = memo(function MemberChoice({
  item,
  selected,
  disabled,
  onSelect,
}: MemberChoiceProps) {
  const select = useCallback(
    () => onSelect(item.user.id),
    [item.user.id, onSelect],
  );
  return (
    <ChoiceChip
      label={item.user.display_name}
      accessibilityLabel={`Assign to ${item.user.display_name}`}
      selected={selected}
      disabled={disabled}
      onPress={select}
    />
  );
});

function EmptyCustomTypes() {
  return <Text style={styles.emptyChoice}>No custom types available.</Text>;
}

function EmptyMembers() {
  return <Text style={styles.emptyChoice}>No active members available.</Text>;
}

export function ActivityForm({
  mode,
  draft,
  initialActivity,
  systemTypes,
  customTypes,
  members,
  canManageCustomTypes,
  canSubmit,
  authorityMessage,
  submitting,
  refreshing,
  localFieldErrors,
  submitError,
  backgroundError,
  onDraftChange,
  onSubmit,
  onRefresh,
  onRetryBackground,
  onManageCustomTypes,
  renderStructuredLocationEditor,
}: ActivityFormProps) {
  const fieldErrors = useMemo<ActivityFormFieldErrors>(
    () => ({
      ...(submitError?.fieldErrors ?? {}),
      ...localFieldErrors,
    }),
    [localFieldErrors, submitError?.fieldErrors],
  );
  const selectableCustomTypes = useMemo(
    () => getSelectableCustomTypes(customTypes, initialActivity),
    [customTypes, initialActivity],
  );
  const disabled = submitting || !canSubmit;
  const activityTypeError = firstError(
    fieldErrors,
    'activity_type',
    'system_type',
    'custom_type_id',
  );
  const assigneeError = firstError(
    fieldErrors,
    'assignee_user_id',
    'assignee_scope',
  );
  const placeErrors = useMemo(
    () => collectPlaceErrors(fieldErrors),
    [fieldErrors],
  );
  const structuredValue = useMemo<StructuredLocationValue | null>(() => {
    if (draft.location_mode !== 'STRUCTURED' || draft.place === null) {
      return null;
    }
    return {
      location_label: draft.location_label,
      place: { ...draft.place },
    };
  }, [draft.location_label, draft.location_mode, draft.place]);

  const changeField = useCallback(
    <K extends ActivityDraftField>(
      field: K,
      value: ActivityFormDraft[K],
    ) => {
      onDraftChange({ ...draft, [field]: value }, [field]);
    },
    [draft, onDraftChange],
  );

  const selectTimeMode = useCallback(
    (timeMode: TimelineActivityTimeMode) => {
      onDraftChange(applyActivityTimeMode(draft, timeMode), [
        'time_mode',
        'start_time',
        'end_time',
        'reminder_offsets_minutes',
      ]);
    },
    [draft, onDraftChange],
  );

  const selectSystemType = useCallback(
    (code: TimelineSystemTypeMeta['code']) => {
      onDraftChange(
        {
          ...draft,
          system_type: code,
          custom_type_id: null,
        },
        ['system_type', 'custom_type_id'],
      );
    },
    [draft, onDraftChange],
  );

  const selectCustomType = useCallback(
    (id: string) => {
      onDraftChange(
        {
          ...draft,
          system_type: null,
          custom_type_id: id,
        },
        ['system_type', 'custom_type_id'],
      );
    },
    [draft, onDraftChange],
  );

  const selectAssigneeScope = useCallback(
    (scope: 'NONE' | 'EVERYONE') => {
      onDraftChange(
        {
          ...draft,
          assignee_scope: scope,
          assignee_user_id: null,
        },
        ['assignee_scope', 'assignee_user_id'],
      );
    },
    [draft, onDraftChange],
  );

  const selectMember = useCallback(
    (id: string) => {
      onDraftChange(
        {
          ...draft,
          assignee_scope: 'USER',
          assignee_user_id: id,
        },
        ['assignee_scope', 'assignee_user_id'],
      );
    },
    [draft, onDraftChange],
  );

  const useManualLocation = useCallback(
    (locationLabel?: string) => {
      const nextDraft = applyActivityLocationMode(draft, 'MANUAL');
      if (locationLabel !== undefined) {
        nextDraft.location_label = locationLabel;
      }
      onDraftChange(
        nextDraft,
        locationLabel === undefined
          ? ['location_mode', 'place']
          : ['location_mode', 'location_label', 'place'],
      );
    },
    [draft, onDraftChange],
  );

  const commitStructuredLocation = useCallback(
    (value: StructuredLocationValue) => {
      onDraftChange(
        {
          ...draft,
          location_mode: 'STRUCTURED',
          location_label: value.location_label,
          place: { ...value.place },
        },
        ['location_mode', 'location_label', 'place'],
      );
    },
    [draft, onDraftChange],
  );

  const toggleReminder = useCallback(
    (value: number) => {
      const nextDraft = toggleActivityReminder(draft, value);
      if (nextDraft !== draft) {
        onDraftChange(nextDraft, ['reminder_offsets_minutes']);
      }
    },
    [draft, onDraftChange],
  );

  const renderCustomType = useCallback(
    ({ item }: ListRenderItemInfo<TimelineCustomTypeMeta>) => (
      <CustomTypeChoice
        item={item}
        selected={
          draft.system_type === null && draft.custom_type_id === item.id
        }
        disabled={disabled}
        onSelect={selectCustomType}
      />
    ),
    [disabled, draft.custom_type_id, draft.system_type, selectCustomType],
  );

  const renderMember = useCallback(
    ({ item }: ListRenderItemInfo<TripMember>) => (
      <MemberChoice
        item={item}
        selected={
          draft.assignee_scope === 'USER' &&
          draft.assignee_user_id === item.user.id
        }
        disabled={disabled}
        onSelect={selectMember}
      />
    ),
    [
      disabled,
      draft.assignee_scope,
      draft.assignee_user_id,
      selectMember,
    ],
  );

  const structuredEditorProps: StructuredLocationEditorProps = {
    value: structuredValue,
    locationLabel: draft.location_label,
    disabled,
    fieldErrors: fieldErrors as Readonly<Record<string, string>>,
    onChange: commitStructuredLocation,
    onUseManual: useManualLocation,
  };

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          testID="activity-form-scroll"
          contentContainerStyle={styles.content}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              testID="activity-form-refresh-control"
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          }
        >
          {backgroundError ? (
            <View accessibilityRole="alert" style={styles.errorBanner}>
              <Text style={styles.errorBannerText}>
                {backgroundError.message}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry refreshing activity form"
                onPress={onRetryBackground}
                style={({ pressed }) => [
                  styles.retry,
                  pressed ? styles.pressed : null,
                ]}
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : null}

          <FormSection title="Basics">
            <TextField
              label="Title *"
              accessibilityLabel="Activity title"
              value={draft.title}
              onChangeText={(value) => changeField('title', value)}
              maxLength={ACTIVITY_FIELD_LIMITS.title}
              editable={!disabled}
              error={fieldErrors.title}
            />
          </FormSection>

          <FormSection title="Schedule">
            <View style={styles.chipWrap}>
              {TIME_MODE_OPTIONS.map((option) => (
                <ChoiceChip
                  key={option.value}
                  label={option.label}
                  accessibilityLabel={`Schedule ${option.label}`}
                  selected={draft.time_mode === option.value}
                  disabled={disabled}
                  onPress={() => selectTimeMode(option.value)}
                />
              ))}
            </View>
            {fieldErrors.time_mode ? (
              <InlineError message={fieldErrors.time_mode} />
            ) : null}
            {draft.time_mode === 'AT_TIME' ||
            draft.time_mode === 'TIME_RANGE' ? (
              <TimeField
                label="Start time *"
                value={draft.start_time}
                onChange={(value) => changeField('start_time', value)}
                disabled={disabled}
                error={fieldErrors.start_time}
              />
            ) : null}
            {draft.time_mode === 'TIME_RANGE' ? (
              <TimeField
                label="End time *"
                value={draft.end_time}
                onChange={(value) => changeField('end_time', value)}
                disabled={disabled}
                error={fieldErrors.end_time}
              />
            ) : null}
          </FormSection>

          <FormSection title="Activity type *">
            <Text style={styles.optionLabel}>System types</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.choiceRow}
            >
              {systemTypes.map((systemType) => (
                <ChoiceChip
                  key={systemType.code}
                  label={systemType.label}
                  accessibilityLabel={`System type ${systemType.label}`}
                  selected={draft.system_type === systemType.code}
                  disabled={disabled}
                  onPress={() => selectSystemType(systemType.code)}
                />
              ))}
            </ScrollView>

            <View style={styles.optionHeading}>
              <Text style={styles.optionLabel}>Custom types</Text>
              {canManageCustomTypes ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Manage custom types"
                  disabled={submitting}
                  onPress={onManageCustomTypes}
                  style={({ pressed }) => [
                    styles.textAction,
                    pressed && !submitting ? styles.pressed : null,
                  ]}
                >
                  <Text style={styles.textActionLabel}>Manage</Text>
                </Pressable>
              ) : null}
            </View>
            <FlatList
              testID="custom-type-list"
              horizontal
              data={selectableCustomTypes}
              keyExtractor={customTypeKey}
              renderItem={renderCustomType}
              ListEmptyComponent={EmptyCustomTypes}
              contentContainerStyle={styles.choiceRow}
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            />
            {activityTypeError ? (
              <InlineError message={activityTypeError} />
            ) : null}
          </FormSection>

          <FormSection title="Assignee">
            <View style={styles.chipWrap}>
              <ChoiceChip
                label="None"
                accessibilityLabel="Assign to no one"
                selected={draft.assignee_scope === 'NONE'}
                disabled={disabled}
                onPress={() => selectAssigneeScope('NONE')}
              />
              <ChoiceChip
                label="Everyone"
                accessibilityLabel="Assign to everyone"
                selected={draft.assignee_scope === 'EVERYONE'}
                disabled={disabled}
                onPress={() => selectAssigneeScope('EVERYONE')}
              />
            </View>
            <FlatList
              testID="assignee-member-list"
              horizontal
              data={members}
              keyExtractor={memberKey}
              renderItem={renderMember}
              ListEmptyComponent={EmptyMembers}
              contentContainerStyle={styles.choiceRow}
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            />
            {assigneeError ? <InlineError message={assigneeError} /> : null}
          </FormSection>

          <FormSection title="Location">
            {renderStructuredLocationEditor
              ? renderStructuredLocationEditor(structuredEditorProps)
              : null}

            {draft.location_mode === 'STRUCTURED' &&
            !renderStructuredLocationEditor ? (
              <DefaultStructuredLocation
                value={structuredValue}
                disabled={disabled}
                onUseManual={useManualLocation}
              />
            ) : null}

            {draft.location_mode === 'MANUAL' ? (
              <TextField
                label="Location label"
                accessibilityLabel="Location label"
                value={draft.location_label}
                onChangeText={(value) =>
                  changeField('location_label', value)
                }
                maxLength={ACTIVITY_FIELD_LIMITS.location_label}
                editable={!disabled}
                error={fieldErrors.location_label}
              />
            ) : fieldErrors.location_label ? (
              <InlineError message={fieldErrors.location_label} />
            ) : null}

            {!renderStructuredLocationEditor
              ? placeErrors.map((message) => (
                  <InlineError key={message} message={message} />
                ))
              : null}

            <TextField
              label="Location note"
              accessibilityLabel="Location note"
              value={draft.location_note}
              onChangeText={(value) => changeField('location_note', value)}
              maxLength={ACTIVITY_FIELD_LIMITS.location_note}
              editable={!disabled}
              error={fieldErrors.location_note}
            />
          </FormSection>

          <FormSection title="Details">
            <TextField
              label="Note"
              accessibilityLabel="Activity note"
              value={draft.note}
              onChangeText={(value) => changeField('note', value)}
              multiline
              numberOfLines={4}
              editable={!disabled}
              error={fieldErrors.note}
            />
            <TextField
              label="Meeting point"
              accessibilityLabel="Meeting point"
              value={draft.meeting_point}
              onChangeText={(value) => changeField('meeting_point', value)}
              maxLength={ACTIVITY_FIELD_LIMITS.meeting_point}
              editable={!disabled}
              error={fieldErrors.meeting_point}
            />
            <TextField
              label="Contact name"
              accessibilityLabel="Contact name"
              value={draft.contact_name}
              onChangeText={(value) => changeField('contact_name', value)}
              maxLength={ACTIVITY_FIELD_LIMITS.contact_name}
              editable={!disabled}
              error={fieldErrors.contact_name}
            />
            <TextField
              label="Contact phone"
              accessibilityLabel="Contact phone"
              value={draft.contact_phone}
              onChangeText={(value) => changeField('contact_phone', value)}
              maxLength={ACTIVITY_FIELD_LIMITS.contact_phone}
              keyboardType="phone-pad"
              editable={!disabled}
              error={fieldErrors.contact_phone}
            />
            <TextField
              label="Booking reference"
              accessibilityLabel="Booking reference"
              value={draft.booking_reference}
              onChangeText={(value) =>
                changeField('booking_reference', value)
              }
              maxLength={ACTIVITY_FIELD_LIMITS.booking_reference}
              editable={!disabled}
              error={fieldErrors.booking_reference}
            />
            <TextField
              label="External link"
              accessibilityLabel="External link"
              value={draft.external_link}
              onChangeText={(value) => changeField('external_link', value)}
              maxLength={ACTIVITY_FIELD_LIMITS.external_link}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!disabled}
              error={fieldErrors.external_link}
            />
          </FormSection>

          <FormSection title="Notifications">
            <ReminderPicker
              value={draft.reminder_offsets_minutes}
              enabled={
                (draft.time_mode === 'AT_TIME' ||
                  draft.time_mode === 'TIME_RANGE') &&
                draft.start_time.length > 0
              }
              disabled={disabled}
              error={fieldErrors.reminder_offsets_minutes}
              onToggle={toggleReminder}
            />
            <Text style={styles.notificationBoundary}>
              Reminders are delivered by GoPlan through the existing
              Notifications tab. This form does not schedule device
              notifications.
            </Text>
          </FormSection>
        </ScrollView>

        <View style={styles.footer}>
          <FormError error={submitError} />
          {authorityMessage ? (
            <Text accessibilityRole="alert" style={styles.authorityMessage}>
              {authorityMessage}
            </Text>
          ) : null}
          <Button
            title={mode === 'create' ? 'Create activity' : 'Save changes'}
            onPress={onSubmit}
            loading={submitting}
            disabled={!canSubmit}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function FormSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <Text accessibilityRole="alert" style={styles.inlineError}>
      {message}
    </Text>
  );
}

function DefaultStructuredLocation({
  value,
  disabled,
  onUseManual,
}: {
  value: StructuredLocationValue | null;
  disabled: boolean;
  onUseManual: () => void;
}) {
  return (
    <View style={styles.structuredCard}>
      <Text style={styles.structuredTitle}>
        {value?.place.title || value?.location_label || 'Verified place'}
      </Text>
      {value?.place.address ? (
        <Text style={styles.structuredAddress}>{value.place.address}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Use manual location"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => onUseManual()}
        style={({ pressed }) => [
          styles.manualAction,
          disabled ? styles.disabled : null,
          pressed && !disabled ? styles.pressed : null,
        ]}
      >
        <Text style={styles.manualActionText}>Use manual location</Text>
      </Pressable>
    </View>
  );
}

function firstError(
  errors: ActivityFormFieldErrors,
  ...fields: (keyof ActivityFormFieldErrors)[]
): string | undefined {
  for (const field of fields) {
    const message = errors[field];
    if (message) {
      return message;
    }
  }
  return undefined;
}

function collectPlaceErrors(errors: ActivityFormFieldErrors): string[] {
  const messages = new Set<string>();
  for (const [field, message] of Object.entries(errors)) {
    if ((field === 'place' || field.startsWith('place.')) && message) {
      messages.add(message);
    }
  }
  return [...messages];
}

function customTypeKey(item: TimelineCustomTypeMeta): string {
  return item.id;
}

function memberKey(item: TripMember): string {
  return item.user.id;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1 },
  content: { gap: spacing.md, padding: spacing.lg },
  section: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
  },
  sectionTitle: { ...typography.heading, color: colors.text },
  optionHeading: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  optionLabel: { ...typography.label, color: colors.text },
  choiceRow: { gap: spacing.sm },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
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
  chipText: { ...typography.label, color: colors.textMuted },
  chipTextSelected: { color: colors.primary },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.55 },
  emptyChoice: {
    ...typography.caption,
    color: colors.textMuted,
    minHeight: 44,
    textAlignVertical: 'center',
  },
  textAction: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  textActionLabel: { ...typography.label, color: colors.primary },
  structuredCard: {
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  structuredTitle: { ...typography.body, color: colors.text },
  structuredAddress: { ...typography.caption, color: colors.textMuted },
  manualAction: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
  },
  manualActionText: { ...typography.label, color: colors.primary },
  notificationBoundary: { ...typography.caption, color: colors.textMuted },
  inlineError: { ...typography.caption, color: colors.danger },
  errorBanner: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radii.md,
    backgroundColor: colors.dangerSoft,
  },
  errorBannerText: { ...typography.caption, color: colors.danger, flex: 1 },
  retry: { minHeight: 44, justifyContent: 'center' },
  retryText: { ...typography.label, color: colors.danger },
  footer: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  authorityMessage: {
    ...typography.caption,
    color: colors.danger,
    textAlign: 'center',
  },
});
