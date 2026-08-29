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
    if (ref === "commitCardChecklist") return mockCommitChecklist;
    return vi.fn();
  },
  useAction: (ref: string) => {
    if (ref === "fetchCardChecklist") return mockFetchChecklist;
    if (ref === "resolveChecklistEntities") return mockResolveEntities;
    return vi.fn();
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import CardChecklist from "./CardChecklist";

const VARIANT_ID = "variant-1" as unknown as Id<"selectorOptions">;

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
    state.ancestorChain = [];
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
    // live, would reopen the dialog on a fresh (unrelated) pairing set.
    await act(async () => {
      resolveFetch({
        success: true,
        sportId: "sport-1" as unknown as Id<"selectorOptions">,
        message: "Fetched 1 card",
        autoMatched: [
          {
            card: {
              cardNumber: "1",
              cardName: "Late-arriving Player",
              platformData: {
                bsc: { ref: "bsc-1" },
                sportlots: { ref: "sl-1" },
              },
            },
            confidence: 1,
          },
        ],
        unmatchedBsc: [],
        unmatchedSl: [],
      });
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
