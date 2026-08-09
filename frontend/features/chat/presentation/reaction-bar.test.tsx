import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReactionBar } from "@/features/chat/presentation/reaction-bar";

describe("ReactionBar", () => {
  it("renders server summaries in the canonical reaction order", () => {
    render(
      <ReactionBar
        currentUserId={null}
        reactions={[
          { emoji: "👎", count: 1, reacted_by_ids: ["user-3"] },
          { emoji: "👍", count: 1, reacted_by_ids: ["user-2"] },
          { emoji: "❤️", count: 1, reacted_by_ids: ["user-1"] },
        ]}
      />,
    );

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "❤️1",
      "👍1",
      "👎1",
    ]);
  });
});
