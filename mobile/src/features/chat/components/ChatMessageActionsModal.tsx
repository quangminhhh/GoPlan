import { FontAwesome6, Ionicons } from '@expo/vector-icons';
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import {
  Alert,
  Modal,
  Platform,
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
import { ChatReactionIcon } from './ChatReactionIcon';
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
  onCloseWithoutFocus?: () => void;
  onDismiss?: () => void;
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
      accessibilityHint={
        selected ? 'Removes your reaction' : 'Adds this reaction'
      }
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
      <ChatReactionIcon emoji={emoji} size={22} />
      {selected ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.reactionSelectedBadge}
          testID={`chat-reaction-option-selected-${emoji}`}
        >
          <FontAwesome6
            color={colors.background}
            name="check"
            size={9}
            solid
          />
        </View>
      ) : null}
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
  onCloseWithoutFocus,
  onDismiss,
  onReact,
  onHide,
  onDeleteForEveryone,
  onSelect,
}: ChatMessageActionsModalProps) {
  const reactionSelectionLockedRef = useRef(false);
  const dismissHandoffRef = useRef<(() => void) | null>(null);
  const dismissHandoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const androidDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    if (!visible) {
      reactionSelectionLockedRef.current = false;
      return;
    }
    if (androidDismissTimerRef.current !== null) {
      clearTimeout(androidDismissTimerRef.current);
      androidDismissTimerRef.current = null;
    }
  }, [visible]);

  useEffect(
    () => () => {
      if (dismissHandoffTimerRef.current !== null) {
        clearTimeout(dismissHandoffTimerRef.current);
        dismissHandoffTimerRef.current = null;
      }
      if (androidDismissTimerRef.current !== null) {
        clearTimeout(androidDismissTimerRef.current);
        androidDismissTimerRef.current = null;
      }
      dismissHandoffRef.current = null;
    },
    [],
  );

  const closeWithFocusRestore = useCallback(() => {
    onClose();
    if (
      Platform.OS === 'android' &&
      androidDismissTimerRef.current === null
    ) {
      // Android does not publish Modal.onDismiss. Wait until the visibility
      // update has removed the native modal host before handing focus back.
      androidDismissTimerRef.current = setTimeout(() => {
        androidDismissTimerRef.current = null;
        onDismiss?.();
      }, 0);
    }
  }, [onClose, onDismiss]);

  const selectReaction = useCallback(
    (emoji: AllowedReactionEmoji) => {
      if (!canReact || busy || reactionSelectionLockedRef.current) {
        return;
      }
      reactionSelectionLockedRef.current = true;
      closeWithFocusRestore();
      onReact(emoji);
    },
    [busy, canReact, closeWithFocusRestore, onReact],
  );

  const closeWithDismissHandoff = useCallback(
    (handoff: () => void) => {
      if (Platform.OS === 'ios') {
        dismissHandoffRef.current = handoff;
      }
      (onCloseWithoutFocus ?? onClose)();

      // React Native only exposes Modal.onDismiss on iOS. Android must not
      // wait for a callback that will never arrive.
      if (Platform.OS !== 'ios') {
        handoff();
      }
    },
    [onClose, onCloseWithoutFocus],
  );

  const handleDismiss = useCallback(() => {
    const handoff = dismissHandoffRef.current;
    dismissHandoffRef.current = null;
    onDismiss?.();
    if (handoff) {
      if (dismissHandoffTimerRef.current !== null) {
        clearTimeout(dismissHandoffTimerRef.current);
      }
      // Fabric emits onDismiss immediately before completing its native focus
      // restoration. Move the alert to the next task so VoiceOver stays on the
      // confirmation instead of being pulled back to the old sheet trigger.
      dismissHandoffTimerRef.current = setTimeout(() => {
        dismissHandoffTimerRef.current = null;
        handoff();
      }, 0);
    }
  }, [onDismiss]);

  const confirmHide = useCallback(() => {
    closeWithDismissHandoff(
      () => Alert.alert(
        'Hide this message?',
        'It will disappear only from your chat history. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Hide', style: 'destructive', onPress: onHide },
        ],
      ),
    );
  }, [closeWithDismissHandoff, onHide]);

  const confirmDeleteForEveryone = useCallback(() => {
    closeWithDismissHandoff(
      () => Alert.alert(
        'Remove this message for everyone?',
        'Its content will be replaced with a removal notice for every trip member.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: onDeleteForEveryone },
        ],
      ),
    );
  }, [closeWithDismissHandoff, onDeleteForEveryone]);

  const startSelection = useCallback(() => {
    closeWithFocusRestore();
    onSelect();
  }, [closeWithFocusRestore, onSelect]);

  return (
    <Modal
      animationType="slide"
      onDismiss={handleDismiss}
      onRequestClose={closeWithFocusRestore}
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
              onPress={closeWithFocusRestore}
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
    position: 'relative',
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    borderCurve: 'continuous',
  },
  reactionOptionSelected: {
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  reactionSelectedBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.full,
    borderCurve: 'continuous',
    backgroundColor: colors.primary,
  },
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
