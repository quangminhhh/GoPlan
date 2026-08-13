import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import {
  GoPlanAIComposerIntent,
  GoPlanAIMentionCommandMenu,
} from '../ai/components/AIMention';
import {
  insertGoPlanAIMention,
  parseGoPlanAIMention,
  shouldOfferGoPlanAICommand,
} from '../ai/mention';

export const CHAT_MESSAGE_MAX_LENGTH = 2000;

export interface ChatComposerSubmitResult {
  draftDisposition: 'clear' | 'preserve';
  feedback: string | null;
}

interface ChatComposerProps {
  disabled?: boolean;
  hidden?: boolean;
  sending?: boolean;
  onSubmit: (content: string) => Promise<ChatComposerSubmitResult>;
}

export function ChatComposer({
  disabled = false,
  hidden = false,
  sending = false,
  onSubmit,
}: ChatComposerProps) {
  const inputRef = useRef<TextInput>(null);
  const submittingRef = useRef(false);
  const [draft, setDraft] = useState('');
  const [localSending, setLocalSending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const trimmedDraft = draft.trim();
  const busy = sending || localSending;
  const parsedAIMention = parseGoPlanAIMention(draft);
  const hasAIMention = parsedAIMention.hasMention;
  const missingAIPrompt = hasAIMention && parsedAIMention.prompt.length === 0;
  const canSend =
    !disabled && !busy && trimmedDraft.length > 0 && !missingAIPrompt;
  const showAIMentionMenu =
    !disabled && !busy && shouldOfferGoPlanAICommand(draft);

  useEffect(() => {
    if (hidden) {
      inputRef.current?.blur();
    }
  }, [hidden]);

  const updateDraft = useCallback((value: string) => {
    setDraft(value);
    setFeedback(null);
  }, []);

  const insertAIMention = useCallback(() => {
    const inserted = insertGoPlanAIMention(draft).displayContent;
    if (inserted.length > CHAT_MESSAGE_MAX_LENGTH) {
      setFeedback(
        'GoPlanAI mention cannot be inserted because this message would exceed 2,000 characters.',
      );
      inputRef.current?.focus();
      return;
    }
    setDraft(inserted);
    setFeedback(null);
    inputRef.current?.focus();
  }, [draft]);

  const submit = useCallback(async () => {
    if (!canSend || submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setLocalSending(true);
    setFeedback(null);
    try {
      const result = await onSubmit(trimmedDraft);
      if (result.draftDisposition === 'clear') {
        setDraft('');
      }
      setFeedback(result.feedback);
    } catch {
      setFeedback('Message could not be sent. Try again.');
    } finally {
      submittingRef.current = false;
      setLocalSending(false);
    }
  }, [canSend, onSubmit, trimmedDraft]);

  return (
    <View
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={[styles.shell, hidden ? styles.hidden : null]}
      testID="chat-composer"
    >
      <GoPlanAIMentionCommandMenu
        disabled={disabled || busy}
        onSelect={insertAIMention}
        open={showAIMentionMenu}
      />
      {hasAIMention ? <GoPlanAIComposerIntent /> : null}
      <View style={styles.composerRow}>
        <TextInput
          ref={inputRef}
          accessibilityLabel="Message"
          accessibilityHint="Enter a message for this trip chat"
          editable={!disabled && !busy}
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          multiline
          onChangeText={updateDraft}
          placeholder="Write a message"
          placeholderTextColor={colors.textMuted}
          scrollEnabled
          style={styles.input}
          textAlignVertical="top"
          value={draft}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !canSend, busy }}
          disabled={!canSend}
          hitSlop={spacing.xs}
          onPress={() => void submit()}
          style={({ pressed }) => [
            styles.sendButton,
            pressed && canSend ? styles.sendButtonPressed : null,
            !canSend ? styles.sendButtonDisabled : null,
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.background} />
          ) : (
            <Ionicons
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              name="arrow-up"
              size={20}
              color={colors.background}
            />
          )}
        </Pressable>
      </View>
      {feedback ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.feedback}
          testID="chat-composer-feedback"
        >
          {feedback}
        </Text>
      ) : null}
      {missingAIPrompt ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.promptHint}
          testID="goplan-ai-prompt-hint"
        >
          Add a prompt for GoPlanAI before sending.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  input: {
    ...typography.body,
    minHeight: 44,
    maxHeight: 120,
    minWidth: 0,
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderCurve: 'continuous',
    color: colors.text,
    backgroundColor: colors.background,
  },
  sendButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.full,
    borderCurve: 'continuous',
    backgroundColor: colors.primary,
  },
  sendButtonPressed: { backgroundColor: colors.primaryPressed },
  sendButtonDisabled: { opacity: 0.38 },
  feedback: { ...typography.caption, color: colors.danger },
  promptHint: { ...typography.caption, color: colors.warning },
  hidden: { display: 'none' },
});
