/**
 * NEO-296 (audit condition 1) — the reconciler store's client-side drain.
 *
 * The bug: the store gained a WRITE budget and began reporting `hasMore`, and
 * neither form read it. An over-budget confirm dropped every row past the
 * budget, closed the panel and printed a count of items SENT — a success
 * message for a write that did not happen.
 *
 * These pin the loop that replaces it, and specifically the two things a
 * replay has to get right: it must keep going until the server stops asking,
 * and it must merge the pages the way the server's own action-side twin
 * (`storeSelectorOptionsUntilDone`) does — last page for the recomputed
 * counts, SUM for the one-off events. Taking the last page's `unlinked` would
 * drop the "no longer listed" notices, which only the first page reports.
 *
 * `.test.tsx` although nothing here renders: the `components` vitest project
 * collects only `.test.tsx`, so a `.test.ts` beside this file would never run.
 */

import { describe, expect, it, vi } from "vitest";
import {
  RECONCILED_STORE_MAX_PAGES,
  storeReconciledUntilDone,
  type ReconciledStoreResult,
} from "./store-reconciled-until-done";

const ARGS = {
  level: "parallel" as const,
  reconciledItems: [{ value: "Gold" }, { value: "Silver" }],
};

describe("storeReconciledUntilDone", () => {
  it("replays the SAME payload until the store stops reporting hasMore", async () => {
    const store = vi
      .fn<(a: typeof ARGS) => Promise<ReconciledStoreResult>>()
      .mockResolvedValueOnce({
        success: true,
        message: "Stored 1 … 1 of 2 not reached this time.",
        optionsCount: 1,
        itemsProcessed: 1,
        hasMore: true,
        writeOps: 800,
        unlinked: [],
        unlinkedTotal: 0,
      })
      .mockResolvedValueOnce({
        success: true,
        message: "Successfully stored 2 reconciled parallel options",
        optionsCount: 2,
        itemsProcessed: 2,
        hasMore: false,
        writeOps: 1,
        unlinked: [],
        unlinkedTotal: 0,
      });

    const { stored, pages, converged } = await storeReconciledUntilDone(
      store,
      ARGS,
    );

    expect(pages).toBe(2);
    expect(converged).toBe(true);
    // Identical args both times — that is what makes the prefix free and the
    // walk resumable. A caller that re-sliced would re-spend the budget on
    // rows it had already stored.
    expect(store).toHaveBeenCalledTimes(2);
    expect(store.mock.calls[1][0]).toBe(store.mock.calls[0][0]);
    // The recomputed counts are the LAST page's: it walked furthest. Summing
    // would say 3 options for a two-item list.
    expect(stored.optionsCount).toBe(2);
    expect(stored.itemsProcessed).toBe(2);
    expect(stored.hasMore).toBe(false);
    // Events SUM: 800 writes then 1.
    expect(stored.writeOps).toBe(801);
  });

  it("keeps the unlink notices from the page that reported them", async () => {
    // The unlink pass detaches on the FIRST page that sees a stale id; every
    // later page re-reads the same row and finds nothing to do. So the last
    // page alone reports none, and taking it alone would lose the only
    // account an operator ever gets of a link being removed (invariant 5).
    const store = vi
      .fn<(a: typeof ARGS) => Promise<ReconciledStoreResult>>()
      .mockResolvedValueOnce({
        hasMore: true,
        optionsCount: 1,
        unlinked: [{ id: "row1", value: "Gold", side: "bsc" }],
        unlinkedTotal: 1,
      })
      .mockResolvedValueOnce({
        hasMore: false,
        optionsCount: 2,
        unlinked: [],
        unlinkedTotal: 0,
      });

    const { stored } = await storeReconciledUntilDone(store, ARGS);

    expect(stored.unlinked).toEqual([
      { id: "row1", value: "Gold", side: "bsc" },
    ]);
    expect(stored.unlinkedTotal).toBe(1);
  });

  it("stops at the page cap and says the store is NOT finished", async () => {
    // The runaway case: a page that keeps asking for more without advancing.
    // Stopping quietly here would be the original bug with extra steps, so
    // `converged` is false and `hasMore` survives into the merged result for
    // a caller that only looks at that.
    const store = vi.fn().mockResolvedValue({
      hasMore: true,
      optionsCount: 1,
      itemsProcessed: 1,
      message: "Stored 1 … 1 of 2 not reached this time.",
    });

    const { stored, pages, converged } = await storeReconciledUntilDone(
      store,
      ARGS,
    );

    expect(pages).toBe(RECONCILED_STORE_MAX_PAGES);
    expect(converged).toBe(false);
    expect(stored.hasMore).toBe(true);
    expect(stored.message).toContain("not reached");
  });

  it("treats a result with no hasMore as finished, in one call", async () => {
    // A tab on an older bundle, or any caller whose result predates the
    // budget. Absent must read as done, never as "loop forever".
    const store = vi.fn().mockResolvedValue({ success: true, unlinked: [] });

    const { pages, converged } = await storeReconciledUntilDone(store, ARGS);

    expect(pages).toBe(1);
    expect(converged).toBe(true);
  });
});
