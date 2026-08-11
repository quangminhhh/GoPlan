import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type KeyboardEvent,
} from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { goPlanAISendFailureMessage } from '../ai/mention';
import { AIReconciliationCoordinatorProvider } from '../ai/reconciliationContext';
import { ChatComposer, type ChatComposerSubmitResult } from '../components/ChatComposer';
import { ChatConnectionBanner } from '../components/ChatConnectionBanner';
import {
  ChatMessageList,
  type ChatListMutationResult,
} from '../components/ChatMessageList';
import { useTripChat } from '../hooks/useTripChat';
import type {
  AllowedReactionEmoji,
  ChatApiFailure,
  DeleteChatMessageMode,
} from '../types';

const CHAT_SAFE_AREA_EDGES = ['left', 'right', 'bottom'] as const;
const EMPTY_DRAFT_ID_SET: ReadonlySet<string> = new Set();

export interface ChatKeyboardFrame {
  readonly height: number;
  readonly screenY: number;
}

export function chatKeyboardBottomInset(
  viewportHeight: number,
  keyboardFrame: ChatKeyboardFrame | null,
  safeAreaBottom: number,
): number {
  if (
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= 0 ||
    keyboardFrame === null ||
    !Number.isFinite(keyboardFrame.height) ||
    keyboardFrame.height <= 0 ||
    !Number.isFinite(keyboardFrame.screenY) ||
    keyboardFrame.screenY <= 0
  ) {
    return 0;
  }
  const safeBottom =
    Number.isFinite(safeAreaBottom) && safeAreaBottom > 0 ? safeAreaBottom : 0;
  const overlapEnd = Math.min(
    viewportHeight,
    keyboardFrame.screenY + keyboardFrame.height,
  );
  const overlapStart = Math.max(0, keyboardFrame.screenY);
  return Math.max(0, overlapEnd - overlapStart - safeBottom);
}

export function stableChatKeyboardFrame(
  current: ChatKeyboardFrame | null,
  candidate: ChatKeyboardFrame | null | undefined,
): ChatKeyboardFrame | null {
  if (candidate === null || candidate === undefined) {
    return current;
  }
  if (!Number.isFinite(candidate.height) || candidate.height <= 0) {
    return null;
  }
  if (!Number.isFinite(candidate.screenY) || candidate.screenY <= 0) {
    // iOS briefly reports screenY=0 while cross-fading keyboard variants.
    // Retaining the last stable frame prevents the composer from jumping.
    return current;
  }
  return { height: candidate.height, screenY: candidate.screenY };
}

function useChatKeyboardBottomInset(): number {
  const { bottom: safeAreaBottom } = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const [keyboardFrame, setKeyboardFrame] = useState<ChatKeyboardFrame | null>(
    () =>
      Platform.OS === 'ios'
        ? stableChatKeyboardFrame(null, Keyboard.metrics())
        : null,
  );

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return undefined;
    }
    const viewportSubscription = Dimensions.addEventListener(
      'change',
      () => {
        setKeyboardFrame((current) =>
          stableChatKeyboardFrame(current, Keyboard.metrics()),
        );
      },
    );
    return () => viewportSubscription.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return undefined;
    }

    const updateKeyboardFrame = (event: KeyboardEvent): void => {
      Keyboard.scheduleLayoutAnimation(event);
      setKeyboardFrame((current) =>
        stableChatKeyboardFrame(current, event.endCoordinates),
      );
    };
    const hideKeyboard = (event: KeyboardEvent): void => {
      Keyboard.scheduleLayoutAnimation(event);
      setKeyboardFrame(null);
    };
    const frameSubscription = Keyboard.addListener(
      'keyboardWillChangeFrame',
      updateKeyboardFrame,
    );
    const hideSubscription = Keyboard.addListener(
      'keyboardWillHide',
      hideKeyboard,
    );

    return () => {
      frameSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  return chatKeyboardBottomInset(
    viewport.height,
    keyboardFrame,
    safeAreaBottom,
  );
}

function routeTripId(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = candidate?.trim();
  return normalized ? normalized : undefined;
}

function failureMessage(failure: ChatApiFailure): string {
  return failureMessageWithDetail(failure, failure.message);
}

function failureMessageWithDetail(
  failure: ChatApiFailure,
  detail: string,
): string {
  const message = detail.trim() || 'Something went wrong.';
  if (failure.retryAfterMs === null || failure.retryAfterMs <= 0) {
    return message;
  }
  const seconds = Math.max(1, Math.ceil(failure.retryAfterMs / 1000));
  return `${message} Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
}

function composerFailureMessage(
  content: string,
  failure: ChatApiFailure,
): string {
  return failureMessageWithDetail(
    failure,
    goPlanAISendFailureMessage(content, failure),
  );
}

function BlockingState({
  message,
  onRetry,
  testID,
}: {
  message: string;
  onRetry?: () => void;
  testID: string;
}) {
  return (
    <SafeAreaView edges={CHAT_SAFE_AREA_EDGES} style={styles.safe}>
      <View style={styles.blockingState} testID={testID}>
        <Text accessibilityRole="header" style={styles.blockingTitle}>
          Chat unavailable
        </Text>
        <Text accessibilityRole="alert" style={styles.blockingMessage}>
          {message}
        </Text>
        {onRetry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading chat"
            onPress={onRetry}
            style={({ pressed }) => [
              styles.retryButton,
              pressed ? styles.retryButtonPressed : null,
            ]}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function StatusNotice({
  children,
  tone = 'neutral',
  testID,
}: {
  children: string;
  tone?: 'neutral' | 'warning' | 'error';
  testID: string;
}) {
  return (
    <Text
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[
        styles.notice,
        tone === 'warning' ? styles.warningNotice : null,
        tone === 'error' ? styles.errorNotice : null,
      ]}
      testID={testID}
    >
      {children}
    </Text>
  );
}

function ReadOnlyFooter({ message }: { message: string }) {
  return (
    <View style={styles.readOnlyFooter} testID="chat-read-only-footer">
      <Text accessibilityLiveRegion="polite" style={styles.readOnlyText}>
        {message}
      </Text>
    </View>
  );
}

export function ChatScreen() {
  const params = useLocalSearchParams<{ tripId?: string | string[] }>();
  const tripId = routeTripId(params.tripId);
  const chat = useTripChat({ tripId });
  const keyboardBottomInset = useChatKeyboardBottomInset();
  const keyboardLayoutStyle = useMemo(
    () => [styles.fill, { paddingBottom: keyboardBottomInset }],
    [keyboardBottomInset],
  );
  const {
    deleteMessage: deleteChatMessage,
    hideMessagesForMe,
    loadOlder: loadOlderMessages,
    retryInitialLoad,
    retryPending,
    sendMessage,
    toggleReaction: toggleChatReaction,
  } = chat;

  const terminalMessage = useMemo(() => {
    if (chat.tripStatus === 'COMPLETED') {
      return 'This completed trip’s chat is read-only.';
    }
    if (chat.tripStatus === 'CANCELLED') {
      return 'This cancelled trip’s chat is read-only.';
    }
    if (chat.roomError?.errorCode === 'TRIP_TERMINAL') {
      return chat.roomError.detail;
    }
    return null;
  }, [chat.roomError, chat.tripStatus]);

  const subscriptionRejected = chat.subscriptionStatus === 'rejected';
  const roomResourceKey =
    chat.aiReconciliationCoordinator?.resourceKey ?? tripId;
  const actionsEnabled = !chat.isReadOnly;
  const readOnlyMessage = subscriptionRejected
    ? 'Realtime is unavailable for this room. Chat actions are disabled.'
    : terminalMessage ?? 'This chat is read-only.';

  const submitMessage = useCallback(
    async (content: string): Promise<ChatComposerSubmitResult> => {
      const outcome = await sendMessage(content);
      if (outcome.kind === 'created' || outcome.kind === 'replayed') {
        return { draftDisposition: 'clear', feedback: null };
      }
      if (outcome.kind === 'failed') {
        return { draftDisposition: 'clear', feedback: null };
      }
      return {
        draftDisposition: 'preserve',
        feedback: composerFailureMessage(content, outcome.error),
      };
    },
    [sendMessage],
  );

  const retryMessage = useCallback(
    (clientMessageId: string) => {
      void retryPending(clientMessageId);
    },
    [retryPending],
  );

  const toggleReaction = useCallback(
    (messageId: string, emoji: AllowedReactionEmoji) => {
      void toggleChatReaction(messageId, emoji);
    },
    [toggleChatReaction],
  );

  const deleteMessage = useCallback(
    (messageId: string, mode: DeleteChatMessageMode) => {
      void deleteChatMessage(messageId, mode);
    },
    [deleteChatMessage],
  );

  const hideMessages = useCallback(
    async (messageIds: readonly string[]): Promise<ChatListMutationResult> => {
      const outcome = await hideMessagesForMe(messageIds);
      return outcome.kind === 'applied'
        ? { applied: true, feedback: null }
        : { applied: false, feedback: failureMessage(outcome.error) };
    },
    [hideMessagesForMe],
  );

  const loadOlder = useCallback(() => {
    void loadOlderMessages();
  }, [loadOlderMessages]);

  const retryInitial = useCallback(() => {
    void retryInitialLoad();
  }, [retryInitialLoad]);

  if (!tripId) {
    return (
      <BlockingState
        message="This trip chat could not be opened."
        testID="chat-invalid-route"
      />
    );
  }

  if (chat.accessStatus === 'checking' || chat.roomStatus === 'loading') {
    return <LoadingScreen />;
  }

  if (chat.accessStatus === 'denied' || chat.roomStatus === 'kicked') {
    return (
      <BlockingState
        message="This chat is no longer available."
        testID="chat-access-denied"
      />
    );
  }

  if (
    chat.accessStatus === 'error' ||
    chat.roomStatus === 'error' ||
    chat.currentUserId === null
  ) {
    return (
      <BlockingState
        message={chat.roomError?.detail ?? 'Chat could not be loaded.'}
        onRetry={retryInitial}
        testID="chat-initial-error"
      />
    );
  }

  const bottomAccessory = (
    <View>
      <ChatComposer
        key={`composer:${roomResourceKey}`}
        disabled={!actionsEnabled}
        hidden={!actionsEnabled}
        onSubmit={submitMessage}
      />
      {!actionsEnabled ? <ReadOnlyFooter message={readOnlyMessage} /> : null}
    </View>
  );
  const genericRoomError =
    !subscriptionRejected &&
    chat.roomError &&
    chat.roomError.errorCode !== 'SUBSCRIPTION_LIMIT_REACHED' &&
    chat.roomError.errorCode !== 'TRIP_TERMINAL'
      ? chat.roomError
      : null;
  const visibleMutationError =
    chat.mutationError &&
    chat.mutationError.error.errorCode !== 'TRIP_TERMINAL' &&
    !(
      actionsEnabled &&
      chat.mutationError.messageId?.startsWith('optimistic:') === true
    )
      ? chat.mutationError
      : null;

  return (
    <SafeAreaView
      edges={CHAT_SAFE_AREA_EDGES}
      style={styles.safe}
      testID="chat-safe-area"
    >
      <View
        style={keyboardLayoutStyle}
        testID="chat-keyboard-layout"
      >
        <ChatConnectionBanner
          status={chat.connectionStatus}
          subscriptionStatus={chat.subscriptionStatus}
        />
        {subscriptionRejected ? (
          <StatusNotice tone="warning" testID="chat-subscription-rejected">
            {chat.roomError?.detail ??
              'Realtime is unavailable for this room. Chat actions are disabled.'}
          </StatusNotice>
        ) : null}
        {terminalMessage ? (
          <StatusNotice testID="chat-terminal-notice">{terminalMessage}</StatusNotice>
        ) : null}
        {genericRoomError ? (
          <StatusNotice tone="error" testID="chat-room-error">
            {genericRoomError.detail}
          </StatusNotice>
        ) : null}
        {chat.isGapFilling || chat.isUpdating ? (
          <StatusNotice testID="chat-catch-up-status">
            Catching up on messages…
          </StatusNotice>
        ) : null}
        {visibleMutationError ? (
          <StatusNotice tone="error" testID="chat-mutation-error">
            {failureMessage(visibleMutationError.error)}
          </StatusNotice>
        ) : null}
        <AIReconciliationCoordinatorProvider
          value={chat.aiReconciliationCoordinator ?? null}
        >
          <ChatMessageList
            key={roomResourceKey}
            messages={chat.messages}
          ambiguousAIDraftIds={chat.ambiguousAIDraftIds ?? EMPTY_DRAFT_ID_SET}
          currentUserId={chat.currentUserId}
          pendingClientIds={chat.pendingClientIds}
          failedClientIds={chat.failedClientIds}
          failedByClientId={chat.failedByClientId}
          pendingReactionMessageIds={chat.pendingReactionMessageIds}
          pendingDeleteMessageIds={chat.pendingDeleteMessageIds}
          hasMoreOlder={chat.hasMoreOlder}
          isLoadingOlder={chat.isLoadingOlder}
          olderLoadError={
            chat.olderLoadError ? failureMessage(chat.olderLoadError) : null
          }
          actionsEnabled={actionsEnabled}
          aiTypingInteractionId={
            chat.aiTypingState.active?.interactionId ?? null
          }
          isHidingMessages={chat.isHidingMessages}
          bottomAccessory={bottomAccessory}
          onLoadOlder={loadOlder}
          onRetry={retryMessage}
          onToggleReaction={toggleReaction}
          onDeleteMessage={deleteMessage}
          onHideMessagesForMe={hideMessages}
            onApplyAIDraftSnapshot={chat.applyAIDraftSnapshot}
          />
        </AIReconciliationCoordinatorProvider>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1 },
  blockingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  blockingTitle: { ...typography.heading, color: colors.text, textAlign: 'center' },
  blockingMessage: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
  retryButton: {
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  retryButtonPressed: { opacity: 0.58 },
  retryButtonText: { ...typography.label, color: colors.primary },
  notice: {
    ...typography.caption,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textMuted,
    backgroundColor: colors.completedSoft,
  },
  warningNotice: { color: colors.warning, backgroundColor: colors.warningSoft },
  errorNotice: { color: colors.danger, backgroundColor: colors.dangerSoft },
  readOnlyFooter: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  readOnlyText: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
});
