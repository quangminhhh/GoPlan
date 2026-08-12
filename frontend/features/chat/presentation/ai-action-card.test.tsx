import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AIActionDraft } from "@/features/chat/domain/ai-action-drafts";
import {
  cancelAIActionDraft,
  confirmAIActionDraft,
  patchAIActionDraft,
} from "@/features/chat/infrastructure/ai-action-drafts-api";
import { AIActionCard } from "@/features/chat/presentation/ai-action-card";

vi.mock("@/features/chat/infrastructure/ai-action-drafts-api", () => ({
  cancelAIActionDraft: vi.fn(),
  confirmAIActionDraft: vi.fn(),
  patchAIActionDraft: vi.fn(),
}));

vi.mock("@/features/trips/presentation/trip-context", () => ({
  useTripContext: () => ({
    tripId: "trip-1",
    data: { trip: { timezone: "UTC", currency_code: "VND" } },
    loading: false,
    error: null,
    notFound: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function makeDraft(overrides: Partial<AIActionDraft> = {}): AIActionDraft {
  return {
    id: "draft-1",
    action_type: "expense.create",
    status: "READY",
    required_confirmation: "CAPTAIN",
    can_confirm: true,
    can_cancel: true,
    can_edit: false,
    preview: { title: "Dinner", amount: "1,200,000 VND" },
    display: {
      icon: "expense",
      kicker: "Expense",
      title: "Dinner",
      tone: "create",
      hero: { kind: "amount", value: "1,200,000", currency: "VND" },
    },
    summary: "[READY] expense.create: Dinner",
    missing_fields: [],
    result: {},
    error_code: "",
    error_detail: "",
    expires_at: "2026-06-01T00:00:00Z",
    created_at: "2026-05-13T00:00:00Z",
    updated_at: "2026-05-13T00:00:00Z",
    ...overrides,
  };
}

describe("AIActionCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows confirm and cancel actions for authorized ready drafts", () => {
    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft()}
        onDraftChanged={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Ready" })).toBeInTheDocument();
  });

  it("hides action buttons for unauthorized ready drafts", () => {
    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft({ can_confirm: false, can_cancel: false })}
        onDraftChanged={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("calls confirm handler and reports changed draft", async () => {
    vi.mocked(confirmAIActionDraft).mockResolvedValueOnce({
      draft: makeDraft({
        status: "CONFIRMED",
        can_confirm: false,
        can_cancel: false,
      }),
    });
    const onDraftChanged = vi.fn();
    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft()}
        onDraftChanged={onDraftChanged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(
      await screen.findByRole("img", { name: "Confirmed" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(onDraftChanged).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CONFIRMED" }),
    );
  });

  it("applies draft returned by confirm error responses", async () => {
    const expiredDraft = makeDraft({
      status: "EXPIRED",
      can_confirm: false,
      can_cancel: false,
    });
    vi.mocked(confirmAIActionDraft).mockRejectedValueOnce({
      response: {
        data: {
          detail: "Draft expired.",
          draft: expiredDraft,
        },
      },
    });
    const onDraftChanged = vi.fn();
    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft()}
        onDraftChanged={onDraftChanged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(
      await screen.findByRole("img", { name: "Expired" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Draft expired.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(onDraftChanged).toHaveBeenCalledWith(expiredDraft);
  });

  it("edits missing fields for needs-info drafts", async () => {
    vi.mocked(patchAIActionDraft).mockResolvedValueOnce({
      draft: makeDraft({
        status: "READY",
        missing_fields: [],
        preview: { title: "Lunch", total_amount: "500000" },
        display: {
          icon: "expense",
          kicker: "Expense",
          title: "Lunch",
          tone: "create",
          hero: { kind: "amount", value: "500,000", currency: "VND" },
        },
      }),
    });
    const onDraftChanged = vi.fn();
    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft({
          status: "NEEDS_INFO",
          can_confirm: false,
          can_cancel: true,
          can_edit: true,
          missing_fields: [{ name: "total_amount", label: "Amount" }],
          preview: { title: "Lunch" },
          display: {
            icon: "expense",
            kicker: "Expense",
            title: "Lunch",
            tone: "create",
          },
        })}
        onDraftChanged={onDraftChanged}
      />,
    );

    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "500000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save info" }));

    expect(patchAIActionDraft).toHaveBeenCalledWith("trip-1", "draft-1", {
      total_amount: "500000",
    });
    expect(
      await screen.findByRole("img", { name: "Ready" }),
    ).toBeInTheDocument();
  });

  it("allows cancelling needs-info drafts without filling fields first", async () => {
    vi.mocked(cancelAIActionDraft).mockResolvedValueOnce({
      draft: makeDraft({
        status: "CANCELLED",
        can_confirm: false,
        can_cancel: false,
        can_edit: false,
        missing_fields: [{ name: "total_amount", label: "Amount" }],
      }),
    });
    const onDraftChanged = vi.fn();

    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft({
          status: "NEEDS_INFO",
          can_confirm: false,
          can_cancel: true,
          can_edit: true,
          missing_fields: [{ name: "total_amount", label: "Amount" }],
          preview: { title: "Lunch" },
          display: {
            icon: "expense",
            kicker: "Expense",
            title: "Lunch",
            tone: "create",
          },
        })}
        onDraftChanged={onDraftChanged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(cancelAIActionDraft).toHaveBeenCalledWith("trip-1", "draft-1");
    expect(
      await screen.findByRole("img", { name: "Cancelled" }),
    ).toBeInTheDocument();
    expect(onDraftChanged).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED" }),
    );
  });

  it("edits synthetic time range fields without losing entered values", async () => {
    vi.mocked(patchAIActionDraft).mockResolvedValueOnce({
      draft: makeDraft({
        action_type: "timeline.activity.create",
        status: "READY",
        can_confirm: true,
        can_cancel: true,
        can_edit: false,
        missing_fields: [],
        preview: {
          title: "Dinh I",
          start_time: "08:30",
          end_time: "10:00",
        },
        display: {
          icon: "activity",
          kicker: "Activity · Sightseeing",
          title: "Dinh I",
          tone: "create",
          chips: [{ icon: "clock", label: "08:30 – 10:00" }],
        },
      }),
    });
    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft({
          action_type: "timeline.activity.create",
          status: "NEEDS_INFO",
          can_confirm: false,
          can_cancel: true,
          can_edit: true,
          preview: { title: "Dinh I" },
          display: {
            icon: "activity",
            kicker: "Activity · Sightseeing",
            title: "Dinh I",
            tone: "create",
          },
          missing_fields: [
            {
              name: "time_range",
              label: "Time",
              type: "time_range",
              constraints: {
                section_index: 1,
                section_date: "2026-04-20",
                pair: ["start_time", "end_time"],
              },
              presets: [
                { label: "Morning", start: "08:30", end: "10:00" },
              ],
            },
          ],
        })}
        onDraftChanged={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Start"), {
      target: { value: "08:30" },
    });
    fireEvent.change(screen.getByLabelText("End"), {
      target: { value: "10:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save info" }));

    expect(patchAIActionDraft).toHaveBeenCalledWith("trip-1", "draft-1", {
      start_time: "08:30",
      end_time: "10:00",
    });
    expect(await screen.findByRole("img", { name: "Ready" })).toBeInTheDocument();
  });

  it("parses JSON missing fields before patching drafts", async () => {
    vi.mocked(patchAIActionDraft).mockResolvedValueOnce({
      draft: makeDraft({ status: "READY", missing_fields: [] }),
    });
    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft({
          action_type: "timeline.activity.update",
          status: "NEEDS_INFO",
          can_confirm: false,
          can_cancel: true,
          can_edit: true,
          missing_fields: [
            { name: "data", label: "Activity details", type: "json" },
          ],
        })}
        onDraftChanged={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Activity details"), {
      target: { value: '{"title":"Museum"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save info" }));

    await waitFor(() => {
      expect(patchAIActionDraft).toHaveBeenCalledWith("trip-1", "draft-1", {
        data: { title: "Museum" },
      });
    });
  });

  it("renders data wrapper field errors inline and retries after editing", async () => {
    const validationMessage = "end_time must be after start_time";
    const editableDraft = makeDraft({
      action_type: "timeline.activity.update",
      status: "NEEDS_INFO",
      can_confirm: false,
      can_cancel: true,
      can_edit: true,
      missing_fields: [
        { name: "data", label: "Activity details", type: "json" },
      ],
    });
    vi.mocked(patchAIActionDraft)
      .mockRejectedValueOnce({
        response: {
          status: 400,
          data: {
            detail: "Field validation failed.",
            error_code: "FIELD_VALIDATION_FAILED",
            field_errors: { data: validationMessage },
            draft: editableDraft,
          },
        },
      })
      .mockResolvedValueOnce({
        draft: makeDraft({
          action_type: "timeline.activity.update",
          status: "READY",
          missing_fields: [],
        }),
      });
    render(
      <AIActionCard
        tripId="trip-1"
        draft={editableDraft}
        onDraftChanged={vi.fn()}
      />,
    );

    const details = screen.getByLabelText("Activity details");
    fireEvent.change(details, {
      target: { value: '{"start_time":"10:00","end_time":"08:00"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save info" }));

    expect(await screen.findByText(validationMessage)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save info" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(patchAIActionDraft).toHaveBeenCalledTimes(1);

    fireEvent.change(details, {
      target: { value: '{"start_time":"08:00","end_time":"10:00"}' },
    });
    expect(screen.queryByText(validationMessage)).toBeNull();
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(patchAIActionDraft).toHaveBeenNthCalledWith(
        2,
        "trip-1",
        "draft-1",
        { data: { start_time: "08:00", end_time: "10:00" } },
      );
    });
  });

  it("renders direct time-range field errors inline and retries after editing", async () => {
    const validationMessage = "Start time conflicts with an existing activity.";
    const editableDraft = makeDraft({
      action_type: "timeline.activity.create",
      status: "NEEDS_INFO",
      can_confirm: false,
      can_cancel: true,
      can_edit: true,
      missing_fields: [
        {
          name: "time_range",
          label: "Time",
          type: "time_range",
          constraints: {
            section_index: 1,
            section_date: "2026-04-20",
            pair: ["start_time", "end_time"],
          },
        },
      ],
    });
    vi.mocked(patchAIActionDraft)
      .mockRejectedValueOnce({
        response: {
          status: 400,
          data: {
            detail: "Field validation failed.",
            error_code: "FIELD_VALIDATION_FAILED",
            field_errors: { start_time: validationMessage },
            draft: editableDraft,
          },
        },
      })
      .mockResolvedValueOnce({
        draft: makeDraft({
          action_type: "timeline.activity.create",
          status: "READY",
          missing_fields: [],
        }),
      });
    render(
      <AIActionCard
        tripId="trip-1"
        draft={editableDraft}
        onDraftChanged={vi.fn()}
      />,
    );

    const start = screen.getByLabelText("Start");
    fireEvent.change(start, { target: { value: "08:30" } });
    fireEvent.change(screen.getByLabelText("End"), {
      target: { value: "10:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save info" }));

    expect(await screen.findByText(validationMessage)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save info" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(patchAIActionDraft).toHaveBeenCalledTimes(1);

    fireEvent.change(start, { target: { value: "08:45" } });
    expect(screen.queryByText(validationMessage)).toBeNull();
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(patchAIActionDraft).toHaveBeenNthCalledWith(
        2,
        "trip-1",
        "draft-1",
        { start_time: "08:45", end_time: "10:00" },
      );
    });
  });

  it("does not resubmit fields that are no longer missing after a partial save", async () => {
    vi.mocked(patchAIActionDraft)
      .mockResolvedValueOnce({
        draft: makeDraft({
          status: "NEEDS_INFO",
          can_confirm: false,
          can_cancel: true,
          can_edit: true,
          missing_fields: [{ name: "total_amount", label: "Amount" }],
          preview: { title: "Lunch" },
          display: {
            icon: "expense",
            kicker: "Expense",
            title: "Lunch",
            tone: "create",
          },
        }),
      })
      .mockResolvedValueOnce({
        draft: makeDraft({
          status: "READY",
          missing_fields: [],
          preview: { title: "Lunch", total_amount: "500000" },
          display: {
            icon: "expense",
            kicker: "Expense",
            title: "Lunch",
            tone: "create",
            hero: { kind: "amount", value: "500,000", currency: "VND" },
          },
        }),
      });

    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft({
          status: "NEEDS_INFO",
          can_confirm: false,
          can_cancel: true,
          can_edit: true,
          missing_fields: [
            { name: "title", label: "Title" },
            { name: "total_amount", label: "Amount" },
          ],
          preview: {},
          display: {
            icon: "expense",
            kicker: "Expense",
            title: "Expense",
            tone: "create",
          },
        })}
        onDraftChanged={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Lunch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save info" }));

    await screen.findByLabelText("Amount");
    expect(patchAIActionDraft).toHaveBeenNthCalledWith(
      1,
      "trip-1",
      "draft-1",
      { title: "Lunch" },
    );

    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "500000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save info" }));

    await waitFor(() => {
      expect(patchAIActionDraft).toHaveBeenNthCalledWith(
        2,
        "trip-1",
        "draft-1",
        { total_amount: "500000" },
      );
    });
  });

  it("renders timeline activity details from preview when display is sparse", () => {
    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft({
          action_type: "timeline.activity.create",
          can_confirm: false,
          can_cancel: false,
          preview: {
            title: "Dinh I",
            system_type: "SIGHTSEEING",
            time_mode: "TIME_RANGE",
            start_time: "08:30:00",
            end_time: "10:00:00",
            location_label: "Dinh I Palace",
            location_note: "Enter through the main gate",
            assignee_scope: "EVERYONE",
            note: "Keep the visit relaxed.",
            meeting_point: "Hotel lobby",
          },
          display: {
            icon: "activity",
            kicker: "Activity · Activity",
            title: "",
            tone: "create",
            chips: [{ icon: "users", label: "Whole group" }],
          },
        })}
        onDraftChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Dinh I")).toBeInTheDocument();
    expect(screen.queryByText("Activity · Sightseeing")).toBeNull();
    expect(screen.getByText("Whole group")).toBeInTheDocument();
    expect(screen.getByText("08:30 – 10:00")).toBeInTheDocument();
    expect(screen.getByText("Dinh I Palace")).toBeInTheDocument();
    expect(screen.getByText("Hotel lobby")).toBeInTheDocument();
    expect(screen.getByText("Keep the visit relaxed.")).toBeInTheDocument();
    expect(screen.getByText("Enter through the main gate")).toBeInTheDocument();
  });

  it("renders timeline activity from preview when display text fields are missing", () => {
    render(
      <AIActionCard
        tripId="trip-1"
        draft={makeDraft({
          action_type: "timeline.activity.create",
          can_confirm: false,
          can_cancel: false,
          preview: {
            title: "Dinh I",
            system_type: "SIGHTSEEING",
          },
          display: {} as AIActionDraft["display"],
        })}
        onDraftChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Dinh I")).toBeInTheDocument();
    expect(screen.queryByText("Activity · Sightseeing")).toBeNull();
  });
});
