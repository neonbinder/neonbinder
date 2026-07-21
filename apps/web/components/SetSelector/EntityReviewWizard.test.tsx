/**
 * NEO-92: coverage for `EntityReviewWizard`, the step-through review wizard
 * that replaced the old single-screen `UnknownEntitiesDialog` (deleted this
 * session — no dedicated test file existed for it either, so this is net-new
 * coverage, not a migration of prior tests).
 *
 * This locks in:
 *   1. Reactive presentation: the "current" item is the earliest row (by
 *      array/query order — the component does not sort) whose `status` is
 *      no longer "pending" AND has no `decision` yet. A still-"pending" row
 *      earlier in the array is skipped over, never blocking presentation of
 *      a later row whose lookup already completed.
 *   2. Enrichment rendering: player (HoF badge, career-team list, "no
 *      history" fallback) and team (league/city/years-active/color swatch)
 *      shapes, plus the "No Wikidata match found" fallback for an
 *      error/no-enrichment row.
 *   3. Progress counters: "{decided} of {total} reviewed" and "{N} still
 *      being looked up".
 *   4. "Add as New {Player/Team}" calls recordDecision({action:"create"}).
 *   5. "Link to Existing…" expands the (stubbed) EntityLinkSearch; selecting
 *      a row calls recordDecision({action:"link", linkedPlayerId/
 *      linkedTeamId}) with the right kind-specific field populated.
 *   6. The final "All reviewed — save N cards?" step appears ONLY once every
 *      row has a decision, and its Confirm button calls the onConfirm prop.
 *   7. Cancel calls cancelBatch then the onCancel prop — from ANY point in
 *      the flow, not just before any decisions are made.
 *   8. isOpen=false (or the query still loading) renders nothing.
 *
 * --- Mocking strategy (mirrors CardDetailPanel.test.tsx / SetAttributesPanel
 * .test.tsx) ---
 * convex/react's useQuery/useMutation are module-mocked, routed by the
 * (string-mocked) query/mutation reference. `./EntityLinkSearch` is mocked to
 * a trivial stub — it already has its own dedicated test file
 * (EntityLinkSearch.test.tsx) covering its typeahead/filtering behavior, so
 * this file only needs to verify the wizard wires its onSelect callback
 * correctly into recordDecision, not re-exercise the search UI itself (same
 * "stub a sibling picker with its own coverage" pattern documented for
 * CardDetailPanel's TeamPicker/PlayerPicker).
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    entityReviewQueue: {
      getBatch: "entityReviewQueue.getBatch",
      recordDecision: "entityReviewQueue.recordDecision",
      cancelBatch: "entityReviewQueue.cancelBatch",
    },
  },
}));

let currentRows: unknown;
const mockRecordDecision = vi.fn();
const mockCancelBatch = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "entityReviewQueue.getBatch" && args !== "skip") return currentRows;
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "entityReviewQueue.recordDecision") return mockRecordDecision;
    if (ref === "entityReviewQueue.cancelBatch") return mockCancelBatch;
    return vi.fn();
  },
}));

let lastLinkSearchProps: { kind: string; sport: string } | null = null;
vi.mock("./EntityLinkSearch", () => ({
  default: ({
    kind,
    sport,
    onSelect,
  }: {
    kind: "player" | "team";
    sport: string;
    onSelect: (id: string) => void;
  }) => {
    lastLinkSearchProps = { kind, sport };
    return (
      <div aria-label="Entity link search (stub)">
        <button onClick={() => onSelect("linked-id-123")}>Stub link select</button>
      </div>
    );
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import EntityReviewWizard from "./EntityReviewWizard";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type Row = {
  _id: Id<"entityReviewQueue">;
  _creationTime: number;
  selectorOptionId: Id<"selectorOptions">;
  batchId: string;
  kind: "player" | "team";
  name: string;
  sport: string;
  status: "pending" | "ready" | "error";
  enrichment?: Record<string, unknown>;
  decision?: { action: "create" } | { action: "link"; linkedPlayerId?: string; linkedTeamId?: string };
};

let nextRowId = 0;
function makeRow(overrides: Partial<Row> = {}): Row {
  nextRowId += 1;
  return {
    _id: `row-${nextRowId}` as unknown as Id<"entityReviewQueue">,
    _creationTime: nextRowId,
    selectorOptionId: "selopt-1" as unknown as Id<"selectorOptions">,
    batchId: "batch-1",
    kind: "player",
    name: "Mike Trout",
    sport: "Baseball",
    status: "ready",
    ...overrides,
  };
}

function renderWizard(props: Partial<Parameters<typeof EntityReviewWizard>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      cardCount={3}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { ...utils, onConfirm, onCancel };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordDecision.mockResolvedValue(null);
  mockCancelBatch.mockResolvedValue(null);
  currentRows = [];
  lastLinkSearchProps = null;
  nextRowId = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Rendering gate
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — rendering gate", () => {
  it("renders nothing when isOpen is false", () => {
    currentRows = [makeRow()];
    renderWizard({ isOpen: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing while getBatch is still loading (rows undefined)", () => {
    currentRows = undefined;
    renderWizard();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Presentation order — completion order, not insertion order blocking
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — current-item selection", () => {
  it("shows 'Looking up N more names' while every row is still pending", () => {
    currentRows = [makeRow({ status: "pending" }), makeRow({ status: "pending" })];
    renderWizard();

    expect(screen.getByText(/Looking up 2 more names/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("0 of 2 reviewed");
    expect(screen.getByRole("status").textContent).toContain("2 still being looked up");
  });

  it("skips a still-pending row and presents the next non-pending, undecided row instead", () => {
    currentRows = [
      makeRow({ name: "Still Pending Player", status: "pending" }),
      makeRow({ name: "Ready Player", status: "ready" }),
    ];
    renderWizard();

    expect(screen.getByText("Ready Player")).toBeTruthy();
    expect(screen.queryByText("Still Pending Player")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enrichment rendering
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — enrichment content", () => {
  it("shows a Hall of Fame badge and career-team history for a ready player row", () => {
    currentRows = [
      makeRow({
        kind: "player",
        name: "Mike Trout",
        status: "ready",
        enrichment: {
          isHallOfFame: true,
          careerTeams: [{ name: "Los Angeles Angels", fromYear: 2011 }],
        },
      }),
    ];
    renderWizard();

    expect(screen.getByText("Hall of Fame")).toBeTruthy();
    expect(screen.getByText(/Los Angeles Angels/)).toBeTruthy();
    expect(screen.getByText(/2011.*present/)).toBeTruthy();
  });

  it("shows 'No career-team history found' for a player with an empty careerTeams list", () => {
    currentRows = [
      makeRow({ kind: "player", status: "ready", enrichment: { careerTeams: [] } }),
    ];
    renderWizard();

    expect(screen.getByText("No career-team history found.")).toBeTruthy();
  });

  it("shows league/city/years-active for a ready team row", () => {
    currentRows = [
      makeRow({
        kind: "team",
        name: "Los Angeles Angels",
        status: "ready",
        enrichment: { league: "Major League Baseball", city: "Anaheim", yearsActive: { from: 1961 } },
      }),
    ];
    renderWizard();

    expect(screen.getByText(/League: Major League Baseball/)).toBeTruthy();
    expect(screen.getByText(/City: Anaheim/)).toBeTruthy();
    expect(screen.getByText(/Active: 1961.*present/)).toBeTruthy();
  });

  it("shows 'No Wikidata match found' for an error-status row", () => {
    currentRows = [makeRow({ status: "error" })];
    renderWizard();

    expect(screen.getByText("No Wikidata match found.")).toBeTruthy();
  });

  it("shows 'No Wikidata match found' for a ready row with no enrichment payload at all", () => {
    currentRows = [makeRow({ status: "ready", enrichment: undefined })];
    renderWizard();

    expect(screen.getByText("No Wikidata match found.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Progress counters
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — progress counters", () => {
  it("counts decided rows and still-pending rows independently of the current item", () => {
    currentRows = [
      makeRow({ status: "ready", decision: { action: "create" } }), // decided
      makeRow({ status: "pending" }), // still looking up
      makeRow({ status: "ready" }), // undecided, ready -> this is "current"
    ];
    renderWizard();

    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("1 of 3 reviewed");
    expect(status).toContain("1 still being looked up");
  });

  it("omits the 'still being looked up' clause once nothing is pending", () => {
    currentRows = [makeRow({ status: "ready" })];
    renderWizard();

    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("0 of 1 reviewed");
    expect(status).not.toContain("still being looked up");
  });
});

// ---------------------------------------------------------------------------
// Add as New / Link to Existing
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — decision actions", () => {
  it("'Add as New Player' calls recordDecision({action:'create'}) for the current row", async () => {
    const row = makeRow({ kind: "player", status: "ready" });
    currentRows = [row];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "create",
      });
    });
  });

  it("'Add as New Team' reads correctly for a team-kind row", () => {
    currentRows = [makeRow({ kind: "team", status: "ready" })];
    renderWizard();

    expect(screen.getByRole("button", { name: "Add as New Team" })).toBeTruthy();
  });

  it("'Link to Existing…' expands EntityLinkSearch scoped to the row's kind/sport", () => {
    currentRows = [makeRow({ kind: "player", sport: "Football", status: "ready" })];
    renderWizard();

    fireEvent.click(screen.getByLabelText("Link to existing instead"));

    expect(screen.getByLabelText("Entity link search (stub)")).toBeTruthy();
    expect(lastLinkSearchProps).toEqual({ kind: "player", sport: "Football" });
  });

  it("selecting a player from EntityLinkSearch calls recordDecision with linkedPlayerId set (linkedTeamId undefined)", async () => {
    const row = makeRow({ kind: "player", status: "ready" });
    currentRows = [row];
    renderWizard();

    fireEvent.click(screen.getByLabelText("Link to existing instead"));
    fireEvent.click(screen.getByText("Stub link select"));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "link",
        linkedPlayerId: "linked-id-123",
        linkedTeamId: undefined,
      });
    });
  });

  it("selecting a team from EntityLinkSearch calls recordDecision with linkedTeamId set (linkedPlayerId undefined)", async () => {
    const row = makeRow({ kind: "team", status: "ready" });
    currentRows = [row];
    renderWizard();

    fireEvent.click(screen.getByLabelText("Link to existing instead"));
    fireEvent.click(screen.getByText("Stub link select"));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "link",
        linkedPlayerId: undefined,
        linkedTeamId: "linked-id-123",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Final "all decided" step
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — final confirm step", () => {
  it("does NOT show the final step while any row is still undecided", () => {
    currentRows = [
      makeRow({ decision: { action: "create" } }),
      makeRow({ status: "ready" }), // undecided
    ];
    renderWizard();

    expect(screen.queryByText(/All reviewed/)).toBeNull();
  });

  it("shows 'All reviewed — save N cards?' once every row has a decision, pluralized correctly", () => {
    currentRows = [
      makeRow({ decision: { action: "create" } }),
      makeRow({ decision: { action: "link", linkedPlayerId: "p1" } }),
    ];
    renderWizard({ cardCount: 5 });

    expect(screen.getByText("All reviewed — save 5 cards?")).toBeTruthy();
  });

  it("uses singular 'card' when cardCount is 1", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    renderWizard({ cardCount: 1 });

    expect(screen.getByText("All reviewed — save 1 card?")).toBeTruthy();
  });

  it("clicking Confirm & Save calls the onConfirm prop", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { onConfirm } = renderWizard();

    fireEvent.click(screen.getByRole("button", { name: /Confirm & Save/ }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables Confirm & Save and shows 'Saving...' while saving is true", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    renderWizard({ saving: true });

    const button = screen.getByRole("button", { name: /Saving/ });
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cancel — from any point in the flow
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — cancel", () => {
  it("Cancel before any decisions calls cancelBatch then onCancel", async () => {
    currentRows = [makeRow({ status: "pending" })];
    const { onCancel } = renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));

    await waitFor(() => {
      expect(mockCancelBatch).toHaveBeenCalledWith({
        selectorOptionId: "selopt-1",
        batchId: "batch-1",
      });
    });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("Cancel mid-review (some rows already decided) still calls cancelBatch then onCancel", async () => {
    currentRows = [
      makeRow({ decision: { action: "create" } }),
      makeRow({ status: "ready" }),
    ];
    const { onCancel } = renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));

    await waitFor(() => expect(mockCancelBatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("Cancel on the final all-decided step still calls cancelBatch then onCancel", async () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { onCancel } = renderWizard();

    expect(screen.getByText(/All reviewed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));

    await waitFor(() => expect(mockCancelBatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("still closes the wizard (calls onCancel) even when cancelBatch rejects", async () => {
    // Robustness: onCancel() lives in handleCancel's finally block, so a
    // transient cancelBatch rejection (network/auth) must NOT strand the dialog
    // permanently open — the finally is the only thing that guarantees the
    // wizard clears its pending-preview state.
    //
    // The component's caller invokes `void handleCancel()`, so the rejection
    // propagates out unawaited (an unhandled rejection — pre-existing behavior,
    // identical before and after this fix). Swallow that one expected rejection
    // locally so it doesn't surface as a false-positive test error.
    const expectedRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      expectedRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      mockCancelBatch.mockRejectedValueOnce(new Error("network down"));
      currentRows = [makeRow({ status: "ready" })];
      const { onCancel } = renderWizard();

      fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));

      await waitFor(() => expect(mockCancelBatch).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
      // Give the microtask that re-throws out of `void handleCancel()` a tick to
      // land on our listener before we detach it.
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(expectedRejections).toHaveLength(1);
    expect((expectedRejections[0] as Error).message).toBe("network down");
  });

  it("pressing Escape also cancels", async () => {
    currentRows = [makeRow({ status: "ready" })];
    const { onCancel } = renderWizard();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(mockCancelBatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });
});
