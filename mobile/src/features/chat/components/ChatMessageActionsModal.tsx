import { Ionicons } from '@expo/vector-icons';
import { type ComponentProps, memo, useCallback } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import {
  ALLOWED_REACTION_EMOJIS,
  type AllowedReactionEmoji,
} from '../types';
import { REACTION_ACCESSIBILITY_LABELS } from './ChatReactionBar';

interface ChatMessageActionsModalProps {
  visible: boolean;
  currentReaction: AllowedReactionEmoji | null;
  canReact: boolean;
  canHide: boolean;
  canDeleteForEveryone: boolean;
  canSelect: boolean;
  busy?: boolean;
  onClose: () => void;
  onReact: (emoji: AllowedReactionEmoji) => void;
  onHide: () => void;
  onDeleteForEveryone: () => void;
  onSelect: () => void;
}

interface ReactionOptionProps {
  emoji: AllowedReactionEmoji;
  selected: boolean;
  disabled: boolean;
  onSelect: (emoji: AllowedReactionEmoji) => void;
}

const ReactionOption = memo(function ReactionOption({
  emoji,
  selected,
  disabled,
  onSelect,
}: ReactionOptionProps) {
  const select = useCallback(() => onSelect(emoji), [emoji, onSelect]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`React with ${REACTION_ACCESSIBILITY_LABELS[emoji].toLowerCase()}`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={select}
      style={({ pressed }) => [
        styles.reactionOption,
        selected ? styles.reactionOptionSelected : null,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
      testID={`chat-reaction-option-${emoji}`}
    >
      <Text style={styles.reactionEmoji}>{emoji}</Text>
    </Pressable>
  );
});

export function ChatMessageActionsModal({
  visible,
  currentReaction,
  canReact,
  canHide,
  canDeleteForEveryone,
  canSelect,
  busy = false,
  onClose,
  onReact,
  onHide,
  onDeleteForEveryone,
  onSelect,
}: ChatMessageActionsModalProps) {
  const selectReaction = useCallback(
    (emoji: AllowedReactionEmoji) => {
      onClose();
      onReact(emoji);
    },
    [onClose, onReact],
  );

  const confirmHide = useCallback(() => {
    onClose();
    Alert.alert(
      'Hide this message?',
      'It will disappear only from your chat history. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Hide', style: 'destructive', onPress: onHide },
      ],
    );
  }, [onClose, onHide]);

  const confirmDeleteForEveryone = useCallback(() => {
    onClose();
    Alert.alert(
      'Remove this message for everyone?',
      'Its content will be replaced with a removal notice for every trip member.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: onDeleteForEveryone },
      ],
    );
  }, [onClose, onDeleteForEveryone]);

  const startSelection = useCallback(() => {
    onClose();
    onSelect();
  }, [onClose, onSelect]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView
        accessibilityViewIsModal
        edges={['top', 'left', 'right', 'bottom']}
        style={styles.safe}
        testID="chat-message-actions-modal"
      >
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>
              Message actions
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close message actions"
              onPress={onClose}
              style={({ pressed }) => [
                styles.closeButton,
                pressed ? styles.pressed : null,
              ]}
            >
              <Ionicons
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                name="close"
                size={22}
                color={colors.text}
              />
            </Pressable>
          </View>

          {canReact ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>React</Text>
              <View style={styles.reactionRow} testID="chat-reaction-options">
                {ALLOWED_REACTION_EMOJIS.map((emoji) => (
                  <ReactionOption
                    key={emoji}
                    emoji={emoji}
                    selected={currentReaction === emoji}
                    disabled={busy}
                    onSelect={selectReaction}
                  />
                ))}
              </View>
            </View>
          ) : null}

          <View style={styles.actions}>
            {canHide ? (
              <ActionRow
                icon="eye-off-outline"
                label="Hide for me"
                destructive
                disabled={busy}
                onPress={confirmHide}
              />
            ) : null}
            {canDeleteForEveryone ? (
              <ActionRow
                icon="trash-outline"
                label="Remove for everyone"
                destructive
                disabled={busy}
                onPress={confirmDeleteForEveryone}
              />
            ) : null}
            {canSelect ? (
              <ActionRow
                icon="checkmark-circle-outline"
                label="Select messages"
                disabled={busy}
                onPress={startSelection}
              />
            ) : null}
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

interface ActionRowProps {
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  destructive?: boolean;
  disabled: boolean;
  onPress: () => void;
}

function ActionRow({
  icon,
  label,
  destructive = false,
  disabled,
  onPress,
}: ActionRowProps) {
  const color = destructive ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionRow,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Ionicons
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        name={icon}
        size={20}
        color={color}
      />
      <Text style={[styles.actionLabel, destructive ? styles.destructiveLabel : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flexGrow: 1,
    gap: spacing.lg,
    padding: spacing.lg,
  },
  header: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: { ...typography.heading, color: colors.text },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.full,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  section: { gap: spacing.sm },
  sectionLabel: { ...typography.label, color: colors.textMuted },
  reactionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    rowGap: spacing.xs,
  },
  reactionOption: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    borderCurve: 'continuous',
  },
  reactionOptionSelected: { backgroundColor: colors.primarySoft },
  reactionEmoji: { ...typography.heading },
  actions: {
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderCurve: 'continuous',
    backgroundColor: colors.background,
  },
  actionRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  actionLabel: { ...typography.body, color: colors.text },
  destructiveLabel: { color: colors.danger },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.45 },
});
