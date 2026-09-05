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

import {
  act,
  createEvent,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
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
      // NEO-221: back-navigation clears a decision so the row can be redecided.
      clearDecision: "entityReviewQueue.clearDecision",
      cancelBatch: "entityReviewQueue.cancelBatch",
      recordAllRemainingAsCreate: "entityReviewQueue.recordAllRemainingAsCreate",
      recordAllRemainingAsSkip: "entityReviewQueue.recordAllRemainingAsSkip",
    },
    players: {
      nearMatches: "players.nearMatches",
      search: "players.search",
      // NEO-221: resolves a linked player's canonical name for the decided list.
      getManyByIds: "players.getManyByIds",
    },
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
/** Rows served to players.getManyByIds (linked-player canonical names). */
let currentLinkedPlayers: unknown;
/** Every (ref, args) pair useQuery saw, so arg-shaping can be asserted. */
let queryCalls: Array<{ ref: string; args: unknown }>;

const mockRecordDecision = vi.fn();
const mockClearDecision = vi.fn();
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
    if (ref === "players.getManyByIds") return currentLinkedPlayers;
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "entityReviewQueue.recordDecision") return mockRecordDecision;
    if (ref === "entityReviewQueue.clearDecision") return mockClearDecision;
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

/**
 * NEO-220 replaced the bare `cardCount` prop with the whole of what Confirm &
 * Save is about to do, so the final step can itemise it.
 */
const SUMMARY = { cardCount: 3, deleteCount: 0, reviewDecisionCount: 0 };

function renderWizard(props: Partial<Parameters<typeof EntityReviewWizard>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={SUMMARY}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { ...utils, onConfirm, onCancel };
}

/** The discard confirm's destructive button — "Discard", per the E2E contract. */
function discardButton(): HTMLElement {
  return screen.getByRole("button", { name: "Discard" });
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

/**
 * The footer's reserved status row (NEO-220): the LAST element in the footer,
 * addressed structurally because `role="status"` is not unique on this screen —
 * the header's progress line and CopyButton's live region both carry it.
 *
 * Returns "" when the row is rendered empty, which is the point of it: the row
 * exists at a fixed height whether or not there is anything to say, so row 1
 * can never be pushed around by a message arriving.
 */
function footerStatusText(): string {
  const overlay = document.querySelector('[role="dialog"]');
  if (!overlay) throw new Error("wizard overlay not found");
  const panel = overlay.firstElementChild as HTMLElement;
  const footer = panel.children[2] as HTMLElement;
  const status = footer.lastElementChild as HTMLElement;
  if (status.getAttribute("role") !== "status") {
    throw new Error("footer's last child is not the status row");
  }
  return (status.textContent ?? "").trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordDecision.mockResolvedValue(null);
  mockClearDecision.mockResolvedValue(null);
  mockCancelBatch.mockResolvedValue(null);
  mockRecordAllRemainingAsCreate.mockResolvedValue(0);
  mockRecordAllRemainingAsSkip.mockResolvedValue(0);
  currentRows = [];
  currentNearMatches = [];
  currentResolvedNames = undefined;
  currentLinkedTeams = undefined;
  currentLinkedPlayers = undefined;
  queryCalls = [];
  lastLinkSearchProps = null;
  nextRowId = 0;
});

afterEach(() => {
  // Several NEO-221 tests drive the armed-bulk debounce on fake timers; a
  // leaked fake clock turns every later `waitFor` in the file into a hang.
  vi.useRealTimers();
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
    renderWizard({ summary: { ...SUMMARY, cardCount: 5 } });

    expect(screen.getByText("All reviewed — save 5 cards?")).toBeTruthy();
  });

  it("uses singular 'card' when cardCount is 1", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    renderWizard({ summary: { ...SUMMARY, cardCount: 1 } });

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
  it("Cancel with NOTHING decided discards straight away — no confirm to read", async () => {
    // The zero-decision case is the one `checklist-fetch-cancel-dialog` walks,
    // and a confirm in front of it would be a question about nothing.
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

  it("Cancel with decisions ASKS FIRST, and cancelling the question keeps the batch", async () => {
    // NEO-220's whole promise: a review session cannot be lost to one click.
    currentRows = [
      makeRow({ decision: { action: "create" } }),
      makeRow({ status: "ready" }),
    ];
    const { onCancel } = renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));

    // The count is in the title, so the operator knows what they are throwing
    // away before they agree to throw it away. Singular, at one decision.
    expect(screen.getByText("Discard 1 decision?")).toBeTruthy();
    expect(mockCancelBatch).not.toHaveBeenCalled();

    // Backing out of the confirm leaves the review exactly where it was.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Discard 1 decision/)).toBeNull();
    expect(mockCancelBatch).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm New Players & Teams")).toBeTruthy();
  });

  it("pluralizes the confirm title", () => {
    currentRows = [
      makeRow({ decision: { action: "create" } }),
      makeRow({ decision: { action: "skip" } }),
      makeRow({ status: "ready" }),
    ];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));
    expect(screen.getByText("Discard 2 decisions?")).toBeTruthy();
  });

  it("confirming the discard cancels the batch and then closes", async () => {
    currentRows = [
      makeRow({ decision: { action: "create" } }),
      makeRow({ status: "ready" }),
    ];
    const { onCancel } = renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));
    fireEvent.click(discardButton());

    await waitFor(() => expect(mockCancelBatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("Cancel on the final all-decided step goes through the same confirm", async () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { onCancel } = renderWizard();

    expect(screen.getByText(/All reviewed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));
    fireEvent.click(discardButton());

    await waitFor(() => expect(mockCancelBatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("does NOT close when cancelBatch rejects — it says the batch is still there", async () => {
    // The inversion NEO-220 makes. `onCancel()` used to live in a `finally`, so
    // a rejected cancel still told the parent "cancelled, nothing saved" while
    // the rows sat on the server: the operator was told a batch was gone that
    // would come straight back on the next sync. Now the failure is reported
    // and the dialog stays put, which is the only honest pair of facts.
    mockCancelBatch.mockRejectedValueOnce(new Error("network down"));
    currentRows = [
      makeRow({ decision: { action: "create" } }),
      makeRow({ status: "ready" }),
    ];
    const { onCancel } = renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));
    fireEvent.click(discardButton());

    const alert = await screen.findByText(/Couldn't discard this review/);
    expect(alert.textContent).toContain("network down");
    expect(alert.textContent).toContain("The batch is still here.");
    expect(onCancel).not.toHaveBeenCalled();
    // Still on screen, still retryable.
    expect(discardButton()).toBeTruthy();
  });

  it("reports a failed zero-decision cancel inline rather than closing", async () => {
    mockCancelBatch.mockRejectedValueOnce(new Error("network down"));
    currentRows = [makeRow({ status: "ready" })];
    const { onCancel } = renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));

    const alert = await screen.findByText(/Couldn't discard this review/);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Escape routes through the same confirm as the Cancel button", () => {
    currentRows = [
      makeRow({ decision: { action: "create" } }),
      makeRow({ status: "ready" }),
    ];
    renderWizard();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.getByText("Discard 1 decision?")).toBeTruthy();
    expect(mockCancelBatch).not.toHaveBeenCalled();
  });

  it("Escape with nothing decided still cancels immediately", async () => {
    currentRows = [makeRow({ status: "ready" })];
    const { onCancel } = renderWizard();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(mockCancelBatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("Escape from inside a text field never reaches the dialog", async () => {
    // NEO-220. The career-team combobox is an editable target, so Escape there
    // is the field's to interpret — it used to bubble out and cancel the batch.
    currentRows = [
      makeRow({ kind: "player", status: "ready", enrichment: { careerTeams: [] } }),
    ];
    const { onCancel } = renderWizard();

    fireEvent.keyDown(screen.getByLabelText("Career team name"), { key: "Escape" });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockCancelBatch).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Escape from a plain field with NO handler of its own still spares the review", async () => {
    // The `Career team name` combobox stops propagation itself, so a test
    // through it proves CareerTeamEntry, not the dialog root. `From year` is a
    // bare `<Input type="number">` with no `onKeyDown` at all, so Escape there
    // reaches the root and only `isEditableTarget` stands between the operator
    // and a discarded batch.
    currentRows = [
      makeRow({ kind: "player", status: "ready", enrichment: { careerTeams: [] } }),
    ];
    const { onCancel } = renderWizard();

    const yearField = screen.getByLabelText("From year");
    expect((yearField as HTMLInputElement).onkeydown).toBeNull();
    fireEvent.keyDown(yearField, { key: "Escape", bubbles: true });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockCancelBatch).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm New Players & Teams")).toBeTruthy();
  });

  it("Escape while the link search is open closes the search, not the review", async () => {
    // One level at a time. The search panel is a level; the batch is not the
    // next one after it.
    currentRows = [makeRow({ kind: "player", status: "ready" })];
    renderWizard();

    fireEvent.click(screen.getByLabelText("Link to existing instead"));
    expect(screen.getByLabelText("Entity link search (stub)")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByLabelText("Entity link search (stub)")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockCancelBatch).not.toHaveBeenCalled();
  });

  it("Escape does nothing while the discard confirm is up", () => {
    // The confirm owns Escape at that point (it cancels itself). A root handler
    // that also fired would open a second confirm behind the first.
    currentRows = [
      makeRow({ decision: { action: "create" } }),
      makeRow({ status: "ready" }),
    ];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));
    // The wizard overlay is the FIRST dialog in the document; the confirm is a
    // sibling rendered after it inside the same portal.
    fireEvent.keyDown(screen.getAllByRole("dialog")[0], { key: "Escape" });

    expect(mockCancelBatch).not.toHaveBeenCalled();
    expect(screen.getByText("Discard 1 decision?")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-220 — Enter no longer reaches past the control it was aimed at
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — Enter", () => {
  it("does NOT commit when Enter is pressed on the focused Cancel button", () => {
    // The defect: a dialog-level Enter handler fired for any target that was
    // not an <input>, so an operator tabbing to Cancel and pressing Enter
    // committed the whole fetch — and then cancelled it. Enter now does only
    // what the focused control does.
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { onConfirm } = renderWizard();

    const cancel = screen.getByRole("button", { name: "Cancel (Esc)" });
    (cancel as HTMLElement).focus();
    fireEvent.keyDown(cancel, { key: "Enter" });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does NOT commit when Enter is pressed on the dialog itself", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { onConfirm } = renderWizard();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("commits on a SYNTHETIC Enter delivered to the focused Confirm button", () => {
    /*
     * THE CI REGRESSION, in one assertion.
     *
     * `checklist-keyboard-only-dialog` taps "Add All Remaining as New", waits
     * for "Confirm & Save (Enter)", and sends `pressKey: Enter`. maestro-web
     * implements that as a constructed KeyboardEvent dispatched at
     * `document.activeElement` — and a synthetic event has NO default action,
     * so a focused <button> is never activated by it. The flow only ever
     * passed because the dialog root committed on Enter from any non-input
     * target; removing that handler (NEO-220 D5, because it also made Enter on
     * the focused CANCEL button commit) took the flow's only working path with
     * it. `fireEvent.keyDown` is the same shape of event.
     */
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { onConfirm } = renderWizard();

    const confirm = screen.getByRole("button", { name: /Confirm & Save/ });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(confirm, { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("carries a UNIQUE id — Maestro re-finds the active element by XPath", () => {
    /*
     * WHY AN id IS A BEHAVIOURAL CONTRACT HERE.
     *
     * maestro-web's `pressKey` does not type into `document.activeElement`. It
     * runs `createXPathFromElement(document.activeElement)`, re-finds the node
     * by that XPath, and sends the key to the match. The generator emits
     * `id("…")` when the element has one and falls back to
     * `tag[@class="…"]` per ancestor otherwise.
     *
     * Confirm & Save and Cancel (Esc) are sibling Radix <Button>s with the
     * IDENTICAL class string — the neon colour is a `data-accent-color`
     * attribute and an inline style, never a class — so the class-based XPath
     * matched BOTH and Selenium returned the first: Cancel. Enter aimed at the
     * correctly-focused Confirm button opened "Discard 1 decision?" instead of
     * committing. The old dialog-level Enter handler hid this by committing
     * from any non-input target, which is the D5 bug that had to go.
     *
     * So: the id must exist, and it must be the only one in the document.
     */
    currentRows = [makeRow({ decision: { action: "create" } })];
    renderWizard();

    const confirm = screen.getByRole("button", { name: "Confirm & Save (Enter)" });
    expect(confirm.id).toBe("entity-review-confirm-save");
    expect(
      document.querySelectorAll("#entity-review-confirm-save"),
    ).toHaveLength(1);
  });

  it("does not give Cancel an id that could shadow it", () => {
    // The sibling that used to win the XPath race. It needs no id of its own —
    // and must not accidentally acquire the Confirm button's.
    currentRows = [makeRow({ decision: { action: "create" } })];
    renderWizard();

    const cancel = screen.getByRole("button", { name: "Cancel (Esc)" });
    expect(cancel.id).not.toBe("entity-review-confirm-save");
  });

  it("prevents the default action so a REAL keypress cannot commit twice", () => {
    // A real browser turns Enter-on-a-button into a click. Without
    // preventDefault the handler above and that click would both fire.
    currentRows = [makeRow({ decision: { action: "create" } })];
    renderWizard();

    const confirm = screen.getByRole("button", { name: /Confirm & Save/ });
    const event = createEvent.keyDown(confirm, { key: "Enter" });
    fireEvent(confirm, event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores Enter on Confirm while the commit is already in flight", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { onConfirm } = renderWizard({ saving: true });

    fireEvent.keyDown(screen.getByRole("button", { name: /Saving/ }), { key: "Enter" });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not commit on Enter aimed at Cancel — the handler is on Confirm alone", async () => {
    // The reason the root-level handler could not simply come back: it fired
    // for any non-input target, so Enter on the focused Cancel button both
    // committed the fetch and cancelled it.
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { onConfirm } = renderWizard();

    const cancel = screen.getByRole("button", { name: "Cancel (Esc)" });
    (cancel as HTMLElement).focus();
    fireEvent.keyDown(cancel, { key: "Enter" });

    expect(onConfirm).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockCancelBatch).not.toHaveBeenCalled();
  });

  it("does not commit on Enter aimed at the dialog root", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { onConfirm } = renderWizard();

    fireEvent.keyDown(screen.getAllByRole("dialog")[0], { key: "Enter" });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("still autofocuses Confirm & Save, which is what makes Enter work", () => {
    // The keyboard contract is unchanged for the operator: reach the final step
    // and Enter saves. It is now the BUTTON's own activation doing it.
    currentRows = [makeRow({ decision: { action: "create" } })];
    renderWizard();

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Confirm & Save/ }),
    );
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
  it("says how many names are still being looked up, and that they are NOT included", async () => {
    // NEO-221. The bulk create used to decide rows whose lookup had not
    // finished — names the operator had never seen, added as new players on
    // the strength of a click that said nothing about them. The server now
    // excludes them, so the button has to say so, or the count silently lies.
    currentRows = [
      makeRow({ status: "ready", name: "A" }),
      makeRow({ status: "pending", name: "B" }),
      makeRow({ status: "pending", name: "C" }),
    ];
    renderWizard();

    const bulk = screen.getByRole("button", { name: "Add All Remaining as New (3)" });
    // The button's own label is JUST the action and its count — no clause. On
    // 1990 Bowman ("(433) — 229 still looking up…") the combined string wrapped
    // to two lines and dragged "Skip Remaining" with it.
    expect(bulk.textContent).toBe("Add All Remaining as New (3)");
    expect(bulk.textContent).not.toContain("still looking up");

    // The clause lives in the footer's own status row instead.
    expect(footerStatusText()).toBe("2 still looking up — wait or skip");

    fireEvent.click(bulk);

    await waitFor(() =>
      expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledWith({
        selectorOptionId: "selopt-1",
        batchId: "batch-1",
      }),
    );
  });

  it("drops the clause entirely when every row has settled", () => {
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "ready" })];
    renderWizard();

    const bulk = screen.getByRole("button", { name: "Add All Remaining as New (2)" });
    expect(bulk.textContent).toBe("Add All Remaining as New (2)");
    // …and the status row is rendered but empty — its height is reserved so
    // row 1 cannot move when a message arrives later.
    expect(footerStatusText()).toBe("");
  });

  it("counts only undecided rows, ignoring ones already decided", () => {
    currentRows = [
      makeRow({ status: "ready", decision: { action: "create" } }),
      makeRow({ status: "ready" }),
      makeRow({ status: "pending" }),
    ];
    renderWizard();

    expect(
      screen.getByRole("button", { name: "Add All Remaining as New (2)" }),
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

    fireEvent.click(screen.getByRole("button", { name: "Add All Remaining as New (2)" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not an admin");
  });

  it("re-enables the button after a failure so the user can retry", async () => {
    currentRows = [makeRow({ status: "ready" })];
    mockRecordAllRemainingAsCreate.mockRejectedValueOnce(new Error("boom"));
    renderWizard();

    const bulk = screen.getByRole("button", {
      name: "Add All Remaining as New (1)",
    }) as HTMLButtonElement;
    fireEvent.click(bulk);

    await screen.findByRole("alert");
    expect(bulk.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEO-221 — "keep adding as their lookups finish"
//
// Excluding pending rows from the bulk create is correct and, on its own,
// turns one click into a click per straggler. Arming a follow-up fixes that
// — and is a client-driven write loop keyed on a reactive query, so the
// security review's bounds (debounce, threshold, cap, disarm-on-rejection)
// are part of the behaviour, not an optimisation on top of it.
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — armed bulk add", () => {
  const wizardEl = () => (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={SUMMARY}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );

  /** [settled-and-decided, then whatever the test wants] */
  const settledA = () =>
    makeRow({ _id: "row-a" as unknown as Id<"entityReviewQueue">, status: "ready", name: "A" });

  it("collapses two rows settling 100ms apart into ONE follow-up call", async () => {
    // The debounce is the bound that matters most: the NEO-99 pool drains five
    // at a time, and without this every drained row would be its own mutation.
    vi.useFakeTimers();
    try {
      currentRows = [
        { ...settledA() },
        makeRow({ _id: "row-b" as unknown as Id<"entityReviewQueue">, status: "pending", name: "B" }),
        makeRow({ _id: "row-c" as unknown as Id<"entityReviewQueue">, status: "pending", name: "C" }),
      ];
      const { rerender } = render(wizardEl());

      fireEvent.click(
        screen.getByRole("button", { name: "Add All Remaining as New (3)" }),
      );
      await act(async () => {});
      expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1);

      // B's lookup lands.
      currentRows = [
        { ...settledA(), decision: { action: "create" } },
        makeRow({ _id: "row-b" as unknown as Id<"entityReviewQueue">, status: "ready", name: "B" }),
        makeRow({ _id: "row-c" as unknown as Id<"entityReviewQueue">, status: "pending", name: "C" }),
      ];
      rerender(wizardEl());

      // …and C's, 100ms later. Both are inside one debounce window.
      act(() => {
        vi.advanceTimersByTime(100);
      });
      currentRows = [
        { ...settledA(), decision: { action: "create" } },
        makeRow({ _id: "row-b" as unknown as Id<"entityReviewQueue">, status: "ready", name: "B" }),
        makeRow({ _id: "row-c" as unknown as Id<"entityReviewQueue">, status: "ready", name: "C" }),
      ];
      rerender(wizardEl());
      expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarms on a rejected follow-up and says it stopped", async () => {
    // One refusal means every retry refuses too, so retrying on a timer would
    // hammer the backend with a call that cannot succeed.
    vi.useFakeTimers();
    try {
      mockRecordAllRemainingAsCreate
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error("not an admin"));

      currentRows = [
        { ...settledA() },
        makeRow({ _id: "row-b" as unknown as Id<"entityReviewQueue">, status: "pending", name: "B" }),
      ];
      const { rerender } = render(wizardEl());

      fireEvent.click(
        screen.getByRole("button", { name: "Add All Remaining as New (2)" }),
      );
      await act(async () => {});
      expect(screen.getByText(/Adding .* as their lookups finish/)).toBeTruthy();

      currentRows = [
        { ...settledA(), decision: { action: "create" } },
        makeRow({ _id: "row-b" as unknown as Id<"entityReviewQueue">, status: "ready", name: "B" }),
      ];
      rerender(wizardEl());
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(2);

      await act(async () => {});
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("not an admin");
      expect(alert.textContent).toContain("Stopped adding automatically");
      // Disarmed: the status line is gone and the bulk buttons are back.
      expect(screen.queryByText(/as their lookups finish/)).toBeNull();

      // …and it does NOT try again on the next tick.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Stop disarms it and cancels the scheduled call", async () => {
    vi.useFakeTimers();
    try {
      currentRows = [
        { ...settledA() },
        makeRow({ _id: "row-b" as unknown as Id<"entityReviewQueue">, status: "pending", name: "B" }),
      ];
      const { rerender } = render(wizardEl());

      fireEvent.click(
        screen.getByRole("button", { name: "Add All Remaining as New (2)" }),
      );
      await act(async () => {});

      currentRows = [
        { ...settledA(), decision: { action: "create" } },
        makeRow({ _id: "row-b" as unknown as Id<"entityReviewQueue">, status: "ready", name: "B" }),
      ];
      rerender(wizardEl());

      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/as their lookups finish/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm at all when nothing is still being looked up", async () => {
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "ready" })];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add All Remaining as New (2)" }));
    await waitFor(() => expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1));

    expect(screen.queryByText(/as their lookups finish/)).toBeNull();
  });

  it("'Skip Remaining' disarms it — that branch means every name, lookups included", async () => {
    vi.useFakeTimers();
    try {
      currentRows = [
        { ...settledA() },
        makeRow({ _id: "row-b" as unknown as Id<"entityReviewQueue">, status: "pending", name: "B" }),
      ];
      const { rerender } = render(wizardEl());

      fireEvent.click(
        screen.getByRole("button", { name: "Add All Remaining as New (2)" }),
      );
      await act(async () => {});
      // Armed — and "Skip Remaining" is STILL live, because row 2 says "wait or
      // skip" and taking the skip away while it says so would advertise an exit
      // and lock it.
      expect(screen.getByText(/as their lookups finish/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Skip Remaining (2)" }));
      await act(async () => {});
      expect(mockRecordAllRemainingAsSkip).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/as their lookups finish/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

    const bulk = screen.getByRole("button", { name: "Skip Remaining (3)" });
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

    expect(
      screen.getByRole("button", { name: "Add All Remaining as New (2)" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip Remaining (2)" })).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "Skip Remaining (2)" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not an admin");
  });

  it("re-enables both bulk buttons after a failure so the user can retry", async () => {
    currentRows = [makeRow({ status: "ready" })];
    mockRecordAllRemainingAsSkip.mockRejectedValueOnce(new Error("boom"));
    renderWizard();

    const skipAll = screen.getByRole("button", {
      name: "Skip Remaining (1)",
    }) as HTMLButtonElement;
    fireEvent.click(skipAll);

    await screen.findByRole("alert");
    expect(skipAll.disabled).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Add All Remaining as New (1)" }) as HTMLButtonElement)
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
        summary={SUMMARY}
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
        summary={SUMMARY}
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
// NEO-221 — the presented row is pinned, and a decision lands on it or nowhere
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — presented row stability", () => {
  const wizardEl = () => (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={SUMMARY}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );

  const rowA = (over: Partial<Row> = {}) =>
    makeRow({
      _id: "row-a" as unknown as Id<"entityReviewQueue">,
      name: "Alpha",
      ...over,
    });
  const rowB = (over: Partial<Row> = {}) =>
    makeRow({
      _id: "row-b" as unknown as Id<"entityReviewQueue">,
      name: "Bravo",
      ...over,
    });

  it("does not swap the row out when an EARLIER sibling's lookup lands", () => {
    // The reordering defect. `current` used to be `rows.find(first settled and
    // undecided)`, so Alpha resolving made Alpha the presented row — mid-
    // sentence, and taking the operator's staged career teams with it.
    currentRows = [rowA({ status: "pending" }), rowB({ status: "ready" })];
    const { rerender } = render(wizardEl());
    expect(screen.getByRole("heading", { level: 3, name: "Bravo" })).toBeTruthy();

    currentRows = [rowA({ status: "ready" }), rowB({ status: "ready" })];
    rerender(wizardEl());

    expect(screen.getByRole("heading", { level: 3, name: "Bravo" })).toBeTruthy();
  });

  it("keeps staged career teams across a sibling's lookup landing", () => {
    // The reset effect is keyed on the presented row id, so a batch update that
    // does not change which row is on screen must not clear the mini-form.
    currentRows = [
      rowA({ status: "pending" }),
      rowB({ kind: "player", status: "ready", enrichment: { careerTeams: [] } }),
    ];
    const { rerender } = render(wizardEl());

    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Toronto Blue Jays" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2023" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));
    expect(screen.getByText(/Toronto Blue Jays \(2023–present\)/)).toBeTruthy();

    currentRows = [
      rowA({ status: "ready" }),
      rowB({ kind: "player", status: "ready", enrichment: { careerTeams: [] } }),
    ];
    rerender(wizardEl());

    expect(screen.getByText(/Toronto Blue Jays \(2023–present\)/)).toBeTruthy();
  });

  it("advances once the presented row is decided", () => {
    currentRows = [rowA({ status: "ready" }), rowB({ status: "ready" })];
    const { rerender } = render(wizardEl());
    expect(screen.getByRole("heading", { level: 3, name: "Alpha" })).toBeTruthy();

    currentRows = [
      rowA({ status: "ready", decision: { action: "create" } }),
      rowB({ status: "ready" }),
    ];
    rerender(wizardEl());

    expect(screen.getByRole("heading", { level: 3, name: "Bravo" })).toBeTruthy();
  });

  it("advances when the presented row disappears from the batch", () => {
    // A resume reconciliation drops rows whose names are no longer incoming.
    currentRows = [rowA({ status: "ready" }), rowB({ status: "ready" })];
    const { rerender } = render(wizardEl());

    currentRows = [rowB({ status: "ready" })];
    rerender(wizardEl());

    expect(screen.getByRole("heading", { level: 3, name: "Bravo" })).toBeTruthy();
  });
});

describe("EntityReviewWizard — one decision at a time", () => {
  it("a double click records EXACTLY ONE decision", async () => {
    // The guard has to be a ref. Two clicks in one frame share a render
    // closure, so a `deciding` STATE read is false for both and issues two
    // mutations — which is how a row got decided twice and, on a slow link, how
    // the second landed after the presentation had already moved on.
    const row = makeRow({ kind: "player", status: "ready" });
    currentRows = [row];
    let resolveDecision: (v: unknown) => void = () => {};
    mockRecordDecision.mockImplementationOnce(
      () => new Promise((res) => (resolveDecision = res)),
    );
    renderWizard();

    // BOTH CLICKS IN ONE `act`. Separate `act`s let React commit the state
    // update from the first click before the second handler runs, so a
    // `deciding` STATE flag would pass this test while still failing in a
    // browser — where two clicks in the same frame share one render closure.
    // Nested `act` does not flush, so this is the real double-click.
    const add = screen.getByRole("button", { name: "Add as New Player" });
    act(() => {
      fireEvent.click(add);
      fireEvent.click(add);
    });

    expect(mockRecordDecision).toHaveBeenCalledTimes(1);

    resolveDecision(null);
    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalledTimes(1));
  });

  it("marks the decision controls aria-disabled — never native disabled — while in flight", () => {
    // Native `disabled` drops a button out of the tab order, so a keyboard
    // operator who had tabbed to it is thrown back to the top of the document
    // for the length of the round-trip (WCAG 2.2 SC 2.4.3). NeonButton already
    // paints aria-disabled the same way.
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    mockRecordDecision.mockImplementationOnce(() => new Promise(() => {}));
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    for (const name of [
      "Add as New Player",
      "Link to existing instead",
      "Skip Mike Trout — not a person",
    ]) {
      const control = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.disabled).toBe(false);
    }
  });

  it("a second control is inert while the first decision is in flight", () => {
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    mockRecordDecision.mockImplementationOnce(() => new Promise(() => {}));
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip Mike Trout — not a person" }));

    expect(mockRecordDecision).toHaveBeenCalledTimes(1);
    expect(mockRecordDecision.mock.calls[0][0].action).toBe("create");
  });

  it("shows a rejected decision inline and leaves the row undecided", async () => {
    // `recordDecision` throws BEFORE it patches, so the row really is still
    // waiting on a decision — and the same three controls are still the way
    // forward. Swallowing this (the old `void handleLink(...)`) made a failed
    // link look exactly like a successful one.
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    mockRecordDecision.mockRejectedValueOnce(new Error("sport mismatch"));
    renderWizard();

    fireEvent.click(screen.getByLabelText("Link to existing instead"));
    fireEvent.click(screen.getByText("Stub link select"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("sport mismatch");
    expect(alert.textContent).toContain("still waiting on a decision");

    // Still the same row, and the search stays open so the operator can pick a
    // different target without retracing their steps.
    expect(screen.getByRole("heading", { level: 3, name: "Mike Trout" })).toBeTruthy();
    expect(screen.getByLabelText("Entity link search (stub)")).toBeTruthy();

    // Backing out of the search returns the three decision controls, because
    // the row is genuinely still undecided.
    fireEvent.keyDown(screen.getAllByRole("dialog")[0], { key: "Escape" });
    expect(screen.getByRole("button", { name: "Add as New Player" })).toBeTruthy();
  });

  it("clears the inline error when the next decision is attempted", async () => {
    currentRows = [makeRow({ kind: "player", name: "Mike Trout", status: "ready" })];
    mockRecordDecision.mockRejectedValueOnce(new Error("sport mismatch"));
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));
    await waitFor(() => expect(screen.queryByText(/sport mismatch/)).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// NEO-221 — back-navigation and the decided list
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — back and re-decide", () => {
  const wizardEl = () => (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={SUMMARY}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );

  const alpha = (over: Partial<Row> = {}) =>
    makeRow({
      _id: "row-a" as unknown as Id<"entityReviewQueue">,
      name: "Alpha",
      kind: "player",
      status: "ready",
      ...over,
    });
  const bravo = (over: Partial<Row> = {}) =>
    makeRow({
      _id: "row-b" as unknown as Id<"entityReviewQueue">,
      name: "Bravo",
      kind: "player",
      status: "ready",
      ...over,
    });

  it("offers no Back until something has been decided this session", () => {
    currentRows = [alpha(), bravo()];
    renderWizard();

    expect(screen.queryByLabelText("Back to previous decision")).toBeNull();
  });

  it("Back presents the last decided row read-only, with no way to decide it twice", async () => {
    currentRows = [alpha(), bravo()];
    const { rerender } = render(wizardEl());

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));
    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalledTimes(1));

    currentRows = [alpha({ decision: { action: "create" } }), bravo()];
    rerender(wizardEl());
    expect(screen.getByRole("heading", { level: 3, name: "Bravo" })).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Back to previous decision"));

    expect(screen.getByRole("heading", { level: 3, name: "Alpha" })).toBeTruthy();
    const panel = screen.getByRole("group", { name: "Decision for Alpha" });
    expect(within(panel).getByText("Added as new")).toBeTruthy();
    // Read-only: the decision controls are gone, so there is nothing to press
    // that would silently overwrite a decision the operator is inspecting.
    expect(screen.queryByRole("button", { name: "Add as New Player" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change decision" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
  });

  it("the presented decided row does NOT auto-advance when the batch updates", async () => {
    // The `explicit` half of the nav rule. Without it the read-only panel would
    // be swept away by the next reactive update, because the row it shows is
    // decided and the derived rule only ever presents undecided rows.
    currentRows = [alpha(), bravo()];
    const { rerender } = render(wizardEl());

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));
    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalledTimes(1));
    currentRows = [alpha({ decision: { action: "create" } }), bravo()];
    rerender(wizardEl());
    fireEvent.click(screen.getByLabelText("Back to previous decision"));

    // A lookup lands elsewhere in the batch.
    currentRows = [
      alpha({ decision: { action: "create" } }),
      bravo({ enrichment: { description: "arrived late" } }),
    ];
    rerender(wizardEl());

    expect(screen.getByRole("heading", { level: 3, name: "Alpha" })).toBeTruthy();
  });

  it("'Change decision' calls clearDecision for that row", async () => {
    currentRows = [alpha(), bravo()];
    const { rerender } = render(wizardEl());

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));
    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalledTimes(1));
    currentRows = [alpha({ decision: { action: "create" } }), bravo()];
    rerender(wizardEl());
    fireEvent.click(screen.getByLabelText("Back to previous decision"));

    fireEvent.click(screen.getByRole("button", { name: "Change decision" }));

    await waitFor(() =>
      expect(mockClearDecision).toHaveBeenCalledWith({ reviewRowId: "row-a" }),
    );
  });

  it("a cleared row becomes decidable again, in place", async () => {
    currentRows = [alpha({ decision: { action: "create" } }), bravo()];
    const { rerender } = render(wizardEl());

    fireEvent.click(screen.getByRole("button", { name: "Change decision for Alpha" }));
    await waitFor(() => expect(mockClearDecision).toHaveBeenCalledTimes(1));

    currentRows = [alpha(), bravo()];
    rerender(wizardEl());

    // Alpha stays presented (explicitly) rather than the wizard walking off to
    // Bravo, so the operator lands on the row they asked to change.
    expect(screen.getByRole("heading", { level: 3, name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add as New Player" })).toBeTruthy();
  });

  it("'Next' hands navigation back to the wizard", async () => {
    currentRows = [alpha(), bravo()];
    const { rerender } = render(wizardEl());

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));
    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalledTimes(1));
    currentRows = [alpha({ decision: { action: "create" } }), bravo()];
    rerender(wizardEl());
    fireEvent.click(screen.getByLabelText("Back to previous decision"));
    expect(screen.getByRole("heading", { level: 3, name: "Alpha" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("heading", { level: 3, name: "Bravo" })).toBeTruthy();
  });

  it("lists every decided row with what it was decided as", () => {
    currentLinkedPlayers = [{ _id: "p1", name: "Michael Trout" }];
    currentRows = [
      alpha({ decision: { action: "create" } }),
      bravo({ decision: { action: "link", linkedPlayerId: "p1" } }),
      makeRow({ _id: "row-c" as unknown as Id<"entityReviewQueue">, name: "Charlie", status: "ready", decision: { action: "skip" } }),
    ];
    renderWizard();

    const list = screen.getByRole("list", { name: "Decided names" });
    expect(list.textContent).toContain("Alpha");
    expect(list.textContent).toContain("Added as new");
    expect(list.textContent).toContain("Linked to Michael Trout");
    expect(list.textContent).toContain("Skipped");
  });

  it("never renders the live control's 'Link to {name}' name in the decided list", () => {
    // Two controls sharing that accessible name is ambiguous to a screen reader
    // and to a Maestro `tapOn` alike, so the history reads in the past tense.
    currentLinkedPlayers = [{ _id: "p1", name: "Michael Trout" }];
    currentRows = [
      alpha({ decision: { action: "link", linkedPlayerId: "p1" } }),
      bravo(),
    ];
    renderWizard();

    expect(screen.queryByLabelText("Link to Michael Trout")).toBeNull();
    expect(screen.getByRole("list", { name: "Decided names" }).textContent).toContain(
      "Linked to Michael Trout",
    );
  });

  it("collapses the decided list past five entries", () => {
    currentRows = [
      ...Array.from({ length: 6 }, (_, i) =>
        makeRow({
          _id: `row-${i}` as unknown as Id<"entityReviewQueue">,
          name: `Name ${i}`,
          status: "ready",
          decision: { action: "create" },
        }),
      ),
      bravo(),
    ];
    renderWizard();

    const disclosure = screen.getByText("Decided (6)").closest("details") as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
  });

  it("leaves a short decided list open", () => {
    currentRows = [alpha({ decision: { action: "create" } }), bravo()];
    renderWizard();

    const disclosure = screen.getByText("Decided (1)").closest("details") as HTMLDetailsElement;
    expect(disclosure.open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEO-220 — the final step says what it is about to do
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — final-step summary", () => {
  it("itemises the commit as a definition list", () => {
    // The card count alone never mentioned the deletes, the field updates or
    // the new player/team rows, so the one irreversible step in the flow was
    // also the least specific screen in it.
    currentRows = [
      makeRow({ name: "A", decision: { action: "create" } }),
      makeRow({ name: "B", decision: { action: "link", linkedTeamId: "t1" } }),
      makeRow({ name: "C", decision: { action: "skip" } }),
    ];
    renderWizard({
      summary: { cardCount: 12, deleteCount: 2, reviewDecisionCount: 3 },
    });

    // Heading unchanged — "All reviewed" and the card count are E2E matchers.
    expect(screen.getByText("All reviewed — save 12 cards?")).toBeTruthy();

    const pairs = Array.from(document.querySelectorAll("dt")).map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(pairs).toEqual([
      ["Cards to save", "12"],
      ["Cards to delete", "2"],
      ["Cards with field updates", "3"],
      ["New players and teams", "1"],
      ["Linked to existing", "1"],
      ["Skipped as not a name", "1"],
    ]);
  });

  it("omits every zero except the card count — a list of noughts buries the rest", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    renderWizard({ summary: { cardCount: 4, deleteCount: 0, reviewDecisionCount: 0 } });

    const terms = Array.from(document.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(terms).toEqual(["Cards to save", "New players and teams"]);
  });

  it("still shows the card count when it is zero", () => {
    // A checklist fetch that only deletes is a real case, and "save 0 cards" is
    // the honest heading for it.
    currentRows = [makeRow({ decision: { action: "skip" } })];
    renderWizard({ summary: { cardCount: 0, deleteCount: 5, reviewDecisionCount: 0 } });

    expect(screen.getByText("All reviewed — save 0 cards?")).toBeTruthy();
    const terms = Array.from(document.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(terms).toEqual(["Cards to save", "Cards to delete", "Skipped as not a name"]);
  });
});

// ---------------------------------------------------------------------------
// NEO-220 — a failed commit is recoverable
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — commit failure", () => {
  it("shows the error with a retry and a way back, and hides the duplicate confirm", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    const onDismissCommitError = vi.fn();
    renderWizard({
      commitError: "Commit failed: conflicting card numbers",
      onDismissCommitError,
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Commit failed: conflicting card numbers");
    expect(alert.textContent).toContain("Every decision you made is still here.");

    // One control per action: the footer's Confirm & Save stands down while the
    // inline Retry is up, so the operator is not choosing between two buttons
    // that do the same thing under different names.
    expect(screen.getByRole("button", { name: "Retry commit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Confirm & Save/ })).toBeNull();
  });

  it("Retry commit calls onConfirm again", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { onConfirm } = renderWizard({ commitError: "Commit failed: timeout" });

    fireEvent.click(screen.getByRole("button", { name: "Retry commit" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Back to review dismisses the error", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    const onDismissCommitError = vi.fn();
    renderWizard({ commitError: "Commit failed: timeout", onDismissCommitError });

    fireEvent.click(screen.getByRole("button", { name: "Back to review" }));

    expect(onDismissCommitError).toHaveBeenCalledTimes(1);
  });

  it("renders nothing extra when there is no commit error", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    renderWizard();

    expect(screen.queryByRole("button", { name: "Retry commit" })).toBeNull();
    expect(screen.getByRole("button", { name: /Confirm & Save/ })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-221 (D13) — the batch was swept out from under the wizard
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — expired session", () => {
  const wizardEl = (props: Partial<Parameters<typeof EntityReviewWizard>[0]> = {}) => (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={SUMMARY}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...props}
    />
  );

  it("says the session expired once the batch it had is emptied", () => {
    // `sweepAbandonedBatches` deletes a batch nobody has touched for a day. A
    // wizard left open on it used to sit on an empty list whose Confirm & Save
    // would commit nothing at all.
    currentRows = [makeRow({ status: "ready" })];
    const { rerender } = render(wizardEl());

    currentRows = [];
    rerender(wizardEl());

    expect(
      screen.getByText("This review session has expired — re-sync to start again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    // Nothing to decide, nothing to discard: the review controls are gone.
    expect(screen.queryByRole("button", { name: "Cancel (Esc)" })).toBeNull();
    expect(screen.queryByText(/Add All Remaining as New/)).toBeNull();
  });

  it("Close reports back without pretending to cancel a batch that is gone", () => {
    currentRows = [makeRow({ status: "ready" })];
    const onCancel = vi.fn();
    const { rerender } = render(wizardEl({ onCancel }));

    currentRows = [];
    rerender(wizardEl({ onCancel }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mockCancelBatch).not.toHaveBeenCalled();
  });

  it("does NOT claim expiry for a batch that was empty from the start", () => {
    // An empty batch before any row has ever arrived is a race with startBatch,
    // not an expiry, and calling it one would be a scary lie about fresh work.
    currentRows = [];
    renderWizard();

    expect(screen.queryByText(/expired/)).toBeNull();
  });

  it("does NOT claim expiry while the commit that consumes the rows is in flight", () => {
    // Commit deletes the batch rows on its way out, so `saving` is exactly the
    // window where an emptied batch is expected rather than abandoned.
    currentRows = [makeRow({ decision: { action: "create" } })];
    const { rerender } = render(wizardEl({ saving: true }));

    currentRows = [];
    rerender(wizardEl({ saving: true }));

    expect(screen.queryByText(/expired/)).toBeNull();
  });

  it("does NOT claim expiry after the operator's own cancel emptied it", async () => {
    currentRows = [makeRow({ status: "ready" })];
    const onCancel = vi.fn();
    const { rerender } = render(wizardEl({ onCancel }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel (Esc)" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));

    currentRows = [];
    rerender(wizardEl({ onCancel }));

    expect(screen.queryByText(/expired/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEO-220 — "Back to matching", the non-destructive way out
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — back to matching", () => {
  it("offers it only when the parent has a matching session to return to", () => {
    currentRows = [makeRow({ status: "ready" })];
    const { unmount } = renderWizard();
    expect(screen.queryByRole("button", { name: "Back to matching" })).toBeNull();
    // …and Cancel is still the only way out on the custom-subtree path.
    expect(screen.getByRole("button", { name: "Cancel (Esc)" })).toBeTruthy();
    unmount();

    currentRows = [makeRow({ status: "ready" })];
    renderWizard({ onBack: vi.fn() });
    expect(screen.getByRole("button", { name: "Back to matching" })).toBeTruthy();
  });

  it("goes back WITHOUT discarding the batch", async () => {
    // The difference between this and Cancel is the whole point: card matching
    // and entity review are two halves of one fetch, and stepping between them
    // must not throw either half away.
    currentRows = [
      makeRow({ decision: { action: "create" } }),
      makeRow({ status: "ready" }),
    ];
    const onBack = vi.fn();
    const { onCancel } = renderWizard({ onBack });

    fireEvent.click(screen.getByRole("button", { name: "Back to matching" }));

    expect(onBack).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockCancelBatch).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    // No confirm either — nothing is being discarded.
    expect(screen.queryByText(/Discard/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Correctness review follow-ups (NEO-221)
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — re-deciding releases the pin", () => {
  const wizardEl = () => (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={SUMMARY}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );

  const alpha = (over: Partial<Row> = {}) =>
    makeRow({
      _id: "row-a" as unknown as Id<"entityReviewQueue">,
      name: "Alpha",
      kind: "player",
      status: "ready",
      ...over,
    });
  const bravo = (over: Partial<Row> = {}) =>
    makeRow({
      _id: "row-b" as unknown as Id<"entityReviewQueue">,
      name: "Bravo",
      kind: "player",
      status: "ready",
      ...over,
    });

  it("moves on to the next undecided row after a re-decide", async () => {
    // `resolveNav` pins an EXPLICIT row even once it is decided — that is what
    // the read-only panel is built on. Deciding it is the operator finishing
    // with it, so the pin has to be released or they re-decide the same row
    // into a panel that just says "Already decided".
    currentRows = [alpha({ decision: { action: "create" } }), bravo()];
    const { rerender } = render(wizardEl());

    fireEvent.click(screen.getByRole("button", { name: "Change decision for Alpha" }));
    await waitFor(() => expect(mockClearDecision).toHaveBeenCalledTimes(1));

    currentRows = [alpha(), bravo()];
    rerender(wizardEl());
    expect(screen.getByRole("heading", { level: 3, name: "Alpha" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));
    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalledTimes(1));

    currentRows = [alpha({ decision: { action: "skip" } }), bravo()];
    rerender(wizardEl());

    expect(screen.getByRole("heading", { level: 3, name: "Bravo" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Decision for Alpha" })).toBeNull();
  });

  it("reaches the final summary when the re-decided row was the LAST one", async () => {
    // The worst shape of the same bug: `current` non-null beats `allDecided`,
    // so the summary <dl> never rendered while Confirm & Save sat autofocused
    // behind a panel that offered no way to reach it but "Next".
    currentRows = [alpha({ decision: { action: "create" } })];
    const { rerender } = render(wizardEl());

    fireEvent.click(screen.getByRole("button", { name: "Change decision for Alpha" }));
    await waitFor(() => expect(mockClearDecision).toHaveBeenCalledTimes(1));
    currentRows = [alpha()];
    rerender(wizardEl());

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));
    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalledTimes(1));
    currentRows = [alpha({ decision: { action: "create" } })];
    rerender(wizardEl());

    expect(screen.getByText("All reviewed — save 3 cards?")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Confirm & Save/ })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Decision for Alpha" })).toBeNull();
  });

  it("'Change decision' KEEPS the pin — that is the case the operator asked for", async () => {
    // The mirror image, so the fix above cannot be widened into the clear path
    // by accident: after a clear the operator must land on the row they
    // reopened, not be walked past it.
    currentRows = [alpha({ decision: { action: "create" } }), bravo()];
    const { rerender } = render(wizardEl());

    fireEvent.click(screen.getByRole("button", { name: "Change decision for Alpha" }));
    await waitFor(() => expect(mockClearDecision).toHaveBeenCalledTimes(1));
    currentRows = [alpha(), bravo()];
    rerender(wizardEl());

    expect(screen.getByRole("heading", { level: 3, name: "Alpha" })).toBeTruthy();
  });

  it("ignores 'Change decision' on another row while a write is in flight", async () => {
    // `decide` refuses on `decidingRef` — and it refuses AFTER this handler has
    // already moved `nav`. Without its own copy of the guard, the second click
    // pinned Bravo showing the very decision its clear was meant to remove,
    // with no clear ever sent and nothing on screen saying so.
    currentRows = [
      alpha({ decision: { action: "create" } }),
      bravo({ decision: { action: "skip" } }),
    ];
    mockClearDecision.mockImplementationOnce(() => new Promise(() => {}));
    render(wizardEl());

    // First click pins Alpha and hangs on the clear.
    fireEvent.click(screen.getByRole("button", { name: "Change decision for Alpha" }));
    expect(mockClearDecision).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("group", { name: "Decision for Alpha" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Change decision for Bravo" }));

    expect(mockClearDecision).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("group", { name: "Decision for Alpha" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Decision for Bravo" })).toBeNull();
  });
});

describe("EntityReviewWizard — armed bulk add does not stall", () => {
  const wizardEl = () => (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={SUMMARY}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );

  it("picks up a row that settled DURING an in-flight bulk call", async () => {
    // The stall: the effect used to return when `bulkRef.current` was set, so
    // a settle landing inside the round-trip scheduled nothing and the footer
    // sat on "Adding N more…" forever with no timer and no further call.
    vi.useFakeTimers();
    try {
      let releaseFirst: (v: unknown) => void = () => {};
      mockRecordAllRemainingAsCreate.mockImplementationOnce(
        () => new Promise((res) => (releaseFirst = res)),
      );

      currentRows = [
        makeRow({ _id: "row-a" as unknown as Id<"entityReviewQueue">, status: "ready", name: "A" }),
        makeRow({ _id: "row-b" as unknown as Id<"entityReviewQueue">, status: "pending", name: "B" }),
      ];
      const { rerender } = render(wizardEl());

      fireEvent.click(
        screen.getByRole("button", { name: "Add All Remaining as New (2)" }),
      );
      expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1);

      // B settles while that first call is still open.
      currentRows = [
        makeRow({ _id: "row-a" as unknown as Id<"entityReviewQueue">, status: "ready", name: "A" }),
        makeRow({ _id: "row-b" as unknown as Id<"entityReviewQueue">, status: "ready", name: "B" }),
      ];
      rerender(wizardEl());

      releaseFirst(1);
      await act(async () => {});

      act(() => {
        vi.advanceTimersByTime(1500);
      });

      expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});


// ---------------------------------------------------------------------------
// The keyboard-only flow, end to end (checklist-keyboard-only-dialog)
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — keyboard-only bulk-then-commit", () => {
  const wizardEl = (props: Partial<Parameters<typeof EntityReviewWizard>[0]> = {}) => (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={SUMMARY}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...props}
    />
  );

  const solo = (over: Partial<Row> = {}) =>
    makeRow({
      _id: "row-solo" as unknown as Id<"entityReviewQueue">,
      name: "Solo",
      kind: "player",
      status: "ready",
      ...over,
    });

  it("tap the bulk button, then Enter, and the commit runs", async () => {
    // The exact CI shape: ONE already-settled unknown, so the bulk decides it
    // immediately with no arming, "Confirm & Save (Enter)" renders, and the
    // driver sends a synthetic Enter to whatever has focus.
    const onConfirm = vi.fn();
    currentRows = [solo()];
    const { rerender } = render(wizardEl({ onConfirm }));

    const bulk = screen.getByRole("button", { name: "Add All Remaining as New (1)" });
    // Tapping it is what puts focus on it — and what makes it unmount a moment
    // later, which is why the autofocus below has to be doing real work.
    (bulk as HTMLElement).focus();
    fireEvent.click(bulk);
    await waitFor(() => expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1));

    currentRows = [solo({ decision: { action: "create" } })];
    rerender(wizardEl({ onConfirm }));

    const confirm = screen.getByRole("button", { name: "Confirm & Save (Enter)" });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("recovers focus after the tapped bulk button unmounts under it", async () => {
    // Belt to the fix's braces. Tapping the bulk button drops focus to <body>
    // the instant the footer swaps, so the `allDecided` autofocus effect is the
    // only thing that puts a target under the operator's next keystroke.
    currentRows = [solo()];
    const { rerender } = render(wizardEl());

    const bulk = screen.getByRole("button", { name: "Add All Remaining as New (1)" });
    (bulk as HTMLElement).focus();
    fireEvent.click(bulk);
    await waitFor(() => expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1));

    currentRows = [solo({ decision: { action: "create" } })];
    rerender(wizardEl());

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Confirm & Save (Enter)" }),
    );
  });
});

// ---------------------------------------------------------------------------
// NEO-220 — the footer is two fixed rows
//
// Jason hit this on 1990 Bowman: 433 unknowns, 229 of them still being looked
// up. The bulk button's label was "Add All Remaining as New (433) — 229 still
// looking up, wait or skip", which wrapped to two centred lines, dragged
// "Skip Remaining (433)" onto a second line with it, and left both sitting
// crookedly beside "Back to matching" and "Cancel (Esc)".
//
// A label whose LENGTH tracks a COUNT THAT CHANGES is the NEO-110 reflow class
// at a smaller scale: the control's height moves under the cursor between a
// Maestro read and the click that follows it.
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — footer layout", () => {
  const wizardEl = (props: Partial<Parameters<typeof EntityReviewWizard>[0]> = {}) => (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={SUMMARY}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...props}
    />
  );

  /** [row 1, row 2] — the footer's shape IS the contract. */
  function footerRows(): { actions: HTMLElement; status: HTMLElement } {
    const overlay = document.querySelector('[role="dialog"]');
    if (!overlay) throw new Error("wizard overlay not found");
    const footer = (overlay.firstElementChild as HTMLElement).children[2] as HTMLElement;
    const [actions, status] = Array.from(footer.children) as HTMLElement[];
    if (!actions || !status || footer.children.length !== 2) {
      throw new Error(`footer must be exactly two rows; got ${footer.children.length}`);
    }
    return { actions, status };
  }

  it("renders the status row even with nothing to say, at a reserved height", () => {
    // The whole reason it is always mounted: if it appeared only when it had
    // text, the footer would grow the moment a lookup started and row 1 would
    // move — which is the defect, arriving from the other direction.
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "ready" })];
    renderWizard();

    const { status } = footerRows();
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent?.trim()).toBe("");
    // `min-h-4` is one text-xs line — the reservation itself.
    expect(status.className).toContain("min-h-4");
  });

  it("keeps the status row present on the final step too", () => {
    currentRows = [makeRow({ decision: { action: "create" } })];
    renderWizard();

    expect(footerRows().status.getAttribute("role")).toBe("status");
    expect(footerStatusText()).toBe("");
  });

  it("puts the pending clause in the status row, never in the button", () => {
    // The 1990 Bowman shape, at test scale.
    currentRows = [
      makeRow({ status: "ready" }),
      ...Array.from({ length: 4 }, (_, i) =>
        makeRow({ _id: `p-${i}` as unknown as Id<"entityReviewQueue">, status: "pending" }),
      ),
    ];
    renderWizard();

    const { actions, status } = footerRows();
    const bulk = screen.getByRole("button", { name: "Add All Remaining as New (5)" });

    expect(actions.contains(bulk)).toBe(true);
    expect(status.contains(bulk)).toBe(false);
    expect(bulk.textContent).toBe("Add All Remaining as New (5)");
    expect(footerStatusText()).toBe("4 still looking up — wait or skip");
  });

  it("keeps both bulk links on one line — they may not wrap", () => {
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "pending" })];
    renderWizard();

    const { actions } = footerRows();
    const left = actions.firstElementChild as HTMLElement;
    expect(left.className).toContain("whitespace-nowrap");
    // The buttons never yield; the links are what clips if it ever comes to it.
    const right = actions.lastElementChild as HTMLElement;
    expect(right.className).toContain("shrink-0");
    expect(left.className).toContain("min-w-0");
  });

  it("aligns the buttons to row 1, not across both rows", () => {
    currentRows = [makeRow({ status: "ready" })];
    renderWizard({ onBack: vi.fn() });

    const { actions, status } = footerRows();
    for (const name of ["Back to matching", "Cancel (Esc)"]) {
      const button = screen.getByRole("button", { name });
      expect(actions.contains(button)).toBe(true);
      expect(status.contains(button)).toBe(false);
    }
  });

  it("dims the bulk create rather than unmounting it while the auto-add is armed", async () => {
    // Unmounting it would move everything to its right. `aria-disabled`, not
    // `disabled`, so a keyboard operator who tabbed here is not ejected.
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "pending" })];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add All Remaining as New (2)" }));
    await waitFor(() => expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1));

    const bulk = screen.getByRole("button", {
      name: "Add All Remaining as New (2)",
    }) as HTMLButtonElement;
    expect(bulk.getAttribute("aria-disabled")).toBe("true");
    expect(bulk.className).toContain("aria-disabled:opacity-50");
    expect(footerStatusText()).toContain("Adding 2 more as their lookups finish…");
  });

  it("keeps Skip Remaining live while armed — row 2 offers it by name", async () => {
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "pending" })];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add All Remaining as New (2)" }));
    await waitFor(() => expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1));

    const skip = screen.getByRole("button", {
      name: "Skip Remaining (2)",
    }) as HTMLButtonElement;
    expect(skip.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(skip);
    await waitFor(() => expect(mockRecordAllRemainingAsSkip).toHaveBeenCalledTimes(1));
  });

  it("puts Stop in the status row beside the message it belongs to", async () => {
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "pending" })];
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add All Remaining as New (2)" }));
    await waitFor(() => expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1));

    const { actions, status } = footerRows();
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(status.contains(stop)).toBe(true);
    expect(actions.contains(stop)).toBe(false);
    // a11y 2.5.8: the p-2 -m-2 target growth, which cannot change row height.
    expect(stop.className).toContain("p-2");
    expect(stop.className).toContain("-m-2");
  });

  it("shows no status and no Stop once nothing is pending", () => {
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "ready" })];
    renderWizard();

    expect(footerStatusText()).toBe("");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("EntityReviewWizard — armed bulk create is inert", () => {
  it("a second click on the dimmed create link issues nothing", async () => {
    currentRows = [makeRow({ status: "ready" }), makeRow({ status: "pending" })];
    renderWizard();

    const bulk = screen.getByRole("button", { name: "Add All Remaining as New (2)" });
    fireEvent.click(bulk);
    await waitFor(() => expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1));

    // Armed and aria-disabled, so the click is a no-op — the button says so and
    // behaves that way, rather than quietly issuing a duplicate.
    fireEvent.click(screen.getByRole("button", { name: "Add All Remaining as New (2)" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRecordAllRemainingAsCreate).toHaveBeenCalledTimes(1);
  });
});
