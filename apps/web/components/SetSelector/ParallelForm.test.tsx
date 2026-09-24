/**
 * NEO-211 (plan B) — the partial-failure guard at the Sub-Variants column.
 *
 * Same bug, same shape, different level: see `VariantForm.test.tsx` for the full
 * account of why a `success: true` result carrying a per-platform error must not
 * reach the store. This file exists because the two forms carry SEPARATE copies
 * of the branch (and separate `SYNC_FAILED_PREFIX` strings, so Maestro can tell
 * a variant failure from a parallel one), and a fix applied to one and not the
 * other is exactly the kind of divergence that ships.
 *
 * First component tests for this file.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_MARKETPLACE_IDS_MESSAGE } from "../../convex/marketplaceResolvability";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    setReconciliation: {
      fetchRawOptions: "fetchRawOptions",
      storeReconciledOptions: "storeReconciledOptions",
    },
    selectorOptions: {
      getAncestorChain: "getAncestorChain",
      getUsedInsertIdentifiersBySet: "getUsedInsertIdentifiersBySet",
      getSelectorOptions: "getSelectorOptions",
      getInsertTreeByVariantType: "getInsertTreeByVariantType",
    },
  },
}));

const mockFetchRawOptions = vi.fn();
const mockStore = vi.fn();
// NEO-300: what getInsertTreeByVariantType answers. Loaded-but-empty by
// default — the auto-sync is gated on it, so `undefined` would never sync.
let insertTree: unknown[] = [];

vi.mock("convex/react", () => ({
  useAction: (ref: string) =>
    ref === "fetchRawOptions" ? mockFetchRawOptions : vi.fn(),
  useMutation: (ref: string) =>
    ref === "storeReconciledOptions" ? mockStore : vi.fn(),
  useQuery: (ref: string) => {
    if (ref === "getAncestorChain") return CHAIN;
    if (ref === "getSelectorOptions") return [];
    if (ref === "getInsertTreeByVariantType") return insertTree;
    if (ref === "getUsedInsertIdentifiersBySet")
      return { slPlatformValues: [], bscPlatformValues: [] };
    return undefined;
  },
}));

import ParallelForm from "./ParallelForm";
import { RECONCILED_STORE_MAX_PAGES } from "./store-reconciled-until-done";

const CHAIN = [
  { _id: "sport1", level: "sport", value: "Hockey" },
  { _id: "year1", level: "year", value: "1972-73" },
  { _id: "mfg1", level: "manufacturer", value: "Topps" },
  { _id: "set1", level: "setName", value: "Topps" },
  { _id: "vt1", level: "variantType", value: "Insert" },
];

const INSERT_ID = "ins1" as unknown as Parameters<
  typeof ParallelForm
>[0]["insertId"];

function bscOnly(errors: Array<{ platform: string; message: string }> = []) {
  return {
    success: true,
    bscOptions: [{ value: "Gold", platformValue: "gold" }],
    slOptions: [],
    autoMatched: [],
    unmatchedBsc: [],
    unmatchedSl: [],
    slCandidates: [],
    errors,
    message: "BSC: 1, SL: 0",
  };
}

async function renderForm(onDone = vi.fn()) {
  const result = render(<ParallelForm insertId={INSERT_ID} onDone={onDone} />);
  await act(async () => {});
  return { ...result, onDone };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.mockResolvedValue({ success: true, unlinked: [] });
  insertTree = [];
});

describe("ParallelForm — single-platform store (NEO-211 plan B)", () => {
  it("stores, with BOTH sides covered, when the empty side succeeded empty", async () => {
    mockFetchRawOptions.mockResolvedValue(bscOnly());
    const { onDone } = await renderForm();

    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    const args = mockStore.mock.calls[0][0];
    expect(args.level).toBe("parallel");
    expect(args.coveredSides).toEqual(["bsc", "sportlots"]);
    // NEO-211 F1: the empty side arrives as [] — "asked, returned nothing".
    expect(args.returnedIds).toEqual({ bsc: ["gold"], sportlots: [] });
    expect(onDone).toHaveBeenCalled();
  });

  it("goes IDLE when BOTH sides were skipped — a hand-built subtree, not a failure", async () => {
    // Same guarantee as VariantForm's, at the Sub-Variants column: no ids on
    // the chain means neither marketplace was asked, so there is nothing to
    // retry and "+ Custom" on the idle column is the only next move.
    mockFetchRawOptions.mockResolvedValue({
      ...bscOnly(),
      bscOptions: [],
      skippedSides: ["bsc", "sportlots"],
      message: NO_MARKETPLACE_IDS_MESSAGE,
    });
    const { onDone } = await renderForm();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("goes IDLE when one side was skipped and the reached side had nothing", async () => {
    mockFetchRawOptions.mockResolvedValue({
      ...bscOnly(),
      bscOptions: [],
      skippedSides: ["sportlots"],
    });
    const { onDone } = await renderForm();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("does NOT cover a side the fetch SKIPPED for lack of ids (NEO-239)", async () => {
    // Same guarantee as VariantForm's: a side that was never queried reports no
    // error, and counting it as covered would let this store detach every
    // child's slot on that marketplace.
    mockFetchRawOptions.mockResolvedValue({
      ...bscOnly(),
      skippedSides: ["sportlots"],
    });
    await renderForm();

    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    expect(mockStore.mock.calls[0][0].coveredSides).toEqual(["bsc"]);
  });

  it("writes NOTHING when the empty side errored, and keeps Retry reachable", async () => {
    mockFetchRawOptions.mockResolvedValue(
      bscOnly([{ platform: "sportlots", message: "socket hang up" }]),
    );
    const { onDone } = await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sync failed: could not load parallels");
    expect(alert.textContent).toContain("SportLots failed, nothing was changed.");
    expect(alert.textContent).not.toContain("socket hang up");
    expect(mockStore).not.toHaveBeenCalled();
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("ParallelForm — reconciliation confirm (NEO-211 F1)", () => {
  const BSC_A = { value: "Gold", platformValue: "bsc-gold" };
  const SL_A = { value: "Gold", platformValue: "sl-gold" };
  const BSC_B = { value: "Silver", platformValue: "bsc-silver" };
  const SL_B = { value: "Silver", platformValue: "sl-silver" };

  it("sends the fetch's id universe, not the operator's confirmed rows", async () => {
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [BSC_A, BSC_B],
      slOptions: [SL_A, SL_B],
      autoMatched: [
        { displayName: "Gold", bsc: BSC_A, sl: SL_A, confidence: 0.9 },
        { displayName: "Silver", bsc: BSC_B, sl: SL_B, confidence: 0.9 },
      ],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
      errors: [],
      message: "BSC: 2, SL: 2",
    });
    await renderForm();

    fireEvent.click(await screen.findByLabelText("Remove set Gold"));
    await act(async () => {
      fireEvent.click(screen.getByText(/Save 1 sets/));
    });

    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    const args = mockStore.mock.calls[0][0];
    expect(args.reconciledItems).toHaveLength(1);
    // The disbanded row's ids are still in returnedIds, so the store cannot
    // read its absence from reconciledItems as "delisted".
    expect(args.returnedIds).toEqual({
      bsc: ["bsc-gold", "bsc-silver"],
      sportlots: ["sl-gold", "sl-silver"],
    });
  });
});

describe("ParallelForm — failed save (NEO-211)", () => {
  it("surfaces our own error in the dialog and keeps it open for a retry", async () => {
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [{ value: "Gold", platformValue: "bsc-gold" }],
      slOptions: [{ value: "Gold", platformValue: "sl-gold" }],
      autoMatched: [
        {
          displayName: "Gold",
          bsc: { value: "Gold", platformValue: "bsc-gold" },
          sl: { value: "Gold", platformValue: "sl-gold" },
          confidence: 0.9,
        },
      ],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
      errors: [],
      message: "BSC: 1, SL: 1",
    });
    mockStore.mockRejectedValueOnce(new Error("[Request ID: xyz] cap exceeded"));
    await renderForm();

    await act(async () => {
      fireEvent.click(await screen.findByText(/Save 1 sets/));
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Couldn't save these sets. Nothing was changed — press Save to try again, or Cancel to close.",
    );
    expect(alert.textContent).not.toContain("Request ID");
    expect(screen.getByText(/Save 1 sets/)).toBeTruthy();
  });
});

describe("ParallelForm — both adapters empty (NEO-211)", () => {
  it("keeps the alert and Retry mounted instead of closing the panel", async () => {
    // Same fix as VariantForm: this branch used to call onDone(), unmounting
    // the form and destroying the very alert it had just set.
    mockFetchRawOptions.mockResolvedValue({
      ...bscOnly([
        { platform: "bsc", message: "503" },
        { platform: "sportlots", message: "socket hang up" },
      ]),
      bscOptions: [],
    });
    const { onDone } = await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sync failed: could not load parallels");
    expect(alert.textContent).toContain(
      "BuySportsCards and SportLots failed, nothing was changed.",
    );
    expect(alert.textContent).not.toContain("socket hang up");
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(mockStore).not.toHaveBeenCalled();
  });
});

describe("ParallelForm — failed fetch copy (NEO-211 F3)", () => {
  it("renders neither the URL nor the raw message", async () => {
    mockFetchRawOptions.mockResolvedValue({
      ...bscOnly([{ platform: "bsc", message: "boom" }]),
      success: false,
      bscOptions: [],
      message:
        "Failed to fetch options: GET https://api.buysportscards.com/x?token=SECRET 500",
    });
    await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("buysportscards.com");
    expect(alert.textContent).not.toContain("SECRET");
    expect(alert.textContent).toBe(
      "Sync failed: could not load parallels. BuySportsCards failed, nothing was changed.",
    );
  });
});

describe("ParallelForm — unlink notice (NEO-211 plan D)", () => {
  it("names the level correctly — sub-variants, not sets", async () => {
    mockFetchRawOptions.mockResolvedValue(bscOnly());
    mockStore.mockResolvedValue({
      success: true,
      unlinked: [{ id: "row1", value: "Gold", side: "sportlots" }],
    });
    await renderForm();

    const notice = await screen.findByText(/No longer listed on SportLots/);
    expect(notice.textContent).toContain("1 sub-variant");
    expect(notice.textContent).toContain("Gold");
  });
});

/**
 * NEO-216 — a fetch that succeeds with nothing on either side.
 *
 * `platformLevels.ts` has `parallel: false` for both sides, and a CUSTOM
 * subtree short-circuits both adapters at any level, so "both lists empty,
 * `errors: []`" is a NORMAL, healthy outcome here — not a failure and not a
 * level nobody serves that deserves its own copy.
 *
 * It must return the column to idle. `EntityColumn` renders this form INSTEAD
 * of the idle controls while `mode === "sync"`, so the "+ Custom" button only
 * exists once `onDone` has fired — which is exactly how `util-drill-to-custom`
 * reaches it. A branch that showed a message and skipped `onDone` here took
 * "+ Custom" off the screen and turned 29 E2E flows red with "No visible
 * element found: id: Add custom Inserts". Hence: no store (there is nothing to
 * write), but `onDone` always.
 */
describe("ParallelForm — nothing on either side, nothing failed (NEO-216)", () => {
  const nothingAnywhere = {
    success: true,
    bscOptions: [],
    slOptions: [],
    autoMatched: [],
    unmatchedBsc: [],
    unmatchedSl: [],
    slCandidates: [],
    errors: [],
    message: "BSC: 0, SL: 0",
  };

  it("stores nothing and returns the column to idle so + Custom is reachable", async () => {
    mockFetchRawOptions.mockResolvedValue(nothingAnywhere);
    const { onDone } = await renderForm();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // Nothing to write, and writing an empty result is a claim about both
    // sides that would license unlinking every existing row.
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("still reports a real adapter failure instead of quietly returning to idle", async () => {
    // Both lists empty AND an error is an outage, not an empty level. The
    // error branch must win, or a BSC failure closes the panel silently.
    mockFetchRawOptions.mockResolvedValue({
      ...nothingAnywhere,
      errors: [{ platform: "bsc", message: "https://api.bsc/internal 500" }],
    });
    const { onDone } = await renderForm();

    await waitFor(() =>
      expect(screen.getByText(/Sync failed: could not load parallels/)).toBeTruthy(),
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(mockStore).not.toHaveBeenCalled();
    // NEO-211 F3: the adapter's own text never reaches the DOM.
    expect(screen.queryByText(/api\.bsc/)).toBeNull();
  });
});

// ===========================================================================
// NEO-296 (audit condition 1) — an over-budget store must finish, and must
// never report a count it did not write
//
// NEO-296 gave `storeReconciledOptions` a write budget: past it the mutation
// stops, stores nothing further, and reports `hasMore` plus an honest
// `message`. This form read none of the three — it took `unlinked`, closed
// up, and printed `Stored ${items.length} parallels`, a count of rows SENT.
// So an over-budget confirm dropped the tail and said everything was stored.
//
// The fix is the loop (`storeReconciledUntilDone`), not a better sentence:
// the store is additive and id-keyed, so re-sending the identical list costs
// nothing for the prefix and walks on into the tail.
// ===========================================================================

describe("ParallelForm — the store is replayed until it is finished (NEO-296)", () => {
  /** Two BSC parallels and no SportLots: the single-platform store path. */
  const twoBscOnly = {
    ...bscOnly(),
    bscOptions: [
      { value: "Gold", platformValue: "bsc-gold" },
      { value: "Silver", platformValue: "bsc-silver" },
    ],
    message: "BSC: 2, SL: 0",
  };

  it("calls the store again with the SAME list and reports the server's final count", async () => {
    mockFetchRawOptions.mockResolvedValue(twoBscOnly);
    mockStore
      .mockResolvedValueOnce({
        success: true,
        // The server's own words for a truncated store. They must not be what
        // the operator ends up reading, because the loop finishes the job.
        message:
          "Stored 1 reconciled parallel options — 1 of 2 not reached this " +
          "time. Run the sync again to store the rest.",
        optionsCount: 1,
        itemsProcessed: 1,
        hasMore: true,
        unlinked: [],
        unlinkedTotal: 0,
      })
      .mockResolvedValueOnce({
        success: true,
        message: "Successfully stored 2 reconciled parallel options",
        optionsCount: 2,
        itemsProcessed: 2,
        hasMore: false,
        unlinked: [],
        unlinkedTotal: 0,
      });

    const { onDone } = await renderForm();

    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(2));
    // Byte-identical payloads: that is what makes the prefix free and the
    // second call reach the tail.
    expect(mockStore.mock.calls[1][0]).toEqual(mockStore.mock.calls[0][0]);
    const status = await screen.findByRole("status");
    // The SERVER's count of rows now linked, not the 2 items we sent — those
    // happen to agree here, and the next test is the one where they do not.
    expect(status.textContent).toBe("Stored 2 parallels (single platform)");
    // Finished, so the column returns to idle exactly as before.
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("never claims a count the store did not write when the walk cannot finish", async () => {
    // The runaway case: every page still asks for more. The panel must carry
    // the server's own account of what was NOT reached, must not print the
    // "Stored 2 parallels" success sentence, and must not close — closing is
    // what turned this into a silent write loss in the first place.
    mockStore.mockResolvedValue({
      success: true,
      message:
        "Stored 1 reconciled parallel options — 1 of 2 not reached this " +
        "time. Run the sync again to store the rest.",
      optionsCount: 1,
      itemsProcessed: 1,
      hasMore: true,
      unlinked: [],
      unlinkedTotal: 0,
    });
    mockFetchRawOptions.mockResolvedValue(twoBscOnly);

    const { onDone } = await renderForm();

    await waitFor(() =>
      expect(mockStore).toHaveBeenCalledTimes(RECONCILED_STORE_MAX_PAGES),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("1 of 2 not reached this time");
    expect(status.textContent).not.toContain("Stored 2 parallels");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("keeps the dialog open on an unfinished save from the reconciliation modal", async () => {
    // The modal path's version of the same rule. Save re-sends the identical
    // list, so the dialog is exactly where the operator can finish the job —
    // closing it would report a reconciliation that did not fully happen.
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [{ value: "Gold", platformValue: "bsc-gold" }],
      slOptions: [{ value: "Gold", platformValue: "sl-gold" }],
      autoMatched: [
        {
          displayName: "Gold",
          bsc: { value: "Gold", platformValue: "bsc-gold" },
          sl: { value: "Gold", platformValue: "sl-gold" },
          confidence: 0.9,
        },
      ],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
      errors: [],
      message: "BSC: 1, SL: 1",
    });
    mockStore.mockResolvedValue({
      success: true,
      message:
        "Stored 0 reconciled parallel options — 1 of 1 not reached this " +
        "time. Run the sync again to store the rest.",
      optionsCount: 0,
      itemsProcessed: 0,
      hasMore: true,
      unlinked: [],
      unlinkedTotal: 0,
    });
    const { onDone } = await renderForm();

    await act(async () => {
      fireEvent.click(await screen.findByText(/Save 1 sets/));
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1 of 1 not reached this time");
    // Still in the dialog, with Save ready to continue the walk.
    expect(screen.getByText(/Save 1 sets/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});

/**
 * NEO-300 — the symmetric half. Syncing THIS insert's parallels must not
 * re-create a set another row in the variant type already holds: another
 * insert, or a parallel grouped under another insert. This insert's own
 * parallels are the sync's own rows and still come back as Ready.
 */
describe("ParallelForm — sets held elsewhere in the variant type (NEO-300)", () => {
  function tree() {
    return [
      {
        // The insert being synced. Its own parallel is NOT held elsewhere.
        insert: { _id: "ins1", value: "Anime", platformData: { bsc: { b0: "bsc-anime" } } },
        parallels: [
          { _id: "p-own", value: "Anime Gold", platformData: { bsc: { b0: "bsc-own" } } },
        ],
      },
      {
        insert: { _id: "ins2", value: "Chrome Stars", platformData: { bsc: { b0: "bsc-stars" } } },
        parallels: [
          { _id: "p-kanji", value: "Stars Kanji", platformData: { bsc: { b0: "bsc-kanji" } } },
        ],
      },
    ];
  }

  it("single platform: skips what another insert or its parallels hold, and says where", async () => {
    insertTree = tree();
    mockFetchRawOptions.mockResolvedValue({
      ...bscOnly(),
      bscOptions: [
        { value: "Gold", platformValue: "bsc-own" },
        { value: "Stars Kanji", platformValue: "bsc-kanji" },
        { value: "Chrome Stars", platformValue: "bsc-stars" },
      ],
    });
    mockStore.mockResolvedValue({
      success: true,
      unlinked: [],
      optionsCount: 1,
      hasMore: false,
    });
    const { onDone } = await renderForm();

    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    const args = mockStore.mock.calls[0][0];
    expect(
      args.reconciledItems.map((i: { platformData: { bsc?: string } }) => i.platformData.bsc),
    ).toEqual(["bsc-own"]);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(
      "2 already live elsewhere in Inserts. Leaving those be.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show where" }));
    // An insert is named on its own; a parallel with the insert it sits under.
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Chrome Stars",
      "Stars Kanji→grouped under Chrome Stars",
    ]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("modal: a pair held by another insert's parallel is not seeded Ready", async () => {
    insertTree = tree();
    const KANJI_BSC = { value: "Stars Kanji", platformValue: "bsc-kanji" };
    const KANJI_SL = { value: "Stars Kanji", platformValue: "sl-kanji" };
    const GOLD_BSC = { value: "Gold", platformValue: "bsc-own" };
    const GOLD_SL = { value: "Gold", platformValue: "sl-own" };
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [KANJI_BSC, GOLD_BSC],
      slOptions: [KANJI_SL, GOLD_SL],
      autoMatched: [
        { displayName: "Stars Kanji", bsc: KANJI_BSC, sl: KANJI_SL, confidence: 0.9 },
        { displayName: "Gold", bsc: GOLD_BSC, sl: GOLD_SL, confidence: 0.9 },
      ],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
      errors: [],
    });
    await renderForm();

    expect(await screen.findByText(/Save 1 sets/)).toBeTruthy();
    expect(
      screen.getByText("1 already lives elsewhere in Inserts. Leaving it be."),
    ).toBeTruthy();
    // Kanji's SL half is not held by anyone, so it is an ordinary unassigned
    // set: in Pending, not silently dropped along with its held partner. (The
    // SL column's set-name prefix filter hides it from the default view,
    // hence "0 of 1".)
    expect(screen.getByText(/Pending \(1\)/)).toBeTruthy();
    expect(screen.getByText(/SportLots \(0\s*of 1\)/)).toBeTruthy();
  });

  it("single platform: an insert the STORE left alone joins the note, named on its own", async () => {
    mockFetchRawOptions.mockResolvedValue(bscOnly());
    mockStore.mockResolvedValue({
      success: true,
      unlinked: [],
      optionsCount: 1,
      hasMore: false,
      heldElsewhere: [
        { id: "ins9", value: "Chrome Stars", level: "insert", parentId: "vt1", parentValue: "Insert" },
      ],
      heldElsewhereTotal: 1,
    });
    const { onDone } = await renderForm();

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(
      "1 already lives elsewhere in Inserts. Leaving it be.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show where" }));
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Chrome Stars",
    ]);
    expect(onDone).not.toHaveBeenCalled();
  });
});
