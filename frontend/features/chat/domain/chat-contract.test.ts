import { describe, expect, it } from "vitest";

import {
  parseChatMessage,
  parseReactionSummaries,
} from "@/features/chat/domain/chat-contract";

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

describe("chat runtime contract", () => {
  it("sorts valid reaction summaries into the canonical server allowlist order", () => {
    expect(
      parseReactionSummaries([
        { emoji: "👍", count: 1, reacted_by_ids: ["user-2"] },
        { emoji: "❤️", count: 1, reacted_by_ids: ["user-1"] },
      ]),
    ).toEqual([
      { emoji: "❤️", count: 1, reacted_by_ids: ["user-1"] },
      { emoji: "👍", count: 1, reacted_by_ids: ["user-2"] },
    ]);
  });

  it.each([
    [
      "an emoji outside the server allowlist",
      [{ emoji: "🦄", count: 1, reacted_by_ids: ["user-1"] }],
    ],
    [
      "duplicate emoji summaries",
      [
        { emoji: "👍", count: 1, reacted_by_ids: ["user-1"] },
        { emoji: "👍", count: 1, reacted_by_ids: ["user-2"] },
      ],
    ],
    [
      "duplicate reacting user IDs",
      [{ emoji: "👍", count: 2, reacted_by_ids: ["user-1", "user-1"] }],
    ],
    [
      "a count that differs from the reacting user IDs",
      [{ emoji: "👍", count: 2, reacted_by_ids: ["user-1"] }],
    ],
    [
      "an empty reacting user ID",
      [{ emoji: "👍", count: 1, reacted_by_ids: [""] }],
    ],
  ])("rejects %s", (_label, reactions) => {
    expect(() => parseReactionSummaries(reactions)).toThrow(
      "Invalid chat contract",
    );
  });

  it.each([
    [
      "sender ID",
      validMessage({
        sender: {
          id: "",
          display_name: "User",
          identify_tag: null,
          avatar_url: null,
        },
      }),
    ],
    ["client message ID", validMessage({ client_message_id: "" })],
    [
      "global-delete actor ID",
      validMessage({ deleted_for_everyone_by_id: "" }),
    ],
  ])("rejects an empty nullable %s", (_label, message) => {
    expect(() => parseChatMessage(message, TRIP_ID)).toThrow(
      "Invalid chat contract",
    );
  });
});
