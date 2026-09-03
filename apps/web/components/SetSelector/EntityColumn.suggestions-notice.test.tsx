/**
 * NEO-211 — the column's two new surfaces: the suggestions affordance (plan C)
 * and the "no longer listed" notice (plan D).
 *
 * Both live in `idleButtons` / `newPathContent`, which every one of the seven
 * levels reaches — so what this file really pins is that neither can appear
 * where there is nothing to say. A "0 suggestions" pill next to Sync, or a
 * notice that comes back after being dismissed, are both worse than the feature
 * not existing: the set builder is a column of small controls the operator taps
 * through hundreds of times a session, and anything that cries wolf there stops
 * being read at all.
 *
 * Mocking mirrors `EntityColumn.ensure-sync.test.tsx` — `convex/react`'s hooks
 * module-mocked and branched by reference so items, syncStatus and suggestions
 * are controlled independently.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityColumnProps } from "./EntityColumn";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      getSelectorSyncStatus: "getSelectorSyncStatus",
      getSelectorSyncSuggestions: "getSelectorSyncSuggestions",
      addCustomSelectorOption: "addCustomSelectorOption",
      applySelectorSyncSuggestions: "applySelectorSyncSuggestions",
      dismissSelectorSyncNotice: "dismissSelectorSyncNotice",
      ensureSelectorOptions: "ensureSelectorOptions",
    },
  },
}));

const mockEnsure = vi.fn();
const mockApply = vi.fn();
const mockDismiss = vi.fn();
const state: { items: unknown; status: unknown; suggestions: unknown } = {
  items: [],
  status: null,
  suggestions: [],
};

vi.mock("convex/react", () => ({
  useMutation: (ref: string) => {
    if (ref === "applySelectorSyncSuggestions") return mockApply;
    if (ref === "dismissSelectorSyncNotice") return mockDismiss;
    return vi.fn();
  },
  useAction: (ref: string) =>
    ref === "ensureSelectorOptions" ? mockEnsure : vi.fn(),
  useQuery: (ref: string) => {
    if (ref === "getSelectorSyncStatus") return state.status;
    if (ref === "getSelectorSyncSuggestions") return state.suggestions;
    return state.items;
  },
}));

import EntityColumn from "./EntityColumn";

const setProps: EntityColumnProps = {
  selector: <div>selector</div>,
  renderForm: () => <div>legacy-form</div>,
  addButtonText: "Sync Sets",
  isVisible: true,
  level: "setName",
  useEnsureSync: true,
  syncingLabel: "Syncing Sets",
};

async function renderColumn(props: Partial<EntityColumnProps> = {}) {
  const view = render(<EntityColumn {...setProps} {...props} />);
  await act(async () => {});
  return view;
}

const SUGGESTION = {
  existingId: "selopt_1",
  currentValue: "TCG",
  baseVersion: 1000,
  suggestions: [{ side: "bsc", label: "Topps", foldEqual: false }],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.items = [{ _id: "s1", value: "Topps", level: "setName" }];
  state.status = null;
  state.suggestions = [];
  mockEnsure.mockResolvedValue({ scheduled: true });
  mockApply.mockResolvedValue({
    applied: 1,
    declined: 0,
    stale: 0,
    clashed: 0,
    skipped: 0,
  });
  mockDismiss.mockResolvedValue({ dismissed: true });
});

describe("EntityColumn — suggestions affordance (NEO-211 plan C)", () => {
  it("renders nothing while the query is still loading", async () => {
    // No ghost "0 suggestions" flash — the same rule the column already applies
    // to its own loading gate.
    state.suggestions = undefined;
    await renderColumn();
    expect(screen.queryByText(/suggestion/)).toBeNull();
  });

  it("renders nothing when there is nothing to review", async () => {
    state.suggestions = [];
    await renderColumn();
    expect(screen.queryByText(/suggestion/)).toBeNull();
  });

  it("shows the bare count as visible text, keyboard-reachable", async () => {
    // Bare count so Maestro can assertVisible / tapOn "1 suggestion" with no id
    // lookup; a real <button> so it is in the tab order.
    state.suggestions = [SUGGESTION];
    await renderColumn();
    const pill = screen.getByText("1 suggestion");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("aria-label")).toBe(
      "1 naming suggestion from marketplaces — review",
    );
  });

  it("pluralises, and does not disturb the Sync or + Custom buttons", async () => {
    state.suggestions = [SUGGESTION, { ...SUGGESTION, existingId: "selopt_2" }];
    await renderColumn();
    expect(screen.getByText("2 suggestions")).toBeTruthy();
    expect(screen.getByText("Sync Sets")).toBeTruthy();
    expect(screen.getByText("+ Custom")).toBeTruthy();
  });

  it("opens the review dialog and applies the operator's decisions", async () => {
    state.suggestions = [SUGGESTION];
    await renderColumn();
    fireEvent.click(screen.getByText("1 suggestion"));

    fireEvent.click(
      screen.getByLabelText('Rename "TCG" to "Topps" (from BSC)'),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Apply decisions"));
    });

    expect(mockApply).toHaveBeenCalledWith({
      level: "setName",
      parentId: undefined,
      decisions: [
        {
          existingId: "selopt_1",
          baseVersion: 1000,
          side: "bsc",
          action: "accept",
        },
      ],
    });
  });

  it("reports every degraded outcome, not just the successes", async () => {
    // A decision that silently did not take is the one failure mode this whole
    // feature exists to avoid.
    state.suggestions = [SUGGESTION];
    mockApply.mockResolvedValue({
      applied: 0,
      declined: 0,
      stale: 1,
      clashed: 1,
      skipped: 2,
    });
    await renderColumn();
    fireEvent.click(screen.getByText("1 suggestion"));
    fireEvent.click(screen.getByLabelText('Rename "TCG" to "Topps" (from BSC)'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Apply decisions"));
    });

    const outcome = screen.getByText(
      "1 changed just now · 1 clashed with a sibling name · 2 skipped",
    );
    // Non-blocking: the dialog has closed and the rows are still live-queried.
    expect(outcome.getAttribute("role")).toBe("status");
  });
});

describe("EntityColumn — unlink notice (NEO-211 plan D)", () => {
  const doneWithUnlinked = {
    status: "done",
    unlinked: [
      { id: "r1", value: "Topps Heritage", side: "bsc" },
      { id: "r2", value: "Topps Chrome", side: "bsc" },
    ],
  };

  /**
   * The inline notice, located by its own dismiss control. Scoped rather than
   * queried by text because the toast (below) deliberately carries the SAME
   * sentence — a background sync can land while this column is scrolled off
   * screen, so the column box alone would announce to nobody.
   */
  function noticeBox() {
    return screen.getByLabelText("Dismiss notice").closest('[role="status"]')!;
  }

  it("names what stopped being listed, and says the rows are still ours", async () => {
    state.status = doneWithUnlinked;
    await renderColumn();
    expect(noticeBox().textContent).toContain(
      "No longer listed on BSC: 2 sets — Topps Heritage, Topps Chrome",
    );
    // "No longer listed" reads as "deleted" unless we say otherwise.
    expect(noticeBox().textContent).toContain(
      "only the marketplace link was removed",
    );
  });

  it("also announces it in a toast, for a column scrolled out of view", async () => {
    // Fires on the transition INTO "done" — reusing SetAttributesPanel's
    // fixed-position pattern rather than inventing a second toast mechanism.
    state.status = doneWithUnlinked;
    await renderColumn();
    const toast = document.querySelector('[aria-live="polite"]')!;
    expect(toast.textContent).toContain("No longer listed on BSC: 2 sets");
  });

  it("leaves the column usable behind it", async () => {
    state.status = doneWithUnlinked;
    await renderColumn();
    expect(screen.getByText("Sync Sets")).toBeTruthy();
    expect(screen.getByText("+ Custom")).toBeTruthy();
  });

  it("clears the notice on the SERVER, not just in this tab", async () => {
    // A purely local dismiss would leave it waiting on every re-subscribe.
    state.status = doneWithUnlinked;
    await renderColumn();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dismiss notice"));
    });
    expect(mockDismiss).toHaveBeenCalledWith({
      level: "setName",
      parentId: undefined,
    });
    // Optimistically gone locally too, so the box disappears on click rather
    // than on round-trip.
    expect(screen.queryByLabelText("Dismiss notice")).toBeNull();
  });

  it("carries the server's per-platform failure text verbatim", async () => {
    // One side failed while the other stored: the sync is "done", not an error,
    // but the operator would otherwise read the column as complete.
    state.status = {
      status: "done",
      message: "SportLots could not be reached; its links were left alone.",
      unlinked: [],
    };
    await renderColumn();
    expect(
      screen.getByText("SportLots could not be reached; its links were left alone."),
    ).toBeTruthy();
  });

  it("never uses the bare word 'Custom' in the notice", async () => {
    // custom-entry-survives-resync.yaml asserts `text: "Custom"` positioned
    // rightOf a row; a second match in this column is a resolution hazard.
    state.status = doneWithUnlinked;
    await renderColumn();
    expect(noticeBox().textContent).not.toMatch(/\bCustom\b/);
  });

  it("says nothing when a sync unlinked nothing", async () => {
    state.status = { status: "done", unlinked: [] };
    await renderColumn();
    expect(screen.queryByLabelText("Dismiss notice")).toBeNull();
    expect(document.querySelector('[aria-live="polite"]')).toBeNull();
  });
});
