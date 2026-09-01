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
  },
}));

const mockFetchChecklist = vi.fn();
const mockResolveEntities = vi.fn();
const mockCommitChecklist = vi.fn();
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
