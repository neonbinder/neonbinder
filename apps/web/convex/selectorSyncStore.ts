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
import { MAX_SLOT_LABEL_LENGTH, type PlatformSide } from "./platformSlots";
import type { IncomingItem } from "./selectorSyncMatch";

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
// NEO-300 / NEO-312 — rows elsewhere that already hold an item's ids
// ───────────────────────────────────────────────────────────────────────────

/** The levels a holder elsewhere can sit at (see `loadSyncHoldersElsewhere`). */
export type HolderLevel = "setName" | "variantType" | "insert" | "parallel";

/**
 * One row the store left alone because it already lives elsewhere and holds
 * the item's marketplace id (see `heldElsewhere` in `planSelectorSync`).
 *
 * `value` and `parentValue` are NB's own names — the row's and the row it sits
 * under now — never the marketplace's label for the incoming item: the notice
 * reads "Refractor is already under Chrome", about NB's tree.
 *
 * NEO-312 — the holder may now be anywhere in the set (another variant type,
 * the Base) or in another set of the brand, so `level` names all four set
 * levels, and `path` carries the NB names from the holder's set down to its
 * parent ("Bowman", "Insert", "All-America Game Autos") so the operator can
 * find it. Optional, so an older client that never reads it is unaffected.
 */
export const heldElsewhereEntryValidator = v.object({
  id: v.id("selectorOptions"),
  value: v.string(),
  level: v.union(
    v.literal("setName"),
    v.literal("variantType"),
    v.literal("insert"),
    v.literal("parallel"),
  ),
  parentId: v.id("selectorOptions"),
  parentValue: v.string(),
  path: v.optional(v.array(v.string())),
});

export type HeldElsewhereEntry = {
  id: Id<"selectorOptions">;
  value: string;
  level: HolderLevel;
  parentId: Id<"selectorOptions">;
  parentValue: string;
  path?: string[];
};

/**
 * NEO-300 — an item the store WITHHELD because of what it found (or could not
 * check) elsewhere, reported to the operator rather than only logged
 * (security audit, NEO-300). Nothing was written for it.
 *
 *   reason "heldByMany"   — the item's marketplace ids are held by more than
 *                           one row elsewhere; the store will not pick one.
 *   reason "idsDisagree"  — the modal said the item IS a row elsewhere
 *                           (`existingId`), but that row does not hold the id
 *                           the item carries.
 *   reason "notChecked"   — NEO-312: the item carries an id no sibling holds,
 *                           and the set walk that would say whether another
 *                           row already holds it stopped on a bound. Fail
 *                           closed: a row created (or a link attached) now
 *                           could be a second holder of one marketplace id.
 *                           `holders` is empty.
 *   reason "linkHeldElsewhere" — NEO-312: the item MATCHED one of the sync's
 *                           own rows (by another id, or the modal's
 *                           `existingId`), but one of its ids is already held
 *                           by another row. That id was NOT attached to the
 *                           matched row; the row's existing links and the
 *                           rest of the refresh stand. `holders` names the
 *                           row that holds it.
 *
 * `label` is the item's own `value` as the caller sent it (the line the
 * operator saw in the modal), trimmed to the selector value limit; `holders`
 * are the NB rows it points at, named by NB values only.
 */
export const withheldElsewhereEntryValidator = v.object({
  label: v.string(),
  reason: v.union(
    v.literal("heldByMany"),
    v.literal("idsDisagree"),
    v.literal("notChecked"),
    v.literal("linkHeldElsewhere"),
  ),
  holders: v.array(heldElsewhereEntryValidator),
});

export type WithheldElsewhereReason =
  | "heldByMany"
  | "idsDisagree"
  | "notChecked"
  | "linkHeldElsewhere";

export type WithheldElsewhereEntry = {
  label: string;
  reason: WithheldElsewhereReason;
  holders: HeldElsewhereEntry[];
};

/** At most this many holders are named per withheld entry. */
export const WITHHELD_HOLDERS_LIMIT = 10;

/**
 * NEO-300 — the most insert-level rows the walk may read across the SET
 * (NEO-312; it used to be one variant type) before it stops and the store
 * fails closed. Every variant type's insert-level rows count: the Insert
 * type's inserts AND the Parallel type's rows, which are insert-level too.
 *
 * Sized against real sets, with headroom (NEO-312 raised it from 400): 2026
 * Bowman's Insert type alone carries ~140 inserts, its Parallel type another
 * few dozen to ~100 rows, so a flagship set sits around 200–250; the biggest
 * products (Prizm, Chrome, with 100+ parallels in the Parallel type) reach
 * ~300–400. 400 left no headroom for the very sets this check protects, and
 * the cost of tripping it is that set's new rows being withheld. 800 is 3–4x
 * a flagship set and 2x the biggest.
 *
 * Cost: one indexed read per insert-level row (its parallels), charged to the
 * 800-write budget capped at half — so at the bound a page spends ~800 reads
 * plus ≥400 writes plus ~60 fixed, ~1,300 operations: past the ~900 the house
 * calls comfortable, well short of the ~4,000 that fails, and only on the
 * biggest sets. 4,096 index ranges is the hard read ceiling.
 */
export const MAX_SUBTREE_WALK_INSERTS = 800;

/**
 * NEO-300 — the most DOCUMENTS the set walk may read (the variant types, the
 * insert-level rows and every parallel under an insert). Operations and
 * documents are separate Convex budgets: a `.collect()` of 900 parallels is
 * one operation but 900 documents. Counted as the walk goes — the cheapest
 * honest measure, since a document's byte size is not observable without
 * serialising it.
 *
 * NEO-312 raised it from 4,000 with the set scope: BSC files an insert's
 * colour parallels under it, so ~140 Bowman inserts at a handful of
 * parallels each, plus the Parallel type, is ~1,000–1,500 documents, and a
 * Chrome or Prizm set with 10–20 parallels per insert approaches 3,000. 6,000
 * is 2x that, a fifth of the 32k documents a transaction may scan, and at
 * ~1 KB a row a few MB of data read.
 */
export const MAX_SUBTREE_WALK_DOCUMENTS = 6000;

/**
 * NEO-312 — the brand walk's bounds: the indexed reads it may make (one per
 * set, variant type and insert in the brand's OTHER sets) and the documents it
 * may collect. The walk is BEST EFFORT (see `loadSyncHoldersElsewhere`), so
 * these are a cost cap, not a correctness line: past them the walk keeps what
 * it found and lets the rest through. 2,000 documents is the ceiling the
 * client's own brand walk (`getBrandSlHolders`) uses; 600 reads keeps the
 * worst case — a set at the set-walk bound plus a full brand walk plus the
 * writes — near ~1,900 operations, short of the ~4,000 that fails.
 */
export const MAX_BRAND_WALK_READS = 600;
export const MAX_BRAND_WALK_DOCUMENTS = 2000;

/**
 * NEO-312 (security audit S3) — the bytes a holder walk always leaves unread in
 * the transaction's 16 MiB read budget. The walks count documents, not bytes,
 * and a row's size is not known until it is read, so before every read they ask
 * Convex how much budget is left (`ctx.meta.getTransactionMetrics()`) and stop
 * below this reserve: the set walk fails closed, the brand walk truncates.
 *
 * What the reserve has to cover: the rest of the store's own transaction (the
 * write pass, the unlink notices' card reads) and one more walk read that is
 * already in flight when the check passes — at most `WALK_MAX_DOCS_PER_READ`
 * rows, ~1–2 MB at selectorOptions sizes. 4 MiB is a quarter of the budget.
 */
export const WALK_BYTES_RESERVE = 4 * 1024 * 1024;

/**
 * NEO-312 (security audit S3) — the most rows one walk read may return. A
 * parent with more children than this is past any real set (an insert's
 * parallels run to dozens); the read stops there and the walk treats it as a
 * documents bound, so no single read can carry the walk past the reserve.
 */
export const WALK_MAX_DOCS_PER_READ = 1000;

export type SyncHoldersElsewhere = {
  /**
   * Rows that are not siblings of this sync and hold (or, inside the sync's
   * own variant type, may be named by) an incoming item's ids. Each is a
   * read-only VIEW: a row that counts on one side only carries that side's
   * slots here, so the matcher cannot see an id it must not compare. Never
   * written back.
   */
  rows: Doc<"selectorOptions">[];
  /** Every row the walk read, by id — to name a held row and its path. */
  parentsById: Map<string, Doc<"selectorOptions">>;
  /**
   * `db.get` + index reads this walk made, for the caller's op budget. Spent
   * even when a bound then stops the walk, so it is charged either way.
   */
  reads: number;
  /** A bound stopped the SET walk (see `uncheckedSides`). */
  skipped: boolean;
  /**
   * NEO-312 — the sides on which the holder index is INCOMPLETE because a
   * bound stopped the SET walk: both, then (it reads both). The matcher fails
   * closed on them: an item carrying an id on one of these sides that no
   * sibling and no known holder has is WITHHELD (`notChecked`), never stored.
   * Empty on every real set. The brand walk never sets it (best effort).
   */
  uncheckedSides: PlatformSide[];
  /**
   * NEO-312 — the brand walk stopped on its bound. Best effort: holders it
   * found are still held; ids it did not reach are let through. For the log.
   */
  brandWalkTruncated: boolean;
};

/** Which of a row's sides make it a holder. */
type HolderSides = "both" | "sportlots";

/**
 * A holder's read-only view. "both": the row as it is (inside the set, at
 * insert and parallel level, both marketplaces' ids identify a set, and a row
 * with no ids still counts so the modal's `existingId` can name it). "sportlots":
 * only its SportLots slots, or `null` when it has none.
 *
 * Why SportLots alone above insert level and across the brand: SportLots is a
 * FLAT list — a SportLots set id means the same set at any level and under any
 * set of the brand, so a second NB row holding it is the duplicate. A BSC id
 * is a facet value of a hierarchy (a set's `setName`, a variant type's
 * `variant`, an insert's `variantName`): the set's own BSC id and a variant
 * type's "parallel" are not the same BSC entity as anything an insert sync
 * stores, and the same `variantName` under two of the brand's sets is two BSC
 * sets. Comparing them would withhold real rows, not duplicates.
 */
function holderView(
  row: Doc<"selectorOptions">,
  sides: HolderSides,
): Doc<"selectorOptions"> | null {
  if (sides === "both") return row;
  const sl = row.platformData?.sportlots;
  if (!sl || Object.keys(sl).length === 0) return null;
  return { ...row, platformData: { sportlots: sl } };
}

/**
 * NEO-300, widened by NEO-312 — every row that is NOT a sibling of this sync
 * and already holds an id an incoming item carries, or `null` when the sync
 * is not inside a set's variant-type subtree.
 *
 * ## Why it reaches past the variant type (NEO-312)
 *
 * NEO-300 made the stores look past their siblings into the same variant
 * type, because Group Parallels moves rows between insert and parallel inside
 * one. NEO-305's "Make parallel of…" and NEO-306's "Make insert of…" move a
 * row's SportLots link ACROSS variant types and across sets — out of the
 * Parallel type into a parallel under an insert in the Insert type, or onto a
 * set's Base — and delete the source row. The next Sync Parallels then saw
 * nothing holding that SportLots id and created the row again, so two NB rows
 * held one SportLots link. The client only partly held these ids back, and a
 * reconcile dialog opened BEFORE the move kept offering them, so the store is
 * where it has to be decided.
 *
 * ## Scope
 *
 *   level=insert,   parent = a variantType V → siblings are V's inserts.
 *   level=parallel, parent = an insert P     → siblings are P's parallels.
 *
 * The SET is V's (or P's variant type's) parent:
 *
 *   - V's subtree (NEO-300): at `insert`, every insert's parallels; at
 *     `parallel`, every insert (P included, below) and every other insert's
 *     parallels. Both marketplaces' ids, and id-less rows too (tier 0 can
 *     name them).
 *   - every OTHER variant type's inserts and parallels: both marketplaces.
 *   - the set row and every variant type row (the Base holds its SportLots
 *     links on itself): SportLots only.
 *
 * The sync's DIRECT parent IS a holder (NEO-312; NEO-300 left it out). One
 * marketplace link lives on one NB row: a NEW parallel cannot take its parent
 * insert's SportLots or BSC id, and a new insert cannot take a SportLots id
 * its variant type row holds. A child row that ALREADY carries the id is a
 * sibling and still matches — a sibling always wins — so nothing an existing
 * row holds changes. The client's held-id rule is the same (NEO-312).
 *
 * Then, only when some item still carries a SportLots id that no sibling and
 * no row of the set holds: every row under the brand's OTHER sets, at every
 * level, SportLots only (the same walk `getBrandSlHolders` makes for the
 * form).
 *
 * NEO-312 (audit N4) — level=setName, parent = a manufacturer (Sync Sets): the
 * siblings are the brand's sets, so there is no set walk; the brand walk runs
 * from each set downward (variant types, inserts, parallels), SportLots only,
 * so a link "Make parallel of…" / "Make insert of…" moved DOWN from a set is
 * not re-created as a set by a stale Sync Sets save. Best effort, like every
 * brand walk; past its bound the client's `listBrandSubtreeSlIds` filter is
 * the protection.
 *
 * Any other level/parent → `null`, today's sibling-only rule. A variant type
 * with no set above it (a bare fixture) walks its own subtree only.
 *
 * Every read is bounded three ways: the transaction's remaining read BYTES
 * (`WALK_BYTES_RESERVE`, asked of Convex before each read), the rows one read
 * may return (`WALK_MAX_DOCS_PER_READ`), and the walk's documents and reads.
 *
 * ## The set walk fails closed; the brand walk is best effort
 *
 * A bound that stops the SET walk returns no rows and both sides unchecked —
 * all or nothing, since a partial index would make "held" depend on which
 * rows happened to be read first. The matcher withholds what it cannot clear
 * (`uncheckedSides`), so a bound can cost a sync its new rows — reported —
 * but never adds a second holder of one marketplace id inside a set, which is
 * where the NEO-312 bug lives.
 *
 * A bound that stops the BRAND walk keeps every holder found so far (still
 * held) and lets the rest through, logging `brandWalkTruncated`. A first-time
 * SportLots set is held by no one, so it always sends the store to the brand;
 * failing closed there would withhold every new set of a big brand-year. The
 * form already holds the brand's other sets' ids (`getBrandSlHolders`); the
 * server's brand scope only closes the stale-dialog race.
 *
 * Reads, by index only, counted as `reads` for the callers' op budgets.
 */
export async function loadSyncHoldersElsewhere(
  ctx: QueryCtx,
  args: {
    level: string;
    parent: Doc<"selectorOptions"> | null;
    siblings: readonly Doc<"selectorOptions">[];
    items: readonly IncomingItem[];
  },
): Promise<SyncHoldersElsewhere | null> {
  const { level, parent, siblings, items } = args;
  if (!parent) return null;

  let reads = 0;
  let documents = 0;
  let insertsSeen = 0;
  const parentsById = new Map<string, Doc<"selectorOptions">>();
  const siblingIds = new Set<string>(siblings.map((s) => s._id));
  const holders = new Map<string, Doc<"selectorOptions">>();
  const addHolder = (
    target: Map<string, Doc<"selectorOptions">>,
    row: Doc<"selectorOptions">,
    sides: HolderSides,
  ) => {
    if (siblingIds.has(row._id)) return;
    if (holders.has(row._id) || target.has(row._id)) return;
    const view = holderView(row, sides);
    if (view) target.set(row._id, view);
  };
  /**
   * NEO-312 (security audit S3) — is there room in this transaction's 16 MiB
   * read budget for another walk read AND the store's own reads after it?
   * Asked before every read; documents are counted too (a second guard),
   * because a document's size is not known until it is read.
   */
  const roomToRead = async () =>
    (await ctx.meta.getTransactionMetrics()).bytesRead.remaining >= WALK_BYTES_RESERVE;

  let variantType: Doc<"selectorOptions"> | null = null;
  if (level === "insert" && parent.level === "variantType") {
    variantType = parent;
  } else if (
    level === "parallel" &&
    parent.level === "insert" &&
    parent.parentId !== undefined
  ) {
    const vt = await ctx.db.get(parent.parentId);
    reads++;
    if (!vt || vt.level !== "variantType") return null;
    variantType = vt;
  } else if (level === "setName" && parent.level === "manufacturer") {
    // NEO-312 (audit N4) — a Sync Sets save: the siblings are the brand's
    // sets; see the brand walk below.
    variantType = null;
  } else {
    return null;
  }
  parentsById.set(parent._id, parent);

  const skipAll = (bound: string): SyncHoldersElsewhere => {
    console.warn(
      JSON.stringify({
        msg: "selector_sync_subtree_walk_skipped",
        scope: "set",
        level,
        parentId: parent._id,
        bound,
        reads,
        inserts: insertsSeen,
        documents,
        limitInserts: MAX_SUBTREE_WALK_INSERTS,
        limitDocuments: MAX_SUBTREE_WALK_DOCUMENTS,
        effect: "items naming an id no sibling holds are withheld, not stored",
      }),
    );
    return {
      rows: [],
      parentsById: new Map(),
      reads,
      skipped: true,
      uncheckedSides: ["bsc", "sportlots"],
      brandWalkTruncated: false,
    };
  };
  /** One bounded read of a row's children for the set walk; `null` = stop. */
  const setRead = async (
    q: (cap: number) => Promise<Doc<"selectorOptions">[]>,
  ): Promise<Doc<"selectorOptions">[] | "bytes" | "documents"> => {
    if (!(await roomToRead())) return "bytes";
    const rows = await q(WALK_MAX_DOCS_PER_READ + 1);
    reads++;
    documents += rows.length;
    if (rows.length > WALK_MAX_DOCS_PER_READ) return "documents";
    if (documents > MAX_SUBTREE_WALK_DOCUMENTS) return "documents";
    return rows;
  };

  // ── The set (fails closed) ──────────────────────────────────────────────
  let setRow: Doc<"selectorOptions"> | null = null;
  let brandRow: Doc<"selectorOptions"> | null = level === "setName" ? parent : null;
  if (variantType) {
    parentsById.set(variantType._id, variantType);
    if (variantType.parentId !== undefined) {
      const set = await ctx.db.get(variantType.parentId);
      reads++;
      if (set && set.level === "setName") setRow = set;
    }

    let types: Doc<"selectorOptions">[] = [variantType];
    if (setRow) {
      parentsById.set(setRow._id, setRow);
      const setId = setRow._id;
      const read = await setRead((cap) =>
        ctx.db
          .query("selectorOptions")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", "variantType").eq("parentId", setId),
          )
          .take(cap),
      );
      if (!Array.isArray(read)) return skipAll(read);
      types = read;
      addHolder(holders, setRow, "sportlots");
    }

    for (const type of types) {
      parentsById.set(type._id, type);
      addHolder(holders, type, "sportlots");
      let inserts: Doc<"selectorOptions">[];
      if (level === "insert" && type._id === variantType._id) {
        // At `insert` the parent variant type's inserts ARE the siblings.
        inserts = [...siblings];
      } else {
        const typeId = type._id;
        const read = await setRead((cap) =>
          ctx.db
            .query("selectorOptions")
            .withIndex("by_level_and_parent", (q) =>
              q.eq("level", "insert").eq("parentId", typeId),
            )
            .take(cap),
        );
        if (!Array.isArray(read)) return skipAll(read);
        inserts = read;
      }
      insertsSeen += inserts.length;
      if (insertsSeen > MAX_SUBTREE_WALK_INSERTS) return skipAll("inserts");

      for (const insert of inserts) {
        parentsById.set(insert._id, insert);
        addHolder(holders, insert, "both");
        // At `parallel`, the parent insert's own parallels are the siblings.
        if (insert._id === parent._id) continue;
        const insertId = insert._id;
        const read = await setRead((cap) =>
          ctx.db
            .query("selectorOptions")
            .withIndex("by_level_and_parent", (q) =>
              q.eq("level", "parallel").eq("parentId", insertId),
            )
            .take(cap),
        );
        if (!Array.isArray(read)) return skipAll(read);
        for (const parallel of read) addHolder(holders, parallel, "both");
      }
    }
  }

  // Past this point the set walk finished: nothing is unchecked, and the
  // brand walk below can only ADD holders (best effort).
  const done = (
    extra: Map<string, Doc<"selectorOptions">> = new Map(),
    brandWalkTruncated = false,
  ): SyncHoldersElsewhere => ({
    rows: [...holders.values(), ...extra.values()],
    parentsById,
    reads,
    skipped: false,
    uncheckedSides: [],
    brandWalkTruncated,
  });

  // ── The brand (best effort), only for a SportLots id nobody nearer holds ─
  const heldSl = new Set<string>();
  for (const row of [...siblings, ...holders.values()]) {
    for (const id of Object.values(row.platformData?.sportlots ?? {})) heldSl.add(id);
  }
  const needsBrand = items.some((item) => {
    const id = item.ids.sportlots;
    return id !== undefined && !heldSl.has(id);
  });
  if (!needsBrand) return done();
  if (!brandRow) {
    if (!setRow?.parentId) return done();
    const brand = await ctx.db.get(setRow.parentId);
    reads++;
    if (!brand || brand.level !== "manufacturer") return done();
    brandRow = brand;
  }
  parentsById.set(brandRow._id, brandRow);

  const brandHolders = new Map<string, Doc<"selectorOptions">>();
  const brandParents = new Map<string, Doc<"selectorOptions">>();
  let brandReads = 0;
  let brandDocuments = 0;
  /**
   * BEST EFFORT past a bound: keep every holder already found (a found holder
   * is real, so the item it names is still held), log the truncation (counts
   * only), and let the rest through. Failing closed here would withhold every
   * first-time SportLots set of a big brand-year, since such an id is held by
   * no one and so always sends the store to the brand. The cross-set case is
   * held by the form (`getBrandSlHolders`; Sync Sets: `listBrandSubtreeSlIds`);
   * this walk only closes the stale-dialog race.
   */
  const truncateBrand = (bound: string): SyncHoldersElsewhere => {
    console.warn(
      JSON.stringify({
        msg: "selector_sync_brand_walk_truncated",
        brandWalkTruncated: true,
        level,
        parentId: parent._id,
        bound,
        brandReads,
        brandDocuments,
        holdersFound: brandHolders.size,
        limitReads: MAX_BRAND_WALK_READS,
        limitDocuments: MAX_BRAND_WALK_DOCUMENTS,
        effect: "holders found so far are held; other ids are let through",
      }),
    );
    for (const [id, row] of brandParents) parentsById.set(id, row);
    return done(brandHolders, true);
  };
  /** One bounded read of a row's children for the brand walk. */
  const brandRead = async (
    q: (cap: number) => Promise<Doc<"selectorOptions">[]>,
  ): Promise<Doc<"selectorOptions">[] | "reads" | "bytes" | "documents"> => {
    if (brandReads >= MAX_BRAND_WALK_READS) return "reads";
    if (!(await roomToRead())) return "bytes";
    const cap = Math.min(
      WALK_MAX_DOCS_PER_READ + 1,
      MAX_BRAND_WALK_DOCUMENTS - brandDocuments + 1,
    );
    const rows = await q(cap);
    reads++;
    brandReads++;
    brandDocuments += rows.length;
    if (rows.length > WALK_MAX_DOCS_PER_READ) return "documents";
    if (brandDocuments > MAX_BRAND_WALK_DOCUMENTS) return "documents";
    return rows;
  };

  let frontier: Doc<"selectorOptions">[];
  if (level === "setName") {
    // The siblings ARE the brand's sets; walk down from each.
    frontier = [...siblings];
  } else {
    const brandId = brandRow._id;
    const sets = await brandRead((cap) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "setName").eq("parentId", brandId),
        )
        .take(cap),
    );
    if (!Array.isArray(sets)) return truncateBrand(sets);
    frontier = sets.filter((s) => s._id !== setRow?._id);
  }
  while (frontier.length > 0) {
    const next: Doc<"selectorOptions">[] = [];
    for (const row of frontier) {
      brandParents.set(row._id, row);
      addHolder(brandHolders, row, "sportlots");
      if (row.level === "parallel") continue;
      const rowId = row._id;
      const children = await brandRead((cap) =>
        ctx.db
          .query("selectorOptions")
          .withIndex("by_parent", (q) => q.eq("parentId", rowId))
          .take(cap),
      );
      if (!Array.isArray(children)) return truncateBrand(children);
      next.push(...children);
    }
    frontier = next;
  }
  for (const [id, row] of brandParents) parentsById.set(id, row);
  return done(brandHolders);
}

/** Why one id was not attached to a matched sibling (NEO-312). */
export type LinkBlock = {
  reason: "linkHeldElsewhere" | "notChecked";
  holderIds: string[];
};

/**
 * NEO-312 — the matched-sibling half of "one link, one row".
 *
 * A sibling match wins (the item is that row), but an item that matched by
 * its BSC id — or by the modal's `existingId` — may carry a SportLots id
 * another row already holds. Refreshing would put that id on a second row.
 * Returns a checker the store asks before it attaches each incoming id the
 * matched row does not ALREADY hold: a holder elsewhere blocks it
 * (`linkHeldElsewhere`, naming the holder); on a side the set walk could not
 * finish it is blocked too (`notChecked`, fail closed). An id the row already
 * holds is never blocked — nothing a row holds changes.
 */
export function linkBlocker(
  holders: SyncHoldersElsewhere | null,
): (row: { platformData: Doc<"selectorOptions">["platformData"] }, side: PlatformSide, id: string) => LinkBlock | null {
  const bySide: Record<PlatformSide, Map<string, string[]>> = {
    bsc: new Map(),
    sportlots: new Map(),
  };
  for (const row of holders?.rows ?? []) {
    for (const side of ["bsc", "sportlots"] as const) {
      for (const id of Object.values(row.platformData?.[side] ?? {})) {
        const list = bySide[side].get(id);
        if (!list) bySide[side].set(id, [row._id]);
        else if (!list.includes(row._id)) list.push(row._id);
      }
    }
  }
  const unchecked = new Set<PlatformSide>(holders?.uncheckedSides ?? []);
  return (row, side, id) => {
    if (Object.values(row.platformData?.[side] ?? {}).includes(id)) return null;
    const found = bySide[side].get(id);
    if (found && found.length > 0) return { reason: "linkHeldElsewhere", holderIds: found };
    if (unchecked.has(side)) return { reason: "notChecked", holderIds: [] };
    return null;
  };
}

/** One withheld entry for every id a matched item could not attach. */
export function linkWithheldEntry(
  label: string,
  blocks: readonly LinkBlock[],
  rowsById: ReadonlyMap<string, Doc<"selectorOptions">>,
  parentsById: ReadonlyMap<string, Doc<"selectorOptions">>,
): WithheldElsewhereEntry {
  const held = blocks.filter((b) => b.reason === "linkHeldElsewhere");
  return withheldElsewhereEntry(
    label,
    {
      reason: held.length > 0 ? "linkHeldElsewhere" : "notChecked",
      holderIds: [...new Set(held.flatMap((b) => b.holderIds))],
    },
    rowsById,
    parentsById,
  );
}

/**
 * NEO-300 — the operator-facing entry for a withhold decided elsewhere.
 * `label` is the caller's own item value, trimmed to the selector value limit
 * (it is echoed back to the client that sent it, never stored); holders are
 * named by NB values only and capped at `WITHHELD_HOLDERS_LIMIT`.
 */
export function withheldElsewhereEntry(
  label: string,
  elsewhere: { reason: WithheldElsewhereReason; holderIds: readonly string[] },
  rowsById: ReadonlyMap<string, Doc<"selectorOptions">>,
  parentsById: ReadonlyMap<string, Doc<"selectorOptions">>,
): WithheldElsewhereEntry {
  const holders: HeldElsewhereEntry[] = [];
  for (const id of elsewhere.holderIds) {
    if (holders.length >= WITHHELD_HOLDERS_LIMIT) break;
    const row = rowsById.get(id);
    const entry = row ? heldElsewhereEntry(row, parentsById) : null;
    if (entry) holders.push(entry);
  }
  return {
    label: label.trim().slice(0, MAX_SLOT_LABEL_LENGTH),
    reason: elsewhere.reason,
    holders,
  };
}

/** How many ancestors `path` names at most (set › type › insert, and spare). */
const MAX_HOLDER_PATH = 4;

/**
 * The notice entry for a held row, named by NB values only. `path` runs from
 * the holder's set down to its parent; a set holder's path is empty (its
 * parent is the brand, named in `parentValue`).
 */
export function heldElsewhereEntry(
  row: Doc<"selectorOptions">,
  parentsById: ReadonlyMap<string, Doc<"selectorOptions">>,
): HeldElsewhereEntry | null {
  if (
    row.level !== "setName" &&
    row.level !== "variantType" &&
    row.level !== "insert" &&
    row.level !== "parallel"
  ) {
    return null;
  }
  if (!row.parentId) return null;
  const parent = parentsById.get(row.parentId);
  if (!parent) return null;
  const path: string[] = [];
  if (row.level !== "setName") {
    let cursor: Doc<"selectorOptions"> | undefined = parent;
    while (cursor && path.length < MAX_HOLDER_PATH) {
      path.unshift(cursor.value);
      if (cursor.level === "setName" || !cursor.parentId) break;
      cursor = parentsById.get(cursor.parentId);
    }
  }
  return {
    id: row._id,
    value: row.value,
    level: row.level,
    parentId: row.parentId,
    parentValue: parent.value,
    path,
  };
}
