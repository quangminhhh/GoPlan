import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';

interface ChatSelectionToolbarProps {
  selectedCount: number;
  feedback: string | null;
  disabled?: boolean;
  hiding?: boolean;
  onCancel: () => void;
  onConfirmHide: () => void;
}

export function ChatSelectionToolbar({
  selectedCount,
  feedback,
  disabled = false,
  hiding = false,
  onCancel,
  onConfirmHide,
}: ChatSelectionToolbarProps) {
  const hideBlocked = selectedCount === 0 || disabled || hiding;

  const confirmHide = () => {
    if (hideBlocked) {
      return;
    }
    Alert.alert(
      `Hide ${selectedCount} ${selectedCount === 1 ? 'message' : 'messages'}?`,
      'They will disappear only from your chat history. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Hide', style: 'destructive', onPress: onConfirmHide },
      ],
    );
  };

  return (
    <View style={styles.toolbar} testID="chat-selection-toolbar">
      {feedback ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.feedback}
        >
          {feedback}
        </Text>
      ) : null}
      <View style={styles.selectionSummary} testID="chat-selection-summary">
        <Text accessibilityLiveRegion="polite" style={styles.count}>
          {selectedCount === 100
            ? '100 selected (maximum)'
            : `${selectedCount} selected`}
        </Text>
      </View>
      <View style={styles.actionRow} testID="chat-selection-actions">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel message selection"
          accessibilityState={{ disabled: hiding }}
          disabled={hiding}
          onPress={onCancel}
          style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
        >
          <Text style={[styles.actionText, hiding ? styles.disabledText : null]}>
            Cancel
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hide selected messages"
          accessibilityState={{ disabled: hideBlocked, busy: hiding }}
          disabled={hideBlocked}
          onPress={confirmHide}
          style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
        >
          <Text style={[styles.hideText, hideBlocked ? styles.disabledText : null]}>
            {hiding ? 'Hiding…' : 'Hide'}
          </Text>
        </Pressable>
      </View>
      <Text style={styles.helper}>You can hide up to 100 messages at a time.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  selectionSummary: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionRow: {
    minHeight: 44,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  action: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  pressed: { opacity: 0.55 },
  actionText: { ...typography.label, color: colors.primary },
  hideText: { ...typography.label, color: colors.danger },
  disabledText: { color: colors.textMuted },
  count: {
    ...typography.label,
    flexShrink: 1,
    color: colors.text,
    textAlign: 'center',
  },
  helper: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
  feedback: { ...typography.caption, color: colors.warning },
});
