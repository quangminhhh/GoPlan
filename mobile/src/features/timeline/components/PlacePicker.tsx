import { memo, useCallback } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { TextField } from '@/shared/ui/TextField';
import {
  MANUAL_LOCATION_GUIDANCE,
  PLACE_SEARCH_UNAVAILABLE_MESSAGE,
  type ManualLocationValue,
  type PlacePickerValue,
  type SettledLocationLookupFailure,
  type StructuredLocationSelection,
  useLocationSearch,
} from '../hooks/useLocationSearch';
import type { LocationSuggestion } from '../types';

export interface PlacePickerProps {
  value: PlacePickerValue | null;
  disabled?: boolean;
  error?: string;
  onSelectLocation: (selection: StructuredLocationSelection) => void;
  onUseManualEntry: (value: ManualLocationValue) => void;
  onLookupFailure: (failure: SettledLocationLookupFailure) => void;
}

interface SuggestionChoiceProps {
  suggestion: LocationSuggestion;
  disabled: boolean;
  onSelect: (suggestion: LocationSuggestion) => void;
}

const SuggestionChoice = memo(function SuggestionChoice({
  suggestion,
  disabled,
  onSelect,
}: SuggestionChoiceProps) {
  const select = useCallback(
    () => onSelect(suggestion),
    [onSelect, suggestion],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Select ${suggestion.title}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={select}
      style={({ pressed }) => [
        styles.suggestion,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text numberOfLines={1} style={styles.suggestionTitle}>
        {suggestion.title}
      </Text>
      {suggestion.subtitle ? (
        <Text numberOfLines={2} style={styles.suggestionSubtitle}>
          {suggestion.subtitle}
        </Text>
      ) : null}
    </Pressable>
  );
});

export function PlacePicker({
  value,
  disabled = false,
  error,
  onSelectLocation,
  onUseManualEntry,
  onLookupFailure,
}: PlacePickerProps) {
  const {
    query,
    setQuery,
    clear,
    suggestions,
    searchStatus,
    searchError,
    searchUnavailable,
    lookupStatus,
    lookupError,
    manualEntrySuggested,
    selectSuggestion,
    createManualValue,
  } = useLocationSearch({ enabled: !disabled });
  const lookupPending = lookupStatus === 'loading';

  const chooseSuggestion = useCallback(
    (suggestion: LocationSuggestion) => {
      void selectSuggestion(suggestion).then((result) => {
        if (result.kind === 'success') {
          onSelectLocation(result.selection);
          clear();
        } else if (result.kind === 'failure') {
          onLookupFailure(result.fallback);
        }
      });
    },
    [clear, onLookupFailure, onSelectLocation, selectSuggestion],
  );

  const useManualEntry = useCallback(() => {
    const manualValue = createManualValue(value?.location_label ?? '');
    clear();
    onUseManualEntry(manualValue);
  }, [clear, createManualValue, onUseManualEntry, value?.location_label]);

  const renderSuggestion = useCallback(
    ({ item }: ListRenderItemInfo<LocationSuggestion>) => (
      <SuggestionChoice
        suggestion={item}
        disabled={disabled || lookupPending}
        onSelect={chooseSuggestion}
      />
    ),
    [chooseSuggestion, disabled, lookupPending],
  );

  const searchMessage = searchUnavailable
    ? PLACE_SEARCH_UNAVAILABLE_MESSAGE
    : searchError?.message;

  return (
    <View style={styles.wrap}>
      {value?.place ? (
        <View
          accessibilityLabel={`Selected place ${value.location_label}`}
          style={styles.selected}
        >
          <Text style={styles.selectedEyebrow}>Selected place</Text>
          <Text style={styles.selectedTitle}>
            {value.place.title || value.location_label}
          </Text>
          {value.place.address ? (
            <Text style={styles.selectedAddress}>{value.place.address}</Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.search}>
        <TextField
          label={value?.place ? 'Search for another place' : 'Search for a place'}
          accessibilityLabel="Search places"
          value={query}
          onChangeText={setQuery}
          placeholder="Enter at least 2 characters"
          maxLength={120}
          editable={!disabled}
          autoCorrect={false}
          error={error}
        />
        {searchStatus === 'debouncing' ||
        searchStatus === 'searching' ||
        lookupPending ? (
          <View
            accessibilityLabel={
              lookupPending ? 'Verifying place' : 'Searching places'
            }
            accessibilityRole="progressbar"
            style={styles.loading}
          >
            <ActivityIndicator color={colors.primary} size="small" />
            <Text style={styles.loadingText}>
              {lookupPending ? 'Verifying place…' : 'Searching…'}
            </Text>
          </View>
        ) : null}
      </View>

      {suggestions.length > 0 ? (
        <FlatList
          testID="place-suggestion-list"
          horizontal
          data={suggestions}
          keyExtractor={suggestionKey}
          renderItem={renderSuggestion}
          contentContainerStyle={styles.suggestionList}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        />
      ) : null}

      {searchMessage ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.notice}
        >
          {searchMessage}
        </Text>
      ) : null}

      {manualEntrySuggested && lookupError ? (
        <View accessibilityRole="alert" style={styles.lookupNotice}>
          <Text style={styles.lookupGuidance}>
            {MANUAL_LOCATION_GUIDANCE}
          </Text>
          <Text style={styles.lookupError}>{lookupError.message}</Text>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Enter location manually"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={useManualEntry}
        style={({ pressed }) => [
          styles.manualAction,
          disabled ? styles.disabled : null,
          pressed && !disabled ? styles.pressed : null,
        ]}
      >
        <Text style={styles.manualActionText}>Enter manually</Text>
      </Pressable>
    </View>
  );
}

function suggestionKey(suggestion: LocationSuggestion): string {
  return suggestion.provider_id;
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  selected: {
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  selectedEyebrow: {
    ...typography.label,
    color: colors.success,
    textTransform: 'uppercase',
  },
  selectedTitle: { ...typography.body, fontWeight: '600', color: colors.text },
  selectedAddress: { ...typography.caption, color: colors.textMuted },
  search: { gap: spacing.xs },
  loading: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  loadingText: { ...typography.caption, color: colors.textMuted },
  suggestionList: { gap: spacing.sm, paddingVertical: spacing.xs },
  suggestion: {
    width: 248,
    minHeight: 72,
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  suggestionTitle: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text,
  },
  suggestionSubtitle: { ...typography.caption, color: colors.textMuted },
  notice: {
    ...typography.caption,
    color: colors.textMuted,
  },
  lookupNotice: {
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radii.md,
    backgroundColor: colors.dangerSoft,
  },
  lookupGuidance: { ...typography.body, color: colors.text },
  lookupError: { ...typography.caption, color: colors.danger },
  manualAction: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  manualActionText: {
    ...typography.body,
    fontWeight: '600',
    color: colors.primary,
  },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.55 },
});
