/**
 * NEO-211 — the pieces both selector-sync stores share that need a `ctx`.
 *
 * `convex/selectorSyncMatch.ts` holds the pure matching rules. This file holds
 * the two things that cannot be pure — the wire validators the two mutations
 * must agree on byte-for-byte, and the one indexed read that turns an unlinked
 * row into a notice worth reading — plus the `children` union.
 *
 * Kept out of `selectorOptions.ts` deliberately: `setReconciliation.ts` needs
 * the same definitions, and importing a 9,000-line function module from
 * another function module drags its whole dependency graph into that isolate.
 */

import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { PlatformSide } from "./platformSlots";

/**
 * Hard ceiling on a single sync batch.
 *
 * The matcher is O(items × siblings-with-the-same-name), which is fine, but a
 * mutation that walks an unbounded client-supplied array is a transaction-time
 * bomb regardless of how cheap each element is. BSC's largest year-level set
 * list is in the hundreds; 2,000 is generous headroom that still fails fast
 * and loudly rather than timing out halfway through a write.
 */
export const MAX_SYNC_ITEMS = 2000;

/**
 * How many unlink notices are kept.
 *
 * The list is written into `selectorSyncStatus`, which every open SetSelector
 * column subscribes to reactively — an unbounded list would be re-shipped to
 * the browser on every unrelated change in the tree. `unlinkedTotal` carries
 * the true count so the notice can say "50 of 312" honestly.
 */
export const UNLINK_NOTICE_LIMIT = 50;

/** Levels whose rows can own a stored checklist. */
const CHECKLIST_BEARING_LEVELS = new Set(["variantType", "insert", "parallel"]);

export const platformSideValidator = v.union(
  v.literal("bsc"),
  v.literal("sportlots"),
);

/**
 * One row that lost a marketplace link this run.
 *
 * `hasCards` is the difference between "a stub lost its BSC link" and "the set
 * you spent an evening entering 400 cards into lost its BSC link". Only
 * populated at levels that can hold a checklist.
 */
/**
 * NEO-211 F1 — what the FETCH returned, as opposed to what the caller is
 * asking us to store.
 *
 * On the `ReconciliationModal` path those are different lists: the modal seeds
 * every existing row into Ready, so `reconciledItems` is the operator's
 * confirmed set, not the marketplace's. Without this the unlink pass both
 * misses a genuinely delisted set and reports an operator's own DISBAND as
 * "no longer listed on BSC".
 *
 * Bounded, but the bound DEGRADES rather than throws — see
 * `checkReturnedIds` below.
 */
export const MAX_RETURNED_IDS = 20000;

/**
 * The point past which a `returnedIds` payload is not a big year, it is abuse.
 *
 * Total across both sides. A real marketplace year tops out in the low
 * thousands per side (SportLots returned 2,563 sets for 2024 baseball); ids are
 * short slugs, so 20k per side is far inside Convex's argument limits and still
 * a bound. Anything past 100k total is not a fetch result.
 */
export const MAX_RETURNED_IDS_TOTAL = 100000;

export const returnedIdsValidator = v.object({
  bsc: v.optional(v.array(v.string())),
  sportlots: v.optional(v.array(v.string())),
});

/**
 * Decide what to do with a `returnedIds` payload that is bigger than expected.
 *
 * This used to throw at 2,000 per side, which took down a real sync: SportLots
 * lists 2,563 sets for a single year, the form passed them all, and "Save 76
 * sets" never completed — the entire additive store was lost to a bound that
 * only ever guarded the UNLINK pass.
 *
 * So the failure mode is now proportionate. A side over the cap is reported as
 * TRUNCATED and treated as not covered: the store still writes everything the
 * caller asked it to write, and simply declines to unlink on a side whose
 * returned-id list it could not trust. Losing an unlink notice for one run is
 * recoverable; losing the operator's 76 saved sets is not.
 *
 * Only a grossly abusive total still throws.
 */
export function checkReturnedIds(
  returnedIds: { bsc?: string[]; sportlots?: string[] } | undefined,
  fnName: string,
): { truncatedSides: PlatformSide[] } {
  if (!returnedIds) return { truncatedSides: [] };
  const total =
    (returnedIds.bsc?.length ?? 0) + (returnedIds.sportlots?.length ?? 0);
  if (total > MAX_RETURNED_IDS_TOTAL) {
    throw new Error(
      `${fnName}: returnedIds carries ${total} entries, over the ` +
        `${MAX_RETURNED_IDS_TOTAL} hard limit`,
    );
  }
  const truncatedSides: PlatformSide[] = [];
  for (const side of ["bsc", "sportlots"] as const) {
    if ((returnedIds[side]?.length ?? 0) > MAX_RETURNED_IDS) {
      truncatedSides.push(side);
    }
  }
  if (truncatedSides.length > 0) {
    console.warn(
      JSON.stringify({
        msg: "selector_sync_returned_ids_truncated",
        fn: fnName,
        sides: truncatedSides,
        counts: {
          bsc: returnedIds.bsc?.length ?? 0,
          sportlots: returnedIds.sportlots?.length ?? 0,
        },
        effect: "side treated as not covered; nothing unlinked on it",
      }),
    );
  }
  return { truncatedSides };
}

export const unlinkedEntryValidator = v.object({
  id: v.id("selectorOptions"),
  value: v.string(),
  side: platformSideValidator,
  hasCards: v.optional(v.boolean()),
});

/**
 * NEO-211 — a row whose marketplace link CHANGED this run: detached
 * (`unlinked`) or rebound to a new id for the same set (`relinked`, the
 * re-slug heal). Same shape, two lists; `hasCards` is only populated on the
 * unlink side, where "did this cost someone a checklist?" is the question.
 */
export type UnlinkedEntry = {
  id: Id<"selectorOptions">;
  value: string;
  side: PlatformSide;
  hasCards?: boolean;
};

/**
 * Answer "does this row own any cards?" for the notices we are about to show.
 *
 * One indexed `.first()` per entry, and only for the entries that survive the
 * cap — so the read count is bounded by `UNLINK_NOTICE_LIMIT` no matter how
 * badly a sync went.
 */
export async function annotateHasCards(
  ctx: QueryCtx,
  level: string,
  entries: readonly UnlinkedEntry[],
): Promise<UnlinkedEntry[]> {
  if (!CHECKLIST_BEARING_LEVELS.has(level)) return [...entries];
  const out: UnlinkedEntry[] = [];
  for (const entry of entries) {
    const card = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", entry.id),
      )
      .first();
    out.push({ ...entry, hasCards: card !== null });
  }
  return out;
}

/**
 * `children` is a CACHE with exactly one consumer (feature propagation's
 * `collectDescendantIds`, which tolerates dangling ids); every column list
 * reads `by_level_and_parent` instead. So the only correctness requirement is
 * that it never LOSES a child — which is precisely what the old
 * rebuild-from-this-sync behaviour did to any row the sync did not name.
 *
 * Set-union, order-stable: whatever is already there keeps its position, new
 * ids are appended. Stable order matters for the NEO-85 write-if-changed
 * guard — a re-ordered array is a "change" and would patch the parent (and
 * reflow every column under Maestro) on every no-op sync.
 */
export function unionChildren(
  current: readonly Id<"selectorOptions">[] | undefined,
  additions: readonly Id<"selectorOptions">[],
): Id<"selectorOptions">[] {
  const out: Id<"selectorOptions">[] = [...(current ?? [])];
  const seen = new Set<string>(out);
  for (const id of additions) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
