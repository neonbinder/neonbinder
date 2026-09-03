/**
 * NEO-189 regression — cancelling the pairing dialog mid-fetch must stick.
 *
 * Before `syncGenerationRef`, `handleSync` only reacted to the fetch action's
 * result AFTER it resolved. Streaming (NEO-195) made the pairing modal open
 * seconds into the fetch instead of ~80s later, so Cancel now routinely lands
 * while `fetchChecklist` is still in flight. Without a guard, that action's
 * eventual (late) resolution unconditionally reopened the dialog and
 * overwrote "Sync cancelled — no cards saved." with its own result — an
 * operator who declined a sync and walked away would return to a re-opened
 * Confirm dialog on a checklist they had already refused.
 *
 * `syncGenerationRef` is bumped by Cancel; the run captures its own
 * generation before awaiting, and after the await a stale generation makes it
 * return without touching state (including the `finally` clearing
 * `syncing`/`fetchInFlight` only when still current).
 *
 * This file pins: a cancel that lands while `fetchChecklist` is in flight
 * survives that fetch resolving afterwards — the dialog does not reopen and
 * the cancelled message stands.
 *
 * It also pins the three things the fetch action's RETURN used to be
 * responsible for, now that it returns only `{ success, message,
 * candidateCount }` and the cards travel solely on the streamed
 * `getReadyCandidates` subscription:
 *
 *   - the dialog SURVIVES the action resolving (it used to hand over to
 *     `pendingPairing`, a second complete copy of the same rows; nothing
 *     hands over any more, so the stream has to keep it open by itself);
 *   - a run that produces no candidates still skips the dialog and goes
 *     straight to entity resolution, keyed on the sport row read off the
 *     ancestor chain rather than off the action's return;
 *   - a failed run closes the dialog rather than leaving a partial batch
 *     sitting there confirmable.
 *
 * --- Mocking strategy ---
 * convex/react's useQuery/useMutation/useAction are module-mocked and routed
 * by the (string-mocked) query/mutation/action reference, mirroring
 * EntityColumn.ensure-sync.test.tsx. `fetchCardChecklist` resolves via a
 * manually-controlled deferred promise so the test can cancel before it
 * settles and then settle it afterward to prove the late result is dropped.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getCardChecklist: "getCardChecklist",
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      fetchCardChecklist: "fetchCardChecklist",
      resolveChecklistEntities: "resolveChecklistEntities",
      commitCardChecklist: "commitCardChecklist",
      addCustomCard: "addCustomCard",
      // Referenced by CrossListingImportModal, which CardChecklist always
      // mounts (isOpen=false). Never asserted on here.
      getSelectorOptions: "getSelectorOptions",
      addCrossListingsByCardNumbers: "addCrossListingsByCardNumbers",
    },
    checklistCandidates: {
      getReadyCandidates: "getReadyCandidates",
      discardCandidates: "discardCandidates",
    },
    // NEO-102: reached once real card rows render (CardChecklistItem's team
    // sub-line, TeamPicker inside the attention walker's fixer) or the walker
    // opens. Routed through the same string-reference mock as everything else.
    teams: {
      getManyByIds: "teams.getManyByIds",
      list: "teams.list",
      findOrCreate: "teams.findOrCreate",
    },
    players: { getManyByIds: "players.getManyByIds" },
    cardChecklist: {
      suggestedTeamsForCard: "cardChecklist.suggestedTeamsForCard",
      confirmCardNoTeam: "cardChecklist.confirmCardNoTeam",
    },
  },
}));

/**
 * NEO-102 — Virtuoso renders nothing measurable under jsdom (no layout), so
 * the attention tests below could not see a card row through it. Replaced with
 * a plain map, which is what the row-level assertions actually need. Every
 * pre-existing test in this file drives the zero-candidate path with
 * `state.cards = []`, so this changes nothing for them.
 */
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => <div>{data.map((item, i) => <div key={i}>{itemContent(i, item)}</div>)}</div>,
}));

/**
 * NEO-102 (CI round 2): the entity-review wizard is stubbed down to its Cancel
 * button. Only ONE thing about it matters here — what CardChecklist's banner
 * says after `onCancel` fires — and the real wizard would drag in the whole
 * `entityReviewQueue` query/mutation surface to prove a fact about its parent.
 * Its own behaviour is covered by EntityReviewWizard.test.tsx.
 */
vi.mock("./EntityReviewWizard", () => ({
  default: ({ onCancel }: { onCancel: () => void }) => (
    <button type="button" onClick={onCancel}>
      Cancel entity review
    </button>
  ),
}));

const mockFetchChecklist = vi.fn();
const mockResolveEntities = vi.fn();
const mockCommitChecklist = vi.fn();
const mockDiffChecklist = vi.fn();
const mockDiscardCandidates = vi.fn();

// Mutable holders read lazily by the mocked hooks at call time — same shape
// as EntityColumn.ensure-sync.test.tsx's `state`.
const state: {
  cards: unknown;
  variantRow: unknown;
  ancestorChain: unknown;
  liveCandidates: unknown;
} = {
  cards: [],
  variantRow: { value: "Test Set" },
  ancestorChain: [],
  liveCandidates: null,
};

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "getCardChecklist") return state.cards;
    if (ref === "getSelectorOptionById") return state.variantRow;
    if (ref === "getAncestorChain") return state.ancestorChain;
    if (ref === "getReadyCandidates") return state.liveCandidates;
    // NEO-102: the walker's fixer reads suggestions per card; [] keeps it
    // resolved-but-empty, which is the "no career history" shape.
    if (ref === "cardChecklist.suggestedTeamsForCard") return [];
    if (ref === "teams.getManyByIds" || ref === "teams.list") return [];
    // CrossListingImportModal's drill-down queries — never exercised here.
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "discardCandidates") return mockDiscardCandidates;
    return vi.fn();
  },
  useAction: (ref: string) => {
    if (ref === "fetchCardChecklist") return mockFetchChecklist;
    if (ref === "resolveChecklistEntities") return mockResolveEntities;
    // NEO-189: commitCardChecklist became an ACTION when the commit was
    // chunked server-side. Same call shape, different hook.
    if (ref === "commitCardChecklist") return mockCommitChecklist;
    return vi.fn();
  },
  // NEO-203: the content-diff review is a ONE-SHOT query (see the note on
  // `useConvex` in CardChecklist.tsx — a subscription keyed on the whole
  // confirmed card array would re-diff under the operator mid-review). Every
  // flow in this file drives the zero-candidate path, which short-circuits
  // before the diff is ever requested, so this only has to exist.
  useConvex: () => ({ query: mockDiffChecklist }),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import CardChecklist from "./CardChecklist";

const VARIANT_ID = "variant-1" as unknown as Id<"selectorOptions">;
const SPORT_ID = "sport-1" as unknown as Id<"selectorOptions">;

function renderChecklist() {
  return render(
    <CardChecklist
      variantId={VARIANT_ID}
      sourceChips={{}}
      sourceLabelMaps={{ bsc: {}, sportlots: {} }}
    />,
  );
}

/** A single streamed candidate, shaped like checklistCandidates.getReadyCandidates. */
const streamedCandidate = {
  cardNumber: "1",
  cardName: "Streamed Player",
  bucket: "matched" as const,
  confidence: 1,
  platformData: {
    bsc: { ref: "bsc-1" },
    sportlots: { ref: "sl-1" },
  },
};

describe("CardChecklist — cancel during an in-flight fetch (NEO-189)", () => {
  let resolveFetch: (value: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    // The sport row the commit path keys on. It used to ride back on
    // `fetchCardChecklist`'s return; the client reads it off the ancestor
    // chain it already subscribes to, so without one here Sync refuses to run
    // at all.
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    // Ready candidates from the very first render, so once `fetchInFlight`
    // flips true the modal has something to stream in immediately — this is
    // what makes the dialog open "seconds in" rather than only once the
    // action resolves.
    state.liveCandidates = {
      ready: 1,
      total: 1,
      cards: [streamedCandidate],
    };
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockFetchChecklist.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
  });

  it("does not reopen the dialog or overwrite the cancelled message when the abandoned fetch resolves afterward", async () => {
    renderChecklist();

    // Kick off the sync — the empty-checklist state renders its own
    // "Sync card checklist" button (sortedCards.length === 0 branch).
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    // The pairing dialog opens on the streamed candidate while the fetch is
    // still in flight — this is the "opens seconds in" behavior itself.
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    expect(screen.getByLabelText("Cancel card matching")).toBeTruthy();

    // Operator cancels mid-fetch.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Cancel card matching"));
    });

    await waitFor(() =>
      expect(screen.getByText("Sync cancelled — no cards saved.")).toBeTruthy(),
    );
    expect(screen.queryByText(/Match Cards/)).toBeNull();
    expect(mockDiscardCandidates).toHaveBeenCalledTimes(1);
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });

    // The abandoned fetch NOW resolves with a result that, if it were still
    // live, would reopen the dialog and put its own message on screen.
    await act(async () => {
      resolveFetch({ success: true, message: "Fetched 1 card", candidateCount: 1 });
    });

    // The dialog must NOT reopen, and the operator's own cancelled message
    // must still stand — not the late fetch's "Fetched 1 card".
    expect(screen.queryByText(/Match Cards/)).toBeNull();
    expect(screen.getByText("Sync cancelled — no cards saved.")).toBeTruthy();
    expect(screen.queryByText("Fetched 1 card")).toBeNull();

    // And the abandoned run must not have gone on to resolve entities or
    // commit anything — it returned as soon as it saw it was stale.
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
  });
});

/**
 * The half of the pairing session the action's return used to own.
 *
 * `streamedPairing` was gated on `fetchInFlight` and went null the instant the
 * fetch resolved; `pendingPairing` — the whole result, sent a second time —
 * took over from there and kept the dialog on screen. With that second copy
 * gone the stream is the only source, so the session flag has to outlive the
 * fetch on its own.
 */
describe("CardChecklist — the pairing session outlives the fetch", () => {
  let resolveFetch: (value: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = { ready: 1, total: 1, cards: [streamedCandidate] };
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: undefined,
    });
    mockCommitChecklist.mockResolvedValue({ count: 0 });
    mockFetchChecklist.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
  });

  it("keeps the dialog open once the fetch resolves, and unlocks Confirm", async () => {
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    // Open mid-fetch on the streamed candidate, Confirm still gated.
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
      "Loading…",
    );

    await act(async () => {
      resolveFetch({
        success: true,
        message: "1 matched, 0 BSC-only, 0 SL-only",
        candidateCount: 1,
      });
    });

    // Still open — this is the assertion that fails the moment the dialog is
    // gated on the fetch rather than on the review session.
    expect(screen.queryByText(/Match Cards/)).toBeTruthy();
    // And the streaming gate lifted, which is the E2E flow's sync point.
    expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
      "Confirm",
    );
    expect(
      screen.getByText("1 matched, 0 BSC-only, 0 SL-only"),
    ).toBeTruthy();
    // Nothing was written by merely finishing the fetch.
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockDiscardCandidates).not.toHaveBeenCalled();
  });

  it("skips the dialog entirely when the run produced no candidates, using the ancestor chain's sport", async () => {
    // The custom-subtree path: `fetchCardChecklist` short-circuits before
    // publishing anything. `candidateCount` is the whole signal — the client
    // cannot read it off the subscription, whose value at that instant may
    // still predate the batch write.
    state.liveCandidates = { ready: 0, total: 0, cards: [] };
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    await act(async () => {
      resolveFetch({
        success: true,
        message: "Custom selector subtree — no marketplace data available.",
        candidateCount: 0,
      });
    });

    expect(screen.queryByText(/Match Cards/)).toBeNull();
    // The sport id came off `getAncestorChain`, which the client already
    // subscribes to for its pickers — not off the fetch's return.
    expect(mockResolveEntities).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
      sportId: SPORT_ID,
      cards: [],
    });
  });

  it("closes the dialog and discards the batch when the fetch reports failure", async () => {
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();

    await act(async () => {
      resolveFetch({
        success: false,
        message: "Failed to fetch checklist: BSC timed out",
        candidateCount: 0,
      });
    });

    // A half-published batch must not stay on screen offering Confirm.
    expect(screen.queryByText(/Match Cards/)).toBeNull();
    expect(
      screen.getByText("Failed to fetch checklist: BSC timed out"),
    ).toBeTruthy();
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });
  });

  it("refuses to sync a row with no sport ancestor, before spending a marketplace round-trip", async () => {
    // The action used to answer with `sportId: undefined` and the client
    // silently showed the card counts of a sync it could not finish. Reading
    // the sport off the chain lets it fail before the fetch, not after.
    state.ancestorChain = [{ _id: VARIANT_ID, level: "variantType", value: "Base" }];
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    await waitFor(() =>
      expect(screen.getByText(/no sport ancestor/)).toBeTruthy(),
    );
    expect(mockFetchChecklist).not.toHaveBeenCalled();
    expect(screen.queryByText(/Match Cards/)).toBeNull();
  });
});

/**
 * NEO-189 — the "Saved N cards" message must not paint before the client's
 * queries have caught up with the commit.
 *
 * `commitCardChecklist` became an ACTION when the commit was chunked
 * server-side. `useAction`'s promise resolves the moment the server returns;
 * `useMutation`'s only resolves once the client's subscribed queries reflect
 * the mutation's writes. So the message that used to be safe to paint right
 * after the commit now races `getCardChecklist`'s repaint — and
 * .maestro/flows/setup.yaml waits for "Saved 335 cards" and then IMMEDIATELY
 * asserts a "#NNN" card row is visible.
 *
 * The fix is ordering, not a new sync primitive: `discardCandidates` is still
 * a mutation, and its resolution guarantees the client reflects every write
 * that preceded it — including the action's internal commit mutations. These
 * tests pin that ordering, and pin that a discard failure after a SUCCESSFUL
 * commit still reports the cards as saved.
 */
describe("CardChecklist — commit paints 'Saved' only after the queries catch up", () => {
  let resolveFetch: (value: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    // The no-candidates path: the fetch short-circuits, the client skips the
    // pairing dialog and runs straight through resolveEntities → runCommit.
    // Shortest route to the commit under test.
    state.liveCandidates = { ready: 0, total: 0, cards: [] };
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: undefined,
    });
    mockCommitChecklist.mockResolvedValue({ count: 335 });
    mockFetchChecklist.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
  });

  /** Drive the fetch → resolve → commit path to the point of the discard. */
  async function runToCommit() {
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    await act(async () => {
      resolveFetch({
        success: true,
        message: "Custom selector subtree — no marketplace data available.",
        candidateCount: 0,
      });
    });
  }

  it("withholds 'Saved N cards' until discardCandidates — the mutation carrying the repaint guarantee — has resolved", async () => {
    let resolveDiscard!: () => void;
    mockDiscardCandidates.mockImplementation(
      () => new Promise<void>((resolve) => (resolveDiscard = resolve)),
    );

    await runToCommit();

    // The action has returned, but the mutation behind it has not. If the
    // message were set here the E2E flow's "#NNN" assertion would be racing
    // the checklist subscription.
    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockDiscardCandidates).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Saved 335 cards/)).toBeNull();

    await act(async () => {
      resolveDiscard();
    });

    expect(screen.getByText("Saved 335 cards.")).toBeTruthy();
  });

  it("still reports the cards as saved when the post-commit discard fails", async () => {
    // The commit succeeded — the rows are in cardChecklist. Reporting
    // "Commit failed" here would tell the operator to re-run a sync that
    // already worked.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockDiscardCandidates.mockRejectedValue(new Error("discard blew up"));

    await runToCommit();

    await waitFor(() =>
      expect(screen.getByText(/^Saved 335 cards\./)).toBeTruthy(),
    );
    expect(screen.queryByText(/Commit failed/)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports 'Commit failed' when the commit action itself throws, and never claims a save", async () => {
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockCommitChecklist.mockRejectedValue(new Error("chunk 3 timed out"));

    await runToCommit();

    await waitFor(() =>
      expect(screen.getByText("Commit failed: chunk 3 timed out")).toBeTruthy(),
    );
    expect(screen.queryByText(/Saved/)).toBeNull();
    expect(mockDiscardCandidates).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEO-102 — the set-level "needs attention" pass
//
// The count, the filter and the walker's entry points. All three read the same
// derived rule (card-attention.ts) off the live getCardChecklist rows, which is
// why fixing a card needs nothing invalidated: the row changes and the count
// follows.
// ---------------------------------------------------------------------------

/** A stored row that needs a team: a lookup ran, found nothing, nobody answered. */
function attentionCard(overrides: Record<string, unknown> = {}) {
  return {
    _id: "card-a" as unknown as Id<"cardChecklist">,
    selectorOptionId: VARIANT_ID,
    cardNumber: "1",
    cardName: "AL Leaders ERA LL",
    platformData: { bsc: { ref: "bsc-1" } },
    teamCheckDoneAt: 1_000,
    ...overrides,
  };
}

/** A settled row: its lookup ran and found a team. */
function settledCard(overrides: Record<string, unknown> = {}) {
  return {
    _id: "card-b" as unknown as Id<"cardChecklist">,
    selectorOptionId: VARIANT_ID,
    cardNumber: "2",
    cardName: "Tarik Skubal",
    platformData: { bsc: { ref: "bsc-2" } },
    teamCheckDoneAt: 1_000,
    teamOnCardIds: ["team-1"],
    ...overrides,
  };
}

/**
 * Renders and drives a commit all the way through, via the ZERO-CANDIDATE
 * path: the fetch short-circuits (`candidateCount: 0`), the client skips the
 * pairing dialog and runs straight through resolveEntities → runCommit. It is
 * the shortest route to a landed commit, which is what puts the post-commit
 * banner — and its attention call-to-action — on screen.
 *
 * Set `state.cards` before calling; the commit mock does not change them (the
 * live `getCardChecklist` subscription is what the count reads).
 */
async function commitZeroCandidatePath() {
  state.liveCandidates = { ready: 0, total: 0, cards: [] };
  mockResolveEntities.mockResolvedValue({
    unknownPlayers: [],
    unknownTeams: [],
    batchId: undefined,
  });
  mockCommitChecklist.mockResolvedValue({ count: 2 });
  mockDiscardCandidates.mockResolvedValue(undefined);
  let resolveFetch!: (value: unknown) => void;
  mockFetchChecklist.mockImplementation(
    () => new Promise((resolve) => (resolveFetch = resolve)),
  );

  const rendered = renderChecklist();
  fireEvent.click(screen.getByLabelText("Sync card checklist"));
  await act(async () => {
    resolveFetch({
      success: true,
      message: "Custom selector subtree — no marketplace data available.",
      candidateCount: 0,
    });
  });
  await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
  return rendered;
}

/**
 * Drives the same zero-candidate route as `commitZeroCandidatePath`, but stops
 * one step short: `resolveChecklistEntities` reports an unknown player, so the
 * entity-review wizard opens instead of the commit running — and the operator
 * cancels it. NOTHING is saved on this path, which is exactly why the banner
 * it leaves behind must not offer to fix anything.
 */
async function cancelEntityReviewPath() {
  state.liveCandidates = { ready: 0, total: 0, cards: [] };
  mockResolveEntities.mockResolvedValue({
    unknownPlayers: [{ name: "Unknown Guy" }],
    unknownTeams: [],
    batchId: "batch-1",
  });
  mockDiscardCandidates.mockResolvedValue(undefined);
  let resolveFetch!: (value: unknown) => void;
  mockFetchChecklist.mockImplementation(
    () => new Promise((resolve) => (resolveFetch = resolve)),
  );

  const rendered = renderChecklist();
  fireEvent.click(screen.getByLabelText("Sync card checklist"));
  await act(async () => {
    resolveFetch({
      success: true,
      message: "Custom selector subtree — no marketplace data available.",
      candidateCount: 0,
    });
  });
  await waitFor(() => expect(mockResolveEntities).toHaveBeenCalledTimes(1));
  return rendered;
}

describe("CardChecklist — NEO-102 attention count, filter and walker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [attentionCard(), settledCard()];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = null;
  });

  it("counts the flagged rows and marks only those rows in the grid", () => {
    renderChecklist();

    expect(
      screen.getByRole("button", { name: /Show only cards needing attention/ }).textContent,
    ).toContain("1 need attention");
    expect(screen.getAllByLabelText(/needs attention/)).toHaveLength(1);
    expect(screen.getByLabelText(/Card 1 needs attention/)).toBeTruthy();
  });

  it("announces the count in a live region, since the chip's own label changes silently", () => {
    renderChecklist();

    const announced = screen
      .getAllByRole("status")
      .map((el) => el.textContent ?? "")
      .join(" | ");
    expect(announced).toContain("1 card needs attention on this checklist");
  });

  it("hides the row entirely when nothing needs attention", () => {
    state.cards = [settledCard()];
    renderChecklist();

    expect(screen.queryByText(/need attention/)).toBeNull();
  });

  it("toggling the chip filters the grid down to the flagged rows", () => {
    renderChecklist();

    expect(screen.getByText("Tarik Skubal")).toBeTruthy();

    const chip = screen.getByRole("button", { name: /Show only cards needing attention/ });
    fireEvent.click(chip);

    expect(screen.getByText("AL Leaders ERA LL")).toBeTruthy();
    expect(screen.queryByText("Tarik Skubal")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Show only cards needing attention \(on\)/ }),
    ).toBeTruthy();
  });

  it("opens the walker from the header, any time", async () => {
    renderChecklist();

    fireEvent.click(
      screen.getByRole("button", { name: /Fix cards needing attention one at a time/ }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Cards Needing Attention");
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#1 AL Leaders ERA LL",
    );
  });

  it("does not open the walker on its own", () => {
    renderChecklist();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /**
   * `walkerOpenedByHand` is the only thing that mounts the walker — see the
   * state block in CardChecklist.tsx. Nothing in
   * CardAttentionWalker.test.tsx exercises this seam: that file drives the
   * walker directly with `isOpen` pinned true, never through the parent, so
   * a change that reintroduced an automatic open would go unnoticed there.
   */
  it("opened BY HAND, stays open and shows All clear once the last flagged row is fixed elsewhere", () => {
    const { rerender } = renderChecklist();

    fireEvent.click(
      screen.getByRole("button", { name: /Fix cards needing attention one at a time/ }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();

    // The BSC pass (or another tab) answers the one flagged card — nothing
    // the walker itself did.
    state.cards = [settledCard()];
    rerender(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/All clear/)).toBeTruthy();
  });

  /**
   * NEO-102 regression — the walker used to ARM itself on a completed commit
   * and open across the grid the moment the background BSC team pass flagged
   * a row. Two E2E flows (checklist-fetch-unknown-entities-link-existing,
   * checklist-fetch-wizard-add-career-team) commit a custom set whose one
   * card has no team, so it was flagged immediately and the walker's
   * `fixed inset-0` overlay swallowed the flow's next tap on the grid. The
   * commit now says what needs attention and offers the walker; it does not
   * take the screen.
   */
  it("after a commit, does NOT open the walker — it offers it in the banner instead", async () => {
    await commitZeroCandidatePath();

    expect(screen.getByText(/Saved 2 cards\./)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Fix them one at a time/ }),
    ).toBeTruthy();
  });

  it("the banner CTA carries the live count", async () => {
    state.cards = [attentionCard(), attentionCard({ _id: "card-c", cardNumber: "3" })];
    await commitZeroCandidatePath();

    expect(
      screen.getByRole("button", { name: "2 need attention — Fix them one at a time" }),
    ).toBeTruthy();
  });

  it("clicking the banner CTA opens the walker", async () => {
    await commitZeroCandidatePath();

    fireEvent.click(screen.getByRole("button", { name: /Fix them one at a time/ }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Cards Needing Attention");
  });

  it("the banner CTA is absent when the commit flagged nothing", async () => {
    state.cards = [settledCard()];
    await commitZeroCandidatePath();

    // The banner itself is there — only the call-to-action half is not.
    expect(screen.getByText(/Saved 2 cards\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Fix them one at a time/ })).toBeNull();
  });

  it("the banner CTA disappears once the count reaches zero", async () => {
    const { rerender } = await commitZeroCandidatePath();
    expect(screen.getByRole("button", { name: /Fix them one at a time/ })).toBeTruthy();

    // The BSC pass (or another tab) answers the one flagged card.
    state.cards = [settledCard()];
    rerender(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      />,
    );

    expect(screen.queryByRole("button", { name: /Fix them one at a time/ })).toBeNull();
    expect(screen.getByText(/Saved 2 cards\./)).toBeTruthy();
  });

  /**
   * CI round 2 regression (flow `checklist-fetch-cancel-dialog`). The CTA was
   * keyed off `syncNotice.tone === "status"` — which is EVERY routine notice,
   * not just a commit. On a custom set holding a teamless card the cancel
   * banner read "Fetch cancelled — no cards saved. 1 need attention — Fix them
   * one at a time", offering to fix cards the operator had just declined to
   * save, and breaking the flow's exact-text assertion on that element.
   *
   * The rule is structural, not textual: only the notice `runCommit` marks
   * `kind: "committed"` carries the CTA.
   */
  it("leaves the cancelled-review banner exactly as written, with no attention CTA", async () => {
    await cancelEntityReviewPath();
    // Precondition: there IS something needing attention, so a tone-keyed CTA
    // would have appeared here.
    expect(
      screen.getByRole("button", { name: /Show only cards needing attention/ }).textContent,
    ).toContain("1 need attention");

    fireEvent.click(screen.getByRole("button", { name: "Cancel entity review" }));

    // Exact match: `getByText` compares the element's whole text content, so a
    // CTA appended inside the banner would fail this outright.
    expect(screen.getByText("Fetch cancelled — no cards saved.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Fix them one at a time/ })).toBeNull();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
  });

  it("does not offer the CTA on the pre-commit 'needs confirmation' notice either", async () => {
    await cancelEntityReviewPath();

    // The wizard is open and nothing has been committed yet.
    expect(
      screen.getByText("1 new players + 0 new teams need confirmation"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Fix them one at a time/ })).toBeNull();
  });
});
