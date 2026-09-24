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
import type { Doc, Id } from "./_generated/dataModel";
import type { PlatformSide } from "./platformSlots";

/**
 * Hard ceiling on the ARGUMENT a single sync batch may carry.
 *
 * The matcher is O(items × siblings-with-the-same-name), which is fine, but a
 * mutation that walks an unbounded client-supplied array is a transaction-time
 * bomb regardless of how cheap each element is. 2,000 is where that argument
 * is refused, fast and loudly, rather than timing out halfway through a write.
 *
 * ## NEO-296 — this is NOT the transaction bound, and it never was
 *
 * The original note here read "BSC's largest year-level set list is in the
 * hundreds; 2,000 is generous headroom". Both halves went stale: SportLots
 * listed 2,563 sets for one year, and the number was chosen against the
 * matcher's CPU with no reference to what an item costs in Convex SYSTEM
 * OPERATIONS. Those are counted one per CALL — a `.collect()` of 2,000 rows is
 * one — so the cost that matters is the per-item loop: one `insert` per fresh
 * row and one `patch` per changed row. At this cap that is up to ~4,000
 * operations, past the line where a transaction fails outright.
 *
 * The real bound is a WRITE BUDGET inside each store, applied per transaction
 * and resumable by replay:
 *
 *   `SELECTOR_STORE_WRITE_BUDGET`  — `selectorOptions.storeSelectorOptions`
 *   `RECONCILE_STORE_WRITE_BUDGET` — `setReconciliation.storeReconciledOptions`
 *
 * So this constant now does one job only: it bounds the ARRAY a caller may
 * hand over in one call. How much of that array a given transaction gets
 * through is the budget's question, and both stores report `hasMore` when the
 * answer is "not all of it".
 */
export const MAX_SYNC_ITEMS = 2000;

// ───────────────────────────────────────────────────────────────────────────
// User-safe notice text
//
// Everything below builds `selectorSyncStatus.message`, which is REACTIVE
// STATE SERVED TO THE BROWSER. An adapter's own message can carry a
// marketplace URL, a response body or a credential hint, and an NB row's value
// is operator content — so these functions are built from a platform NAME and
// nothing else (NEO-47, NEO-211 B).
//
// The two builders live together because they must agree on that mapping: a
// side that failed and a side that was never asked are different events with
// the same vocabulary, and the FE renders both from the same notice.
// ───────────────────────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  bsc: "BuySportsCards",
  sportlots: "SportLots",
};

/**
 * An unrecognised key is NOT echoed. The only keys these ever receive are
 * "bsc" and "sportlots"; the fallback is what makes "no adapter string reaches
 * reactive state" a property of these functions rather than of their callers.
 *
 * Exported because NEO-216's "no marketplace serves this level" notice needs
 * the same naming and the same guarantee — one mapping, not two.
 */
export function platformNames(sides: readonly string[]): string {
  return sides
    .map((p) => PLATFORM_LABELS[p] ?? "A marketplace")
    .sort()
    .join(" and ");
}

/**
 * NEO-211 B — what the admin is told when ONE marketplace FAILED and the other
 * one stored fine.
 */
export function partialSyncMessage(failedPlatforms: readonly string[]): string {
  const names = platformNames(failedPlatforms);
  return (
    `${names} could not be reached, so nothing from ${names} was changed. ` +
    `Everything the other marketplace returned was saved — retry to fill in the rest.`
  );
}

/**
 * NEO-239 — what the admin is told when one marketplace was NEVER ASKED,
 * because this path carries no ids to scope it with.
 *
 * Deliberately distinct from `partialSyncMessage`: "could not be reached"
 * invites a Retry that would fail identically every time, because nothing is
 * wrong with the marketplace. The fix is to attach an id, which is a different
 * action in a different place.
 *
 * For the case where BOTH sides are skipped, callers use
 * `NO_MARKETPLACE_IDS_MESSAGE` instead and say nothing at all on the level-sync
 * path — a hand-made subtree has no marketplace behind it by design, and a
 * notice on every one of its columns would be noise the operator learns to
 * dismiss.
 */
export function skippedSyncMessage(skippedSides: readonly string[]): string {
  const names = platformNames(skippedSides);
  return `${names} skipped: no ${names} ids on this path.`;
}

/**
 * NEO-287 — what the admin is told when a marketplace was NEVER ASKED because
 * the operator has paused it (`NEONBINDER_PAUSED_PLATFORMS`).
 *
 * A third vocabulary, deliberately distinct from both of the above:
 * `partialSyncMessage` invites a Retry (the marketplace hiccupped),
 * `skippedSyncMessage` points at a missing id (attach one and it will run).
 * Neither is true here — nothing is wrong with the path and a retry changes
 * nothing until the operator lifts the pause — and the sentence also has to
 * carry the invariant-5 reassurance that the pause cost no links.
 *
 * Callers compose it the same way they compose the skipped sentence: appended
 * to the result message after a space, one sentence per run regardless of how
 * many sides are paused (the names are joined by `platformNames`). One paused
 * side plus one skipped side yields the paused sentence followed by the skipped
 * sentence — never `NO_MARKETPLACE_IDS_MESSAGE`, which would misreport a
 * pause as a missing id.
 *
 * Pure — this module is imported by React components and must stay free of
 * `process.env`; the caller reads the pause and passes the sides in.
 */
export function pausedSyncMessage(pausedSides: readonly string[]): string {
  const names = platformNames(pausedSides);
  const verb = pausedSides.length > 1 ? "are" : "is";
  return `${names} ${verb} on pause: nothing from ${names} was asked for or changed.`;
}

/**
 * NEO-287 — the notice for every side a run did NOT ask, in one string:
 * the paused sentence first, then the "no ids" sentence for the sides that
 * were skipped for want of ids. `undefined` when nothing was left unasked.
 *
 * Callers pass `pausedSideList(resolution)` and
 * `notifiableSkippedSides(resolution)` — the latter already excludes paused
 * sides, so a side is never described twice. This is the ONLY composition
 * rule: a paused side and a skipped side read as two sentences, and the
 * two-sided case never collapses into `NO_MARKETPLACE_IDS_MESSAGE` while a
 * pause is involved (that sentence would misreport the pause as a missing
 * id and send the operator to attach one).
 */
export function unaskedSidesNotice(
  pausedSides: readonly string[],
  skippedSides: readonly string[],
): string | undefined {
  const parts: string[] = [];
  if (pausedSides.length > 0) parts.push(pausedSyncMessage(pausedSides));
  if (skippedSides.length > 0) parts.push(skippedSyncMessage(skippedSides));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

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

// ───────────────────────────────────────────────────────────────────────────
// NEO-300 — rows elsewhere in the same variant type's subtree
// ───────────────────────────────────────────────────────────────────────────

/**
 * One row the store left alone because it already lives elsewhere in the
 * variant type's subtree (see `heldElsewhere` in `planSelectorSync`).
 *
 * `value` and `parentValue` are NB's own names — the row's and the row it sits
 * under now — never the marketplace's label for the incoming item: the notice
 * reads "Refractor is already under Chrome", about NB's tree.
 */
export const heldElsewhereEntryValidator = v.object({
  id: v.id("selectorOptions"),
  value: v.string(),
  level: v.union(v.literal("insert"), v.literal("parallel")),
  parentId: v.id("selectorOptions"),
  parentValue: v.string(),
});

export type HeldElsewhereEntry = {
  id: Id<"selectorOptions">;
  value: string;
  level: "insert" | "parallel";
  parentId: Id<"selectorOptions">;
  parentValue: string;
};

/**
 * NEO-300 — the most inserts one variant type may carry for the subtree walk
 * to run. The walk is one indexed read per insert, and the stores charge those
 * reads against their 800-write budgets capped at half, so 400 keeps a sync's
 * whole transaction inside the ~900 operations the house treats as
 * comfortable. A variant type past it is not a real set (a set's inserts run
 * to dozens, low hundreds at the extreme); the walk is skipped with a
 * structured warning and the store falls back to the sibling-only rule rather
 * than risk the transaction.
 */
export const MAX_SUBTREE_WALK_INSERTS = 400;

export type VariantTypeSubtreeElsewhere = {
  /** Subtree rows that are not siblings of this sync. */
  rows: Doc<"selectorOptions">[];
  /** Every row the walk read, by id — to name a held row's parent. */
  parentsById: Map<string, Doc<"selectorOptions">>;
  /** `db.get` + index reads this walk made, for the caller's op budget. */
  reads: number;
};

/**
 * NEO-300 — every row in the sync's variant-type subtree that is NOT one of
 * its siblings, or `null` when the sync is not inside such a subtree.
 *
 * A grouping (`applyParallelGroupings`) moves an insert down to be a parallel
 * of another insert, or a parallel up to be an insert, keeping its `_id`, its
 * slots and its cards. Both stores used to see only same-(level, parent)
 * siblings, so the next Sync Inserts no longer found the promoted row, matched
 * nothing, and re-created it at its old level. The subtree is what the match
 * has to see instead:
 *
 *   level=insert,   parent = a variantType → siblings are the inserts;
 *                   elsewhere = every insert's parallels.
 *   level=parallel, parent = an insert     → siblings are that insert's
 *                   parallels; elsewhere = every insert under the variant
 *                   type (the parent included) + every OTHER insert's
 *                   parallels.
 *
 * Any other level/parent → `null`, today's sibling-only rule.
 *
 * Reads, by index only: one `by_level_and_parent` per insert for its parallels
 * (the parent's own at `parallel` excluded — those are the siblings), plus at
 * `parallel` one for the inserts and one `db.get` for the variant type (to name
 * a demoted row's parent). They are returned as `reads` so the store charges
 * them against its write budget; see the two call sites. Bounded by
 * `MAX_SUBTREE_WALK_INSERTS`.
 */
export async function loadVariantTypeSubtreeElsewhere(
  ctx: QueryCtx,
  args: {
    level: string;
    parent: Doc<"selectorOptions"> | null;
    siblings: readonly Doc<"selectorOptions">[];
  },
): Promise<VariantTypeSubtreeElsewhere | null> {
  const { level, parent, siblings } = args;
  if (!parent) return null;

  let inserts: Doc<"selectorOptions">[];
  let reads = 0;
  const parentsById = new Map<string, Doc<"selectorOptions">>();
  const rows: Doc<"selectorOptions">[] = [];

  if (level === "insert" && parent.level === "variantType") {
    inserts = [...siblings];
    parentsById.set(parent._id, parent);
  } else if (
    level === "parallel" &&
    parent.level === "insert" &&
    parent.parentId !== undefined
  ) {
    const variantTypeId = parent.parentId;
    const variantType = await ctx.db.get(variantTypeId);
    reads++;
    if (!variantType || variantType.level !== "variantType") return null;
    parentsById.set(variantType._id, variantType);
    inserts = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "insert").eq("parentId", variantTypeId),
      )
      .collect();
    reads++;
    // Every insert is elsewhere at `parallel` — including the parent itself,
    // and including a parallel an operator demoted to an insert.
    rows.push(...inserts);
  } else {
    return null;
  }

  if (inserts.length > MAX_SUBTREE_WALK_INSERTS) {
    console.warn(
      JSON.stringify({
        msg: "selector_sync_subtree_walk_skipped",
        level,
        parentId: parent._id,
        inserts: inserts.length,
        limit: MAX_SUBTREE_WALK_INSERTS,
        effect: "sibling-only matching; a grouped row may be re-created",
      }),
    );
    return null;
  }

  for (const insert of inserts) {
    parentsById.set(insert._id, insert);
    // At `parallel`, the parent's own parallels ARE the siblings.
    if (insert._id === parent._id) continue;
    const parallels = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "parallel").eq("parentId", insert._id),
      )
      .collect();
    reads++;
    rows.push(...parallels);
  }

  const siblingIds = new Set<string>(siblings.map((s) => s._id));
  return {
    rows: rows.filter((row) => !siblingIds.has(row._id)),
    parentsById,
    reads,
  };
}

/** The notice entry for a held row, named by NB values only. */
export function heldElsewhereEntry(
  row: Doc<"selectorOptions">,
  parentsById: ReadonlyMap<string, Doc<"selectorOptions">>,
): HeldElsewhereEntry | null {
  if (row.level !== "insert" && row.level !== "parallel") return null;
  if (!row.parentId) return null;
  const parent = parentsById.get(row.parentId);
  if (!parent) return null;
  return {
    id: row._id,
    value: row.value,
    level: row.level,
    parentId: row.parentId,
    parentValue: parent.value,
  };
}
