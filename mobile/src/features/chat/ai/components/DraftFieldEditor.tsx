import { useLayoutEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import {
  buildEditedDraftPayload,
  createDraftEditingState,
  rebaseDraftEditingState,
  setDraftEditedValue,
  type DraftEditingState,
} from '../editing';
import type {
  AIActionDraft,
  AIActionDraftMissingField,
} from '../drafts';

export interface DraftFieldEditorProps {
  readonly draft: AIActionDraft;
  readonly pending: boolean;
  readonly disabled?: boolean;
  readonly disabledMessage?: string | null;
  readonly initialValues?: Readonly<Record<string, unknown>>;
  readonly fieldErrors?: Readonly<Record<string, string>> | null;
  readonly onValuesChange?: (
    values: Readonly<Record<string, unknown>>,
  ) => void;
  readonly onSave: (
    payload: Readonly<Record<string, unknown>>,
    editedValues: Readonly<Record<string, unknown>>,
  ) => void | Promise<void>;
}

function timeRangeNames(field: AIActionDraftMissingField): readonly [string, string] {
  const pair = field.constraints?.pair;
  if (
    Array.isArray(pair) &&
    pair.length === 2 &&
    typeof pair[0] === 'string' &&
    typeof pair[1] === 'string' &&
    pair[0].length > 0 &&
    pair[1].length > 0
  ) {
    return [pair[0], pair[1]];
  }
  return ['start_time', 'end_time'];
}

function InputError({ message }: { readonly message: string | null }) {
  return message ? (
    <Text accessibilityRole="alert" style={styles.errorText}>
      {message}
    </Text>
  ) : null;
}

function SelectField(props: {
  readonly field: AIActionDraftMissingField;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onChange: (name: string, value: string) => void;
}) {
  const selected = typeof props.value === 'string' ? props.value : '';
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{props.field.label}</Text>
      <View style={styles.options}>
        {(props.field.options ?? []).map((option) => {
          const isSelected = selected === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityLabel={`${props.field.label}: ${option.label}`}
              accessibilityRole="button"
              accessibilityState={{
                disabled: props.disabled,
                selected: isSelected,
              }}
              disabled={props.disabled}
              onPress={() => props.onChange(props.field.name, option.value)}
              style={({ pressed }) => [
                styles.option,
                isSelected ? styles.optionSelected : null,
                pressed && !props.disabled ? styles.pressed : null,
                props.disabled ? styles.disabled : null,
              ]}
            >
              <Text
                style={[
                  styles.optionText,
                  isSelected ? styles.optionTextSelected : null,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <InputError message={props.error} />
    </View>
  );
}

function TimeRangeField(props: {
  readonly field: AIActionDraftMissingField;
  readonly state: DraftEditingState;
  readonly disabled: boolean;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly onChange: (name: string, value: string) => void;
}) {
  const [startName, endName] = timeRangeNames(props.field);
  const start = props.state.editedValues[startName];
  const end = props.state.editedValues[endName];
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{props.field.label}</Text>
      <View style={styles.timeRange}>
        <View style={styles.timeInputBlock}>
          <Text style={styles.inputCaption}>Start</Text>
          <TextInput
            accessibilityLabel={`${props.field.label} start`}
            editable={!props.disabled}
            onChangeText={(value) => props.onChange(startName, value)}
            placeholder="HH:MM"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            value={typeof start === 'string' ? start : ''}
          />
          <InputError message={props.fieldErrors[startName] ?? null} />
        </View>
        <View style={styles.timeInputBlock}>
          <Text style={styles.inputCaption}>End</Text>
          <TextInput
            accessibilityLabel={`${props.field.label} end`}
            editable={!props.disabled}
            onChangeText={(value) => props.onChange(endName, value)}
            placeholder="HH:MM"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            value={typeof end === 'string' ? end : ''}
          />
          <InputError message={props.fieldErrors[endName] ?? null} />
        </View>
      </View>
    </View>
  );
}

function TextField(props: {
  readonly field: AIActionDraftMissingField;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onChange: (name: string, value: string) => void;
}) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{props.field.label}</Text>
      <TextInput
        accessibilityLabel={props.field.label}
        editable={!props.disabled}
        keyboardType={props.field.type === 'money' ? 'decimal-pad' : 'default'}
        multiline={props.field.type === 'json'}
        onChangeText={(value) => props.onChange(props.field.name, value)}
        placeholder={props.field.required ? 'Required' : 'Enter a value'}
        placeholderTextColor={colors.textMuted}
        style={[
          styles.input,
          props.field.type === 'json' ? styles.multilineInput : null,
          props.error ? styles.inputError : null,
        ]}
        value={typeof props.value === 'string' ? props.value : ''}
      />
      <InputError message={props.error} />
    </View>
  );
}

export function DraftFieldEditor({
  draft,
  pending,
  disabled = false,
  disabledMessage = null,
  initialValues = {},
  fieldErrors: serverFieldErrors,
  onValuesChange,
  onSave,
}: DraftFieldEditorProps) {
  const [editing, setEditing] = useState(() => ({
    ...createDraftEditingState(draft),
    editedValues: { ...initialValues },
  }));
  const editingRef = useRef(editing);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const currentEditing =
    editing.draft.id === draft.id && editing.draft.updated_at === draft.updated_at
      ? editing
      : rebaseDraftEditingState(editing, draft);

  useLayoutEffect(() => {
    editingRef.current = currentEditing;
  }, [currentEditing]);

  const fieldErrors = serverFieldErrors ?? currentEditing.fieldErrors;
  const controlsDisabled = disabled || pending;
  const change = (name: string, value: string): void => {
    const next = setDraftEditedValue(
      rebaseDraftEditingState(editingRef.current, draft),
      name,
      value,
    );
    editingRef.current = next;
    setEditing(next);
    onValuesChange?.(next.editedValues);
    setLocalMessage(null);
  };

  const save = async (): Promise<void> => {
    const latestEditing = rebaseDraftEditingState(
      editingRef.current,
      draft,
    );
    const built = buildEditedDraftPayload(latestEditing);
    if (!built.ok) {
      setLocalMessage(built.message);
      if (built.field !== null) {
        const fieldName = built.field;
        const next = {
          ...latestEditing,
          fieldErrors: {
            ...latestEditing.fieldErrors,
            [fieldName]: built.message,
          },
        };
        editingRef.current = next;
        setEditing(next);
      }
      return;
    }
    setLocalMessage(null);
    await onSave(built.payload, latestEditing.editedValues);
  };

  return (
    <View style={styles.editor} testID="ai-draft-field-editor">
      {draft.missing_fields.map((field) => {
        if (field.type === 'target') {
          return (
            <View key={field.name} style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>{field.label}</Text>
              <Text style={styles.targetHelp}>
                Ask GoPlanAI to clarify this target. It cannot be guessed on the device.
              </Text>
            </View>
          );
        }
        if (field.type === 'time_range') {
          return (
            <TimeRangeField
              key={field.name}
              disabled={controlsDisabled}
              field={field}
              fieldErrors={fieldErrors}
              onChange={change}
              state={currentEditing}
            />
          );
        }
        if (field.type === 'select' && (field.options?.length ?? 0) > 0) {
          return (
            <SelectField
              key={field.name}
              disabled={controlsDisabled}
              error={fieldErrors[field.name] ?? null}
              field={field}
              onChange={change}
              value={currentEditing.editedValues[field.name]}
            />
          );
        }
        return (
          <TextField
            key={field.name}
            disabled={controlsDisabled}
            error={fieldErrors[field.name] ?? null}
            field={field}
            onChange={change}
            value={currentEditing.editedValues[field.name]}
          />
        );
      })}
      {disabledMessage !== null ? (
        <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.errorText}>
          {disabledMessage}
        </Text>
      ) : null}
      <InputError message={localMessage} />
      <Pressable
        accessibilityLabel="Save draft information"
        accessibilityRole="button"
        accessibilityState={{ disabled: controlsDisabled, busy: pending }}
        disabled={controlsDisabled}
        onPress={() => void save()}
        style={({ pressed }) => [
          styles.saveButton,
          pressed && !controlsDisabled ? styles.primaryPressed : null,
          controlsDisabled ? styles.disabled : null,
        ]}
      >
        <Text style={styles.saveButtonText}>
          {pending ? 'Saving…' : 'Save information'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  editor: {
    gap: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  fieldGroup: { gap: spacing.xs },
  fieldLabel: { ...typography.label, color: colors.text },
  inputCaption: { ...typography.caption, color: colors.textMuted },
  input: {
    ...typography.body,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    color: colors.text,
    backgroundColor: colors.background,
  },
  multilineInput: { minHeight: 88, textAlignVertical: 'top' },
  inputError: { borderColor: colors.danger },
  errorText: { ...typography.caption, color: colors.danger },
  targetHelp: {
    ...typography.caption,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    color: colors.textMuted,
    backgroundColor: colors.surface,
  },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  option: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.full,
    borderCurve: 'continuous',
    backgroundColor: colors.background,
  },
  optionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  optionText: { ...typography.caption, color: colors.text },
  optionTextSelected: { color: colors.primary, fontWeight: '600' },
  timeRange: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  timeInputBlock: { minWidth: 120, flex: 1, gap: spacing.xs },
  saveButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    backgroundColor: colors.primary,
  },
  saveButtonText: { ...typography.label, color: colors.background },
  primaryPressed: { backgroundColor: colors.primaryPressed },
  pressed: { opacity: 0.62 },
  disabled: { opacity: 0.45 },
});
