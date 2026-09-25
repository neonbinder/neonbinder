/**
 * NEO-296 (audit condition 1) — call `storeReconciledOptions` until it has
 * stored the whole list.
 *
 * ## The bug this replaces
 *
 * NEO-296 gave the store a WRITE budget (`RECONCILE_STORE_WRITE_BUDGET`): past
 * it, the mutation stops, stores nothing further, and says so in `hasMore`,
 * `itemsProcessed` and its own `message`. Neither client caller was taught to
 * read any of the three. `VariantForm` and `ParallelForm` took `unlinked` off
 * the result, closed up, and — on the single-platform path — printed a sentence
 * of their own naming a count of items SENT. An over-budget confirm therefore
 * dropped every row past the budget and reported a clean success with a number
 * nothing had written.
 *
 * ## Why the fix is a loop and not a better sentence
 *
 * The store is additive and id-keyed, and its budget counts WRITES, so
 * re-sending the identical list is free for the prefix already stored (those
 * items match by id and change nothing) and the call walks on into the tail.
 * That is what makes the truncation resumable by replay rather than something
 * an operator has to be told about — the server's own note on
 * `RECONCILE_STORE_WRITE_BUDGET` says as much. An action-side caller already
 * does exactly this (`storeSelectorOptionsUntilDone` in selectorOptions.ts);
 * a form can do it too, with `EntityReviewWizard.drainRemaining` as the house
 * shape for a client loop: bound it, and if the bound trips, say so in words
 * the operator can act on rather than finishing quietly.
 *
 * ## Merging the pages, which is not "add everything up"
 *
 * Each page walks the list FROM THE START, so some of its numbers are
 * recomputed over everything it reached and others are events that happened in
 * that one transaction. Mirrors `storeSelectorOptionsUntilDone`'s rule, and
 * getting it backwards puts a wrong number in front of an operator:
 *
 *  - `optionsCount`, `itemsProcessed`, `message`, `returnedIdsTruncatedSides`
 *    and (NEO-300) `heldElsewhere` / `heldElsewhereTotal`,
 *    `withheldElsewhere` / `withheldElsewhereTotal` and `subtreeWalkSkipped`
 *    are recomputed per
 *    page and the LAST page reached furthest, so the last page's value is the
 *    whole answer. Summing would count the prefix once per page — a row held
 *    elsewhere is re-found by every page that walks past it.
 *  - `unlinked`, `relinked` and `writeOps` are events. The unlink pass detaches
 *    a stale primary id the first time it sees one; a later page re-reads the
 *    same row, finds nothing to detach and reports none. So these SUM — and
 *    taking only the last page would silently drop the "no longer listed"
 *    notices, which invariant 5 says the operator must be told about.
 */

import {
  UNLINK_NOTICE_LIMIT,
  type HeldElsewhereEntry,
  type WithheldElsewhereEntry,
} from "../../convex/selectorSyncStore";
import type { SyncSide, UnlinkedEntry } from "./selector-sync-feedback";

/**
 * How many times a form replays the same payload before it stops and says so.
 *
 * A runaway guard, not a budget. `MAX_SYNC_ITEMS` (2,000) is the most items
 * one call may carry and the budget is 800 writes, so a real store finishes in
 * at most three pages and a form's own batch (~100–200 rows) in one. Reaching
 * 8 means a page is not advancing — a bug, and one that must not be reported
 * to the operator as a finished sync.
 *
 * Deliberately a local constant rather than an import: the server's budget
 * lives in `convex/setReconciliation.ts`, which is a Convex function module,
 * and importing a value from one would pull the whole server graph into the
 * browser bundle. Only genuinely pure convex modules are importable here
 * (`selectorSyncStore` above is one).
 */
export const RECONCILED_STORE_MAX_PAGES = 8;

/**
 * What `storeReconciledOptions` returns, as a form consumes it.
 *
 * Every field optional on purpose: this is what a CLIENT can rely on across a
 * deploy. A tab holding an older bundle, or a test stubbing the mutation,
 * yields a narrower object, and none of the merging below may throw on one.
 * `hasMore` missing therefore means "done", which is the right reading of a
 * result shape that predates the budget.
 */
export type ReconciledStoreResult = {
  success?: boolean;
  message?: string;
  optionsCount?: number;
  unlinked?: UnlinkedEntry[];
  unlinkedTotal?: number;
  relinked?: UnlinkedEntry[];
  relinkedTotal?: number;
  returnedIdsTruncatedSides?: SyncSide[];
  itemsProcessed?: number;
  hasMore?: boolean;
  writeOps?: number;
  /**
   * NEO-300 — rows the store left alone because they already live elsewhere
   * in the variant type (a parallel grouped under another insert, say). A
   * sample capped at `UNLINK_NOTICE_LIMIT`; `heldElsewhereTotal` is the real
   * count. Recomputed per page, so the LAST page's pair is the answer.
   */
  heldElsewhere?: HeldElsewhereEntry[];
  heldElsewhereTotal?: number;
  /**
   * NEO-300 — items the store did NOT add: their marketplace id is already on
   * 2+ rows in the variant type (`heldByMany`), or the row they point at
   * carries different ids (`idsDisagree`). ≤50 entries, ≤10 holders each;
   * `withheldElsewhereTotal` is the real count. Last page wins.
   */
  withheldElsewhere?: WithheldElsewhereEntry[];
  withheldElsewhereTotal?: number;
  /**
   * NEO-300 — the variant type was too big for the store to look for grouped
   * rows, so it fell back to siblings only and may have re-added some. Last
   * page wins.
   */
  subtreeWalkSkipped?: boolean;
};

export type ReconciledStoreDrain = {
  /** The merged result: last page's counts, summed events. */
  stored: ReconciledStoreResult;
  /** How many times the mutation was called. */
  pages: number;
  /**
   * The store reported it was finished.
   *
   * False means the page cap stopped a walk that was still reporting
   * `hasMore` — the rows already stored are stored (each page is its own
   * transaction) and the tail is not. A caller must not treat that as done:
   * surface `stored.message`, which is the server's own count of what it did
   * not reach, and leave the operator somewhere to retry from.
   */
  converged: boolean;
};

/**
 * Replay `store(args)` — the SAME args every time — until it stops asking for
 * more, or until `RECONCILED_STORE_MAX_PAGES`.
 */
export async function storeReconciledUntilDone<TArgs>(
  store: (args: TArgs) => Promise<ReconciledStoreResult | null | undefined>,
  args: TArgs,
): Promise<ReconciledStoreDrain> {
  let last: ReconciledStoreResult = {};
  const unlinked: UnlinkedEntry[] = [];
  const relinked: UnlinkedEntry[] = [];
  let unlinkedTotal = 0;
  let relinkedTotal = 0;
  let writeOps = 0;
  let pages = 0;
  let converged = true;

  for (;;) {
    const page = (await store(args)) ?? {};
    pages++;
    last = page;
    unlinked.push(...(page.unlinked ?? []));
    relinked.push(...(page.relinked ?? []));
    unlinkedTotal += page.unlinkedTotal ?? 0;
    relinkedTotal += page.relinkedTotal ?? 0;
    writeOps += page.writeOps ?? 0;
    if (!page.hasMore) break;
    if (pages >= RECONCILED_STORE_MAX_PAGES) {
      converged = false;
      break;
    }
  }

  return {
    // `hasMore` is left exactly as the last page reported it, so a caller that
    // reads the merged result alone still sees an unfinished store.
    // The NEO-300 fields (`heldElsewhere*`, `withheldElsewhere*`,
    // `subtreeWalkSkipped`) ride in on `...last` on purpose:
    // recomputed per page, never summed (see the header).
    stored: {
      ...last,
      unlinked: unlinked.slice(0, UNLINK_NOTICE_LIMIT),
      unlinkedTotal,
      relinked: relinked.slice(0, UNLINK_NOTICE_LIMIT),
      relinkedTotal,
      writeOps,
    },
    pages,
    converged,
  };
}
