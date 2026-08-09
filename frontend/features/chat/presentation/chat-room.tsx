"use client";

import { Spinner } from "@/shared/ui/spinner";

import { useTripChat } from "@/features/chat/application/use-trip-chat";
import { ConnectionBanner } from "@/features/chat/presentation/connection-banner";
import { MessageList } from "@/features/chat/presentation/message-list";
import { RichComposer } from "@/features/chat/presentation/rich-composer";
import { useWebSocket } from "@/features/realtime/application/ws-context";

type Props = {
  tripId: string;
  isTerminal: boolean;
  captainUserId?: string | null;
  currentUser: {
    id: string;
    display_name: string;
    identify_tag: string | null;
    avatar_url: string | null;
  };
};

function getChatWarning(errorCode: string | null): string | null {
  if (
    errorCode === "GAP_FILL_FAILED" ||
    errorCode === "GAP_FILL_INCOMPLETE" ||
    errorCode === "CHANGE_SYNC_FAILED" ||
    errorCode === "CHANGE_SYNC_INCOMPLETE"
  ) {
    return "Some chat updates may be missing. Reconnecting will retry recovery.";
  }
  if (errorCode === "SERVER_ERROR" || errorCode === "INVALID_PAYLOAD") {
    return "Realtime updates are unavailable.";
  }
  if (errorCode === "MESSAGE_DELETE_WINDOW_EXPIRED") {
    return "This message can no longer be removed for everyone.";
  }
  if (errorCode === "MESSAGE_DELETE_FORBIDDEN") {
    return "You can only remove your own message.";
  }
  if (errorCode === "MESSAGE_DELETED") {
    return "This message has already been removed.";
  }
  if (errorCode === "TRIP_TERMINAL") {
    return "This trip is closed. Chat changes are disabled.";
  }
  if (errorCode === "AI_BUSY") {
    return "GoPlanAI is still replying. Your prompt is kept; try again shortly.";
  }
  if (errorCode === "INVALID_AI_PROMPT") {
    return "What would you like to ask GoPlanAI?";
  }
  if (errorCode === "THROTTLED") {
    return "You are sending GoPlanAI too quickly. Your prompt is kept; try again shortly.";
  }
  if (
    errorCode === "REACTION_DUPLICATE" ||
    errorCode === "REACTION_NOT_FOUND" ||
    errorCode === "INVALID_EMOJI"
  ) {
    return "Could not update reaction. Please try again.";
  }
  if (errorCode === "DELETE_FAILED" || errorCode === "REACTION_FAILED") {
    return "Could not update chat. Please try again.";
  }
  return null;
}

export function ChatRoom({
  tripId,
  isTerminal,
  captainUserId = null,
  currentUser,
}: Props) {
  const { status: wsStatus } = useWebSocket();
  const chat = useTripChat(tripId, currentUser);
  const isChatClosed = isTerminal || chat.sendLockReason !== null;
  const chatWarning =
    chat.sendLockReason === "subscription"
      ? "Realtime chat is unavailable. Chat is read-only until reconnect."
      : getChatWarning(chat.errorCode);

  if (chat.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (chat.status === "error") {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <p className="text-sm text-destructive">
          {chat.errorCode === "TRIP_NOT_FOUND"
            ? "This trip is not available."
            : "Could not load chat. Please try again."}
        </p>
      </div>
    );
  }

  if (chat.status === "kicked") {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <p className="text-sm text-muted-foreground">
          You are no longer a member of this trip. Chat history is no longer
          available.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <ConnectionBanner status={wsStatus} />
      {chatWarning && (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100"
        >
          {chatWarning}
        </div>
      )}
      <MessageList
        tripId={tripId}
        messages={chat.messages}
        currentUserId={currentUser.id}
        captainUserId={captainUserId}
        pendingClientIds={chat.pendingClientIds}
        failedClientIds={chat.failedClientIds}
        hasMoreOlder={chat.hasMoreOlder}
        isLoadingOlder={chat.isLoadingOlder}
        onLoadOlder={chat.loadOlder}
        onRetry={chat.retryPending}
        onToggleReaction={isChatClosed ? undefined : chat.toggleReaction}
        onDeleteMessage={isChatClosed ? undefined : chat.deleteMessage}
        onHideMessagesForMe={isChatClosed ? undefined : chat.hideMessagesForMe}
        isAITyping={chat.isAITyping}
      />
      {isChatClosed ? (
        <div className="border-t border-border bg-muted/40 px-3 py-3 text-center text-xs text-muted-foreground">
          {chat.sendLockReason === "subscription"
            ? "Realtime connection required — chat changes are temporarily disabled."
            : "This trip is closed — sending new messages is disabled."}
        </div>
      ) : (
        <RichComposer
          disabled={false}
          isSending={chat.isSending}
          onSend={(content) => chat.sendMessage(content)}
        />
      )}
    </div>
  );
}
