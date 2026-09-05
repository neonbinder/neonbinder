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
 *      history" fallback) and team (league/location/years-active/color swatch)
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
 * NEO-212 adds, in the blocks at the bottom of this file:
 *   9. The third decision — "Skip — not a person/team" per row, and
 *      "Skip Remaining (N)" in the footer beside the bulk create.
 *  10. Near matches and the action hierarchy. THE LABEL "Add as New
 *      {Player|Team}" IS AN E2E CONTRACT and is asserted present in the two
 *      states any Maestro flow can reach (no match, close-only). In the
 *      exact-match state the primary becomes "Link to {name}" and creation
 *      demotes to a text link whose visible text and accessible name are the
 *      same string, "Add as New {Player|Team} anyway" — no aria-label override
 *      (WCAG 2.2 SC 2.5.3). That state needs an exact near match, which no
 *      flow produces. The primary is ONE element across both states so focus
 *      survives the async swap.
 *  11. Wikidata career teams as unchecked-able proposals, and the
 *      `excludedCareerTeamNames` they produce.
 *  12. The "Will create N new teams · M already exist" summary.
 *  13. Row-header copy control, Wikidata/Wikipedia links, description line.
 *  14. Readability classes, and the enlarged NEO-110 height reservation.
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
      recordAllRemainingAsCreate: "entityReviewQueue.recordAllRemainingAsCreate",
      recordAllRemainingAsSkip: "entityReviewQueue.recordAllRemainingAsSkip",
    },
    players: { nearMatches: "players.nearMatches", search: "players.search" },
    // `teams.search` is CareerTeamEntry's typeahead (rendered for player rows);
    // `getManyByIds` resolves linked teams for the staging list; `resolveNames`
    // backs the "will create N new teams" summary. Each returns undefined from
    // the mock unless a test sets it.
    teams: {
      nearMatches: "teams.nearMatches",
      search: "teams.search",
      getManyByIds: "teams.getManyByIds",
      resolveNames: "teams.resolveNames",
    },
  },
}));

let currentRows: unknown;
/** Near matches served to whichever of players/teams.nearMatches is active. */
let currentNearMatches: unknown;
/** Rows served to teams.resolveNames (the summary line). */
let currentResolvedNames: unknown;
/** Rows served to teams.getManyByIds (linked-team canonical names). */
let currentLinkedTeams: unknown;
/** Every (ref, args) pair useQuery saw, so arg-shaping can be asserted. */
let queryCalls: Array<{ ref: string; args: unknown }>;

const mockRecordDecision = vi.fn();
const mockCancelBatch = vi.fn();
const mockRecordAllRemainingAsCreate = vi.fn();
const mockRecordAllRemainingAsSkip = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    queryCalls.push({ ref, args });
    if (args === "skip") return undefined;
    if (ref === "entityReviewQueue.getBatch") return currentRows;
    if (ref === "players.nearMatches" || ref === "teams.nearMatches")
      return currentNearMatches;
    if (ref === "teams.resolveNames") return currentResolvedNames;
    if (ref === "teams.getManyByIds") return currentLinkedTeams;
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "entityReviewQueue.recordDecision") return mockRecordDecision;
    if (ref === "entityReviewQueue.cancelBatch") return mockCancelBatch;
    if (ref === "entityReviewQueue.recordAllRemainingAsCreate")
      return mockRecordAllRemainingAsCreate;
    if (ref === "entityReviewQueue.recordAllRemainingAsSkip")
      return mockRecordAllRemainingAsSkip;
    return vi.fn();
  },
}));

let lastLinkSearchProps: { kind: string; sportId: string } | null = null;
vi.mock("./EntityLinkSearch", () => ({
  default: ({
    kind,
    sportId,
    onSelect,
  }: {
    kind: "player" | "team";
    sportId: string;
    onSelect: (id: string) => void;
  }) => {
    lastLinkSearchProps = { kind, sportId };
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
  sportId: Id<"selectorOptions">;
  sportValue: string;
  status: "pending" | "ready" | "error";
  enrichment?: Record<string, unknown>;
  decision?:
    | { action: "create"; excludedCareerTeamNames?: string[] }
    | { action: "link"; linkedPlayerId?: string; linkedTeamId?: string }
    | { action: "skip" };
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
    sportId: "selopt-sport-1" as unknown as Id<"selectorOptions">,
    sportValue: "Baseball",
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

/**
 * The wizard's progress line, addressed by content rather than by role.
 *
 * `screen.getByRole("status")` used to be unambiguous here. NEO-212 added a
 * `CopyButton` to the row header, and that primitive keeps an always-mounted
 * `role="status"` live region (empty until a copy happens) — deliberately, so
 * VoiceOver announces the result reliably. So the role now matches more than
 * one node and the progress line has to be picked out of them.
 */
function progressText(): string {
  const texts = screen.getAllByRole("status").map((el) => el.textContent ?? "");
  return texts.find((t) => t.includes("reviewed")) ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordDecision.mockResolvedValue(null);
  mockCancelBatch.mockResolvedValue(null);
  mockRecordAllRemainingAsCreate.mockResolvedValue(0);
  mockRecordAllRemainingAsSkip.mockResolvedValue(0);
  currentRows = [];
  currentNearMatches = [];
  currentResolvedNames = undefined;
  currentLinkedTeams = undefined;
  queryCalls = [];
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
    expect(progressText()).toContain("0 of 2 reviewed");
    expect(progressText()).toContain("2 still being looked up");
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

  it("shows league/location/years-active for a ready team row", () => {
    currentRows = [
      makeRow({
        kind: "team",
        name: "Los Angeles Angels",
        status: "ready",
        enrichment: { league: "Major League Baseball", location: "Anaheim", yearsActive: { from: 1961 } },
      }),
    ];
    renderWizard();

    expect(screen.getByText(/League: Major League Baseball/)).toBeTruthy();
    expect(screen.getByText(/Location: Anaheim/)).toBeTruthy();
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

    const status = progressText();
    expect(status).toContain("1 of 3 reviewed");
    expect(status).toContain("1 still being looked up");
  });

  it("omits the 'still being looked up' clause once nothing is pending", () => {
    currentRows = [makeRow({ status: "ready" })];
    renderWizard();

    const status = progressText();
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
    currentRows = [makeRow({
      kind: "player",
      sportId: "selopt-sport-2" as unknown as Id<"selectorOptions">,
      sportValue: "Football",
      status: "ready",
    })];
    renderWizard();

    fireEvent.click(screen.getByLabelText("Link to existing instead"));

    expect(screen.getByLabelText("Entity link search (stub)")).toBeTruthy();
    // NEO-96: the wizard hands the search a sport ROW ID, not a label.
    expect(lastLinkSearchProps).toEqual({
      kind: "player",
      sportId: "selopt-sport-2",
    });
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
// Manual career-team entry (player rows only)
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — manual career-team entry", () => {
  it("shows the manual career-team control for a player row", () => {
    currentRows = [makeRow({ kind: "player", status: "ready", enrichment: { careerTeams: [] } })];
    renderWizard();

    expect(screen.getByLabelText("Career team name")).toBeTruthy();
    expect(screen.getByLabelText("From year")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add career team" })).toBeTruthy();
  });

  it("does NOT show the manual career-team control for a team row", () => {
    currentRows = [makeRow({ kind: "team", status: "ready", enrichment: { league: "MLB" } })];
    renderWizard();

    expect(screen.queryByLabelText("Career team name")).toBeNull();
  });

  it("is available even when the player has no Wikidata match (the Daulton Varsho case)", () => {
    currentRows = [makeRow({ kind: "player", status: "error", enrichment: undefined })];
    renderWizard();

    expect(screen.getByText("No Wikidata match found.")).toBeTruthy();
    // Manual entry is not gated to the enrichment-present branch.
    expect(screen.getByLabelText("Career team name")).toBeTruthy();
  });

  it("stages an entry as a removable chip, then removes it", () => {
    currentRows = [makeRow({ kind: "player", status: "ready", enrichment: { careerTeams: [] } })];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Toronto Blue Jays" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2023" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    // Chip appears, and the mini-form cleared.
    expect(screen.getByText(/Toronto Blue Jays \(2023–present\)/)).toBeTruthy();
    expect((screen.getByLabelText("Career team name") as HTMLInputElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Remove Toronto Blue Jays" }));
    expect(screen.queryByText(/Toronto Blue Jays/)).toBeNull();
  });

  it("does not add an entry when the year is out of bounds (Add stays disabled)", () => {
    currentRows = [makeRow({ kind: "player", status: "ready", enrichment: { careerTeams: [] } })];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Ancient Club" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "1200" } });

    const addButton = screen.getByRole("button", { name: "Add career team" }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    fireEvent.click(addButton);
    expect(screen.queryByText(/Ancient Club/)).toBeNull();
  });

  it("'Add as New Player' passes staged manualCareerTeams to recordDecision", async () => {
    const row = makeRow({ kind: "player", status: "ready", enrichment: { careerTeams: [] } });
    currentRows = [row];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Arizona Diamondbacks" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2020" } });
    fireEvent.change(screen.getByLabelText("To year (optional)"), { target: { value: "2022" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "create",
        manualCareerTeams: [
          { name: "Arizona Diamondbacks", fromYear: 2020, toYear: 2022 },
        ],
        // NEO-236: the chip's Location + Name travels alongside the stint, so
        // commit can CREATE the team when it matches nothing. `sourceName` is
        // the composed name commit looks the entry up by.
        createTeams: [
          { sourceName: "Arizona Diamondbacks", name: "Arizona Diamondbacks" },
        ],
      });
    });
  });

  it("'Add as New Player' with no staged entries passes manualCareerTeams: undefined", async () => {
    const row = makeRow({ kind: "player", status: "ready", enrichment: { careerTeams: [] } });
    currentRows = [row];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "create",
        manualCareerTeams: undefined,
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

// ---------------------------------------------------------------------------
// Bulk "Add All Remaining as New" + NEO-110 footer stability
//
// The bulk action had NO coverage at either layer (this file or
// convex/entityReviewQueue.test.ts) before NEO-110, which is why a real defect
// around it reached CI and cost a full investigation to root-cause.
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — bulk 'Add All Remaining as New'", () => {
  it("labels the button with the undecided count and calls the bulk mutation", async () => {
    currentRows = [
      makeRow({ status: "ready", name: "A" }),
      makeRow({ status: "pending", name: "B" }),
      makeRow({ status: "pending", name: "C" }),
    ];
    renderWizard();

    const bulk = screen.getByRole("button", { name: "Add all remaining as new (3)" });
    expect(bulk.textContent).toContain("Add All Remaining as New (3)");

    fireEvent.click(bulk);

    await waitFor(() =>
      expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledWith({
        selectorOptionId: "selopt-1",
        batchId: "batch-1",
      }),
    );
  });

  it("counts only undecided rows, ignoring ones already decided", () => {
    currentRows = [
      makeRow({ status: "ready", decision: { action: "create" } }),
      makeRow({ status: "ready" }),
      makeRow({ status: "pending" }),
    ];
    renderWizard();

    expect(
      screen.getByRole("button", { name: "Add all remaining as new (2)" }),
    ).toBeTruthy();
  });

  it("is not rendered once every row is decided (the final step owns the footer)", () => {
    currentRows = [
      makeRow({ status: "ready", decision: { action: "create" } }),
      makeRow({ status: "ready", decision: { action: "create" } }),
    ];
    renderWizard();

    expect(screen.queryByText(/Add All Remaining as New/)).toBeNull();
    expect(screen.getByText(/All reviewed/)).toBeTruthy();
  });

  it("surfaces a rejected bulk decide instead of swallowing it (NEO-110)", async () => {
    // Before the fix `handleBulkCreate` had no catch and the call site is
    // `void handleBulkCreate()`, so a failure became a silent unhandled
    // rejection — indistinguishable to the user from a partial decide.
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "ready" })];
    mockRecordAllRemainingAsCreate.mockRejectedValueOnce(new Error("not an admin"));
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add all remaining as new (2)" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not an admin");
  });

  it("re-enables the button after a failure so the user can retry", async () => {
    currentRows = [makeRow({ status: "ready" })];
    mockRecordAllRemainingAsCreate.mockRejectedValueOnce(new Error("boom"));
    renderWizard();

    const bulk = screen.getByRole("button", {
      name: "Add all remaining as new (1)",
    }) as HTMLButtonElement;
    fireEvent.click(bulk);

    await screen.findByRole("alert");
    expect(bulk.disabled).toBe(false);
  });
});

describe("EntityReviewWizard — NEO-110 footer stability", () => {
  // WHY A CLASS ASSERTION: jsdom performs no layout, so the footer's real pixel
  // position cannot be measured here. The defect was purely geometric — the
  // body swapped between a ~20px "Looking up…" line and a ~240px item block,
  // and because the overlay centres the dialog the footer moved ~108px, so a
  // click aimed at the bulk link struck the green "Add as New Player" button
  // that had just rendered into those coordinates (CI run 30505189226; the tap
  // point (394,388) is #00D558 in the failure screenshot).
  //
  // A reserved MINIMUM body height (`min-h-80`, then `min-h-[22rem]`) was the
  // first fix. It only BOUNDED the movement to (max-h − min-h)/2, and the bound
  // came due: CI run 33817648830 (the seed job) lost the same bulk click to an
  // 11px shift, because the Ohtani row's Wikidata description, career-team
  // checkboxes and "Will create 3 new teams…" line landed in the 332ms between
  // Maestro reading the link at [194,521][386,537] and clicking its centre
  // (290,529) — by which time the link was at [194,532][386,548] and the click
  // hit footer padding. The link is `text-xs`, 16px tall; 13px was never a safe
  // margin.
  //
  // SO THE CONTRACT THESE PIN IS NOW STRUCTURAL, not a magic number: the dialog
  // has a DEFINITE height and the body is the flex child that absorbs all of the
  // change (`flex-1 min-h-0 overflow-y-auto`). Given those two facts the footer's
  // y is invariant no matter what the body does, so there is no residual shift
  // left to size. Re-adding `min-h-*`/`max-h-*` to the body — the shape that
  // failed twice — fails the last test here, which is the point: nothing else in
  // the suite would notice.
  const DIALOG_HEIGHT_CLASS = "h-[min(40rem,100%)]";

  /** The three-child panel: [header, body, footer]. Structure IS the contract. */
  function panelRegions(): {
    panel: HTMLElement;
    header: HTMLElement;
    body: HTMLElement;
    footer: HTMLElement;
  } {
    const overlay = document.querySelector('[role="dialog"]');
    if (!overlay) throw new Error("wizard overlay not found");
    const panel = overlay.firstElementChild as HTMLElement | null;
    if (!panel) throw new Error("wizard panel not found");
    const [header, body, footer] = Array.from(panel.children) as HTMLElement[];
    if (!header || !body || !footer) {
      throw new Error(
        `wizard panel must be header/body/footer; got ${panel.children.length} children`,
      );
    }
    return { panel, header, body, footer };
  }

  it("gives the dialog a definite height while every row is still pending", () => {
    currentRows = [makeRow({ status: "pending" }), makeRow({ status: "pending" })];
    renderWizard();

    expect(screen.getByText(/Looking up 2 more names/)).toBeTruthy();
    const { panel } = panelRegions();
    expect(panel.className).toContain(DIALOG_HEIGHT_CLASS);
    expect(panel.className).toContain("flex-col");
  });

  it("keeps the same definite dialog height once an item block renders", () => {
    // The exact state transition that used to move the footer.
    currentRows = [makeRow({ status: "ready", name: "Resolved Player" })];
    renderWizard();

    expect(screen.getByText("Resolved Player")).toBeTruthy();
    expect(panelRegions().panel.className).toContain(DIALOG_HEIGHT_CLASS);
  });

  it("keeps it on the final all-decided step too", () => {
    currentRows = [makeRow({ status: "ready", decision: { action: "create" } })];
    renderWizard();

    expect(screen.getByText(/All reviewed/)).toBeTruthy();
    expect(panelRegions().panel.className).toContain(DIALOG_HEIGHT_CLASS);
  });

  it("makes the body the only region that flexes, so the footer cannot move", () => {
    currentRows = [makeRow({ status: "ready" })];
    renderWizard();

    const { header, body, footer } = panelRegions();

    // The body absorbs every height change and scrolls past the dialog height.
    expect(body.className).toContain("flex-1");
    expect(body.className).toContain("min-h-0");
    expect(body.className).toContain("overflow-y-auto");

    // …and must NOT reintroduce its own elastic height band. A `min-h-*` floor
    // with a `max-h-*` ceiling on this div is exactly the shape that shipped
    // both incidents. (`min-h-0` is the opposite of a floor — it is what lets a
    // flex child shrink below its content and scroll — so it is allowed.)
    const heightClasses = body.className
      .split(/\s+/)
      .filter((c) => /^(min|max)-h-/.test(c) && c !== "min-h-0");
    expect(heightClasses).toEqual([]);

    // Header and footer are fixed bookends — neither may be squeezed by the body.
    expect(header.className).toContain("shrink-0");
    expect(footer.className).toContain("shrink-0");
  });

  it("keeps the bulk buttons inside the footer, not the scrolling body", () => {
    // If the bulk link ever migrated into the body it would move with the
    // content again, whatever the dialog height says.
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "ready" })];
    renderWizard();

    const { body, footer } = panelRegions();
    const bulk = screen.getByRole("button", { name: /Add all remaining as new/i });

    expect(footer.contains(bulk)).toBe(true);
    expect(body.contains(bulk)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — "Skip — not a person / not a team"
//
// The third decision. Before it existed, a checklist string that was not a
// person at all ("Checklist", "Team Card", a subset header that landed in the
// player column) could only be got past by minting a junk player row or by
// cancelling the entire batch.
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — skip decision", () => {
  it("offers 'Skip — not a person' on a player row and records action:'skip'", async () => {
    const row = makeRow({ kind: "player", name: "Checklist", status: "ready" });
    currentRows = [row];
    renderWizard();

    const skip = screen.getByRole("button", {
      name: "Skip Checklist — not a person",
    });
    expect(skip.textContent).toBe("Skip — not a person");

    fireEvent.click(skip);

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "skip",
      });
    });
  });

  it("says 'not a team' on a team row", () => {
    currentRows = [makeRow({ kind: "team", name: "Team Card", status: "ready" })];
    renderWizard();

    const skip = screen.getByRole("button", {
      name: "Skip Team Card — not a team",
    });
    expect(skip.textContent).toBe("Skip — not a team");
  });

  it("carries NO career-team or link payload — skip means nothing is written", async () => {
    // The server ignores leftovers, but sending them at all would make the
    // stored decision a misleading audit record.
    const row = makeRow({
      kind: "player",
      name: "Checklist",
      status: "ready",
      enrichment: { careerTeams: [{ name: "Los Angeles Angels", fromYear: 2011 }] },
    });
    currentRows = [row];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Some Club" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2020" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Skip Checklist — not a person" }),
    );

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "skip",
      });
    });
  });

  it("sits alongside 'Link to Existing…' rather than replacing it", () => {
    currentRows = [makeRow({ kind: "player", name: "Checklist", status: "ready" })];
    renderWizard();

    expect(screen.getByLabelText("Link to existing instead")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Skip Checklist — not a person" }),
    ).toBeTruthy();
  });
});

describe("EntityReviewWizard — bulk 'Skip Remaining'", () => {
  it("labels the button with the undecided count and calls the bulk mutation", async () => {
    currentRows = [
      makeRow({ status: "ready", name: "A" }),
      makeRow({ status: "pending", name: "B" }),
      makeRow({ status: "pending", name: "C" }),
    ];
    renderWizard();

    const bulk = screen.getByRole("button", { name: "Skip remaining (3)" });
    expect(bulk.textContent).toContain("Skip Remaining (3)");

    fireEvent.click(bulk);

    await waitFor(() =>
      expect(mockRecordAllRemainingAsSkip).toHaveBeenCalledWith({
        selectorOptionId: "selopt-1",
        batchId: "batch-1",
      }),
    );
    expect(mockRecordAllRemainingAsCreate).not.toHaveBeenCalled();
  });

  it("sits beside 'Add All Remaining as New' with the same count", () => {
    currentRows = [
      makeRow({ status: "ready", decision: { action: "create" } }),
      makeRow({ status: "ready" }),
      makeRow({ status: "pending" }),
    ];
    renderWizard();

    expect(screen.getByRole("button", { name: "Add all remaining as new (2)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip remaining (2)" })).toBeTruthy();
  });

  it("is not rendered once every row is decided", () => {
    currentRows = [makeRow({ status: "ready", decision: { action: "skip" } })];
    renderWizard();

    expect(screen.queryByText(/Skip Remaining/)).toBeNull();
    expect(screen.getByText(/All reviewed/)).toBeTruthy();
  });

  it("surfaces a rejected bulk skip through the same alert as the bulk create (NEO-110)", async () => {
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "ready" })];
    mockRecordAllRemainingAsSkip.mockRejectedValueOnce(new Error("not an admin"));
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Skip remaining (2)" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not an admin");
  });

  it("re-enables both bulk buttons after a failure so the user can retry", async () => {
    currentRows = [makeRow({ status: "ready" })];
    mockRecordAllRemainingAsSkip.mockRejectedValueOnce(new Error("boom"));
    renderWizard();

    const skipAll = screen.getByRole("button", {
      name: "Skip remaining (1)",
    }) as HTMLButtonElement;
    fireEvent.click(skipAll);

    await screen.findByRole("alert");
    expect(skipAll.disabled).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Add all remaining as new (1)" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — near matches and the action hierarchy
//
// The whole ticket in one behaviour: the wizard used to offer a green "Add as
// New" with nothing else on screen, and "NY Yankees" became a second Yankees
// row next to "New York Yankees".
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — near matches", () => {
  // NeonButton paints its neon as an INLINE style, so the variant is readable
  // straight off the node. happy-dom preserves the authored hex rather than
  // normalising it to rgb(), so these compare as written.
  const GREEN = "#00D558";
  const BLUE = "#00C2FF"; // NeonButton's `secondary`

  it("queries players.nearMatches for a player row, skipping the team query", () => {
    currentRows = [
      makeRow({
        kind: "player",
        name: "Mike Trout",
        sportId: "selopt-sport-9" as unknown as Id<"selectorOptions">,
        status: "ready",
      }),
    ];
    renderWizard();

    const playerCall = queryCalls.filter((c) => c.ref === "players.nearMatches").pop();
    const teamCall = queryCalls.filter((c) => c.ref === "teams.nearMatches").pop();
    expect(playerCall?.args).toEqual({ name: "Mike Trout", sportId: "selopt-sport-9" });
    expect(teamCall?.args).toBe("skip");
  });

  it("queries teams.nearMatches for a team row, skipping the player query", () => {
    currentRows = [makeRow({ kind: "team", name: "NY Yankees", status: "ready" })];
    renderWizard();

    const teamCall = queryCalls.filter((c) => c.ref === "teams.nearMatches").pop();
    const playerCall = queryCalls.filter((c) => c.ref === "players.nearMatches").pop();
    expect(teamCall?.args).toEqual({ name: "NY Yankees", sportId: "selopt-sport-1" });
    expect(playerCall?.args).toBe("skip");
  });

  it("NO MATCHES: green 'Add as New Player', no panel — unchanged from before", () => {
    // This is the state every existing Maestro flow runs in (their names are
    // nonsense strings that match nothing), so it must not move.
    currentNearMatches = [];
    currentRows = [makeRow({ kind: "player", status: "ready" })];
    renderWizard();

    const add = screen.getByRole("button", { name: "Add as New Player" });
    expect(add.textContent).toBe("Add as New Player");
    expect((add as HTMLElement).style.backgroundColor).toBe(GREEN);
    expect(screen.queryByText("Possible matches")).toBeNull();
  });

  it("CLOSE ONLY: same label, panel shown, and the button loses its green", () => {
    currentNearMatches = [
      { _id: "p9", name: "Michael Trout", confidence: "close" },
    ];
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    renderWizard();

    expect(screen.getByText("Possible matches")).toBeTruthy();
    // The accessible name is an E2E contract and survives the demotion.
    const add = screen.getByRole("button", { name: "Add as New Player" });
    expect(add.textContent).toBe("Add as New Player");
    expect((add as HTMLElement).style.backgroundColor).toBe(BLUE);
    expect((add as HTMLElement).style.backgroundColor).not.toBe(GREEN);
    // NeonButton's own `secondary` foreground is white — 2.07:1 on #00C2FF.
    // The call site overrides it to black (10.2:1) rather than repainting the
    // shared primitive; assert the override is actually applied.
    expect((add as HTMLElement).style.color).toBe("#000000");
  });

  it("EXACT: the green button becomes 'Link to {name}' and create demotes to a text link", () => {
    currentNearMatches = [
      { _id: "p9", name: "Mike Trout", confidence: "exact" },
      { _id: "p8", name: "Michael Trout", confidence: "close" },
    ];
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    renderWizard();

    // EXACTLY ONE control carries "Link to Mike Trout". The promoted primary
    // button IS the exact panel row, so that row is filtered out of the panel —
    // two controls sharing one accessible name is ambiguous to a screen reader
    // reading the list and to a Maestro `tapOn` matching by it.
    const linkButtons = screen.getAllByLabelText("Link to Mike Trout");
    expect(linkButtons).toHaveLength(1);
    expect((linkButtons[0] as HTMLElement).style.backgroundColor).toBe(GREEN);

    // Create is still reachable, as a text link whose accessible name IS its
    // visible text — no aria-label sitting over words the operator can read.
    const add = screen.getByRole("button", { name: "Add as New Player anyway" });
    expect(add.textContent).toBe("Add as New Player anyway");
    expect(add.getAttribute("aria-label")).toBeNull();
    expect((add as HTMLElement).style.backgroundColor).toBe("");
    // And the old mismatched name is gone.
    expect(screen.queryByLabelText("Add as New Player")).toBeNull();
  });

  it("EXACT: the OTHER matches stay listed in the panel", () => {
    // Only the promoted row is filtered, and by id — a different entity is
    // still a candidate the operator should see, whatever its confidence.
    currentNearMatches = [
      { _id: "p9", name: "Mike Trout", confidence: "exact" },
      { _id: "p8", name: "Michael Trout", confidence: "close" },
    ];
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    renderWizard();

    expect(screen.getByText("Possible matches")).toBeTruthy();
    expect(screen.getByLabelText("Link to Michael Trout")).toBeTruthy();
  });

  it("EXACT and nothing else: the panel disappears entirely", () => {
    // Filtering the promoted row leaves [], which NearMatchPanel already
    // renders as no panel at all — so the operator is not shown an empty
    // "Possible matches" box whose only entry has moved up to the button.
    currentNearMatches = [{ _id: "p9", name: "Mike Trout", confidence: "exact" }];
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    renderWizard();

    expect(screen.queryByText("Possible matches")).toBeNull();
    expect(screen.getAllByLabelText("Link to Mike Trout")).toHaveLength(1);
  });

  it("EXACT: the promoted button links to the exact match's id", async () => {
    const row = makeRow({ kind: "player", name: "Mike Trout", status: "ready" });
    currentNearMatches = [{ _id: "player_exact", name: "Mike Trout", confidence: "exact" }];
    currentRows = [row];
    renderWizard();

    const green = screen.getByLabelText("Link to Mike Trout");
    expect((green as HTMLElement).style.backgroundColor).toBe(GREEN);
    fireEvent.click(green);

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "link",
        linkedPlayerId: "player_exact",
        linkedTeamId: undefined,
      });
    });
  });

  it("EXACT: the demoted create still carries the row's staged career teams", async () => {
    const row = makeRow({
      kind: "player",
      name: "Mike Trout",
      status: "ready",
      enrichment: { careerTeams: [] },
    });
    currentNearMatches = [{ _id: "p9", name: "Mike Trout", confidence: "exact" }];
    currentRows = [row];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Los Angeles Angels" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2011" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Add as New Player anyway" }),
    );

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "create",
        manualCareerTeams: [{ name: "Los Angeles Angels", fromYear: 2011 }],
        excludedCareerTeamNames: undefined,
        createTeams: [
          { sourceName: "Los Angeles Angels", name: "Los Angeles Angels" },
        ],
      });
    });
  });

  it("picking a panel row records a link decision", async () => {
    const row = makeRow({ kind: "team", name: "NY Yankees", status: "ready" });
    currentNearMatches = [
      { _id: "team_ny", name: "New York Yankees", confidence: "close" },
    ];
    currentRows = [row];
    renderWizard();

    fireEvent.click(screen.getByLabelText("Link to New York Yankees"));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "link",
        linkedPlayerId: undefined,
        linkedTeamId: "team_ny",
      });
    });
  });

  it("hides the panel while the link search is open, so 'Link to {name}' is never ambiguous", () => {
    currentNearMatches = [
      { _id: "p9", name: "Michael Trout", confidence: "close" },
    ];
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    renderWizard();

    expect(screen.getByText("Possible matches")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Link to existing instead"));
    expect(screen.queryByText("Possible matches")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — Wikidata career teams are PROPOSALS, not facts
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — career-team proposals", () => {
  const angelsRow = () =>
    makeRow({
      kind: "player",
      name: "Mike Trout",
      status: "ready",
      enrichment: {
        careerTeams: [
          { name: "Los Angeles Angels", fromYear: 2011 },
          { name: "Salt Lake Bees", fromYear: 2011, toYear: 2011 },
          { name: "Cedar Rapids Kernels", fromYear: 2010, toYear: 2010 },
        ],
      },
    });

  it("renders each career team as a checkbox, checked by default", () => {
    currentRows = [angelsRow()];
    renderWizard();

    const angels = screen.getByLabelText(
      "Include career team Los Angeles Angels",
    ) as HTMLInputElement;
    expect(angels.type).toBe("checkbox");
    expect(angels.checked).toBe(true);
  });

  it("sorts by fromYear, with an open-ended tenure last within a shared start year", () => {
    currentRows = [angelsRow()];
    renderWizard();

    const labels = screen
      .getAllByRole("checkbox")
      .map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Include career team Cedar Rapids Kernels", // 2010
      "Include career team Salt Lake Bees", // 2011–2011 (closed)
      "Include career team Los Angeles Angels", // 2011–present (open, last)
    ]);
  });

  it("labels each proposal '{name} ({from}–{to|present})'", () => {
    currentRows = [angelsRow()];
    renderWizard();

    expect(screen.getByText("Los Angeles Angels (2011–present)")).toBeTruthy();
    expect(screen.getByText("Salt Lake Bees (2011–2011)")).toBeTruthy();
  });

  it("sends UNCHECKED proposals as excludedCareerTeamNames on create", async () => {
    const row = angelsRow();
    currentRows = [row];
    renderWizard();

    fireEvent.click(screen.getByLabelText("Include career team Salt Lake Bees"));
    expect(
      (screen.getByLabelText("Include career team Salt Lake Bees") as HTMLInputElement)
        .checked,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "create",
        manualCareerTeams: undefined,
        excludedCareerTeamNames: ["Salt Lake Bees"],
        // NEO-236: a pair per ACCEPTED proposal, untouched (Name = the label,
        // no location) — and none for the one the operator unchecked.
        createTeams: [
          { sourceName: "Cedar Rapids Kernels", name: "Cedar Rapids Kernels" },
          { sourceName: "Los Angeles Angels", name: "Los Angeles Angels" },
        ],
      });
    });
  });

  it("sends no exclusion list at all when nothing is unchecked", async () => {
    const row = angelsRow();
    currentRows = [row];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "create",
        manualCareerTeams: undefined,
        excludedCareerTeamNames: undefined,
        createTeams: [
          { sourceName: "Cedar Rapids Kernels", name: "Cedar Rapids Kernels" },
          { sourceName: "Salt Lake Bees", name: "Salt Lake Bees" },
          { sourceName: "Los Angeles Angels", name: "Los Angeles Angels" },
        ],
      });
    });
  });

  it("re-checking a proposal drops it back out of the exclusion list", async () => {
    const row = angelsRow();
    currentRows = [row];
    renderWizard();

    const bees = () => screen.getByLabelText("Include career team Salt Lake Bees");
    fireEvent.click(bees());
    fireEvent.click(bees());
    expect((bees() as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith({
        reviewRowId: row._id,
        action: "create",
        manualCareerTeams: undefined,
        excludedCareerTeamNames: undefined,
        createTeams: [
          { sourceName: "Cedar Rapids Kernels", name: "Cedar Rapids Kernels" },
          { sourceName: "Salt Lake Bees", name: "Salt Lake Bees" },
          { sourceName: "Los Angeles Angels", name: "Los Angeles Angels" },
        ],
      });
    });
  });

  it("keeps two same-named tenures from different years as distinct rows (list key)", () => {
    // The list used to key on `ct.name` alone, so a player who returned to a
    // club rendered one row instead of two.
    currentRows = [
      makeRow({
        kind: "player",
        status: "ready",
        enrichment: {
          careerTeams: [
            { name: "Boston Red Sox", fromYear: 2005, toYear: 2008 },
            { name: "Boston Red Sox", fromYear: 2012, toYear: 2014 },
          ],
        },
      }),
    ];
    renderWizard();

    expect(screen.getByText("Boston Red Sox (2005–2008)")).toBeTruthy();
    expect(screen.getByText("Boston Red Sox (2012–2014)")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — "will create N new teams" summary
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — team creation summary", () => {
  const trout = () =>
    makeRow({
      kind: "player",
      name: "Mike Trout",
      status: "ready",
      enrichment: {
        careerTeams: [
          { name: "Los Angeles Angels", fromYear: 2011 },
          { name: "Salt Lake Bees", fromYear: 2011, toYear: 2011 },
        ],
      },
    });

  it("resolves the checked proposals plus the staged chips, deduped, for this sport", () => {
    currentRows = [trout()];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Career team name"), {
      // Same team, different casing — the commit dedupes it, so the preview must.
      target: { value: "los angeles angels" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2011" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    const call = queryCalls.filter((c) => c.ref === "teams.resolveNames").pop();
    expect(call?.args).toEqual({
      names: ["Los Angeles Angels", "Salt Lake Bees"],
      sportId: "selopt-sport-1",
    });
  });

  it("shows both halves when some names exist and some do not", () => {
    currentResolvedNames = [
      { name: "Los Angeles Angels" },
      { name: "Salt Lake Bees", existingTeamId: "t1", existingName: "Salt Lake Bees" },
    ];
    currentRows = [trout()];
    renderWizard();

    expect(
      screen.getByText("Will create 1 new team: Los Angeles Angels · 1 already exist"),
    ).toBeTruthy();
  });

  it("omits the 'already exist' half when nothing exists yet", () => {
    currentResolvedNames = [
      { name: "Los Angeles Angels" },
      { name: "Salt Lake Bees" },
    ];
    currentRows = [trout()];
    renderWizard();

    expect(
      screen.getByText("Will create 2 new teams: Los Angeles Angels, Salt Lake Bees"),
    ).toBeTruthy();
  });

  it("omits the 'will create' half when every name already exists", () => {
    currentResolvedNames = [
      { name: "Los Angeles Angels", existingTeamId: "t1" },
      { name: "Salt Lake Bees", existingTeamId: "t2" },
    ];
    currentRows = [trout()];
    renderWizard();

    expect(screen.getByText("2 already exist")).toBeTruthy();
    expect(screen.queryByText(/Will create/)).toBeNull();
  });

  it("skips the query entirely when there is nothing to resolve", () => {
    currentRows = [
      makeRow({ kind: "player", status: "ready", enrichment: { careerTeams: [] } }),
    ];
    renderWizard();

    const call = queryCalls.filter((c) => c.ref === "teams.resolveNames").pop();
    expect(call?.args).toBe("skip");
    expect(screen.queryByText(/Will create/)).toBeNull();
  });

  it("does not run for a team row", () => {
    currentRows = [makeRow({ kind: "team", status: "ready", enrichment: { league: "MLB" } })];
    renderWizard();

    const call = queryCalls.filter((c) => c.ref === "teams.resolveNames").pop();
    expect(call?.args).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — row header: copy, source links, disambiguation line
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — row header", () => {
  it("offers a copy control for the reviewed name", () => {
    currentRows = [makeRow({ name: "Mike Trout", status: "ready" })];
    renderWizard();

    expect(screen.getByLabelText("Copy name")).toBeTruthy();
  });

  it("links to the Wikidata record, opening safely in a new tab", () => {
    currentRows = [
      makeRow({ name: "Mike Trout", status: "ready", enrichment: { wikidataId: "Q303" } }),
    ];
    renderWizard();

    const link = screen.getByRole("link", { name: /Wikidata Q303/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://www.wikidata.org/wiki/Q303");
    expect(link.getAttribute("target")).toBe("_blank");
    // rel is the security half — `noopener` denies the opened page a handle on
    // this window, `noreferrer` denies it the referrer.
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("(opens in new tab)");
  });

  it("links to Wikipedia, underscoring and encoding the article title", () => {
    currentRows = [
      makeRow({
        status: "ready",
        enrichment: { wikidataId: "Q303", enwikiTitle: "Mike Trout" },
      }),
    ];
    renderWizard();

    const link = screen.getByRole("link", { name: /Wikipedia/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://en.wikipedia.org/wiki/Mike_Trout");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("percent-encodes an article title that needs it", () => {
    currentRows = [
      makeRow({ status: "ready", enrichment: { enwikiTitle: "José Ramírez (baseball)" } }),
    ];
    renderWizard();

    const link = screen.getByRole("link", { name: /Wikipedia/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "https://en.wikipedia.org/wiki/Jos%C3%A9_Ram%C3%ADrez_(baseball)",
    );
  });

  it("shows a malformed Wikidata id as text, never as a link", () => {
    // NEO-212 security review. `enrichment.wikidataId` originates at
    // query.wikidata.org, so it is external input on its way into an `href`,
    // and React warns on a `javascript:` URL while rendering it anyway. The
    // guard is `wikidataUrl` (lib/players/wikidata-id.ts) returning null. The
    // value is still SHOWN — the operator needs to see what the lookup found
    // in order to judge it — just not as a destination.
    currentRows = [
      makeRow({
        name: "Mike Trout",
        status: "ready",
        enrichment: { wikidataId: "javascript:alert(1)" },
      }),
    ];
    renderWizard();

    expect(screen.queryByRole("link", { name: /Wikidata/ })).toBeNull();
    expect(screen.getByText("Wikidata javascript:alert(1)")).toBeTruthy();
    // Nothing on the page carries the payload as a URL of any kind.
    for (const a of Array.from(document.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toContain("javascript:");
    }
  });

  it("renders neither link when the lookup found nothing", () => {
    currentRows = [makeRow({ status: "error", enrichment: undefined })];
    renderWizard();

    expect(screen.queryByRole("link", { name: /Wikidata/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Wikipedia/ })).toBeNull();
  });

  it("shows the description and birth year — the line that settles 'which Mike Smith?'", () => {
    currentRows = [
      makeRow({
        status: "ready",
        enrichment: { description: "American baseball player", birthYear: 1991 },
      }),
    ];
    renderWizard();

    expect(screen.getByText("American baseball player · b. 1991")).toBeTruthy();
  });

  it("shows whichever half of that line exists on its own", () => {
    currentRows = [makeRow({ status: "ready", enrichment: { birthYear: 1991 } })];
    const { unmount } = renderWizard();
    expect(screen.getByText("b. 1991")).toBeTruthy();
    unmount();

    currentRows = [
      makeRow({ status: "ready", enrichment: { description: "Canadian ice hockey player" } }),
    ];
    renderWizard();
    expect(screen.getByText("Canadian ice hockey player")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — readability
//
// Class assertions, for the same reason the footer-stability block uses them:
// happy-dom performs no layout, so the only observable is the class that
// produces the size.
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — readability", () => {
  it("widens the dialog from max-w-md to max-w-2xl", () => {
    currentRows = [makeRow({ status: "ready" })];
    renderWizard();

    expect(document.querySelector(".max-w-2xl")).toBeTruthy();
    expect(document.querySelector(".max-w-md")).toBeNull();
  });

  it("renders the enrichment body at text-sm rather than text-xs", () => {
    currentRows = [makeRow({ status: "error", enrichment: undefined })];
    renderWizard();

    const body = screen.getByText("No Wikidata match found.").parentElement;
    expect(body?.className).toContain("text-sm");
    expect(body?.className).not.toContain("text-xs");
  });

  it("renders the manual career-team prompt at text-sm", () => {
    currentRows = [
      makeRow({ kind: "player", status: "ready", enrichment: { careerTeams: [] } }),
    ];
    renderWizard();

    const prompt = screen.getByText(/Add career team history manually/);
    expect(prompt.className).toContain("text-sm");
  });

  it("lifts the kind/sport tag from text-gray-500 to text-gray-400", () => {
    currentRows = [makeRow({ kind: "player", sportValue: "Baseball", status: "ready" })];
    renderWizard();

    const tag = screen.getByText(/\(Player · Baseball\)/);
    expect(tag.className).toContain("text-gray-400");
    expect(tag.className).not.toContain("text-gray-500");
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — the single decision seam
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — decision seam", () => {
  it("exposes the in-flight state on the action row (the seam NEO-221 hooks)", () => {
    // Deliberately NOT a guard yet: nothing is disabled here. This asserts the
    // seam exists and is observable, so the guard lands in one place.
    currentRows = [makeRow({ kind: "player", status: "ready" })];
    renderWizard();

    const actionRow = screen
      .getByRole("button", { name: "Add as New Player" })
      .closest("[aria-busy]");
    expect(actionRow).toBeTruthy();
    expect(actionRow?.getAttribute("aria-busy")).toBe("false");
  });

  it("routes create, link and skip through it — all three reach recordDecision", async () => {
    const row = makeRow({ kind: "player", name: "Mike Trout", status: "ready" });
    currentRows = [row];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));
    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Skip Mike Trout — not a person" }));
    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByLabelText("Link to existing instead"));
    fireEvent.click(screen.getByText("Stub link select"));
    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalledTimes(3));

    expect(mockRecordDecision.mock.calls.map((c) => c[0].action)).toEqual([
      "create",
      "skip",
      "link",
    ]);
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — accessibility fixes from the WCAG 2.2 AA audit
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — accessibility", () => {
  it("keeps focus on the primary action when the near-match result flips to exact", () => {
    // The near-match query resolves while the row is already on screen, so this
    // swap can land under a keyboard user who has tabbed to the primary. One
    // element in one slot means React patches it; a ternary between two
    // elements would unmount the focused node and drop focus to <body>.
    const props = () => (
      <EntityReviewWizard
        isOpen
        selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
        batchId="batch-1"
        cardCount={3}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    currentNearMatches = [
      { _id: "p9", name: "Michael Trout", confidence: "close" },
    ];
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    // A NEW element each render: React bails out of re-rendering an element
    // that is referentially identical to the previous one.
    const { rerender } = render(props());

    const primary = screen.getByRole("button", { name: "Add as New Player" });
    (primary as HTMLElement).focus();
    expect(document.activeElement).toBe(primary);

    currentNearMatches = [{ _id: "p9", name: "Mike Trout", confidence: "exact" }];
    rerender(props());

    // The same node, now relabelled — not a remount, and not <body>.
    expect(screen.getByRole("button", { name: "Link to Mike Trout" })).toBe(
      primary,
    );
    expect(document.activeElement).toBe(primary);
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("keeps focus on the primary when the exact match disappears again", () => {
    // The reverse edge: a debounce landing a fresh, emptier result set.
    const props = () => (
      <EntityReviewWizard
        isOpen
        selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
        batchId="batch-1"
        cardCount={3}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    currentNearMatches = [{ _id: "p9", name: "Mike Trout", confidence: "exact" }];
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    const { rerender } = render(props());

    const primary = screen.getByRole("button", { name: "Link to Mike Trout" });
    (primary as HTMLElement).focus();

    currentNearMatches = [];
    rerender(props());

    expect(document.activeElement).toBe(primary);
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(
      screen.getByRole("button", { name: "Add as New Player" }),
    ).toBe(primary);
  });

  it("groups the Wikidata career-team checkboxes under their own prompt", () => {
    currentRows = [
      makeRow({
        kind: "player",
        name: "Mike Trout",
        status: "ready",
        enrichment: {
          careerTeams: [
            { name: "Los Angeles Angels", fromYear: 2011 },
            { name: "Arkansas Travelers", fromYear: 2010, toYear: 2011 },
          ],
        },
      }),
    ];
    renderWizard();

    const group = screen.getByRole("group", {
      name: "Career teams to create with this player:",
    });
    expect(
      group.querySelectorAll('input[type="checkbox"]'),
    ).toHaveLength(2);
  });

  it("keeps the row heading's accessible name to just the entity name", () => {
    // The CopyButton and the kind/sport tag used to live INSIDE the <h3>, so
    // heading navigation announced "Mike Trout Copy name (Player · Baseball)".
    currentRows = [
      makeRow({
        kind: "player",
        name: "Mike Trout",
        sportValue: "Baseball",
        status: "ready",
      }),
    ];
    renderWizard();

    const heading = screen.getByRole("heading", { level: 3, name: "Mike Trout" });
    expect(heading.textContent).toBe("Mike Trout");
    expect(heading.querySelector("button")).toBeNull();
    // Both are still on screen — moved beside the heading, not removed.
    expect(screen.getByText(/\(Player · Baseball\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy name" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-236 — creating a team takes Location + Name, never the checklist string
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — team Location + Name", () => {
  it("pre-fills Location from an ESPN location that is a whole-word prefix", () => {
    currentRows = [
      makeRow({
        kind: "team",
        name: "San Diego Padres",
        status: "ready",
        enrichment: { location: "San Diego" },
      }),
    ];
    renderWizard();

    expect((screen.getByLabelText("Location") as HTMLInputElement).value).toBe(
      "San Diego",
    );
    expect((screen.getByLabelText("Team name") as HTMLInputElement).value).toBe(
      "Padres",
    );
    expect(screen.getByText("Shows as: San Diego Padres")).toBeTruthy();
  });

  it("leaves Location blank when the ESPN location is NOT a prefix of the name", () => {
    // "Anaheim" is where the franchise plays, not the front of its name. A
    // wizard that split on it would offer to create "Anaheim Angels", a team
    // that has not existed since 2005.
    currentRows = [
      makeRow({
        kind: "team",
        name: "Los Angeles Angels",
        status: "ready",
        enrichment: { location: "Anaheim" },
      }),
    ];
    renderWizard();

    expect((screen.getByLabelText("Location") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Team name") as HTMLInputElement).value).toBe(
      "Los Angeles Angels",
    );
  });

  it("leaves Location blank when the lookup found no location at all", () => {
    currentRows = [
      makeRow({ kind: "team", name: "Orix Buffaloes", status: "ready" }),
    ];
    renderWizard();

    expect((screen.getByLabelText("Location") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Team name") as HTMLInputElement).value).toBe(
      "Orix Buffaloes",
    );
    // No location, so the composed name IS the name — the preview says so
    // rather than going quiet.
    expect(screen.getByText("Shows as: Orix Buffaloes")).toBeTruthy();
  });

  it("sends the operator's two fields as `create`, not the reviewed name", async () => {
    const row = makeRow({
      kind: "team",
      name: "SD PADRES",
      status: "ready",
    });
    currentRows = [row];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "San Diego" },
    });
    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "Padres" },
    });
    expect(screen.getByText("Shows as: San Diego Padres")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Team" }));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewRowId: row._id,
          action: "create",
          create: { name: "Padres", location: "San Diego" },
        }),
      );
    });
  });

  it("omits `location` entirely when the operator leaves it blank", async () => {
    const row = makeRow({ kind: "team", name: "Aztecs", status: "ready" });
    currentRows = [row];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Team" }));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({ create: { name: "Aztecs" } }),
      );
    });
  });

  it("refuses to create a team whose Name has been cleared, and says why", async () => {
    const row = makeRow({ kind: "team", name: "Padres", status: "ready" });
    currentRows = [row];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "  " } });

    const primary = screen.getByRole("button", { name: "Add as New Team" });
    expect(primary.getAttribute("aria-disabled")).toBe("true");
    const message = screen.getByText("Enter a team name before adding it.");
    // The control points at the reason, so it is announced rather than left
    // for the operator to find on screen.
    expect(primary.getAttribute("aria-describedby")).toBe(message.id);

    fireEvent.click(primary);
    await waitFor(() => {
      expect(mockRecordDecision).not.toHaveBeenCalled();
    });
  });

  it("shows no Location/Name pair on a player row", () => {
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    renderWizard();

    expect(screen.queryByLabelText("Location")).toBeNull();
    expect(screen.queryByLabelText("Team name")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEO-236 — career teams that match nothing get their own Location + Name
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — career-team Location + Name", () => {
  const trout = () =>
    makeRow({
      kind: "player",
      name: "Mike Trout",
      status: "ready",
      enrichment: {
        careerTeams: [
          { name: "Los Angeles Angels", fromYear: 2011 },
          { name: "Salt Lake Bees", fromYear: 2010, toYear: 2010 },
        ],
      },
    });

  it("shows a pair only for the proposals that match no existing team", () => {
    currentRows = [trout()];
    currentResolvedNames = [
      { name: "Los Angeles Angels", existingTeamId: "team_angels" },
      { name: "Salt Lake Bees" },
    ];
    renderWizard();

    expect(screen.getByLabelText("Name for new team Salt Lake Bees")).toBeTruthy();
    // The Angels already exist — commit will LINK, so there is nothing to say.
    expect(
      screen.queryByLabelText("Name for new team Los Angeles Angels"),
    ).toBeNull();
  });

  it("defaults the pair to the label with no location, and sends the operator's split", async () => {
    const row = trout();
    currentRows = [row];
    currentResolvedNames = [
      { name: "Los Angeles Angels", existingTeamId: "team_angels" },
      { name: "Salt Lake Bees" },
    ];
    renderWizard();

    expect(
      (screen.getByLabelText("Name for new team Salt Lake Bees") as HTMLInputElement)
        .value,
    ).toBe("Salt Lake Bees");
    expect(
      (
        screen.getByLabelText(
          "Location for new team Salt Lake Bees",
        ) as HTMLInputElement
      ).value,
    ).toBe("");

    fireEvent.change(screen.getByLabelText("Location for new team Salt Lake Bees"), {
      target: { value: "Salt Lake" },
    });
    fireEvent.change(screen.getByLabelText("Name for new team Salt Lake Bees"), {
      target: { value: "Bees" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          createTeams: [
            // The edited one first — the ordering only matters if the list
            // ever has to be truncated, and what the operator touched is what
            // must survive that.
            {
              sourceName: "Salt Lake Bees",
              name: "Bees",
              location: "Salt Lake",
            },
            // Already exists — sent anyway, and inert: commit matches first.
            {
              sourceName: "Los Angeles Angels",
              name: "Los Angeles Angels",
            },
          ],
        }),
      );
    });
  });

  it("the summary line names the team as the operator split it", () => {
    currentRows = [trout()];
    currentResolvedNames = [
      { name: "Los Angeles Angels", existingTeamId: "team_angels" },
      { name: "Salt Lake Bees" },
    ];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Location for new team Salt Lake Bees"), {
      target: { value: "Salt Lake" },
    });
    fireEvent.change(screen.getByLabelText("Name for new team Salt Lake Bees"), {
      target: { value: "Bees" },
    });

    expect(
      screen.getByText("Will create 1 new team: Salt Lake Bees · 1 already exist"),
    ).toBeTruthy();
  });

  it("refuses to confirm while an accepted, unmatched career team has no name", async () => {
    const row = trout();
    currentRows = [row];
    currentResolvedNames = [
      { name: "Los Angeles Angels", existingTeamId: "team_angels" },
      { name: "Salt Lake Bees" },
    ];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Name for new team Salt Lake Bees"), {
      target: { value: "" },
    });

    const primary = screen.getByRole("button", { name: "Add as New Player" });
    expect(primary.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("Name the new team for Salt Lake Bees, or uncheck it."),
    ).toBeTruthy();

    fireEvent.click(primary);
    await waitFor(() => {
      expect(mockRecordDecision).not.toHaveBeenCalled();
    });
  });

  it("unchecking the offending proposal unblocks the confirm", async () => {
    const row = trout();
    currentRows = [row];
    currentResolvedNames = [
      { name: "Los Angeles Angels", existingTeamId: "team_angels" },
      { name: "Salt Lake Bees" },
    ];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Name for new team Salt Lake Bees"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByLabelText("Include career team Salt Lake Bees"));

    const primary = screen.getByRole("button", { name: "Add as New Player" });
    expect(primary.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(primary);
    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          excludedCareerTeamNames: ["Salt Lake Bees"],
          createTeams: [
            { sourceName: "Los Angeles Angels", name: "Los Angeles Angels" },
          ],
        }),
      );
    });
  });

  it("still sends a pair per accepted proposal while the match query is unanswered", async () => {
    // `resolveNames` undefined means "not answered yet", not "nothing matches".
    // No pairs are shown, but the untouched defaults still travel — otherwise
    // confirming early would silently drop every stint at a team we lack.
    const row = trout();
    currentRows = [row];
    currentResolvedNames = undefined;
    renderWizard();

    expect(screen.queryByLabelText("Name for new team Salt Lake Bees")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          createTeams: [
            { sourceName: "Salt Lake Bees", name: "Salt Lake Bees" },
            { sourceName: "Los Angeles Angels", name: "Los Angeles Angels" },
          ],
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// NEO-236 (a11y) — the refusal reason is reachable from the field that causes
// it, not only from the button that is blocked by it
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — the create refusal is described where it is caused", () => {
  it("points the team Name field at the reason, and leaves Location alone", () => {
    currentRows = [makeRow({ kind: "team", name: "Padres", status: "ready" })];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "" } });

    const reason = screen.getByText("Enter a team name before adding it.");
    // A screen-reader user who tabs into the field and clears it hears why
    // immediately, rather than only on reaching the button several stops later.
    expect(screen.getByLabelText("Team name").getAttribute("aria-describedby")).toBe(
      reason.id,
    );
    // Location is not what is blocking — describing the refusal there would be
    // a mismatch, and a blank Location is a valid answer.
    expect(
      screen.getByLabelText("Location").getAttribute("aria-describedby"),
    ).toBeNull();
  });

  it("points a blanked career-team Name field at the reason too", () => {
    currentRows = [
      makeRow({
        kind: "player",
        name: "Mike Trout",
        status: "ready",
        enrichment: { careerTeams: [{ name: "Salt Lake Bees", fromYear: 2010 }] },
      }),
    ];
    currentResolvedNames = [{ name: "Salt Lake Bees" }];
    renderWizard();

    const field = screen.getByLabelText("Name for new team Salt Lake Bees");
    fireEvent.change(field, { target: { value: "" } });

    const reason = screen.getByText(
      "Name the new team for Salt Lake Bees, or uncheck it.",
    );
    expect(field.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("drops the description again once the name is filled back in", () => {
    currentRows = [makeRow({ kind: "team", name: "Padres", status: "ready" })];
    renderWizard();

    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "" } });
    expect(
      screen.getByLabelText("Team name").getAttribute("aria-describedby"),
    ).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "Padres" },
    });
    expect(
      screen.getByLabelText("Team name").getAttribute("aria-describedby"),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Add as New Team" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEO-236 security review, finding 3 — a refused decision is SEEN
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — a refused create decision reaches the operator", () => {
  it("refuses an over-long composed name before the round trip", () => {
    currentRows = [makeRow({ kind: "team", name: "Padres", status: "ready" })];
    renderWizard();

    // Neither half is over the limit; together they are. The bound is on the
    // composed name because that is what gets stored.
    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "L".repeat(70) },
    });
    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "N".repeat(70) },
    });

    const primary = screen.getByRole("button", { name: "Add as New Team" });
    expect(primary.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("That name is 141 characters; the limit is 120."),
    ).toBeTruthy();

    fireEvent.click(primary);
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });

  it("surfaces the server's own words when the mutation refuses anyway", async () => {
    // The client guard above and this one are independent on purpose: a stale
    // bundle must not be able to get the write through, and when the server
    // refuses, its message is the one written for the operator to read.
    mockRecordDecision.mockRejectedValueOnce({
      data: "A team name is 141 characters; the limit is 120.",
    });
    currentRows = [makeRow({ kind: "team", name: "Padres", status: "ready" })];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Team" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "A team name is 141 characters; the limit is 120.",
    );
  });

  it("falls back to a readable sentence when the error carries no message", async () => {
    // A plain Error reaches the browser already redacted to "Server Error", so
    // echoing it would tell the operator nothing.
    mockRecordDecision.mockRejectedValueOnce(new Error("Server Error"));
    currentRows = [makeRow({ kind: "team", name: "Padres", status: "ready" })];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Team" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Couldn't save that decision. Check the name and try again.",
    );
  });

  it("does not swallow a refusal on a player row either", async () => {
    mockRecordDecision.mockRejectedValueOnce({ data: "Nope." });
    currentRows = [
      makeRow({ kind: "player", name: "Mike Trout", status: "ready" }),
    ];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Nope.");
  });

  it("clears the refusal when the wizard advances to another row", async () => {
    // A refusal belongs to the row it was raised on.
    mockRecordDecision.mockRejectedValueOnce({ data: "Nope." });
    const first = makeRow({ kind: "team", name: "Padres", status: "ready" });
    currentRows = [first];
    const { rerender } = renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Team" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Nope.");

    currentRows = [
      { ...first, decision: { action: "create" } },
      makeRow({ kind: "team", name: "Angels", status: "ready" }),
    ];
    rerender(
      <EntityReviewWizard
        isOpen
        selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
        batchId="batch-1"
        cardCount={3}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
