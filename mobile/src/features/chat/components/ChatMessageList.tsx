import { Ionicons } from '@expo/vector-icons';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  type ListRenderItemInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { AITypingIndicator } from '../ai/components/AITypingIndicator';
import { useRoomAIActionDraftControllerSessionStore } from '../ai/reconciliationContext';
import type {
  AllowedReactionEmoji,
  ChatApiFailure,
  ChatMessage,
  DeleteChatMessageMode,
} from '../types';
import { ChatMessageActionsModal } from './ChatMessageActionsModal';
import {
  ChatMessageBubble,
  type ApplyMessageAIDraftSnapshot,
} from './ChatMessageBubble';
import { ChatSelectionToolbar } from './ChatSelectionToolbar';

const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;
export const CHAT_HIDE_SELECTION_LIMIT = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAINTAIN_VISIBLE_CONTENT_POSITION = { minIndexForVisible: 0 } as const;

export interface ChatListMutationResult {
  applied: boolean;
  feedback: string | null;
}

export function toggleChatMessageSelection(
  selectedMessageIds: ReadonlySet<string>,
  messageId: string,
): { selectedMessageIds: ReadonlySet<string>; limitReached: boolean } {
  const next = new Set(selectedMessageIds);
  if (next.has(messageId)) {
    next.delete(messageId);
    return { selectedMessageIds: next, limitReached: false };
  }
  if (next.size >= CHAT_HIDE_SELECTION_LIMIT) {
    return { selectedMessageIds, limitReached: true };
  }
  next.add(messageId);
  return { selectedMessageIds: next, limitReached: false };
}

interface ChatMessageListProps {
  messages: readonly ChatMessage[];
  currentUserId: string;
  pendingClientIds: ReadonlySet<string>;
  failedClientIds: ReadonlySet<string>;
  failedByClientId: ReadonlyMap<string, ChatApiFailure>;
  pendingReactionMessageIds: ReadonlySet<string>;
  pendingDeleteMessageIds: ReadonlySet<string>;
  hasMoreOlder: boolean;
  isLoadingOlder: boolean;
  olderLoadError: string | null;
  actionsEnabled: boolean;
  ambiguousAIDraftIds: ReadonlySet<string>;
  aiTypingInteractionId: string | null;
  isHidingMessages: boolean;
  bottomAccessory: ReactNode;
  onLoadOlder: () => void;
  onRetry: (clientMessageId: string) => void;
  onToggleReaction: (messageId: string, emoji: AllowedReactionEmoji) => void;
  onDeleteMessage: (messageId: string, mode: DeleteChatMessageMode) => void;
  onHideMessagesForMe: (messageIds: readonly string[]) => Promise<ChatListMutationResult>;
  onApplyAIDraftSnapshot: ApplyMessageAIDraftSnapshot;
}

function chatMessageKey(message: ChatMessage): string {
  if (message.client_message_id) {
    return `client:${message.sender.id ?? 'unknown'}:${message.client_message_id}`;
  }
  return `message:${message.id}`;
}

function senderGroupKey(message: ChatMessage): string | null {
  if (message.sender.id) {
    return `user:${message.sender.id}`;
  }
  if (message.sender_kind === 'AI') {
    return 'ai';
  }
  // A deleted sender has no stable identity. Grouping two nullable senders
  // could visually attribute one person's message to another account.
  return null;
}

function messagesShareGroup(older: ChatMessage, newer: ChatMessage): boolean {
  const olderSender = senderGroupKey(older);
  const newerSender = senderGroupKey(newer);
  if (olderSender === null || newerSender === null || olderSender !== newerSender) {
    return false;
  }
  const olderTime = Date.parse(older.created_at);
  const newerTime = Date.parse(newer.created_at);
  if (!Number.isFinite(olderTime) || !Number.isFinite(newerTime)) {
    return false;
  }
  return newerTime >= olderTime && newerTime - olderTime <= MESSAGE_GROUP_WINDOW_MS;
}

function messageDeadlineMs(message: ChatMessage): number | null {
  if (!message.can_delete_for_everyone || !message.delete_for_everyone_until) {
    return null;
  }
  const deadline = Date.parse(message.delete_for_everyone_until);
  return Number.isFinite(deadline) ? deadline : null;
}

export function canDeleteMessageForEveryoneAt(
  message: ChatMessage,
  currentUserId: string,
  nowMs: number,
): boolean {
  if (
    message.sender_kind !== 'USER' ||
    message.sender.id !== currentUserId ||
    message.is_deleted_for_everyone
  ) {
    return false;
  }
  const deadline = messageDeadlineMs(message);
  return deadline !== null && nowMs <= deadline;
}

function useDeleteDeadlineClock(messages: readonly ChatMessage[]): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const actualNow = Date.now();
    const deadlines = messages
      .map(messageDeadlineMs)
      .filter((deadline): deadline is number => deadline !== null);
    const hasNewlyExpiredDeadline = deadlines.some(
      (deadline) => deadline < actualNow && deadline >= nowMs,
    );
    const nextDeadline = deadlines
      .filter((deadline) => deadline >= actualNow)
      .reduce<number | null>(
        (earliest, deadline) =>
          earliest === null || deadline < earliest ? deadline : earliest,
        null,
      );

    if (!hasNewlyExpiredDeadline && nextDeadline === null) {
      return undefined;
    }

    const delay = hasNewlyExpiredDeadline
      ? 0
      : Math.min(
          MAX_TIMER_DELAY_MS,
          Math.max(0, (nextDeadline ?? actualNow) - actualNow + 1),
        );
    const timer = setTimeout(() => setNowMs(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [messages, nowMs]);

  return nowMs;
}

function EmptyChatState() {
  return (
    <View style={styles.emptyState}>
      <Ionicons name="chatbubbles-outline" size={44} color={colors.textMuted} />
      <Text accessibilityRole="header" style={styles.emptyTitle}>
        No messages yet
      </Text>
      <Text style={styles.emptyMessage}>
        Start the conversation with your trip mates.
      </Text>
    </View>
  );
}

export function ChatMessageList({
  messages,
  currentUserId,
  pendingClientIds,
  failedClientIds,
  failedByClientId,
  pendingReactionMessageIds,
  pendingDeleteMessageIds,
  hasMoreOlder,
  isLoadingOlder,
  olderLoadError,
  actionsEnabled,
  ambiguousAIDraftIds,
  aiTypingInteractionId,
  isHidingMessages,
  bottomAccessory,
  onLoadOlder,
  onRetry,
  onToggleReaction,
  onDeleteMessage,
  onHideMessagesForMe,
  onApplyAIDraftSnapshot,
}: ChatMessageListProps) {
  const aiControllerSessionStore =
    useRoomAIActionDraftControllerSessionStore();
  const nowMs = useDeleteDeadlineClock(messages);
  const userInteractedRef = useRef(false);
  const actionsEnabledRef = useRef(actionsEnabled);
  const messagesRef = useRef(messages);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectionFeedback, setSelectionFeedback] = useState<string | null>(null);
  const newestFirstMessages = useMemo(() => [...messages].reverse(), [messages]);
  useLayoutEffect(() => {
    if (aiControllerSessionStore === null) {
      return;
    }
    aiControllerSessionStore.setAmbiguousDraftIds(ambiguousAIDraftIds);
  }, [aiControllerSessionStore, ambiguousAIDraftIds]);
  const visibleMessageIds = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages],
  );
  const visibleSelectedIds = useMemo(
    () =>
      new Set(
        [...selectedMessageIds].filter((messageId) => visibleMessageIds.has(messageId)),
      ),
    [selectedMessageIds, visibleMessageIds],
  );
  const selectionMode = visibleSelectedIds.size > 0;
  const activeMessage = useMemo(
    () => messages.find((message) => message.id === activeMessageId) ?? null,
    [activeMessageId, messages],
  );
  const activeClientId = activeMessage?.client_message_id ?? null;
  const activePending = activeClientId ? pendingClientIds.has(activeClientId) : false;
  const activeFailed = activeClientId ? failedClientIds.has(activeClientId) : false;
  const activeConfirmed = Boolean(activeMessage && !activePending && !activeFailed);
  const activeReaction =
    activeMessage?.reactions.find((reaction) =>
      reaction.reacted_by_ids.includes(currentUserId),
    )?.emoji ?? null;
  const activeBusy = activeMessage
    ? pendingReactionMessageIds.has(activeMessage.id) ||
      pendingDeleteMessageIds.has(activeMessage.id)
    : false;
  const typingHeader = useMemo(
    () =>
      aiTypingInteractionId === null ? null : (
        <View style={styles.typingHeader}>
          <AITypingIndicator interactionId={aiTypingInteractionId} />
        </View>
      ),
    [aiTypingInteractionId],
  );

  useLayoutEffect(() => {
    actionsEnabledRef.current = actionsEnabled;
    messagesRef.current = messages;
  }, [actionsEnabled, messages]);

  const markUserInteraction = useCallback(() => {
    userInteractedRef.current = true;
  }, []);

  const beginTranscriptDrag = useCallback(() => {
    markUserInteraction();
    Keyboard.dismiss();
  }, [markUserInteraction]);

  const loadOlderFromScroll = useCallback(() => {
    if (userInteractedRef.current && hasMoreOlder && !isLoadingOlder) {
      onLoadOlder();
    }
  }, [hasMoreOlder, isLoadingOlder, onLoadOlder]);

  const openActions = useCallback((messageId: string) => {
    setActiveMessageId(messageId);
  }, []);

  const closeActions = useCallback(() => {
    setActiveMessageId(null);
  }, []);

  const toggleSelection = useCallback(
    (messageId: string) => {
      const result = toggleChatMessageSelection(visibleSelectedIds, messageId);
      if (result.limitReached) {
        setSelectionFeedback('You can select up to 100 messages at once.');
        return;
      }
      setSelectionFeedback(null);
      setSelectedMessageIds(result.selectedMessageIds);
    },
    [visibleSelectedIds],
  );

  const startSelection = useCallback(() => {
    if (activeMessage && activeConfirmed) {
      setSelectionFeedback(null);
      setSelectedMessageIds(new Set([activeMessage.id]));
    }
  }, [activeConfirmed, activeMessage]);

  const cancelSelection = useCallback(() => {
    setSelectionFeedback(null);
    setSelectedMessageIds(new Set());
  }, []);

  const hideSelected = useCallback(async () => {
    const ids = [...visibleSelectedIds].slice(0, CHAT_HIDE_SELECTION_LIMIT);
    if (!actionsEnabledRef.current || ids.length === 0) {
      return;
    }
    const result = await onHideMessagesForMe(ids);
    if (result.applied) {
      cancelSelection();
    } else {
      setSelectionFeedback(result.feedback);
    }
  }, [cancelSelection, onHideMessagesForMe, visibleSelectedIds]);

  const reactToActiveMessage = useCallback(
    (emoji: AllowedReactionEmoji) => {
      if (activeMessage && actionsEnabledRef.current) {
        onToggleReaction(activeMessage.id, emoji);
      }
    },
    [activeMessage, onToggleReaction],
  );

  const hideActiveMessage = useCallback(() => {
    if (activeMessage && actionsEnabledRef.current) {
      onDeleteMessage(activeMessage.id, 'for_me');
    }
  }, [activeMessage, onDeleteMessage]);

  const deleteActiveMessageForEveryone = useCallback(() => {
    if (
      activeMessage &&
      actionsEnabledRef.current
    ) {
      const latestMessage = messagesRef.current.find(
        (message) => message.id === activeMessage.id,
      );
      if (
        latestMessage &&
        canDeleteMessageForEveryoneAt(latestMessage, currentUserId, Date.now())
      ) {
        onDeleteMessage(latestMessage.id, 'for_everyone');
      }
    }
  }, [activeMessage, currentUserId, onDeleteMessage]);

  const renderMessage = useCallback(
    ({ item, index }: ListRenderItemInfo<ChatMessage>) => {
      const clientId = item.client_message_id;
      const pending = clientId ? pendingClientIds.has(clientId) : false;
      const failed = clientId ? failedClientIds.has(clientId) : false;
      const isOwn = item.sender.id === currentUserId;
      const newerMessage = index > 0 ? newestFirstMessages[index - 1] : null;
      const olderMessage =
        index < newestFirstMessages.length - 1
          ? newestFirstMessages[index + 1]
          : null;
      const continuesFromOlder =
        olderMessage !== null && messagesShareGroup(olderMessage, item);
      const continuesIntoNewer =
        newerMessage !== null && messagesShareGroup(item, newerMessage);

      return (
        <ChatMessageBubble
          message={item}
          currentUserId={currentUserId}
          isOwn={isOwn}
          showSender={!isOwn && !continuesFromOlder}
          showAvatar={!isOwn && !continuesIntoNewer}
          showMeta={!continuesIntoNewer}
          pending={pending}
          failed={failed}
          failure={clientId ? failedByClientId.get(clientId) ?? null : null}
          deleting={pendingDeleteMessageIds.has(item.id)}
          reactionBusy={pendingReactionMessageIds.has(item.id)}
          actionsEnabled={actionsEnabled}
          ambiguousAIDraftIds={ambiguousAIDraftIds}
          selectionMode={selectionMode}
          selected={visibleSelectedIds.has(item.id)}
          onOpenActions={openActions}
          onToggleSelection={toggleSelection}
          onRetry={onRetry}
          onToggleReaction={onToggleReaction}
          onApplyAIDraftSnapshot={onApplyAIDraftSnapshot}
        />
      );
    },
    [
      actionsEnabled,
      ambiguousAIDraftIds,
      currentUserId,
      failedClientIds,
      failedByClientId,
      newestFirstMessages,
      onRetry,
      onToggleReaction,
      onApplyAIDraftSnapshot,
      openActions,
      pendingClientIds,
      pendingDeleteMessageIds,
      pendingReactionMessageIds,
      selectionMode,
      toggleSelection,
      visibleSelectedIds,
    ],
  );

  const paginationFooter = hasMoreOlder ? (
    <View style={styles.paginationFooter}>
      {isLoadingOlder ? (
        <View
          accessible
          accessibilityLabel="Loading earlier messages"
          accessibilityRole="progressbar"
          style={styles.paginationProgress}
        >
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.paginationText}>Loading earlier messages…</Text>
        </View>
      ) : (
        <>
          {olderLoadError ? (
            <Text accessibilityRole="alert" style={styles.paginationError}>
              {olderLoadError}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Load earlier messages"
            onPress={onLoadOlder}
            style={({ pressed }) => [styles.loadOlderButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.loadOlderText}>Load earlier messages</Text>
          </Pressable>
        </>
      )}
    </View>
  ) : null;

  const canDeleteActiveForEveryone = Boolean(
    activeMessage &&
      actionsEnabled &&
      activeConfirmed &&
      canDeleteMessageForEveryoneAt(activeMessage, currentUserId, nowMs),
  );
  const activeMessageCanMutate = Boolean(
    activeMessage && actionsEnabled && activeConfirmed && !activeBusy,
  );

  return (
    <View style={styles.shell}>
      <FlatList
        data={newestFirstMessages}
        inverted
        initialNumToRender={20}
        keyExtractor={chatMessageKey}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={MAINTAIN_VISIBLE_CONTENT_POSITION}
        onEndReached={loadOlderFromScroll}
        onEndReachedThreshold={0.25}
        onMomentumScrollBegin={markUserInteraction}
        onScrollBeginDrag={beginTranscriptDrag}
        renderItem={renderMessage}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={
          newestFirstMessages.length === 0 ? styles.emptyContent : styles.listContent
        }
        ListEmptyComponent={<EmptyChatState />}
        ListHeaderComponent={typingHeader}
        ListFooterComponent={paginationFooter}
        testID="chat-message-list"
      />

      <View
        accessibilityElementsHidden={selectionMode}
        importantForAccessibility={selectionMode ? 'no-hide-descendants' : 'auto'}
        style={selectionMode ? styles.hiddenAccessory : null}
      >
        {bottomAccessory}
      </View>
      {selectionMode ? (
        <ChatSelectionToolbar
          selectedCount={visibleSelectedIds.size}
          feedback={selectionFeedback}
          disabled={!actionsEnabled}
          hiding={isHidingMessages}
          onCancel={cancelSelection}
          onConfirmHide={() => void hideSelected()}
        />
      ) : null}

      <ChatMessageActionsModal
        visible={activeMessage !== null}
        currentReaction={activeReaction}
        canReact={
          activeMessageCanMutate && activeMessage?.is_deleted_for_everyone === false
        }
        canHide={activeMessageCanMutate}
        canDeleteForEveryone={canDeleteActiveForEveryone}
        canSelect={activeMessageCanMutate}
        busy={activeBusy}
        onClose={closeActions}
        onReact={reactToActiveMessage}
        onHide={hideActiveMessage}
        onDeleteForEveryone={deleteActiveMessageForEveryone}
        onSelect={startSelection}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.surface },
  listContent: { paddingVertical: spacing.sm },
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
  typingHeader: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  emptyTitle: { ...typography.heading, color: colors.text, textAlign: 'center' },
  emptyMessage: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
  paginationFooter: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  paginationProgress: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  paginationText: { ...typography.caption, color: colors.textMuted },
  paginationError: { ...typography.caption, color: colors.danger, textAlign: 'center' },
  loadOlderButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  loadOlderText: { ...typography.label, color: colors.primary },
  pressed: { opacity: 0.58 },
  hiddenAccessory: { display: 'none' },
});
