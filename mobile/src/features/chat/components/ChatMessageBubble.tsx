import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { UserAvatar } from '@/features/auth/components/UserAvatar';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { AIActionDraftCardController } from '../ai/components/AIActionDraftCardController';
import {
  GoPlanAIMentionMessageText,
} from '../ai/components/AIMention';
import { AIMessageContent } from '../ai/components/AIMessageContent';
import {
  aiActionDraftSourceIdentity,
  parseAIActionDraft,
  type AIActionDraft,
} from '../ai/drafts';
import { parseGoPlanAIMention } from '../ai/mention';
import type {
  AllowedReactionEmoji,
  ChatApiFailure,
  ChatMessage,
} from '../types';
import { ChatReactionBar } from './ChatReactionBar';

const visualTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const accessibleTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const EMPTY_DRAFT_ID_SET: ReadonlySet<string> = new Set();

export interface ApplyMessageAIDraftSnapshotInput {
  readonly messageId: string;
  readonly draftId: string;
  readonly expectedSourceIdentity: string;
  readonly draft: AIActionDraft;
}

export type ApplyMessageAIDraftSnapshot = (
  input: ApplyMessageAIDraftSnapshotInput,
) => Promise<void>;

interface ChatMessageBubbleProps {
  message: ChatMessage;
  currentUserId: string;
  isOwn: boolean;
  showSender: boolean;
  showAvatar: boolean;
  showMeta: boolean;
  pending: boolean;
  failed: boolean;
  failure: ChatApiFailure | null;
  deleting: boolean;
  reactionBusy: boolean;
  actionsEnabled: boolean;
  ambiguousAIDraftIds?: ReadonlySet<string>;
  selectionMode: boolean;
  selected: boolean;
  onOpenActions: (messageId: string) => void;
  onToggleSelection: (messageId: string) => void;
  onRetry: (clientMessageId: string) => void;
  onToggleReaction: (messageId: string, emoji: AllowedReactionEmoji) => void;
  onApplyAIDraftSnapshot: ApplyMessageAIDraftSnapshot;
}

function senderLabel(message: ChatMessage): string {
  if (message.sender_kind === 'AI') {
    return 'GoPlanAI';
  }
  const displayName = message.sender.display_name.trim();
  return displayName || 'Deleted user';
}

function formatMessageTime(value: string, accessible = false): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return (accessible ? accessibleTimeFormatter : visualTimeFormatter).format(parsed);
}

function messageAccessibilityLabel(
  message: ChatMessage,
  isOwn: boolean,
  pending: boolean,
  failed: boolean,
  deleting: boolean,
): string {
  const sender = isOwn ? 'You' : senderLabel(message);
  const content = message.is_deleted_for_everyone
    ? 'Message removed for everyone'
    : message.sender_kind === 'AI' && message.ai_status === 'ERROR'
      ? `GoPlanAI could not complete this request. ${message.content || 'No error detail was provided.'}`
      : message.content || 'Message with no text';
  const time = formatMessageTime(message.created_at, true);
  const delivery = failed
    ? 'Not sent'
    : pending
      ? 'Sending'
      : deleting
        ? 'Removing'
        : null;
  return [sender, content, time, delivery].filter(Boolean).join(', ');
}

function SelectionIndicator({ selected }: { selected: boolean }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.selectionIndicator, selected ? styles.selectionIndicatorSelected : null]}
    >
      {selected ? (
        <Ionicons name="checkmark" size={14} color={colors.background} />
      ) : null}
    </View>
  );
}

function SenderAvatar({ message }: { message: ChatMessage }) {
  if (message.sender_kind === 'AI') {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.aiAvatar}
      >
        <Ionicons name="sparkles" size={16} color={colors.violet} />
      </View>
    );
  }
  const label = senderLabel(message);
  return (
    <UserAvatar
      displayName={label}
      avatarUrl={message.sender.avatar_url}
      size={32}
      accessibilityLabel={`${label}'s profile picture`}
    />
  );
}

interface AIDraftCardAdapterProps {
  readonly draft: AIActionDraft;
  readonly interactionDisabled: boolean;
  readonly messageId: string;
  readonly tripId: string;
  readonly onApplyAIDraftSnapshot: ApplyMessageAIDraftSnapshot;
}

const AIDraftCardAdapter = memo(function AIDraftCardAdapter({
  draft,
  interactionDisabled,
  messageId,
  tripId,
  onApplyAIDraftSnapshot,
}: AIDraftCardAdapterProps) {
  const expectedSourceIdentity = useMemo(
    () => aiActionDraftSourceIdentity(draft),
    [draft],
  );
  const applySnapshot = useCallback(
    (nextDraft: AIActionDraft) =>
      onApplyAIDraftSnapshot({
        messageId,
        draftId: draft.id,
        expectedSourceIdentity,
        draft: nextDraft,
      }),
    [draft.id, expectedSourceIdentity, messageId, onApplyAIDraftSnapshot],
  );

  return (
    <AIActionDraftCardController
      draft={draft}
      interactionDisabled={interactionDisabled}
      onDraftChanged={applySnapshot}
      tripId={tripId}
    />
  );
});
AIDraftCardAdapter.displayName = 'AIDraftCardAdapter';

function ChatMessageBubbleComponent({
  message,
  currentUserId,
  isOwn,
  showSender,
  showAvatar,
  showMeta,
  pending,
  failed,
  failure,
  deleting,
  reactionBusy,
  actionsEnabled,
  ambiguousAIDraftIds = EMPTY_DRAFT_ID_SET,
  selectionMode,
  selected,
  onOpenActions,
  onToggleSelection,
  onRetry,
  onToggleReaction,
  onApplyAIDraftSnapshot,
}: ChatMessageBubbleProps) {
  const canSelect = !pending && !failed && !deleting;
  const canOpenActions = actionsEnabled && canSelect && !selectionMode;
  const canRetry = Boolean(actionsEnabled && failed && message.client_message_id);
  const time = formatMessageTime(message.created_at);
  const label = senderLabel(message);
  const userHasAIMention = useMemo(
    () =>
      message.sender_kind === 'USER' &&
      parseGoPlanAIMention(message.content).hasMention,
    [message.content, message.sender_kind],
  );
  const parsedDrafts = useMemo(() => {
    if (
      message.sender_kind !== 'AI' ||
      message.is_deleted_for_everyone
    ) {
      return { drafts: [] as readonly AIActionDraft[], malformedCount: 0 };
    }
    const parsedCandidates = message.action_drafts.map(parseAIActionDraft);
    const idCounts = new Map<string, number>();
    for (const parsed of parsedCandidates) {
      if (parsed !== null) {
        idCounts.set(parsed.id, (idCounts.get(parsed.id) ?? 0) + 1);
      }
    }
    const drafts: AIActionDraft[] = [];
    let malformedCount = 0;
    for (const parsed of parsedCandidates) {
      if (parsed === null) {
        malformedCount += 1;
      } else if (
        (idCounts.get(parsed.id) ?? 0) !== 1 ||
        ambiguousAIDraftIds.has(parsed.id)
      ) {
        malformedCount += 1;
      } else {
        drafts.push(parsed);
      }
    }
    return { drafts, malformedCount };
  }, [
    ambiguousAIDraftIds,
    message.action_drafts,
    message.is_deleted_for_everyone,
    message.sender_kind,
  ]);
  const accessibilityActions = useMemo<AccessibilityActionInfo[]>(() => {
    if (selectionMode && canSelect) {
      return [
        {
          name: 'toggleSelection',
          label: selected ? 'Deselect message' : 'Select message',
        },
      ];
    }
    if (canOpenActions) {
      return [{ name: 'openMessageActions', label: 'Open message actions' }];
    }
    if (canRetry) {
      return [{ name: 'retrySend', label: 'Retry sending message' }];
    }
    return [];
  }, [canOpenActions, canRetry, canSelect, selected, selectionMode]);

  const openActions = useCallback(() => {
    if (canOpenActions) {
      onOpenActions(message.id);
    }
  }, [canOpenActions, message.id, onOpenActions]);

  const toggleSelection = useCallback(() => {
    if (canSelect) {
      onToggleSelection(message.id);
    }
  }, [canSelect, message.id, onToggleSelection]);

  const retry = useCallback(() => {
    if (message.client_message_id) {
      onRetry(message.client_message_id);
    }
  }, [message.client_message_id, onRetry]);

  const toggleReaction = useCallback(
    (emoji: AllowedReactionEmoji) => onToggleReaction(message.id, emoji),
    [message.id, onToggleReaction],
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'openMessageActions') {
        openActions();
      } else if (event.nativeEvent.actionName === 'toggleSelection') {
        toggleSelection();
      } else if (event.nativeEvent.actionName === 'retrySend') {
        retry();
      }
    },
    [openActions, retry, toggleSelection],
  );

  const content = message.sender_kind === 'AI' ? (
    <View style={styles.aiContent}>
      {message.ai_status === 'ERROR' ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.aiErrorText}
          testID={`chat-ai-error-${message.id}`}
        >
          GoPlanAI could not complete this request.
        </Text>
      ) : null}
      <AIMessageContent content={message.content} />
    </View>
  ) : userHasAIMention ? (
    <GoPlanAIMentionMessageText content={message.content} inverse={isOwn} />
  ) : (
    <Text style={[styles.messageText, isOwn ? styles.ownMessageText : null]}>
      {message.content}
    </Text>
  );

  const bubble = (
    <Pressable
      accessible
      accessibilityRole={canOpenActions || (selectionMode && canSelect) ? 'button' : undefined}
      accessibilityLabel={messageAccessibilityLabel(message, isOwn, pending, failed, deleting)}
      accessibilityHint={
        canOpenActions
          ? 'Long press or use the Open message actions accessibility action'
          : selectionMode && canSelect
            ? `Double tap to ${selected ? 'deselect' : 'select'} this message`
            : undefined
      }
      accessibilityState={{
        selected: selectionMode ? selected : undefined,
        busy: pending || deleting || reactionBusy,
      }}
      accessibilityActions={accessibilityActions}
      delayLongPress={400}
      onAccessibilityAction={handleAccessibilityAction}
      onLongPress={canOpenActions ? openActions : undefined}
      onPress={selectionMode && canSelect ? toggleSelection : undefined}
      style={({ pressed }) => [
        styles.bubble,
        isOwn ? styles.ownBubble : styles.otherBubble,
        message.sender_kind === 'AI' ? styles.aiBubble : null,
        message.ai_status === 'ERROR' ? styles.aiErrorBubble : null,
        message.is_deleted_for_everyone ? styles.tombstoneBubble : null,
        pending ? styles.pendingBubble : null,
        pressed && (canOpenActions || selectionMode) ? styles.pressed : null,
      ]}
      testID={`chat-message-${message.id}`}
    >
      {message.is_deleted_for_everyone ? (
        <Text style={styles.tombstoneText}>Message removed for everyone</Text>
      ) : (
        content
      )}
    </Pressable>
  );

  const actionDraftCards =
    parsedDrafts.drafts.length > 0 || parsedDrafts.malformedCount > 0 ? (
      <View style={styles.actionDrafts} testID={`chat-ai-drafts-${message.id}`}>
        {parsedDrafts.drafts.map((draft) => (
          <AIDraftCardAdapter
            draft={draft}
            interactionDisabled={!actionsEnabled || selectionMode}
            key={draft.id}
            messageId={message.id}
            onApplyAIDraftSnapshot={onApplyAIDraftSnapshot}
            tripId={message.trip_id}
          />
        ))}
        {parsedDrafts.malformedCount > 0 ? (
          <Text
            accessibilityRole="alert"
            style={styles.malformedDraftText}
            testID={`chat-ai-draft-malformed-${message.id}`}
          >
            An AI action draft could not be displayed safely.
          </Text>
        ) : null}
      </View>
    ) : null;

  const meta = showMeta || pending || failed || deleting ? (
    <View style={[styles.metaRow, isOwn ? styles.metaRowOwn : null]}>
      {deleting ? (
        <>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text style={styles.metaText}>Removing…</Text>
        </>
      ) : failed && canRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            failure
              ? `Retry sending message. ${failure.message}`
              : 'Retry sending message'
          }
          onPress={retry}
          style={({ pressed }) => [styles.retryButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.failedText}>
            {failure ? `Not sent. ${failure.message} Retry` : 'Not sent. Retry'}
          </Text>
        </Pressable>
      ) : failed ? (
        <Text accessibilityLiveRegion="polite" style={styles.failedText}>
          {failure ? `Not sent. ${failure.message}` : 'Not sent.'}
        </Text>
      ) : pending ? (
        <Text accessibilityLiveRegion="polite" style={styles.metaText}>
          Sending…
        </Text>
      ) : time ? (
        <Text style={styles.metaText}>{time}</Text>
      ) : null}
    </View>
  ) : null;

  const reactions = message.is_deleted_for_everyone ? null : (
    <ChatReactionBar
      reactions={message.reactions}
      currentUserId={currentUserId}
      disabled={!actionsEnabled || selectionMode}
      busy={reactionBusy}
      onToggle={toggleReaction}
    />
  );

  if (isOwn) {
    return (
      <View style={[styles.row, styles.ownRow, selected ? styles.selectedRow : null]}>
        <View style={[styles.messageColumn, styles.ownColumn]}>
          {bubble}
          {actionDraftCards}
          {reactions}
          {meta}
        </View>
        {selectionMode && canSelect ? <SelectionIndicator selected={selected} /> : null}
      </View>
    );
  }

  return (
    <View style={[styles.row, styles.otherRow, selected ? styles.selectedRow : null]}>
      {selectionMode && canSelect ? <SelectionIndicator selected={selected} /> : null}
      <View style={styles.avatarGutter}>{showAvatar ? <SenderAvatar message={message} /> : null}</View>
      <View
        style={[
          styles.messageColumn,
          styles.otherColumn,
          message.sender_kind === 'AI' ? styles.aiColumn : null,
        ]}
      >
        {showSender ? (
          <View style={styles.senderRow}>
            <Text style={[styles.senderName, message.sender_kind === 'AI' ? styles.aiSender : null]}>
              {label}
            </Text>
            {message.sender.identify_tag ? (
              <Text style={styles.senderTag}>{message.sender.identify_tag}</Text>
            ) : null}
          </View>
        ) : null}
        {bubble}
        {actionDraftCards}
        {reactions}
        {meta}
      </View>
    </View>
  );
}

export const ChatMessageBubble = memo(ChatMessageBubbleComponent);
ChatMessageBubble.displayName = 'ChatMessageBubble';

const styles = StyleSheet.create({
  row: {
    width: '100%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  ownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  otherRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  selectedRow: { backgroundColor: colors.primarySoft },
  messageColumn: { minWidth: 0, gap: spacing.xs },
  ownColumn: { maxWidth: '82%', alignItems: 'flex-end' },
  otherColumn: { maxWidth: '82%', alignItems: 'flex-start' },
  aiColumn: { maxWidth: '100%', flex: 1, alignItems: 'stretch' },
  avatarGutter: { width: 32, minHeight: 32, justifyContent: 'flex-end' },
  aiAvatar: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.full,
    borderCurve: 'continuous',
    backgroundColor: colors.violetSoft,
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  senderName: { ...typography.label, color: colors.textMuted },
  senderTag: { ...typography.caption, color: colors.textMuted },
  aiSender: { color: colors.violet },
  bubble: {
    minHeight: 44,
    minWidth: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.lg,
    borderCurve: 'continuous',
  },
  ownBubble: { backgroundColor: colors.primary },
  otherBubble: { backgroundColor: colors.background },
  aiBubble: {
    borderWidth: 1,
    borderColor: colors.violet,
    backgroundColor: colors.violetSoft,
  },
  aiErrorBubble: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSoft,
  },
  tombstoneBubble: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.textMuted,
    backgroundColor: colors.completedSoft,
  },
  pendingBubble: { opacity: 0.68 },
  pressed: { opacity: 0.58 },
  messageText: { ...typography.body, color: colors.text },
  ownMessageText: { color: colors.background },
  aiContent: { minWidth: 0, gap: spacing.sm },
  aiErrorText: { ...typography.label, color: colors.danger },
  actionDrafts: { width: '100%', minWidth: 0, gap: spacing.sm },
  malformedDraftText: {
    ...typography.caption,
    color: colors.danger,
  },
  tombstoneText: { ...typography.caption, color: colors.textMuted, fontStyle: 'italic' },
  metaRow: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  metaRowOwn: { justifyContent: 'flex-end' },
  metaText: { ...typography.caption, color: colors.textMuted },
  retryButton: { minHeight: 44, justifyContent: 'center' },
  failedText: { ...typography.caption, color: colors.danger },
  selectionIndicator: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.textMuted,
    borderRadius: radii.full,
    borderCurve: 'continuous',
  },
  selectionIndicatorSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
});
