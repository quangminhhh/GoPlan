import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "@/features/chat/domain/types";
import { ChatRoom } from "@/features/chat/presentation/chat-room";

const chatMock = vi.hoisted(() => ({
  state: {
    status: "ready" as const,
    errorCode: null as string | null,
    messages: [] as ChatMessage[],
    pendingClientIds: new Set<string>(),
    failedClientIds: new Set<string>(),
    sendLockReason: null as "terminal" | "subscription" | null,
    hasMoreOlder: false,
    isLoadingOlder: false,
    isSending: false,
    isAITyping: false,
    loadOlder: vi.fn(),
    sendMessage: vi.fn(),
    retryPending: vi.fn(),
    toggleReaction: vi.fn(),
    deleteMessage: vi.fn(),
    hideMessagesForMe: vi.fn(),
  },
}));

const wsContextMock = vi.hoisted(() => ({
  status: "connected" as
    | "connected"
    | "connecting"
    | "reconnecting"
    | "disconnected",
}));

vi.mock("@/features/chat/application/use-trip-chat", () => ({
  useTripChat: () => chatMock.state,
}));

vi.mock("@/features/realtime/application/ws-context", () => ({
  useWebSocket: () => ({ status: wsContextMock.status }),
}));

const CURRENT_USER = {
  id: "user-self",
  display_name: "Me",
  identify_tag: null,
  avatar_url: null,
};

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m-1",
    trip_id: "trip-1",
    sender: { ...CURRENT_USER },
    sender_kind: "USER",
    ai_status: null,
    content: "hello",
    client_message_id: null,
    created_at: "2026-05-08T10:00:00Z",
    updated_at: "2026-05-08T10:00:00Z",
    change_sequence: 1,
    is_deleted_for_everyone: false,
    deleted_for_everyone_at: null,
    deleted_for_everyone_by_id: null,
    delete_for_everyone_until: "2026-05-08T10:05:00Z",
    can_delete_for_everyone: true,
    reactions: [],
    action_drafts: [],
    ...overrides,
  };
}

describe("ChatRoom", () => {
  beforeEach(() => {
    wsContextMock.status = "connected";
    chatMock.state.status = "ready";
    chatMock.state.errorCode = null;
    chatMock.state.messages = [];
    chatMock.state.sendLockReason = null;
    chatMock.state.isSending = false;
    chatMock.state.isAITyping = false;
  });

  it("keeps REST sending available while websocket is disconnected", () => {
    wsContextMock.status = "disconnected";

    render(
      <ChatRoom
        tripId="trip-1"
        isTerminal={false}
        currentUser={CURRENT_USER}
      />,
    );

    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
  });

  it("locks composer when the chat hook discovers a terminal trip", () => {
    chatMock.state.sendLockReason = "terminal";

    render(
      <ChatRoom
        tripId="trip-1"
        isTerminal={false}
        currentUser={CURRENT_USER}
      />,
    );

    expect(
      screen.getByText("This trip is closed — sending new messages is disabled."),
    ).toBeDefined();
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("surfaces realtime room errors while keeping the composer available", () => {
    chatMock.state.errorCode = "SERVER_ERROR";

    render(
      <ChatRoom
        tripId="trip-1"
        isTerminal={false}
        currentUser={CURRENT_USER}
      />,
    );

    expect(screen.getByText("Realtime updates are unavailable.")).toBeDefined();
    expect(screen.getByLabelText("Message")).toBeDefined();
  });

  it("surfaces exhausted recovery so reconnect provides a visible retry path", () => {
    chatMock.state.errorCode = "CHANGE_SYNC_FAILED";

    render(
      <ChatRoom
        tripId="trip-1"
        isTerminal={false}
        currentUser={CURRENT_USER}
      />,
    );

    expect(
      screen.getByText(
        "Some chat updates may be missing. Reconnecting will retry recovery.",
      ),
    ).toBeDefined();
  });

  it("surfaces delete-window errors as a visible room warning", () => {
    chatMock.state.errorCode = "MESSAGE_DELETE_WINDOW_EXPIRED";

    render(
      <ChatRoom
        tripId="trip-1"
        isTerminal={false}
        currentUser={CURRENT_USER}
      />,
    );

    expect(
      screen.getByText("This message can no longer be removed for everyone."),
    ).toBeDefined();
  });

  it("shows AI_BUSY warning when GoPlanAI is already replying", () => {
    chatMock.state.errorCode = "AI_BUSY";

    render(
      <ChatRoom
        tripId="trip-1"
        isTerminal={false}
        currentUser={CURRENT_USER}
      />,
    );

    expect(
      screen.getByText(
        "GoPlanAI is still replying. Your prompt is kept; try again shortly.",
      ),
    ).toBeDefined();
    expect(screen.getByLabelText("Message")).toBeDefined();
  });

  it("shows throttling warning while keeping the composer available", () => {
    chatMock.state.errorCode = "THROTTLED";

    render(
      <ChatRoom
        tripId="trip-1"
        isTerminal={false}
        currentUser={CURRENT_USER}
      />,
    );

    expect(
      screen.getByText(
        "You are sending GoPlanAI too quickly. Your prompt is kept; try again shortly.",
      ),
    ).toBeDefined();
    expect(screen.getByLabelText("Message")).toBeDefined();
  });

  it("keeps terminal chat history read-only, including reactions and deletes", () => {
    chatMock.state.messages = [
      makeMessage({
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [] }],
      }),
    ];

    render(
      <ChatRoom tripId="trip-1" isTerminal currentUser={CURRENT_USER} />,
    );

    const textEl = screen.getByText("hello");
    const bubbleEl = textEl.parentElement;
    if (!(bubbleEl instanceof HTMLElement)) {
      throw new Error("Could not find message bubble.");
    }

    fireEvent.mouseEnter(bubbleEl);

    expect(screen.queryByRole("button", { name: "Remove message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add reaction" })).toBeNull();
    const reactionButton = screen.getByRole("button", { name: "👍 1" });
    expect((reactionButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps retained history read-only while realtime subscription is rejected", () => {
    chatMock.state.messages = [makeMessage()];
    chatMock.state.errorCode = "SUBSCRIPTION_LIMIT_REACHED";
    chatMock.state.sendLockReason = "subscription";

    render(
      <ChatRoom
        tripId="trip-1"
        isTerminal={false}
        currentUser={CURRENT_USER}
      />,
    );

    expect(screen.getByText("hello")).toBeDefined();
    expect(
      screen.getByText(
        "Realtime chat is unavailable. Chat is read-only until reconnect.",
      ),
    ).toBeDefined();
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add reaction" })).toBeNull();
  });
});
