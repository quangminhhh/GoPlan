import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  bffAddReaction,
  bffDeleteChatMessage,
  bffGapFillChatMessages,
  bffHideChatMessagesForMe,
  bffListChatHistory,
  bffSendChatMessage,
  bffSyncChangedChatMessages,
} from "@/features/chat/infrastructure/chat-api";
import { bff } from "@/shared/http/bff-client";

vi.mock("@/shared/http/bff-client", () => ({
  bff: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

const TRIP_ID = "a0b1c2d3-e4f5-4678-9abc-def012345678";

function validMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    trip_id: TRIP_ID,
    sender: {
      id: "user-1",
      display_name: "User",
      identify_tag: null,
      avatar_url: null,
    },
    sender_kind: "USER",
    ai_status: null,
    content: "hello",
    client_message_id: null,
    created_at: "2026-08-10T12:00:00Z",
    updated_at: "2026-08-10T12:00:00Z",
    change_sequence: 1,
    is_deleted_for_everyone: false,
    deleted_for_everyone_at: null,
    deleted_for_everyone_by_id: null,
    delete_for_everyone_until: null,
    can_delete_for_everyone: false,
    reactions: [],
    action_drafts: [],
    ...overrides,
  };
}

describe("chat BFF API", () => {
  beforeEach(() => {
    vi.mocked(bff.get).mockReset();
    vi.mocked(bff.post).mockReset();
    vi.mocked(bff.delete).mockReset();
  });

  it("uses canonical UUID paths and sequence-only change cursors", async () => {
    vi.mocked(bff.get).mockResolvedValueOnce({
      data: { results: [], has_more: false },
    });

    await bffSyncChangedChatMessages(TRIP_ID.toUpperCase(), {
      changed_since: 42,
      changed_since_id: "message-42",
      limit: 100,
    });

    expect(bff.get).toHaveBeenCalledWith(
      `/api/trips/${TRIP_ID}/chat/messages`,
      {
        params: {
          changed_since: 42,
          changed_since_id: "message-42",
          limit: 100,
        },
      },
    );
  });

  it("returns the full server-authored reaction mutation envelope", async () => {
    const envelope = {
      reactions: [{ emoji: "👍", count: 1, reacted_by_ids: ["user-1"] }],
      change_sequence: 43,
      updated_at: "2026-08-10T12:00:00Z",
    };
    vi.mocked(bff.post).mockResolvedValueOnce({ data: envelope });

    await expect(
      bffAddReaction(TRIP_ID, "message-1", "👍"),
    ).resolves.toEqual(envelope);
  });

  it("fails closed before issuing HTTP for malformed trip IDs", async () => {
    await expect(bffListChatHistory("not-a-uuid")).rejects.toThrow(
      "Invalid chat trip UUID.",
    );
    expect(bff.get).not.toHaveBeenCalled();
  });

  it("rejects malformed history, gap, and change-sync envelopes", async () => {
    vi.mocked(bff.get)
      .mockResolvedValueOnce({ data: { results: [null], next_cursor: null } })
      .mockResolvedValueOnce({ data: { results: [validMessage()], has_more: "no" } })
      .mockResolvedValueOnce({
        data: {
          results: [validMessage({ change_sequence: -1 })],
          has_more: false,
        },
      });

    await expect(bffListChatHistory(TRIP_ID)).rejects.toThrow(
      "Invalid chat contract",
    );
    await expect(
      bffGapFillChatMessages(TRIP_ID, { since: "message-0" }),
    ).rejects.toThrow("Invalid chat contract");
    await expect(
      bffSyncChangedChatMessages(TRIP_ID, { changed_since: 0 }),
    ).rejects.toThrow("Invalid chat contract");
  });

  it("rejects malformed send, delete, hide, and reaction mutation envelopes", async () => {
    vi.mocked(bff.post)
      .mockResolvedValueOnce({ data: { message: null }, status: 201 })
      .mockResolvedValueOnce({ data: { hidden_message_ids: [42] } })
      .mockResolvedValueOnce({ data: { reactions: [] } });
    vi.mocked(bff.delete).mockResolvedValueOnce({ data: { message: {} } });

    await expect(
      bffSendChatMessage(TRIP_ID, {
        content: "hello",
        client_message_id: "client-1",
      }),
    ).rejects.toThrow("Invalid chat contract");
    await expect(
      bffHideChatMessagesForMe(TRIP_ID, ["message-1"]),
    ).rejects.toThrow("Invalid chat contract");
    await expect(
      bffAddReaction(TRIP_ID, "message-1", "👍"),
    ).rejects.toThrow("Invalid chat contract");
    await expect(
      bffDeleteChatMessage(TRIP_ID, "message-1", "for_everyone"),
    ).rejects.toThrow("Invalid chat contract");
  });

  it("rejects a valid send body returned with a non-contract status", async () => {
    vi.mocked(bff.post).mockResolvedValueOnce({
      data: { message: validMessage() },
      status: 202,
    });

    await expect(
      bffSendChatMessage(TRIP_ID, {
        content: "hello",
        client_message_id: "client-1",
      }),
    ).rejects.toThrow("Invalid chat contract");
  });

  it.each([
    [
      "for_everyone with a non-tombstone message",
      "for_everyone" as const,
      { message: validMessage() },
    ],
    [
      "for_everyone with hidden IDs",
      "for_everyone" as const,
      { hidden_message_ids: ["message-1"] },
    ],
    [
      "for_me with a tombstone message",
      "for_me" as const,
      {
        message: validMessage({
          content: "",
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-08-10T12:01:00Z",
        }),
      },
    ],
    [
      "either mode with both discriminants",
      "for_everyone" as const,
      {
        message: validMessage({
          content: "",
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-08-10T12:01:00Z",
        }),
        hidden_message_ids: ["message-1"],
      },
    ],
    ["either mode with neither discriminant", "for_me" as const, {}],
  ])("rejects delete response %s", async (_label, mode, data) => {
    vi.mocked(bff.delete).mockResolvedValueOnce({ data });
    await expect(
      bffDeleteChatMessage(TRIP_ID, "message-1", mode),
    ).rejects.toThrow("Invalid chat contract");
  });

  it.each([
    [
      "for_everyone tombstone",
      "for_everyone" as const,
      {
        message: validMessage({
          content: "",
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-08-10T12:01:00Z",
        }),
      },
    ],
    [
      "for_me hidden IDs",
      "for_me" as const,
      { hidden_message_ids: ["message-1"] },
    ],
  ])("accepts the exact %s delete response", async (_label, mode, data) => {
    vi.mocked(bff.delete).mockResolvedValueOnce({ data });
    await expect(
      bffDeleteChatMessage(TRIP_ID, "message-1", mode),
    ).resolves.toEqual({ mode, ...data });
  });

  it("preserves opaque action draft fields while validating the message envelope", async () => {
    const opaqueDraft = {
      id: "draft-1",
      future_nested_payload: { untouched: [1, { future: true }] },
    };
    vi.mocked(bff.get).mockResolvedValueOnce({
      data: {
        results: [validMessage({ action_drafts: [opaqueDraft] })],
        next_cursor: null,
      },
    });

    const result = await bffListChatHistory(TRIP_ID);
    expect(result.results[0].action_drafts).toEqual([opaqueDraft]);
  });
});
