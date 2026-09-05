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
      // NEO-221: the attention walker's UnreviewedNameFixer writes through
      // this one.
      updateCard: "selectorOptions.updateCard",
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
    // NEO-221: UnreviewedNameFixer mounts the REAL PlayerPicker, which needs
    // all three of these to resolve.
    players: {
      getManyByIds: "players.getManyByIds",
      list: "players.list",
      findOrCreate: "players.findOrCreate",
    },
    cardChecklist: {
      suggestedTeamsForCard: "cardChecklist.suggestedTeamsForCard",
      confirmCardNoTeam: "cardChecklist.confirmCardNoTeam",
    },
    // NEO-212: SkippedNamesPanel, mounted unconditionally under the sync
    // notice. It renders nothing unless the set has skips, but the references
    // still have to resolve — hence these entries even for the many tests
    // below that never look at it.
    entityReviewSkips: {
      listForSet: "entityReviewSkips.listForSet",
      clearSkip: "entityReviewSkips.clearSkip",
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
 * NEO-102 (CI round 2): the entity-review wizard is stubbed down to the props
 * its PARENT owns. The real wizard would drag in the whole
 * `entityReviewQueue` query/mutation surface to prove facts about
 * CardChecklist; its own behaviour is covered by EntityReviewWizard.test.tsx.
 *
 * NEO-221 widened the stub with the three props D6/D9/D10 added — `summary`,
 * `onBack` and `commitError`/`onDismissCommitError`. Each is rendered as plain
 * text or a button so a test can read back exactly what the parent decided:
 * what the final step will claim it is saving, whether there is a pairing
 * session to return to, and whether a failed commit was reported without
 * throwing the review away.
 */
vi.mock("./EntityReviewWizard", () => ({
  default: ({
    summary,
    onConfirm,
    onCancel,
    onBack,
    commitError,
    onDismissCommitError,
  }: {
    summary: {
      cardCount: number;
      deleteCount: number;
      reviewDecisionCount: number;
    };
    onConfirm: () => void;
    onCancel: () => void;
    onBack?: () => void;
    commitError?: string | null;
    onDismissCommitError?: () => void;
  }) => (
    <div>
      <p>
        {`Wizard summary: ${summary.cardCount} cards, ${summary.deleteCount} deletions, ${summary.reviewDecisionCount} field decisions`}
      </p>
      {commitError && <p>{`Wizard commit error: ${commitError}`}</p>}
      <button type="button" onClick={onConfirm}>
        Confirm entity review
      </button>
      <button type="button" onClick={onCancel}>
        Cancel entity review
      </button>
      {/* Rendered ONLY when the prop is present — that presence is itself the
          assertion in the "custom subtree has nothing to go back to" test. */}
      {onBack && (
        <button type="button" onClick={onBack}>
          Back to matching
        </button>
      )}
      {onDismissCommitError && (
        <button type="button" onClick={onDismissCommitError}>
          Dismiss commit error
        </button>
      )}
    </div>
  ),
}));

const mockFetchChecklist = vi.fn();
const mockResolveEntities = vi.fn();
const mockCommitChecklist = vi.fn();
const mockDiffChecklist = vi.fn();
const mockDiscardCandidates = vi.fn();
// NEO-208: the quick-add form's mutation. It was already listed in the `api`
// mock above but never routed to a spy, because nothing exercised the form —
// it had no component test at all before this ticket.
const mockAddCustomCard = vi.fn();
const mockFindOrCreateTeam = vi.fn();
// NEO-221 — the attention walker's UnreviewedNameFixer.
const mockUpdateCard = vi.fn();
const mockFindOrCreatePlayer = vi.fn();

// Mutable holders read lazily by the mocked hooks at call time — same shape
// as EntityColumn.ensure-sync.test.tsx's `state`.
const state: {
  cards: unknown;
  variantRow: unknown;
  ancestorChain: unknown;
  liveCandidates: unknown;
  /**
   * NEO-208: the `teams` table, for the REAL `TeamPicker` now living in the
   * quick-add form. Serves both `teams.list` (the typeahead's candidate pool)
   * and `teams.getManyByIds` (the chip labels) — the mocked `useQuery` ignores
   * arguments, and returning the same rows for both is exactly right here:
   * every id the picker can hold came from this pool.
   *
   * Defaults to `[]`, which is what the mock returned unconditionally before,
   * so every pre-existing test in this file is untouched.
   */
  teams: Array<{ _id: string; name: string }>;
  /**
   * NEO-221: the `players` table, for the REAL `PlayerPicker` inside
   * `UnreviewedNameFixer`. Serves `players.list` (typeahead candidates) and
   * `players.getManyByIds` (chip labels), exactly as `teams` does for
   * `TeamPicker` — the mocked `useQuery` ignores arguments.
   */
  players: Array<{ _id: string; name: string }>;
  /**
   * NEO-212: rows for `entityReviewSkips.listForSet`. `[]` — no skips — is the
   * state every pre-existing test in this file runs in, and SkippedNamesPanel
   * renders nothing for it, so the checklist is visually unchanged for them.
   */
  skippedNames: Array<{
    _id: string;
    kind: "player" | "team";
    name: string;
    skippedAt: number;
  }>;
} = {
  cards: [],
  variantRow: { value: "Test Set" },
  ancestorChain: [],
  liveCandidates: null,
  teams: [],
  players: [],
  skippedNames: [],
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
    if (ref === "teams.getManyByIds" || ref === "teams.list") return state.teams;
    if (ref === "players.getManyByIds" || ref === "players.list") {
      return state.players;
    }
    if (ref === "entityReviewSkips.listForSet") return state.skippedNames;
    // CrossListingImportModal's drill-down queries — never exercised here.
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "discardCandidates") return mockDiscardCandidates;
    if (ref === "addCustomCard") return mockAddCustomCard;
    if (ref === "teams.findOrCreate") return mockFindOrCreateTeam;
    if (ref === "players.findOrCreate") return mockFindOrCreatePlayer;
    if (ref === "selectorOptions.updateCard") return mockUpdateCard;
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
  // NEO-221 (D12): the commit now reports how many names its batch never had
  // a decision for. Zero here — the "nothing was skipped" shape every
  // pre-existing assertion in this file runs in.
  mockCommitChecklist.mockResolvedValue({ count: 2, unreviewedNameCount: 0 });
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

// ---------------------------------------------------------------------------
// NEO-208 — the quick-add form's Team field
//
// This is the FIRST component coverage the quick-add form has ever had, which
// is most of why NEO-208 shipped as a bug: the old free-text Team box wrote
// `addCustomCard({ teams: [typedName] })` → `pendingTeamNames`, a column
// nothing rendered, and no test looked at either end of that.
//
// The form now uses the REAL `TeamPicker` — the same component the card drawer
// and the attention walker's fixer use — deliberately un-stubbed here. Two
// things depend on the real one: the picker's value is React STATE in
// CardChecklist and has to survive the reactive `getCardChecklist` re-renders
// that broke controlled inputs in NEO-36, and the aria-labels Maestro drives
// ("Add team", "Search teams", "Add <name>") are the real component's.
// ---------------------------------------------------------------------------

const YANKEES = { _id: "team-yankees", name: "New York Yankees" };
const METS = { _id: "team-mets", name: "New York Mets" };
/**
 * NEO-220 — the quick-add form's PlayerPicker exposes DIFFERENT accessible
 * names from the card drawer's and the attention walker's, because
 * CardChecklist mounts more than one of these pickers and neither hides the
 * other. Mirrored from `QUICK_ADD_PLAYER_LABELS` in CardChecklist.tsx;
 * spelled out here rather than imported so a rename has to be made
 * deliberately in both places, and so this file records what the E2E flows
 * actually target.
 */
const QA_ROOT = "Players on the new card";
const QA_TRIGGER = "Add a player to the new card";
const QA_SEARCH = "Find a player for the new card";

/** NEO-220 — the quick-add form's PlayerPicker candidate pool. */
const JUDGE = { _id: "player-judge", name: "Aaron Judge" };
const LINDOR = { _id: "player-lindor", name: "Francisco Lindor" };

/** Pick a player through the real picker's popover, by its display name. */
function pickPlayer(name: string) {
  fireEvent.click(screen.getByLabelText(QA_TRIGGER));
  fireEvent.click(screen.getByLabelText(`Add ${name}`));
}

/** Open the form and return its container element. */
function openAddForm(): HTMLElement {
  fireEvent.click(screen.getByLabelText("Open add card form"));
  const heading = screen.getByRole("heading", { name: "Add Card" });
  return heading.parentElement as HTMLElement;
}

/** Pick a team through the real picker's popover, by its display name. */
function pickTeam(name: string) {
  fireEvent.click(screen.getByLabelText("Add team"));
  fireEvent.click(screen.getByLabelText(`Add ${name}`));
}

function fillCardNumber(value: string) {
  fireEvent.change(screen.getByLabelText("Card number"), {
    target: { value },
  });
}

describe("CardChecklist — NEO-208 quick-add Team picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = null;
    state.teams = [YANKEES, METS];
    mockAddCustomCard.mockResolvedValue("new-card-1");
  });

  it("renders a TeamPicker, not a free-text Team box", () => {
    renderChecklist();
    openAddForm();

    // The old field's accessible name. Its absence is the regression pin: a
    // revert to the textbox brings this label back.
    expect(screen.queryByLabelText("Team")).toBeNull();
    expect(screen.getByLabelText("Team picker")).toBeTruthy();
    expect(screen.getByLabelText("Add team")).toBeTruthy();
  });

  it("keeps each field's reserved Maestro marker class on its picker wrapper", () => {
    // Maestro's web driver re-finds a tapped element by an XPath built from
    // its class (see useFieldTestClass). Neither picker is an <input>, but the
    // "team" and "players" keys stay claimed so no other field in this form
    // can be handed one, and each class stays a stable handle for scoping a
    // query to that box.
    const form = (() => {
      renderChecklist();
      return openAddForm();
    })();

    // Read the base off a field that is still a real <input>, rather than
    // hardcoding a `useId()` value. NEO-220: that used to be the players
    // textbox; it is a picker now, so the card-number field is the one left —
    // and its SUFFIX is unreadable ("cardNumber" sanitizes to "card-umber",
    // since the key sanitizer replaces the capital rather than lowercasing
    // it), so match the `mb-field-<base>` prefix instead. `useId()` is
    // stripped to alphanumerics by the hook, so the base never contains a
    // hyphen and this cannot over-match.
    const base = screen
      .getByLabelText("Card number")
      .className.split(/\s+/)
      .map((c) => /^(mb-field-[a-z0-9]+)-/.exec(c)?.[1])
      .find((b): b is string => !!b)!;

    const teamWrapper = form.querySelector(`.${base}-team`);
    expect(teamWrapper).toBeTruthy();
    expect(teamWrapper!.contains(screen.getByLabelText("Team picker"))).toBe(
      true,
    );

    const playersWrapper = form.querySelector(`.${base}-players`);
    expect(playersWrapper).toBeTruthy();
    expect(
      playersWrapper!.contains(screen.getByLabelText(QA_ROOT)),
    ).toBe(true);
  });

  it("sends the picked ids as teamOnCardIds, and no `teams` name array", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("501");
    pickTeam("New York Yankees");
    pickTeam("New York Mets");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard).toHaveBeenCalledTimes(1);
    const args = mockAddCustomCard.mock.calls[0][0];
    expect(args.teamOnCardIds).toEqual([YANKEES._id, METS._id]);
    // The legacy free-text shape must not ride along — a row carrying both
    // would state its team twice (see addCustomCard).
    expect(args).not.toHaveProperty("teams");
  });

  it("sends NEITHER teamOnCardIds nor teams when no team was picked", async () => {
    // "No answer about teams" is what leaves the card correctly badged as
    // needing one. An empty array would read as a deliberate "no team".
    renderChecklist();
    openAddForm();
    fillCardNumber("502");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    const args = mockAddCustomCard.mock.calls[0][0];
    expect(args).not.toHaveProperty("teamOnCardIds");
    expect(args).not.toHaveProperty("teams");
  });

  it("still forwards the other fields unchanged", async () => {
    state.players = [JUDGE, LINDOR];
    renderChecklist();
    openAddForm();
    fillCardNumber("503");
    fireEvent.change(screen.getByLabelText("Card name"), {
      target: { value: "Subway Series" },
    });
    pickPlayer("Aaron Judge");
    pickPlayer("Francisco Lindor");
    pickTeam("New York Yankees");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    // NEO-220: `players` (the typed name array) is gone from this call
    // entirely — the whole argument list is asserted, so its return would
    // fail here.
    expect(mockAddCustomCard).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
      cardNumber: "503",
      cardName: "Subway Series",
      playerIds: [JUDGE._id, LINDOR._id],
      teamOnCardIds: [YANKEES._id],
    });
  });

  /**
   * The NEO-36 pin, and the reason the picker's value is allowed to be React
   * state at all.
   *
   * That ticket found controlled TEXT inputs being wiped by reactive
   * `getCardChecklist` re-renders: a keystroke and a re-render race, and the
   * re-render wins with the stale value. A picker has no such window — its
   * value changes only in whole chips, one discrete setState each — so state
   * is safe here. This test is what proves it rather than asserting it, by
   * driving exactly the event that broke the text fields: new query data
   * arriving underneath an open form.
   */
  it("keeps the picked chips across a re-render with new getCardChecklist data", async () => {
    const { rerender } = renderChecklist();
    openAddForm();
    fillCardNumber("504");
    pickTeam("New York Yankees");

    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();

    // A background sync lands: `getCardChecklist` answers with rows it did not
    // have before, and CardChecklist re-renders under the operator.
    state.cards = [settledCard()];
    rerender(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      />,
    );

    // The form is still open and the chip is still on it.
    expect(screen.getByRole("heading", { name: "Add Card" })).toBeTruthy();
    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();

    // And it is still what gets submitted — the value the operator can see.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });
    expect(mockAddCustomCard.mock.calls[0][0].teamOnCardIds).toEqual([
      YANKEES._id,
    ]);
  });

  it("resets the picker when the form is cancelled", () => {
    // The text fields reset by being unmounted; the picker is React state and
    // does not, so a cancelled card's team must be cleared explicitly or it
    // silently rides along on the next one.
    renderChecklist();
    openAddForm();
    pickTeam("New York Yankees");
    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Cancel new card"));
    openAddForm();

    expect(screen.queryByLabelText("Team: New York Yankees")).toBeNull();
  });

  it("resets the picker on OPEN too, not only on cancel", () => {
    // Belt for the same failure from the other side: whatever route hid the
    // form, opening it is a fresh card.
    renderChecklist();
    openAddForm();
    pickTeam("New York Yankees");
    fireEvent.click(screen.getByLabelText("Cancel new card"));

    openAddForm();
    expect(screen.queryByLabelText(/^Team: /)).toBeNull();
    expect(screen.queryByLabelText(/^Remove team /)).toBeNull();
  });

  it("closes the form and clears the picker after a successful add", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("505");
    pickTeam("New York Yankees");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(screen.queryByRole("heading", { name: "Add Card" })).toBeNull();

    openAddForm();
    expect(screen.queryByLabelText("Team: New York Yankees")).toBeNull();
  });

  it("submits nothing at all without a card number", async () => {
    renderChecklist();
    openAddForm();
    pickTeam("New York Yankees");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard).not.toHaveBeenCalled();
    // And the form stays open with the team still picked, so the operator
    // fixes the one missing field rather than re-entering everything.
    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();
  });

  it("keeps autoFocus on the card number field", () => {
    // The form's whole point is speed: an operator adding twenty cards types
    // a number, tabs, types a name. Whatever the Team field became, the
    // landing point must not move.
    renderChecklist();
    openAddForm();

    expect(document.activeElement).toBe(screen.getByLabelText("Card number"));
  });

  it("keeps the keyboard order: number, name, player picker, team picker, buttons", () => {
    // NEO-220: the Players textbox became a picker, so its tab stop is the
    // picker's own "+ Add player" trigger. The ORDER is what must not move —
    // an operator adding twenty cards has this sequence in their fingers.
    const form = (() => {
      renderChecklist();
      return openAddForm();
    })();

    const focusables = Array.from(
      form.querySelectorAll<HTMLElement>("input, button"),
    ).map((el) => el.getAttribute("aria-label"));

    expect(focusables).toEqual([
      "Card number",
      "Card name",
      QA_TRIGGER,
      "Add team",
      "Submit new card",
      "Cancel new card",
    ]);
  });

  it("dedupes ids before sending, even though the picker refuses a duplicate chip", () => {
    // Belt on the client side of a server-side dedupe. `TeamPicker.addChip`
    // already refuses a repeat, so this asserts the property rather than
    // trying to force the picker into an impossible state.
    renderChecklist();
    openAddForm();
    pickTeam("New York Yankees");
    // Re-open the popover and confirm the picked team is out of the pool, so
    // no second chip is reachable from the UI at all.
    fireEvent.click(screen.getByLabelText("Add team"));
    expect(screen.queryByLabelText("Add New York Yankees")).toBeNull();
    expect(screen.getByLabelText("Add New York Mets")).toBeTruthy();
  });

  it("lets a chip be removed again before submitting", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("506");
    pickTeam("New York Yankees");
    fireEvent.click(screen.getByLabelText("Remove team New York Yankees"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0]).not.toHaveProperty(
      "teamOnCardIds",
    );
  });

  it("leaves the form open when the mutation fails, so nothing typed is lost", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockAddCustomCard.mockRejectedValue(new Error("server said no"));

    renderChecklist();
    openAddForm();
    fillCardNumber("507");
    pickTeam("New York Yankees");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(screen.getByRole("heading", { name: "Add Card" })).toBeTruthy();
    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("passes the ancestor chain's sport to the picker, so the typeahead is scoped", () => {
    // `sportId` is what filters the candidate pool AND what tags a team the
    // operator creates from the popover. Without it the picker lists the whole
    // teams table and its "+ Create" option is disabled — which is what a
    // sport-less row should get, and is asserted separately below.
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));
    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    expect(
      screen.getByLabelText('Create team Savannah Bananas'),
    ).toBeTruthy();
  });

  it("cannot create a team from a row with no sport ancestor", () => {
    state.ancestorChain = [
      { _id: VARIANT_ID, level: "variantType", value: "Base" },
    ];
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));
    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    // NEO-96: a team must reference a real sport row. No sport, no create.
    expect(screen.queryByLabelText(/^Create team /)).toBeNull();
  });

  /**
   * Creating a NEW team from the quick-add form's popover — the escape hatch
   * `TeamPicker` gives every consumer (see its own module docstring) — was
   * untested end-to-end from THIS form specifically. `teams.findOrCreate`'s
   * resolved id has to make it all the way to `addCustomCard`'s
   * `teamOnCardIds`, through the same React-state chip list the picked-from-
   * the-list case uses.
   */
  it("creates a new team from the popover, then sends the freshly created id on submit", async () => {
    mockFindOrCreateTeam.mockImplementation(
      async ({ name }: { name: string; sportId: unknown }) => {
        const newTeam = { _id: "team-bananas", name };
        state.teams = [...state.teams, newTeam];
        return newTeam._id;
      },
    );
    renderChecklist();
    openAddForm();
    fillCardNumber("520");
    fireEvent.click(screen.getByLabelText("Add team"));
    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Create team Savannah Bananas"));
    });

    expect(mockFindOrCreateTeam).toHaveBeenCalledWith({
      name: "Savannah Bananas",
      sportId: SPORT_ID,
    });
    // The picker's own "createAndAdd" chips it immediately — same as picking
    // an existing match.
    expect(screen.getByLabelText("Team: Savannah Bananas")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0].teamOnCardIds).toEqual([
      "team-bananas",
    ]);
  });

  it("cancelling after creating a team leaves the team CREATED server-side but sends nothing on submit", async () => {
    // The mutation already ran — cancel only clears the FORM's local chip
    // list, which is all NEO-208's reset-on-close guarantees. It does not,
    // and cannot, undo a write that already committed.
    mockFindOrCreateTeam.mockImplementation(
      async ({ name }: { name: string; sportId: unknown }) => {
        const newTeam = { _id: "team-bananas", name };
        state.teams = [...state.teams, newTeam];
        return newTeam._id;
      },
    );
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));
    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Create team Savannah Bananas"));
    });
    expect(mockFindOrCreateTeam).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Cancel new card"));
    openAddForm();
    fillCardNumber("521");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    // No second team created, and the cancelled pick never reaches this card.
    expect(mockFindOrCreateTeam).toHaveBeenCalledTimes(1);
    expect(mockAddCustomCard.mock.calls[0][0]).not.toHaveProperty(
      "teamOnCardIds",
    );
  });

  it("submitting while the picker popover is still open still sends the picked team", async () => {
    // `addChip` deliberately leaves the popover open after a pick (so a
    // second team can be added without re-opening it) — this is the state the
    // form is normally IN at the moment an operator hits Add, not an edge
    // case reached only by skipping a close.
    renderChecklist();
    openAddForm();
    fillCardNumber("522");
    pickTeam("New York Yankees");
    // The popover is still open — its search box is still on screen.
    expect(screen.getByLabelText("Search teams")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0].teamOnCardIds).toEqual([
      YANKEES._id,
    ]);
  });

  // a11y (WCAG 2.4.11 Focus Not Obscured): the picker's popover is
  // `absolute top-full z-10` and opens right above this form's "Add"/
  // "Cancel" buttons — the same overlap TeamPicker's own pointerdown-outside
  // comment documents for MissingTeamFixer's "Save & Next"/"No team on this
  // card" buttons, just reached here by Tab instead of a mouse click
  // elsewhere. Without a keyboard-equivalent close, tabbing out of an open
  // popover lands focus on a button the popover is still visually covering.
  it("closes the team popover when Tab moves focus onto Submit (2.4.11)", async () => {
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));
    const searchInput = screen.getByLabelText("Search teams");

    // Let the picker's own open-time autofocus effect land first. It moves
    // focus into the search input on a `setTimeout(0)` queued by the same
    // click; a real Tab key can't outrun that the way synchronous test code
    // racing the same macrotask queue can, so without waiting for it here,
    // that autofocus can win the race and re-steal focus into the popover a
    // moment after our manual Tab-out below, masking the close this test
    // means to check.
    await waitFor(() => expect(document.activeElement).toBe(searchInput));

    // Tab from inside the popover lands on the next focusable element in DOM
    // order — the quick-add form's "Add" button — without the popover's own
    // state changing on its own. Move focus there directly, the same
    // observable effect a real Tab key press has. The close is deferred
    // (TeamPicker reads `document.activeElement` a tick after the blur, not
    // off the blur event's own `relatedTarget` — see its comment), so this
    // needs an `act(async ...)` to flush that timer.
    await act(async () => {
      screen.getByLabelText("Submit new card").focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByLabelText("Search teams")).toBeNull();
    // And the trigger is back to its closed state, not stuck mid-open.
    expect(
      screen.getByLabelText("Add team").getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps the popover open when focus moves between controls inside it", async () => {
    // Regression guard on the fix above: closing on "focus left the root"
    // must not also fire for focus moving from one in-picker control to
    // another (e.g. the search input to a match option), which is ordinary
    // keyboard use, not a Tab-out.
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Search teams")),
    );

    await act(async () => {
      screen.getByLabelText("Add New York Yankees").focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByLabelText("Search teams")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-220 — the quick-add form's Players field is a real PlayerPicker.
//
// The players twin of the NEO-208 block above, and deliberately the same cases
// so a divergence between the two fields shows up as one block passing and the
// other failing.
//
// The defect: a typed name went to `addCustomCard.players` →
// `pendingPlayerNames`, so the card was born NAMING a player it did not link
// to — which `deriveCardAttention` badges as an `unreviewedName`, sending the
// attention walker to ask the operator about a player they had just typed in.
// Picked ids make the card born LINKED, and a linked card starts answered.
//
// Driven through the REAL `PlayerPicker` throughout, so the aria-labels
// Maestro targets are the real ones.
// ---------------------------------------------------------------------------
describe("CardChecklist — NEO-220 quick-add Player picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = null;
    state.teams = [YANKEES, METS];
    state.players = [JUDGE, LINDOR];
    mockAddCustomCard.mockResolvedValue("new-card-1");
  });

  it("renders a PlayerPicker, not a free-text Players box", () => {
    renderChecklist();
    openAddForm();

    // The old field's accessible name. Its absence is the regression pin: a
    // revert to the textbox brings this label back.
    expect(screen.queryByLabelText("Players")).toBeNull();
    expect(screen.getByLabelText(QA_ROOT)).toBeTruthy();
    expect(screen.getByLabelText(QA_TRIGGER)).toBeTruthy();
  });

  it("labels the field, so the picker is not an unexplained row of chips", () => {
    renderChecklist();
    const form = openAddForm();
    expect(form.textContent).toContain("Players (optional)");
  });

  it("names its controls distinctly from every other PlayerPicker on the page", () => {
    // CardChecklist mounts more than one PlayerPicker — the quick-add form's
    // and, when a card is open, the drawer's — and neither hides the other. So
    // the quick-add instance must not answer to the default names, and, just
    // as importantly, must not CONTAIN them: Maestro's `id:` selector is a
    // regex find over the aria-label, so a suffixed label would make a flow
    // targeting the default match both elements.
    renderChecklist();
    openAddForm();

    for (const [distinct, base] of [
      [QA_ROOT, "Player picker"],
      [QA_TRIGGER, "Add player"],
    ] as const) {
      expect(screen.getByLabelText(distinct)).toBeTruthy();
      expect(distinct.includes(base)).toBe(false);
      expect(base.includes(distinct)).toBe(false);
    }
    // The defaults are not present at all while only this form is open.
    expect(screen.queryByLabelText("Player picker")).toBeNull();
    expect(screen.queryByLabelText("Add player")).toBeNull();

    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    expect(screen.getByLabelText(QA_SEARCH)).toBeTruthy();
    expect(QA_SEARCH.includes("Search players")).toBe(false);
    expect(screen.queryByLabelText("Search players")).toBeNull();
  });

  it("sends the picked ids as playerIds, and no `players` name array", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("601");
    pickPlayer("Aaron Judge");
    pickPlayer("Francisco Lindor");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard).toHaveBeenCalledTimes(1);
    const args = mockAddCustomCard.mock.calls[0][0];
    expect(args.playerIds).toEqual([JUDGE._id, LINDOR._id]);
    // The legacy free-text shape must not ride along — a row carrying both
    // would name the same player twice, once in a spelling that links to
    // nothing (see addCustomCard).
    expect(args).not.toHaveProperty("players");
  });

  it("sends NEITHER playerIds nor players when nobody was picked", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("602");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    const args = mockAddCustomCard.mock.calls[0][0];
    expect(args).not.toHaveProperty("playerIds");
    expect(args).not.toHaveProperty("players");
  });

  /**
   * The NEO-36 pin, for the same reason the Team block carries one: the
   * picker's value is React STATE, which is the deviation from this form's
   * uncontrolled-fields rule. That rule exists because a keystroke and a
   * reactive `getCardChecklist` re-render race. A picker changes only in whole
   * chips, one discrete setState each, so there is no half-typed value for a
   * re-render to overwrite — proved here by driving exactly the event that
   * broke the text fields.
   */
  it("keeps the picked chips across a re-render with new getCardChecklist data", async () => {
    const { rerender } = renderChecklist();
    openAddForm();
    fillCardNumber("603");
    pickPlayer("Aaron Judge");

    expect(screen.getByLabelText("Player: Aaron Judge")).toBeTruthy();

    state.cards = [settledCard()];
    rerender(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Add Card" })).toBeTruthy();
    expect(screen.getByLabelText("Player: Aaron Judge")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });
    expect(mockAddCustomCard.mock.calls[0][0].playerIds).toEqual([JUDGE._id]);
  });

  it("resets the picker when the form is cancelled, and again on open", () => {
    // The text fields reset by being unmounted; the picker is React state and
    // does not, so a cancelled card's players must be cleared explicitly or
    // they silently ride along on the next one. Both edges, because whatever
    // route hid the form, opening it is a fresh card.
    renderChecklist();
    openAddForm();
    pickPlayer("Aaron Judge");
    expect(screen.getByLabelText("Player: Aaron Judge")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Cancel new card"));
    openAddForm();

    expect(screen.queryByLabelText(/^Player: /)).toBeNull();
    expect(screen.queryByLabelText(/^Remove player /)).toBeNull();
  });

  it("closes the form and clears the picker after a successful add", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("604");
    pickPlayer("Aaron Judge");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(screen.queryByRole("heading", { name: "Add Card" })).toBeNull();

    openAddForm();
    expect(screen.queryByLabelText("Player: Aaron Judge")).toBeNull();
  });

  it("lets a chip be removed again before submitting", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("605");
    pickPlayer("Aaron Judge");
    fireEvent.click(screen.getByLabelText("Remove player Aaron Judge"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0]).not.toHaveProperty("playerIds");
  });

  it("keeps a picked player when the mutation fails, so nothing is lost", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockAddCustomCard.mockRejectedValue(new Error("server said no"));

    renderChecklist();
    openAddForm();
    fillCardNumber("606");
    pickPlayer("Aaron Judge");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(screen.getByRole("heading", { name: "Add Card" })).toBeTruthy();
    expect(screen.getByLabelText("Player: Aaron Judge")).toBeTruthy();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("passes the ancestor chain's sport to the picker, so the typeahead is scoped", () => {
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    fireEvent.change(screen.getByLabelText(QA_SEARCH), {
      target: { value: "Rookie Nobody" },
    });

    expect(screen.getByLabelText("Create player Rookie Nobody")).toBeTruthy();
  });

  it("cannot create a player from a row with no sport ancestor", () => {
    state.ancestorChain = [
      { _id: VARIANT_ID, level: "variantType", value: "Base" },
    ];
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    fireEvent.change(screen.getByLabelText(QA_SEARCH), {
      target: { value: "Rookie Nobody" },
    });

    // NEO-96: a player must reference a real sport row. No sport, no create.
    expect(screen.queryByLabelText(/^Create player /)).toBeNull();
  });

  /**
   * The escape hatch that makes this field usable at all on a hand-added card:
   * a brand-new rookie, or anyone the marketplace sync has never named, is not
   * in the `players` table yet. `players.findOrCreate`'s resolved id has to
   * reach `addCustomCard.playerIds` through the same React-state chip list a
   * picked-from-the-list player takes.
   */
  it("creates a new player from the popover, then sends the fresh id on submit", async () => {
    mockFindOrCreatePlayer.mockImplementation(
      async ({ name }: { name: string; sportId: unknown }) => {
        const created = { _id: "player-rookie", name };
        state.players = [...state.players, created];
        return created._id;
      },
    );
    renderChecklist();
    openAddForm();
    fillCardNumber("610");
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    fireEvent.change(screen.getByLabelText(QA_SEARCH), {
      target: { value: "Rookie Nobody" },
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Create player Rookie Nobody"));
    });

    expect(mockFindOrCreatePlayer).toHaveBeenCalledWith({
      name: "Rookie Nobody",
      sportId: SPORT_ID,
    });
    expect(screen.getByLabelText("Player: Rookie Nobody")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0].playerIds).toEqual([
      "player-rookie",
    ]);
  });

  it("surfaces a refused create inline instead of silently doing nothing", async () => {
    // Before this the handler was a bare try/finally: "Creating…" flipped
    // back, no chip appeared, no reason was given, and the rejection went
    // unhandled. The popover must still be the SAME open popover afterwards —
    // a close/reopen would throw the message away with it.
    mockFindOrCreatePlayer.mockRejectedValue(new Error("nope"));
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    fireEvent.change(screen.getByLabelText(QA_SEARCH), {
      target: { value: "Rookie Nobody" },
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Create player Rookie Nobody"));
    });

    expect(screen.getByRole("alert").textContent).toBe(
      "Could not create player.",
    );
    expect(screen.getByLabelText(QA_SEARCH)).toBeTruthy();
    expect(screen.queryByLabelText(/^Player: /)).toBeNull();
  });

  it("submitting while the picker popover is still open still sends the picked player", async () => {
    // `addChip` deliberately leaves the popover open so a second player can be
    // added on a multi-player card — this is the state the form is normally IN
    // when an operator hits Add, not an edge case.
    renderChecklist();
    openAddForm();
    fillCardNumber("611");
    pickPlayer("Aaron Judge");
    expect(screen.getByLabelText(QA_SEARCH)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0].playerIds).toEqual([JUDGE._id]);
  });

  // a11y (WCAG 2.4.11 Focus Not Obscured). This picker's popover is
  // `absolute top-full z-10` and now opens directly over the Team row and the
  // Add/Cancel buttons below it. `PlayerPicker` had no keyboard-equivalent
  // close before NEO-220 — it had no outside-close of any kind — so tabbing
  // out of an open popover landed focus on a control the popover was still
  // visually covering.
  it("closes the player popover when Tab moves focus onto Submit (2.4.11)", async () => {
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    const searchInput = screen.getByLabelText(QA_SEARCH);

    // Let the picker's own open-time autofocus effect land first; it runs on a
    // `setTimeout(0)` queued by the same click, and synchronous test code can
    // outrun it in a way a real Tab press cannot — which would let the
    // autofocus re-steal focus and mask the close this test checks.
    await waitFor(() => expect(document.activeElement).toBe(searchInput));

    // Moving focus directly is the same observable effect a real Tab has. The
    // close is deferred (a `document.activeElement` read a tick after the
    // blur, not the blur's own `relatedTarget`), so this needs an async act to
    // flush that timer.
    await act(async () => {
      screen.getByLabelText("Submit new card").focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByLabelText(QA_SEARCH)).toBeNull();
    expect(
      screen.getByLabelText(QA_TRIGGER).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps the popover open when focus moves between controls inside it", async () => {
    // Regression guard on the fix above: "focus left the root" must not also
    // fire for focus moving from one in-picker control to another, which is
    // ordinary keyboard use.
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText(QA_SEARCH),
      ),
    );

    await act(async () => {
      screen.getByLabelText("Add Aaron Judge").focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByLabelText(QA_SEARCH)).toBeTruthy();
  });

  it("picks a highlighted player with Enter, so the field is keyboard-only operable", async () => {
    // The whole flow without a mouse: open the popover, type, Enter. Arrow
    // keys move the highlight; Enter takes it.
    renderChecklist();
    openAddForm();
    fillCardNumber("612");
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    const search = screen.getByLabelText(QA_SEARCH);
    fireEvent.change(search, { target: { value: "Francisco" } });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(screen.getByLabelText("Player: Francisco Lindor")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });
    expect(mockAddCustomCard.mock.calls[0][0].playerIds).toEqual([LINDOR._id]);
  });

  it("closes the popover on Escape without picking anything", () => {
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    fireEvent.keyDown(screen.getByLabelText(QA_SEARCH), {
      key: "Escape",
    });

    expect(screen.queryByLabelText(QA_SEARCH)).toBeNull();
    expect(screen.queryByLabelText(/^Player: /)).toBeNull();
  });

  it("removes the last chip on Backspace in an empty search box", () => {
    renderChecklist();
    openAddForm();
    pickPlayer("Aaron Judge");
    pickPlayer("Francisco Lindor");

    fireEvent.keyDown(screen.getByLabelText(QA_SEARCH), {
      key: "Backspace",
    });

    expect(screen.getByLabelText("Player: Aaron Judge")).toBeTruthy();
    expect(screen.queryByLabelText("Player: Francisco Lindor")).toBeNull();
  });

  it("keeps the two pickers independent — a player pick is not a team pick", async () => {
    // Both pickers are chip rows with near-identical markup sitting one row
    // apart. This pins that the ids land in the right argument.
    renderChecklist();
    openAddForm();
    fillCardNumber("613");
    pickPlayer("Aaron Judge");
    pickTeam("New York Yankees");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    const args = mockAddCustomCard.mock.calls[0][0];
    expect(args.playerIds).toEqual([JUDGE._id]);
    expect(args.teamOnCardIds).toEqual([YANKEES._id]);
  });
});

/**
 * NEO-212 — the checklist mounts `SkippedNamesPanel` with its own variant id.
 *
 * Only the wiring is pinned here: that the panel appears for a set WITH skips
 * and stays entirely absent for one without, scoped to the right set. The
 * panel's own list, undo, announcement and failure handling are covered by
 * SkippedNamesPanel.test.tsx.
 */
describe("CardChecklist — NEO-212 skipped-names disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = null;
    state.teams = [];
    state.skippedNames = [];
  });

  it("shows nothing when the set has no skipped names", () => {
    renderChecklist();
    expect(screen.queryByText(/Skipped names/)).toBeNull();
  });

  it("shows the disclosure, with its count, when the set has skipped names", () => {
    state.skippedNames = [
      {
        _id: "skip-1",
        kind: "player",
        name: "Checklist",
        skippedAt: Date.parse("2026-09-03T12:00:00Z"),
      },
    ];
    renderChecklist();

    expect(
      screen.getByLabelText("Skipped names (1) — not players or teams"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Unskip Checklist")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-221 — the orchestration half of "you cannot lose a review session by
// accident" (plan §3 WP-D: D6, D9, D10, D12 client).
//
// Everything here is about what CardChecklist DOES with the wizard, not what
// the wizard looks like: which props it hands over, what survives a trip back
// to matching, and what a failed commit costs. The wizard itself is the stub
// at the top of this file.
// ---------------------------------------------------------------------------

/** A `SyncDiff` with nothing to settle, so `needsSyncReview` is false. */
const NOTHING_TO_REVIEW = {
  cards: [],
  conflicts: [],
  removedUpstream: { fullyOrphaned: [] },
};

/** A BSC-only candidate — something the operator can KEEP in the pairing dialog. */
const bscOnlyCandidate = {
  cardNumber: "2",
  cardName: "BSC Only Player",
  bucket: "bscOnly" as const,
  confidence: 1,
  platformData: { bsc: { ref: "bsc-2" } },
};

/**
 * Drives a REAL pairing session all the way to an open wizard: two streamed
 * candidates (one matched, one BSC-only), the operator confirms the pairing,
 * the content diff has nothing to settle, and entity resolution reports an
 * unknown player.
 *
 * Distinct from `cancelEntityReviewPath` above, which reaches the same wizard
 * through the ZERO-candidate short-circuit — no pairing session ever exists on
 * that route, which is exactly why it must not be offered a way back to one.
 */
async function pairedEntityReviewPath() {
  state.liveCandidates = {
    ready: 2,
    total: 2,
    cards: [streamedCandidate, bscOnlyCandidate],
  };
  mockFetchChecklist.mockResolvedValue({
    success: true,
    message: "Fetched 2 cards",
    candidateCount: 2,
  });
  mockDiffChecklist.mockResolvedValue(NOTHING_TO_REVIEW);
  mockResolveEntities.mockResolvedValue({
    unknownPlayers: [{ name: "Unknown Guy" }],
    unknownTeams: [],
    batchId: "batch-1",
  });
  mockDiscardCandidates.mockResolvedValue(undefined);

  const rendered = renderChecklist();
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
  });
  expect(await screen.findByText(/Match Cards/)).toBeTruthy();
  return rendered;
}

/** Press Confirm in the pairing dialog and wait for the wizard to take over. */
async function confirmPairing() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Confirm card matches"));
  });
  await waitFor(() => expect(screen.getByText(/Wizard summary/)).toBeTruthy());
}

describe("CardChecklist — NEO-221 D6: what the wizard is told it will save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /**
   * The wizard used to be handed `cardCount` alone. Deletions and accepted
   * field changes are the IRREVERSIBLE half of a commit and they were decided
   * one dialog earlier, so the final step has to account for them too.
   */
  it("derives the summary from the preview, not just its card count", async () => {
    await pairedEntityReviewPath();
    await confirmPairing();

    expect(
      screen.getByText(
        "Wizard summary: 1 cards, 0 deletions, 0 field decisions",
      ),
    ).toBeTruthy();
  });
});

describe("CardChecklist — NEO-221 D9: Back to matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  it("re-opens the pairing dialog and closes the wizard", async () => {
    await pairedEntityReviewPath();
    await confirmPairing();
    expect(screen.queryByText(/Match Cards/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to matching" }));
    });

    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    expect(screen.queryByText(/Wizard summary/)).toBeNull();
  });

  /**
   * The whole point of parking rather than unmounting. `CardPairingModal`'s
   * `if (!isOpen) return null` sits BELOW its hooks, so a modal that is merely
   * hidden keeps its reducer — every link, keep and rename the operator made.
   * Read back through the CARDS the second Confirm produces: a kept BSC-only
   * card is in the confirmed set both times, which it could not be if the
   * reducer had been re-seeded from `initialData`.
   */
  it("keeps the pairing session's own state — the kept card survives the round trip", async () => {
    await pairedEntityReviewPath();

    fireEvent.click(screen.getByLabelText("Keep all BSC-only cards"));
    await confirmPairing();
    expect(mockResolveEntities.mock.calls[0][0].cards).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to matching" }));
    });
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();

    await confirmPairing();
    expect(mockResolveEntities).toHaveBeenCalledTimes(2);
    expect(mockResolveEntities.mock.calls[1][0].cards).toHaveLength(2);
  });

  /**
   * Back is NOT an abort. It leaves the batch alone (so `startBatch` resumes
   * the same review with the same decisions) and it leaves the candidates
   * alone — discarding them would empty the very dialog it goes back to.
   */
  it("does not discard the candidates it is going back to", async () => {
    await pairedEntityReviewPath();
    await confirmPairing();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to matching" }));
    });

    expect(mockDiscardCandidates).not.toHaveBeenCalled();
  });

  /**
   * The custom-subtree path reaches the wizard with `candidateCount === 0` —
   * nothing was ever paired, so there is nowhere to go back TO and the footer
   * must offer only Cancel.
   */
  it("is not offered when there was no pairing session", async () => {
    await cancelEntityReviewPath();

    expect(screen.getByText(/Wizard summary/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to matching" })).toBeNull();
  });
});

describe("CardChecklist — NEO-221 D9/D10: aborting the review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /**
   * `discardCandidates` used to fire when the operator CONFIRMED the pairing.
   * It cannot any more — a parked session can still be returned to — so it
   * moved to the two ends of the pipeline. This is the abort end.
   */
  it("closes the parked pairing session and discards its candidates", async () => {
    await pairedEntityReviewPath();
    await confirmPairing();
    expect(mockDiscardCandidates).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel entity review" }));
    });

    expect(screen.getByText("Fetch cancelled — no cards saved.")).toBeTruthy();
    expect(screen.queryByText(/Wizard summary/)).toBeNull();
    // Closed for good: the dialog does not come back, parked or otherwise.
    expect(screen.queryByText(/Match Cards/)).toBeNull();
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });
  });
});

describe("CardChecklist — NEO-221 D10: a commit that fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /**
   * The review is the expensive thing on screen — potentially hundreds of
   * create/link decisions. Clearing `pendingPreview` on a rejection threw all
   * of it away and closed the wizard over a message the operator could no
   * longer act on.
   */
  it("keeps the wizard open and hands it the failure", async () => {
    await cancelEntityReviewPath();
    mockCommitChecklist.mockRejectedValue(new Error("chunk 2/3 timed out"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm entity review" }));
    });

    expect(screen.getByText(/Wizard summary/)).toBeTruthy();
    expect(
      screen.getByText("Wizard commit error: chunk 2/3 timed out"),
    ).toBeTruthy();
    expect(screen.getByText(/Commit failed: chunk 2\/3 timed out/)).toBeTruthy();
  });

  /** Retry is the same commit, re-sent: the batch is untouched server-side. */
  it("retrying re-sends the commit, and a second attempt can land", async () => {
    await cancelEntityReviewPath();
    mockCommitChecklist.mockRejectedValueOnce(new Error("chunk 2/3 timed out"));
    mockCommitChecklist.mockResolvedValue({ count: 1, unreviewedNameCount: 0 });
    mockDiscardCandidates.mockResolvedValue(undefined);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm entity review" }));
    });
    expect(screen.getByText(/Wizard commit error/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm entity review" }));
    });

    expect(mockCommitChecklist).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Wizard summary/)).toBeNull();
    expect(screen.getByText(/Saved 1 cards\./)).toBeTruthy();
  });

  it("dismissing the failure clears it without closing the wizard", async () => {
    await cancelEntityReviewPath();
    mockCommitChecklist.mockRejectedValue(new Error("chunk 2/3 timed out"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm entity review" }));
    });
    expect(screen.getByText(/Wizard commit error/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss commit error" }));

    expect(screen.queryByText(/Wizard commit error/)).toBeNull();
    expect(screen.getByText(/Wizard summary/)).toBeTruthy();
  });
});

describe("CardChecklist — NEO-221 D12: names nobody reviewed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /**
   * The cards ARE saved, so this is a NOTE on the success banner rather than a
   * failure — but it is the only announcement that some of them landed with no
   * player or team link at all.
   */
  it("appends the unreviewed-names sentence to the commit banner", async () => {
    state.liveCandidates = { ready: 0, total: 0, cards: [] };
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: undefined,
    });
    // A COUNT and nothing else: the names themselves stay on the cards
    // (`pendingPlayerNames`/`pendingTeamNames`), which is where the attention
    // walker's fixer reads them from. Shipping them back through the commit
    // return as well would be a second copy that can only go stale.
    mockCommitChecklist.mockResolvedValue({ count: 2, unreviewedNameCount: 3 });
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockFetchChecklist.mockResolvedValue({
      success: true,
      message: "Custom selector subtree — no marketplace data available.",
      candidateCount: 0,
    });

    renderChecklist();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
    });
    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));

    expect(
      screen.getByText(
        "Saved 2 cards. 3 names were not reviewed; those cards have no player/team link.",
      ),
    ).toBeTruthy();
  });

  it("says nothing extra when every name was reviewed", async () => {
    await commitZeroCandidatePath();

    expect(screen.getByText("Saved 2 cards.")).toBeTruthy();
  });

  /**
   * The attention count and the walker's fixer, end to end through the parent.
   *
   * DEPENDS ON WP-C: `deriveCardAttention` has to know the `unreviewedName`
   * kind before a row carrying `pendingPlayerNames` is counted at all, and
   * `updateCard` has to accept the pending arrays before the fixer's write can
   * clear them. That is why the plan lands C and D together.
   */
  it("counts a card whose names were never reviewed, and links them in the walker", async () => {
    state.players = [{ _id: "player-1", name: "Yordan Alvarez" }];
    state.cards = [
      settledCard({
        _id: "card-unreviewed" as unknown as Id<"cardChecklist">,
        cardNumber: "9",
        cardName: "Yordan Alvrez",
        pendingPlayerNames: ["Yordan Alvrez"],
      }),
    ];
    mockUpdateCard.mockResolvedValue(null);

    renderChecklist();

    expect(
      screen.getByRole("button", { name: /Show only cards needing attention/ })
        .textContent,
    ).toContain("1 need attention");

    fireEvent.click(
      screen.getByRole("button", { name: /Fix cards needing attention one at a time/ }),
    );

    // The unreviewed name is shown — an operator cannot link a misspelling
    // they cannot see. Scoped to the fixer's own list: the grid row behind the
    // dialog carries the same text.
    const names = await screen.findByRole("list", {
      name: "Typed on this card, not linked yet",
    });
    expect(names.textContent).toContain("Yordan Alvrez");

    // Link the real player through the walker's picker and save. The
    // attention walker's `UnreviewedNameFixer` mounts a DEFAULT-labelled
    // PlayerPicker — only the quick-add form's instance is renamed (NEO-220),
    // and this is the test that says so.
    fireEvent.click(screen.getByLabelText("Add player"));
    fireEvent.click(screen.getByLabelText("Add Yordan Alvarez"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save & Next/ }));
    });

    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: "card-unreviewed",
      playerIds: ["player-1"],
      teamOnCardIds: ["team-1"],
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });
  });
});

// ---------------------------------------------------------------------------
// NEO-221 — the failure paths out of a PARKED pairing session.
//
// `handlePairingConfirm` parks the session (D9) so the wizard can offer "Back
// to matching". Three routes then leave no dialog on screen at all, and each
// one used to leave the session parked forever: nothing could reach it, its
// candidates were never discarded, and — because `startCandidateBatch` clears
// and rewrites in ONE transaction — the next Sync re-showed the SAME modal
// instance, whose append-only absorb stacked the new batch beside the stale
// one. Confirm then shipped cards from a checklist the operator was no longer
// looking at.
// ---------------------------------------------------------------------------

/** A second fetch's candidate, sharing nothing with the first batch. */
const freshCandidate = {
  cardNumber: "7",
  cardName: "Fresh Player",
  bucket: "matched" as const,
  confidence: 1,
  platformData: { bsc: { ref: "bsc-7" }, sportlots: { ref: "sl-7" } },
};

/**
 * Sync again after a failure and assert the dialog that comes back holds ONLY
 * the new batch.
 *
 * This is the bleed itself, observed from the operator's seat: a stale row
 * surviving into the next session is a card that can be committed onto a set
 * it was never fetched for.
 */
async function resyncAndExpectOnlyTheNewBatch() {
  state.liveCandidates = { ready: 1, total: 1, cards: [freshCandidate] };
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
  });

  expect(await screen.findByText(/Match Cards/)).toBeTruthy();
  expect(screen.getByText(/Fresh Player/)).toBeTruthy();
  expect(screen.queryByText(/Streamed Player/)).toBeNull();
  expect(screen.queryByText(/BSC Only Player/)).toBeNull();
}

describe("CardChecklist — NEO-221: a parked session that nothing can reach", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = [{ _id: SPORT_ID, level: "sport", value: "Baseball" }];
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /** (a) The content diff — or entity resolution — throws. */
  it("closes and discards when the step after pairing throws", async () => {
    await pairedEntityReviewPath();
    mockDiffChecklist.mockRejectedValue(new Error("diff exploded"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Confirm card matches"));
    });

    expect(screen.getByText("Error: diff exploded")).toBeTruthy();
    expect(screen.queryByText(/Wizard summary/)).toBeNull();
    // No dialog is on screen, so the session has to end itself.
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });
    await resyncAndExpectOnlyTheNewBatch();
  });

  /**
   * (b) The commit fails on the path with NO unknowns — so no wizard opens,
   * and `commitError` has nothing to render it. The banner is the only place
   * the operator sees this, and the session still has to end.
   */
  it("closes when a commit fails with no wizard to report it", async () => {
    await pairedEntityReviewPath();
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: undefined,
    });
    mockCommitChecklist.mockRejectedValue(new Error("chunk 2/3 timed out"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Confirm card matches"));
    });

    expect(screen.getByText(/Commit failed: chunk 2\/3 timed out/)).toBeTruthy();
    expect(screen.queryByText(/Wizard summary/)).toBeNull();
    await resyncAndExpectOnlyTheNewBatch();
  });

  /** (c) The content review was shown, skipped, and the step after it threw. */
  it("closes and discards when the step after the content review throws", async () => {
    await pairedEntityReviewPath();
    mockDiffChecklist.mockResolvedValue({
      cards: [],
      removedUpstream: {
        fullyOrphaned: [
          {
            id: "row-gone" as unknown as Id<"cardChecklist">,
            cardNumber: "5",
            cardName: "Gone Card",
            sides: ["bsc"],
          },
        ],
        partialOrphanCount: 0,
      },
      conflicts: [],
      collisionInsertCount: 0,
      ambiguityBlockedCount: 0,
    });
    mockResolveEntities.mockRejectedValue(new Error("resolve exploded"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Confirm card matches"));
    });
    // The content review takes over from the pairing dialog.
    await screen.findByText(/Gone Card/);

    await act(async () => {
      // Its accessible name is the aria-label, not the visible "Skip changes".
      fireEvent.click(
        screen.getByRole("button", { name: /Skip reviewing changes/ }),
      );
    });

    expect(screen.getByText("Error: resolve exploded")).toBeTruthy();
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });
    await resyncAndExpectOnlyTheNewBatch();
  });
});
