import { Ionicons } from '@expo/vector-icons';
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
import type { ApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { FormError } from '@/shared/ui/FormError';
import { TextField } from '@/shared/ui/TextField';
import {
  CUSTOM_TYPE_NAME_MAX_LENGTH,
  type CustomTypeDraft,
  type CustomTypeFieldErrors,
} from '../customTypeModel';
import {
  getTimelineIconName,
  getTimelineTokenColors,
  isTimelineColorToken,
  isTimelineIconKey,
  TIMELINE_COLOR_OPTIONS,
  TIMELINE_ICON_OPTIONS,
  type TimelineColorToken,
  type TimelineIconKey,
} from '../tokenMaps';
import type { TimelineCustomTypeMeta } from '../types';

export type CustomTypeMutationScope =
  | { kind: 'create' }
  | {
      kind: 'edit' | 'toggle' | 'delete';
      typeId: string;
    };

export interface CustomTypeMutationError {
  scope: CustomTypeMutationScope;
  error: ApiError;
}

interface CustomTypeManagerProps {
  customTypes: readonly TimelineCustomTypeMeta[];
  createDraft: CustomTypeDraft;
  createFieldErrors: CustomTypeFieldErrors;
  editTypeId: string | null;
  editDraft: CustomTypeDraft | null;
  editFieldErrors: CustomTypeFieldErrors;
  editDirty: boolean;
  mutationKey: string | null;
  mutationError: CustomTypeMutationError | null;
  onChangeCreate: (changes: Partial<CustomTypeDraft>) => void;
  onCreate: () => void;
  onStartEdit: (customType: TimelineCustomTypeMeta) => void;
  onChangeEdit: (changes: Partial<CustomTypeDraft>) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onToggleActive: (customType: TimelineCustomTypeMeta) => void;
  onDelete: (customType: TimelineCustomTypeMeta) => void;
}

interface ColorPickerProps {
  value: string;
  disabled: boolean;
  error?: string;
  accessibilityPrefix: string;
  onSelect: (value: TimelineColorToken) => void;
}

interface IconPickerProps {
  value: string;
  disabled: boolean;
  error?: string;
  accessibilityPrefix: string;
  onSelect: (value: TimelineIconKey) => void;
}

interface RowActionProps {
  label: string;
  disabled: boolean;
  danger?: boolean;
  onPress: () => void;
}

interface CustomTypeRowProps {
  customType: TimelineCustomTypeMeta;
  editing: boolean;
  editDraft: CustomTypeDraft | null;
  editFieldErrors: CustomTypeFieldErrors;
  editDirty: boolean;
  actionsDisabled: boolean;
  mutationKey: string | null;
  mutationError: ApiError | null;
  onStartEdit: (customType: TimelineCustomTypeMeta) => void;
  onChangeEdit: (changes: Partial<CustomTypeDraft>) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onToggleActive: (customType: TimelineCustomTypeMeta) => void;
  onDelete: (customType: TimelineCustomTypeMeta) => void;
}

function RowAction({
  label,
  disabled,
  danger = false,
  onPress,
}: RowActionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.rowAction,
        danger ? styles.rowActionDanger : null,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text
        style={[
          styles.rowActionText,
          danger ? styles.rowActionDangerText : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ColorPicker({
  value,
  disabled,
  error,
  accessibilityPrefix,
  onSelect,
}: ColorPickerProps) {
  const hasUnknownValue = !isTimelineColorToken(value);

  return (
    <View style={styles.pickerGroup}>
      <Text style={styles.fieldLabel}>Color</Text>
      {hasUnknownValue ? (
        <Text style={styles.unknownValue}>
          Current unsupported color token: {value || '(blank)'}. It stays
          unchanged until you choose a supported color.
        </Text>
      ) : null}
      <View style={styles.optionWrap}>
        {TIMELINE_COLOR_OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityLabel={`${accessibilityPrefix} color ${option.label}`}
              accessibilityState={{ disabled, selected }}
              disabled={disabled}
              onPress={() => onSelect(option.value)}
              style={({ pressed }) => [
                styles.colorOption,
                {
                  backgroundColor: option.backgroundColor,
                  borderColor: selected ? option.color : colors.border,
                },
                disabled ? styles.disabled : null,
                pressed && !disabled ? styles.pressed : null,
              ]}
            >
              <View
                style={[
                  styles.colorSwatch,
                  { backgroundColor: option.color },
                ]}
              />
              <Text style={[styles.colorLabel, { color: option.color }]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function IconPicker({
  value,
  disabled,
  error,
  accessibilityPrefix,
  onSelect,
}: IconPickerProps) {
  const hasUnknownValue = !isTimelineIconKey(value);

  return (
    <View style={styles.pickerGroup}>
      <Text style={styles.fieldLabel}>Icon</Text>
      {hasUnknownValue ? (
        <Text style={styles.unknownValue}>
          Current unsupported icon key: {value || '(blank)'}. It stays
          unchanged until you choose a supported icon.
        </Text>
      ) : null}
      <View style={styles.optionWrap}>
        {TIMELINE_ICON_OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityLabel={`${accessibilityPrefix} icon ${option.label}`}
              accessibilityState={{ disabled, selected }}
              disabled={disabled}
              onPress={() => onSelect(option.value)}
              style={({ pressed }) => [
                styles.iconOption,
                selected ? styles.iconOptionSelected : null,
                disabled ? styles.disabled : null,
                pressed && !disabled ? styles.pressed : null,
              ]}
            >
              <Ionicons
                name={option.icon}
                size={20}
                color={selected ? colors.primary : colors.textMuted}
              />
              <Text
                style={[
                  styles.iconLabel,
                  selected ? styles.iconLabelSelected : null,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function CustomTypeEditor({
  customType,
  draft,
  fieldErrors,
  dirty,
  disabled,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  customType: TimelineCustomTypeMeta;
  draft: CustomTypeDraft;
  fieldErrors: CustomTypeFieldErrors;
  dirty: boolean;
  disabled: boolean;
  saving: boolean;
  error: ApiError | null;
  onChange: (changes: Partial<CustomTypeDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={styles.editor}>
      <TextField
        label="Name *"
        accessibilityLabel={`Name for ${customType.name}`}
        value={draft.name}
        editable={!disabled}
        maxLength={CUSTOM_TYPE_NAME_MAX_LENGTH}
        onChangeText={(name) => onChange({ name })}
        error={fieldErrors.name ?? error?.fieldErrors?.name}
      />
      <ColorPicker
        value={draft.color_token}
        disabled={disabled}
        accessibilityPrefix={customType.name}
        onSelect={(color_token) => onChange({ color_token })}
        error={error?.fieldErrors?.color_token}
      />
      <IconPicker
        value={draft.icon_key}
        disabled={disabled}
        accessibilityPrefix={customType.name}
        onSelect={(icon_key) => onChange({ icon_key })}
        error={error?.fieldErrors?.icon_key}
      />
      <FormError error={error} />
      <View style={styles.editorActions}>
        <View style={styles.editorAction}>
          <Button
            title="Cancel edit"
            variant="secondary"
            disabled={disabled}
            onPress={onCancel}
          />
        </View>
        <View style={styles.editorAction}>
          <Button
            title="Save type"
            disabled={disabled || !dirty}
            loading={saving}
            onPress={onSave}
          />
        </View>
      </View>
    </View>
  );
}

function CustomTypeRowComponent({
  customType,
  editing,
  editDraft,
  editFieldErrors,
  editDirty,
  actionsDisabled,
  mutationKey,
  mutationError,
  onStartEdit,
  onChangeEdit,
  onSaveEdit,
  onCancelEdit,
  onToggleActive,
  onDelete,
}: CustomTypeRowProps) {
  const tokenColors = getTimelineTokenColors(customType.color_token);
  const iconName = getTimelineIconName(customType.icon_key);
  const rowBusy =
    mutationKey === `edit:${customType.id}` ||
    mutationKey === `toggle:${customType.id}` ||
    mutationKey === `delete:${customType.id}`;

  if (editing && editDraft) {
    return (
      <View style={styles.card}>
        <CustomTypeEditor
          customType={customType}
          draft={editDraft}
          fieldErrors={editFieldErrors}
          dirty={editDirty}
          disabled={actionsDisabled}
          saving={mutationKey === `edit:${customType.id}`}
          error={mutationError}
          onChange={onChangeEdit}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      </View>
    );
  }

  return (
    <View style={[styles.card, !customType.is_active ? styles.inactiveCard : null]}>
      <View style={styles.rowSummary}>
        <View
          style={[
            styles.typeIcon,
            { backgroundColor: tokenColors.backgroundColor },
          ]}
        >
          <Ionicons name={iconName} size={20} color={tokenColors.color} />
        </View>
        <View style={styles.rowText}>
          <Text
            style={[
              styles.typeName,
              !customType.is_active ? styles.inactiveName : null,
            ]}
          >
            {customType.name}
          </Text>
          <Text style={styles.typeState}>
            {customType.is_active ? 'Active' : 'Inactive'}
          </Text>
        </View>
        {rowBusy ? (
          <ActivityIndicator color={colors.primary} />
        ) : null}
      </View>
      {mutationError ? <FormError error={mutationError} /> : null}
      <View style={styles.rowActions}>
        <RowAction
          label={`Edit ${customType.name}`}
          disabled={actionsDisabled}
          onPress={() => onStartEdit(customType)}
        />
        <RowAction
          label={`${customType.is_active ? 'Deactivate' : 'Activate'} ${customType.name}`}
          disabled={actionsDisabled}
          onPress={() => onToggleActive(customType)}
        />
        <RowAction
          label={`Delete ${customType.name}`}
          disabled={actionsDisabled}
          danger
          onPress={() => onDelete(customType)}
        />
      </View>
    </View>
  );
}

const CustomTypeRow = memo(CustomTypeRowComponent);

export function CustomTypeManager({
  customTypes,
  createDraft,
  createFieldErrors,
  editTypeId,
  editDraft,
  editFieldErrors,
  editDirty,
  mutationKey,
  mutationError,
  onChangeCreate,
  onCreate,
  onStartEdit,
  onChangeEdit,
  onSaveEdit,
  onCancelEdit,
  onToggleActive,
  onDelete,
}: CustomTypeManagerProps) {
  const actionsDisabled = mutationKey !== null;
  const createError =
    mutationError?.scope.kind === 'create'
      ? mutationError.error
      : null;

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TimelineCustomTypeMeta>) => {
      const itemError =
        mutationError?.scope.kind !== 'create' &&
        mutationError?.scope.typeId === item.id
          ? mutationError.error
          : null;
      return (
        <CustomTypeRow
          customType={item}
          editing={editTypeId === item.id}
          editDraft={editTypeId === item.id ? editDraft : null}
          editFieldErrors={editFieldErrors}
          editDirty={editDirty}
          actionsDisabled={actionsDisabled}
          mutationKey={mutationKey}
          mutationError={itemError}
          onStartEdit={onStartEdit}
          onChangeEdit={onChangeEdit}
          onSaveEdit={onSaveEdit}
          onCancelEdit={onCancelEdit}
          onToggleActive={onToggleActive}
          onDelete={onDelete}
        />
      );
    },
    [
      actionsDisabled,
      editDraft,
      editDirty,
      editFieldErrors,
      editTypeId,
      mutationError,
      mutationKey,
      onCancelEdit,
      onChangeEdit,
      onDelete,
      onSaveEdit,
      onStartEdit,
      onToggleActive,
    ],
  );

  const header = (
    <View style={styles.header}>
      <View style={styles.intro}>
        <Text accessibilityRole="header" style={styles.title}>
          Custom activity types
        </Text>
        <Text style={styles.body}>
          Create trip-specific labels and keep inactive types available for
          existing activities.
        </Text>
      </View>
      <View style={styles.createCard}>
        <Text style={styles.sectionTitle}>Add a custom type</Text>
        <TextField
          label="Name *"
          accessibilityLabel="New custom type name"
          value={createDraft.name}
          editable={!actionsDisabled}
          maxLength={CUSTOM_TYPE_NAME_MAX_LENGTH}
          onChangeText={(name) => onChangeCreate({ name })}
          error={createFieldErrors.name ?? createError?.fieldErrors?.name}
        />
        <ColorPicker
          value={createDraft.color_token}
          disabled={actionsDisabled}
          accessibilityPrefix="New custom type"
          onSelect={(color_token) => onChangeCreate({ color_token })}
          error={createError?.fieldErrors?.color_token}
        />
        <IconPicker
          value={createDraft.icon_key}
          disabled={actionsDisabled}
          accessibilityPrefix="New custom type"
          onSelect={(icon_key) => onChangeCreate({ icon_key })}
          error={createError?.fieldErrors?.icon_key}
        />
        <FormError error={createError} />
        <Button
          title="Add custom type"
          loading={mutationKey === 'create'}
          disabled={actionsDisabled || !createDraft.name.trim()}
          onPress={onCreate}
        />
      </View>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Existing types
      </Text>
    </View>
  );

  return (
    <FlatList
      testID="custom-type-manager-list"
      data={customTypes}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <Ionicons
            name="pricetags-outline"
            size={40}
            color={colors.textMuted}
          />
          <Text style={styles.emptyTitle}>No custom types yet</Text>
          <Text style={styles.emptyBody}>
            Add one above to use it on timeline activities.
          </Text>
        </View>
      }
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  header: { gap: spacing.md, paddingBottom: spacing.sm },
  intro: { gap: spacing.xs },
  title: { ...typography.heading, color: colors.text },
  body: { ...typography.body, color: colors.textMuted },
  sectionTitle: { ...typography.label, color: colors.text },
  createCard: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
  },
  card: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
  },
  inactiveCard: { backgroundColor: colors.surface },
  rowSummary: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  typeIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.full,
  },
  rowText: { flex: 1, gap: spacing.xs },
  typeName: { ...typography.body, color: colors.text, fontWeight: '600' },
  inactiveName: {
    color: colors.textMuted,
    textDecorationLine: 'line-through',
  },
  typeState: { ...typography.caption, color: colors.textMuted },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  rowAction: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  rowActionDanger: { borderColor: colors.dangerBorder },
  rowActionText: { ...typography.label, color: colors.primary },
  rowActionDangerText: { color: colors.danger },
  pickerGroup: { gap: spacing.sm },
  fieldLabel: { ...typography.label, color: colors.text },
  optionWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  colorOption: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
  },
  colorSwatch: { width: 12, height: 12, borderRadius: radii.full },
  colorLabel: { ...typography.label },
  iconOption: {
    minHeight: 56,
    minWidth: 76,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  iconOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  iconLabel: { ...typography.caption, color: colors.textMuted },
  iconLabelSelected: { color: colors.primary },
  unknownValue: { ...typography.caption, color: colors.textMuted },
  errorText: { ...typography.caption, color: colors.danger },
  editor: { gap: spacing.md },
  editorActions: { flexDirection: 'row', gap: spacing.sm },
  editorAction: { flex: 1 },
  emptyState: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  emptyTitle: { ...typography.heading, color: colors.text },
  emptyBody: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.55 },
});
