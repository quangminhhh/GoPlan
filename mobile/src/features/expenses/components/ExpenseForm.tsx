import { Ionicons } from '@expo/vector-icons';
import {
  useCallback,
  useMemo,
  type ReactElement,
} from 'react';
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
import type {
  ExpenseFormDraft,
  ExpenseFormFieldErrors,
} from '../formModel';
import { ZERO_DECIMAL_CURRENCIES } from '../money';
import type { ExpensePerson } from '../types';

interface ExpenseFormProps {
  mode: 'create' | 'edit';
  draft: ExpenseFormDraft;
  fieldErrors: ExpenseFormFieldErrors;
  submitError: ApiError | null;
  collectors: readonly TripMember[];
  currentCollector?: ExpensePerson | null;
  currencyCode: string;
  canSubmit: boolean;
  dirty: boolean;
  submitting: boolean;
  refreshing?: boolean;
  authorityMessage?: string;
  backgroundError?: ApiError | null;
  onChange: (changes: Partial<ExpenseFormDraft>) => void;
  onSubmit: () => void;
  onRefresh?: () => void;
  onRetryBackground?: () => void;
}

interface CollectorChoiceProps {
  member: TripMember;
  selected: boolean;
  disabled: boolean;
  onSelect: (userId: string) => void;
}

function CollectorChoice({
  member,
  selected,
  disabled,
  onSelect,
}: CollectorChoiceProps) {
  const select = useCallback(
    () => onSelect(member.user.id),
    [member.user.id, onSelect],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Choose ${member.user.display_name} as collector`}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={select}
      style={({ pressed }) => [
        styles.collectorChoice,
        selected ? styles.collectorChoiceSelected : null,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Ionicons
        name={selected ? 'checkmark-circle' : 'person-circle-outline'}
        size={18}
        color={selected ? colors.primary : colors.textMuted}
      />
      <View style={styles.collectorText}>
        <Text
          numberOfLines={1}
          style={[
            styles.collectorName,
            selected ? styles.collectorNameSelected : null,
          ]}
        >
          {member.user.display_name}
        </Text>
        <Text numberOfLines={1} style={styles.collectorTag}>
          {member.user.identify_tag}
        </Text>
      </View>
    </Pressable>
  );
}

function collectorKey(member: TripMember): string {
  return member.user.id;
}

function EmptyCollectors() {
  return (
    <Text style={styles.emptyCollectors}>
      No eligible active members are available.
    </Text>
  );
}

export function ExpenseForm({
  mode,
  draft,
  fieldErrors,
  submitError,
  collectors,
  currentCollector,
  currencyCode,
  canSubmit,
  dirty,
  submitting,
  refreshing = false,
  authorityMessage,
  backgroundError,
  onChange,
  onSubmit,
  onRefresh,
  onRetryBackground,
}: ExpenseFormProps) {
  const disabled = submitting || !canSubmit;
  const mergedFieldErrors = useMemo<ExpenseFormFieldErrors>(
    () => ({
      ...(submitError?.fieldErrors ?? {}),
      ...fieldErrors,
    }),
    [fieldErrors, submitError?.fieldErrors],
  );
  const selectedCollectorIsEligible = collectors.some(
    (member) => member.user.id === draft.collector_id,
  );
  const showDepartedCurrentCollector =
    mode === 'edit' &&
    currentCollector !== null &&
    currentCollector !== undefined &&
    draft.collector_id === currentCollector.id &&
    !selectedCollectorIsEligible;
  const unchanged = mode === 'edit' && !dirty;
  const normalizedCurrency = currencyCode.trim().toUpperCase();
  const amountKeyboardType = ZERO_DECIMAL_CURRENCIES.has(
    normalizedCurrency,
  )
    ? 'number-pad'
    : 'decimal-pad';

  const selectCollector = useCallback(
    (collectorId: string) => {
      onChange({ collector_id: collectorId });
    },
    [onChange],
  );

  const selectCreator = useCallback(() => {
    onChange({ collector_id: null });
  }, [onChange]);

  const renderCollector = useCallback(
    ({ item }: ListRenderItemInfo<TripMember>): ReactElement => (
      <CollectorChoice
        member={item}
        selected={draft.collector_id === item.user.id}
        disabled={disabled}
        onSelect={selectCollector}
      />
    ),
    [disabled, draft.collector_id, selectCollector],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          testID="expense-form-scroll"
          contentContainerStyle={styles.content}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl
                testID="expense-form-refresh-control"
                refreshing={refreshing}
                onRefresh={onRefresh}
              />
            ) : undefined
          }
        >
          {backgroundError ? (
            <View accessibilityRole="alert" style={styles.errorBanner}>
              <Text style={styles.errorBannerText}>
                {backgroundError.message}
              </Text>
              {onRetryBackground ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry refreshing expense form"
                  onPress={onRetryBackground}
                  style={({ pressed }) => [
                    styles.retry,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <Text style={styles.retryText}>Retry</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <View style={styles.intro}>
            <Text accessibilityRole="header" style={styles.title}>
              {mode === 'create' ? 'Add expense' : 'Edit expense'}
            </Text>
            <Text style={styles.body}>
              {mode === 'create'
                ? 'Create a new expense for all active trip members.'
                : 'Update the expense details and eligible collector.'}
            </Text>
          </View>

          <View style={styles.section}>
            <TextField
              label="Expense name *"
              accessibilityLabel="Expense name"
              value={draft.title}
              onChangeText={(title) => onChange({ title })}
              maxLength={120}
              editable={!disabled}
              error={mergedFieldErrors.title}
            />
            <TextField
              label="Description"
              accessibilityLabel="Expense description"
              value={draft.description}
              onChangeText={(description) => onChange({ description })}
              multiline
              numberOfLines={4}
              editable={!disabled}
              error={mergedFieldErrors.description}
            />
            <View style={styles.amountField}>
              <View style={styles.amountInput}>
                <TextField
                  label="Total amount *"
                  accessibilityLabel="Expense total amount"
                  value={draft.total_amount}
                  onChangeText={(totalAmount) =>
                    onChange({ total_amount: totalAmount })
                  }
                  keyboardType={amountKeyboardType}
                  autoCorrect={false}
                  editable={!disabled}
                  error={mergedFieldErrors.total_amount}
                />
              </View>
              <View
                accessible
                accessibilityLabel={`Currency ${normalizedCurrency}`}
                style={styles.currency}
              >
                <Text style={styles.currencyText}>
                  {normalizedCurrency}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.collectorHeading}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                Collector
              </Text>
              <Text style={styles.collectorHint}>
                Active participants only
              </Text>
            </View>

            {mode === 'create' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Use expense creator as collector"
                accessibilityState={{
                  disabled,
                  selected:
                    draft.collector_id === null ||
                    draft.collector_id === '',
                }}
                disabled={disabled}
                onPress={selectCreator}
                style={({ pressed }) => [
                  styles.creatorChoice,
                  draft.collector_id === null ||
                  draft.collector_id === ''
                    ? styles.collectorChoiceSelected
                    : null,
                  disabled ? styles.disabled : null,
                  pressed && !disabled ? styles.pressed : null,
                ]}
              >
                <Ionicons
                  name="person-add-outline"
                  size={18}
                  color={
                    draft.collector_id === null ||
                    draft.collector_id === ''
                      ? colors.primary
                      : colors.textMuted
                  }
                />
                <Text
                  style={[
                    styles.collectorName,
                    draft.collector_id === null ||
                    draft.collector_id === ''
                      ? styles.collectorNameSelected
                      : null,
                  ]}
                >
                  Expense creator
                </Text>
              </Pressable>
            ) : null}

            {showDepartedCurrentCollector ? (
              <View
                accessible
                accessibilityLabel={`${currentCollector.display_name}, current collector, left trip`}
                style={[
                  styles.departedCollector,
                  styles.collectorChoiceSelected,
                ]}
              >
                <Ionicons
                  name="person-remove-outline"
                  size={18}
                  color={colors.textMuted}
                />
                <View style={styles.collectorText}>
                  <Text numberOfLines={1} style={styles.collectorName}>
                    {currentCollector.display_name}
                  </Text>
                  <Text numberOfLines={1} style={styles.collectorTag}>
                    {currentCollector.identify_tag
                      ? `${currentCollector.identify_tag} · left trip`
                      : 'Current collector · left trip'}
                  </Text>
                </View>
              </View>
            ) : null}

            <FlatList
              testID="expense-collector-list"
              horizontal
              data={collectors}
              keyExtractor={collectorKey}
              renderItem={renderCollector}
              ListEmptyComponent={EmptyCollectors}
              contentContainerStyle={styles.collectorList}
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            />

            {mergedFieldErrors.collector_id ? (
              <Text accessibilityRole="alert" style={styles.inlineError}>
                {mergedFieldErrors.collector_id}
              </Text>
            ) : null}
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <FormError error={submitError} />
          {authorityMessage ? (
            <Text accessibilityRole="alert" style={styles.authorityMessage}>
              {authorityMessage}
            </Text>
          ) : null}
          {unchanged ? (
            <Text style={styles.submitHint}>
              Change at least one field to save.
            </Text>
          ) : null}
          <Button
            title={mode === 'create' ? 'Create expense' : 'Save expense'}
            onPress={onSubmit}
            loading={submitting}
            disabled={!canSubmit || unchanged}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  fill: { flex: 1 },
  content: {
    gap: spacing.lg,
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  intro: { gap: spacing.xs },
  title: {
    ...typography.heading,
    color: colors.text,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
  section: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
  },
  amountField: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  amountInput: { flex: 1 },
  currency: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  currencyText: {
    ...typography.label,
    color: colors.textMuted,
  },
  collectorHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typography.heading,
    color: colors.text,
  },
  collectorHint: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  collectorList: {
    gap: spacing.sm,
  },
  collectorChoice: {
    minHeight: 52,
    maxWidth: 220,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  creatorChoice: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  departedCollector: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  collectorChoiceSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  collectorText: {
    minWidth: 0,
    flexShrink: 1,
  },
  collectorName: {
    ...typography.label,
    color: colors.text,
  },
  collectorNameSelected: { color: colors.primary },
  collectorTag: {
    ...typography.caption,
    color: colors.textMuted,
  },
  emptyCollectors: {
    ...typography.caption,
    color: colors.textMuted,
  },
  inlineError: {
    ...typography.caption,
    color: colors.danger,
  },
  footer: {
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  authorityMessage: {
    ...typography.body,
    color: colors.danger,
    textAlign: 'center',
  },
  submitHint: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
  },
  errorBanner: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radii.md,
    backgroundColor: colors.dangerSoft,
  },
  errorBannerText: {
    ...typography.body,
    color: colors.danger,
  },
  retry: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
  },
  retryText: {
    ...typography.label,
    color: colors.primary,
  },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.55 },
});
