import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "@/features/chat/domain/types";
import { MessageList } from "@/features/chat/presentation/message-list";

const CURRENT_USER_ID = "user-self";

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m-1",
    trip_id: "trip-1",
    sender: {
      id: CURRENT_USER_ID,
      display_name: "Me",
      identify_tag: null,
      avatar_url: null,
    },
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

function getInteractionForMessage(content: string): HTMLElement {
  const bubbleEl = getBubbleForMessage(content);
  const interactionEl = bubbleEl.parentElement;
  if (!(interactionEl instanceof HTMLElement)) {
    throw new Error(`Could not find interaction wrapper for "${content}".`);
  }
  return interactionEl;
}

function getBubbleForMessage(content: string): HTMLElement {
  const textEl = screen.getByText((_, element) => {
    return element?.tagName.toLowerCase() === "p" && element.textContent === content;
  });
  const bubbleEl = textEl.parentElement;
  if (!(bubbleEl instanceof HTMLElement)) {
    throw new Error(`Could not find bubble for "${content}".`);
  }
  return bubbleEl;
}

function queryReactionTriggerForMessage(
  content: string,
): HTMLButtonElement | null {
  return getInteractionForMessage(content).querySelector<HTMLButtonElement>(
    'button[aria-label="Add reaction"]',
  );
}

function getReactionTriggerForMessage(content: string): HTMLButtonElement {
  const button = queryReactionTriggerForMessage(content);
  if (button === null) {
    throw new Error(`Could not find reaction trigger for "${content}".`);
  }
  return button;
}

function queryRemoveButtonForMessage(content: string): HTMLButtonElement | null {
  return getInteractionForMessage(content).querySelector<HTMLButtonElement>(
    'button[aria-label="Remove message"]',
  );
}

function getMessageListForMessage(content: string): HTMLElement {
  const rowEl = getInteractionForMessage(content).closest(
    '[data-testid="chat-message"]',
  );
  const listEl = rowEl?.parentElement;
  if (!(listEl instanceof HTMLElement)) {
    throw new Error(`Could not find message list for "${content}".`);
  }
  return listEl;
}

describe("MessageList", () => {
  it("offers a manual older-message load when older pages exist", () => {
    const onLoadOlder = vi.fn();

    render(
      <MessageList
        messages={[makeMessage()]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder
        isLoadingOlder={false}
        onLoadOlder={onLoadOlder}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("opens remove dialog with both modes when the backend allows everyone-delete", () => {
    const onDeleteMessage = vi.fn();

    render(
      <MessageList
        messages={[
          makeMessage({
            created_at: "2000-01-01T00:00:00Z",
            can_delete_for_everyone: true,
          }),
        ]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onDeleteMessage={onDeleteMessage}
      />,
    );

    fireEvent.mouseEnter(getBubbleForMessage("hello"));
    fireEvent.click(screen.getByRole("button", { name: "Remove message" }));
    fireEvent.click(screen.getByLabelText(/Thu hồi với mọi người/));
    fireEvent.click(screen.getByRole("button", { name: "Gỡ" }));

    expect(onDeleteMessage).toHaveBeenCalledWith("m-1", "for_everyone");
  });

  it("hides everyone-delete when the backend says the window is closed", () => {
    render(
      <MessageList
        messages={[makeMessage({ can_delete_for_everyone: false })]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(getBubbleForMessage("hello"));
    fireEvent.click(screen.getByRole("button", { name: "Remove message" }));

    expect(screen.queryByLabelText(/Thu hồi với mọi người/)).toBeNull();
  });

  it("uses neutral tombstone copy for globally deleted messages", () => {
    render(
      <MessageList
        messages={[
          makeMessage({
            content: "",
            sender: {
              id: "user-other",
              display_name: "Other",
              identify_tag: null,
              avatar_url: null,
            },
            is_deleted_for_everyone: true,
            deleted_for_everyone_at: "2026-05-08T10:01:00Z",
            deleted_for_everyone_by_id: "user-other",
            delete_for_everyone_until: null,
            can_delete_for_everyone: false,
          }),
        ]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Tin nhắn đã được xóa")).not.toBeNull();
    expect(screen.queryByText("Bạn đã xóa một tin nhắn")).toBeNull();
  });

  it("highlights the trip captain sender name in red", () => {
    render(
      <MessageList
        messages={[
          makeMessage({
            sender: {
              id: "user-captain",
              display_name: "Captain",
              identify_tag: null,
              avatar_url: null,
            },
          }),
        ]}
        currentUserId={CURRENT_USER_ID}
        captainUserId="user-captain"
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Captain").classList.contains("text-destructive"))
      .toBe(true);
  });

  it("bulk selection only offers remove for current user", () => {
    const onHideMessagesForMe = vi.fn();

    render(
      <MessageList
        messages={[
          makeMessage({ id: "m-1", content: "one" }),
          makeMessage({ id: "m-2", content: "two" }),
        ]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onHideMessagesForMe={onHideMessagesForMe}
      />,
    );

    fireEvent.mouseEnter(getBubbleForMessage("one"));
    fireEvent.click(screen.getByRole("button", { name: "Select message" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Select message" })[1]);

    expect(screen.getByText("2 selected")).not.toBeNull();
    expect(screen.queryByText("Thu hồi với mọi người")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Thu hồi với bạn" }));

    expect(onHideMessagesForMe).toHaveBeenCalledWith(["m-1", "m-2"]);
  });

  it("keeps hover controls active for only the latest hovered message", () => {
    render(
      <MessageList
        messages={[
          makeMessage({ id: "m-1", content: "one" }),
          makeMessage({ id: "m-2", content: "two" }),
        ]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onToggleReaction={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(getBubbleForMessage("one"));
    expect(queryReactionTriggerForMessage("one")).not.toBeNull();
    expect(queryReactionTriggerForMessage("two")).toBeNull();

    fireEvent.mouseEnter(getBubbleForMessage("two"));

    expect(queryReactionTriggerForMessage("one")).toBeNull();
    expect(queryReactionTriggerForMessage("two")).not.toBeNull();
  });

  it("hides hover controls when the pointer leaves the active message", () => {
    render(
      <MessageList
        messages={[makeMessage({ id: "m-1", content: "one" })]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onToggleReaction={vi.fn()}
      />,
    );

    const interactionEl = getInteractionForMessage("one");

    fireEvent.mouseEnter(getBubbleForMessage("one"));
    expect(queryReactionTriggerForMessage("one")).not.toBeNull();

    fireEvent.mouseLeave(interactionEl);

    expect(queryReactionTriggerForMessage("one")).toBeNull();
  });

  it("closes an open reaction picker when another message becomes active", () => {
    render(
      <MessageList
        messages={[
          makeMessage({ id: "m-1", content: "one" }),
          makeMessage({ id: "m-2", content: "two" }),
        ]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onToggleReaction={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(getBubbleForMessage("one"));
    fireEvent.click(getReactionTriggerForMessage("one"));
    expect(screen.getByRole("dialog", { name: "Pick a reaction" })).not.toBeNull();

    fireEvent.mouseEnter(getBubbleForMessage("two"));

    expect(screen.queryByRole("dialog", { name: "Pick a reaction" })).toBeNull();
  });

  it("mounts hover controls only for the active message", () => {
    render(
      <MessageList
        messages={[
          makeMessage({ id: "m-1", content: "one" }),
          makeMessage({ id: "m-2", content: "two" }),
        ]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onToggleReaction={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    );

    expect(queryReactionTriggerForMessage("one")).toBeNull();
    expect(queryRemoveButtonForMessage("one")).toBeNull();
    expect(queryReactionTriggerForMessage("two")).toBeNull();
    expect(queryRemoveButtonForMessage("two")).toBeNull();

    fireEvent.mouseEnter(getBubbleForMessage("one"));

    expect(queryReactionTriggerForMessage("one")).not.toBeNull();
    expect(queryRemoveButtonForMessage("one")).not.toBeNull();
    expect(queryReactionTriggerForMessage("two")).toBeNull();
    expect(queryRemoveButtonForMessage("two")).toBeNull();
  });

  it("does not reveal hover controls when the pointer enters the non-bubble hover shell", () => {
    render(
      <MessageList
        messages={[makeMessage({ id: "m-1", content: "one" })]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onToggleReaction={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(getInteractionForMessage("one"));

    expect(queryReactionTriggerForMessage("one")).toBeNull();
    expect(queryRemoveButtonForMessage("one")).toBeNull();
  });

  it("clears the active message when the pointer crosses another message hidden action shell", () => {
    render(
      <MessageList
        messages={[
          makeMessage({ id: "m-1", content: "one" }),
          makeMessage({ id: "m-2", content: "two" }),
        ]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onToggleReaction={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(getBubbleForMessage("one"));
    expect(queryReactionTriggerForMessage("one")).not.toBeNull();
    expect(queryRemoveButtonForMessage("one")).not.toBeNull();

    fireEvent.mouseMove(getInteractionForMessage("two"));

    expect(queryReactionTriggerForMessage("one")).toBeNull();
    expect(queryRemoveButtonForMessage("one")).toBeNull();
    expect(queryReactionTriggerForMessage("two")).toBeNull();
    expect(queryRemoveButtonForMessage("two")).toBeNull();
  });

  it("clears hover controls when the pointer moves over blank chat space", () => {
    render(
      <MessageList
        messages={[makeMessage({ id: "m-1", content: "one" })]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onToggleReaction={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(getBubbleForMessage("one"));
    expect(queryReactionTriggerForMessage("one")).not.toBeNull();

    fireEvent.mouseMove(getMessageListForMessage("one"));

    expect(queryReactionTriggerForMessage("one")).toBeNull();
  });

  it("renders GoPlanAI mention as a token in user prompt messages", () => {
    render(
      <MessageList
        messages={[makeMessage({ content: "@GoPlanAI plan day 1" })]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("@GoPlanAI").className).toContain(
      "text-primary-foreground",
    );
    expect(screen.getByText(/plan day 1/)).toBeDefined();
  });

  it("renders AI messages as GoPlanAI sender and hides everyone-delete", () => {
    render(
      <MessageList
        messages={[
          makeMessage({
            id: "ai-1",
            sender_kind: "AI",
            ai_status: "SUCCESS",
            sender: {
              id: null,
              display_name: "GoPlanAI",
              identify_tag: null,
              avatar_url: null,
            },
            content: "AI reply",
            can_delete_for_everyone: false,
          }),
        ]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    );

    expect(screen.getByText("GoPlanAI")).toBeDefined();
    fireEvent.mouseEnter(screen.getByText("AI reply").parentElement as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Remove message" }));
    expect(screen.queryByLabelText(/Thu hồi với mọi người/)).toBeNull();
  });

  it("renders the GoPlanAI typing indicator when AI is replying", () => {
    render(
      <MessageList
        messages={[]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        isAITyping
      />,
    );

    expect(screen.getByText("GoPlanAI đang trả lời…")).toBeInTheDocument();
  });

  it("centers hover controls beside multiline message bubbles", () => {
    const ownContent = "one\ntwo\nthree";
    const otherContent = "alpha\nbeta\ngamma";

    render(
      <MessageList
        messages={[
          makeMessage({ id: "m-1", content: ownContent }),
          makeMessage({
            id: "m-2",
            sender: {
              id: "user-other",
              display_name: "Other",
              identify_tag: null,
              avatar_url: null,
            },
            content: otherContent,
          }),
        ]}
        currentUserId={CURRENT_USER_ID}
        pendingClientIds={new Set()}
        failedClientIds={new Set()}
        hasMoreOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onToggleReaction={vi.fn()}
      />,
    );

    expect(getInteractionForMessage(ownContent).classList.contains("items-center"))
      .toBe(true);
    expect(getInteractionForMessage(otherContent).classList.contains("items-center"))
      .toBe(true);
  });
});
