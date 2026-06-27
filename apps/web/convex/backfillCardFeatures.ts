/**
 * NEO-38 (PR B-3): node+card materialized feature backfill for sets that were
 * synced BEFORE the materialized-inheritance pipeline (PR B-1) landed.
 *
 * Background
 * ----------
 * PR B-1 reworked features to MATERIALIZED inheritance: every selectorOptions
 * node carries its own resolved `features` map (parent's resolved features +
 * its own overrides), and `setSelectorOptionFeature` /
 * `materializeSelectorOptionFeature` cascade a value to descendant NODES and
 * cardChecklist rows. At sync, `commitCardChecklist` seeds the
 * `deriveSetLevelFeatures` heuristic FILL-ABSENT at each key's natural
 * originating node.
 *
 * The OLD backfill (commit d1baf01) gap-filled features directly onto each
 * `cardChecklist` row and never touched nodes — inconsistent with the new
 * model (the card-detail panel and SetFeaturesPanel now read resolved values
 * off the NODES). This file replaces it with a node+card backfill that mirrors
 * what `commitCardChecklist` does, but for already-synced data.
 *
 * What it does
 * ------------
 * For each setName subtree it seeds the `deriveSetLevelFeatures` heuristic
 * FILL-ABSENT (only when the target node's own `features[key]` is undefined)
 * via `materializeSelectorOptionFeature`, which cascades each value down to
 * descendant nodes AND cards. Because materialize's overwrite rule only
 * touches a node/card whose value is undefined OR equals the seeded node's
 * previous value, any operator/card-observed override is preserved, and a
 * second run is a no-op (idempotent).
 *
 * Set metadata (releaseDate / block / tcdbSetId / sourceUrl) is intentionally
 * OUT of scope here — it is manually edited via `setSetMetadata`. This backfill
 * only seeds the heuristic so pre-pipeline data isn't left blank.
 *
 * Originating-node mapping (mirrors commitCardChecklist's seedPlan)
 * ----------------------------------------------------------------
 *   league       → from the sport ancestor value
 *   era, vintage → from the year ancestor value
 *   manufacturer → from the manufacturer ancestor value
 *   isReprint    → default "false"
 *   cardType     → from each variant-leaf node's own level
 *
 * Batching / why it stays under Convex limits
 * -------------------------------------------
 * `materializeSelectorOptionFeature` SCANS the target node's whole subtree
 * (every descendant node + every cardChecklist row) on each call. Backfilling
 * many sets — or anchoring a key at a sport/year/manufacturer ancestor whose
 * subtree spans every set under it — in one mutation would blow Convex's
 * per-mutation read/write budget (~4096 reads / ~8192 writes).
 *
 * So the batch UNIT is a SINGLE setName subtree, and EVERY heuristic key is
 * anchored at the setName node or below (never at the sport/year/manufacturer
 * ancestor). Concretely, per set we:
 *   1. walk UP from the setName node to read the sport/year/manufacturer
 *      ancestor VALUES (cheap: one get per ancestor),
 *   2. seed league/era/vintage/manufacturer/isReprint at the SETNAME node
 *      (each materialize scans only this one set subtree),
 *   3. seed cardType at each variant-leaf node under the setName (each scans
 *      only that leaf's subtree).
 * `collectDescendantIds`/`materializeSelectorOptionFeature` note that a single
 * set subtree is ≪100 descendants in practice, so one set per step stays well
 * within budget. The internal mutation paginates over setName nodes a few at a
 * time (default 3) and self-reschedules until every set is drained.
 *
 * DEVIATION FROM commitCardChecklist (documented on purpose)
 * ----------------------------------------------------------
 * commit anchors league@sport, era/vintage@year, manufacturer@manufacturer at
 * the TRUE ancestor node. The backfill anchors them at the SETNAME node
 * instead. Two reasons: (a) a single materialize at a sport node scans every
 * set under that sport — unbounded for a backfill that may run over hundreds
 * of pre-existing sets, and (b) asserting a sport/year/manufacturer-wide value
 * from one pre-existing set's heuristic over-reaches. The resolved values on
 * every node WITHIN the set and on every card are identical to what commit
 * produces; only the (empty) sport/year/manufacturer ancestor node is left
 * untouched. Going forward, the in-band commit/edit path seeds those ancestors.
 *
 * Trigger once with the public `runCardFeaturesBackfill` mutation (admin
 * only). Gap-fill only; safe to re-run.
 */

import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { materializeSelectorOptionFeature } from "./selectorOptions";
import {
  deriveSetLevelFeatures,
  type SetLevelFeatureInputs,
} from "./features/deriveCardFeatures";

type Level =
  | "sport"
  | "year"
  | "manufacturer"
  | "setName"
  | "variantType"
  | "insert"
  | "parallel";

// How many setName subtrees to process per scheduled mutation. Kept small: each
// set's seed fans out into several materialize calls, and each materialize
// scans the set's whole subtree. 3 sets/batch keeps a single mutation's total
// read/write fan-out comfortably under Convex's per-mutation limits even for
// sets with many variant leaves; the batch self-reschedules until done.
const DEFAULT_SETS_PER_BATCH = 3;

/**
 * Walk UP from a setName node to read the sport/year/manufacturer ancestor
 * VALUES (not ids) needed to derive the set-level heuristic. Cheap — one
 * ctx.db.get per ancestor; 16-step cutoff matches the commitCardChecklist walk
 * so a cycle can't deadlock the mutation.
 */
async function resolveAncestorValues(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<any> } },
  setNameNodeId: Id<"selectorOptions">,
): Promise<{ sport?: string; year?: string; manufacturer?: string }> {
  const out: { sport?: string; year?: string; manufacturer?: string } = {};
  let cursor: Id<"selectorOptions"> | undefined = setNameNodeId;
  let depth = 0;
  while (cursor && depth < 16) {
    const node = await ctx.db.get(cursor);
    if (!node) break;
    if (node.level === "sport") out.sport = node.value;
    if (node.level === "year") out.year = node.value;
    if (node.level === "manufacturer") out.manufacturer = node.value;
    cursor = node.parentId;
    depth += 1;
  }
  return out;
}

/**
 * Seed the heuristic for ONE setName subtree, fill-absent, anchored at the
 * setName node (set-and-above keys) and each variant leaf (cardType). Each
 * seed goes through `materializeSelectorOptionFeature` so it cascades to
 * descendant nodes + cards, never clobbering an existing own value. Returns
 * the number of materialize calls that actually wrote something (for logging /
 * the idempotency assertion in tests).
 */
async function backfillSetSubtree(
  ctx: { db: { get: any; patch: any; query: any } },
  setNameNode: {
    _id: Id<"selectorOptions">;
    level: Level;
    value: string;
    features?: Record<string, string>;
  },
): Promise<number> {
  let writes = 0;

  // 1. Set-and-above heuristic keys, all anchored at the setName node so each
  //    materialize scans only THIS set's subtree (see the batching note above).
  const ancestors = await resolveAncestorValues(ctx, setNameNode._id);
  const setLevelInputs: SetLevelFeatureInputs = {
    sport: ancestors.sport,
    year: ancestors.year,
    manufacturer: ancestors.manufacturer,
    // No leaf level here — cardType is seeded per variant leaf below, NOT at
    // the setName node (the setName isn't a variant leaf).
  };
  const setLevelHeuristic = deriveSetLevelFeatures(setLevelInputs);
  for (const key of ["league", "era", "vintage", "manufacturer", "isReprint"]) {
    const derived = setLevelHeuristic[key];
    if (derived === undefined) continue; // heuristic produced nothing here
    // Fill-absent: only seed when the setName node has no own value for the key.
    if (setNameNode.features && setNameNode.features[key] !== undefined) continue;
    const res = await materializeSelectorOptionFeature(
      ctx,
      setNameNode._id,
      key,
      derived,
    );
    if (res.propagatedToCardCount > 0 || res.propagatedToNodeCount > 0) {
      writes += 1;
    }
  }

  // 2. cardType, seeded at EVERY variant node under the setName, derived from
  //    that node's OWN level (variantType→"Base", insert→"Insert",
  //    parallel→"Parallel"). This mirrors commitCardChecklist, which seeds
  //    cardType at the leaf the card hangs off.
  //
  //    Ordering matters: materialize cascades a value DOWN to descendants, so a
  //    parent variant node seeded first would push its own cardType onto a
  //    not-yet-seeded child of a different variant level. We therefore process
  //    variant nodes DEEPEST-FIRST. A deeper node sets its own correct cardType
  //    before its parent is seeded; when the parent later cascades, the child's
  //    value differs from the parent's previous (undefined) value and is
  //    correctly treated as an override and skipped.
  const variantNodes = await collectVariantNodesByDepth(ctx, setNameNode._id);
  for (const { node } of variantNodes) {
    const leafInputs: SetLevelFeatureInputs = {
      leafLevel: node.level,
      leafIsInsert: node.metadata?.isInsert ?? undefined,
      leafIsParallel: node.metadata?.isParallel ?? undefined,
    };
    const cardType = deriveSetLevelFeatures(leafInputs).cardType;
    if (cardType === undefined) continue;
    // Fill-absent on the variant node itself.
    if (node.features && node.features.cardType !== undefined) continue;
    const res = await materializeSelectorOptionFeature(
      ctx,
      node._id,
      "cardType",
      cardType,
    );
    if (res.propagatedToCardCount > 0 || res.propagatedToNodeCount > 0) {
      writes += 1;
    }
  }

  return writes;
}

type VariantNode = {
  _id: Id<"selectorOptions">;
  level: Level;
  metadata?: { isInsert?: boolean; isParallel?: boolean };
  features?: Record<string, string>;
};

/**
 * BFS the children-graph under a setName node and return every variant node
 * (variantType / insert / parallel) tagged with its depth, sorted DEEPEST-FIRST
 * so cardType seeding never lets a parent variant level clobber a child of a
 * different level (see the ordering note in backfillSetSubtree).
 */
async function collectVariantNodesByDepth(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<any> } },
  setNameNodeId: Id<"selectorOptions">,
): Promise<Array<{ depth: number; node: VariantNode }>> {
  const out: Array<{ depth: number; node: VariantNode }> = [];
  const queue: Array<{ id: Id<"selectorOptions">; depth: number }> = [
    { id: setNameNodeId, depth: 0 },
  ];
  const seen = new Set<string>([setNameNodeId as unknown as string]);
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    const row = await ctx.db.get(id);
    if (!row) continue;
    if (
      row.level === "variantType" ||
      row.level === "insert" ||
      row.level === "parallel"
    ) {
      out.push({ depth, node: row as VariantNode });
    }
    for (const childId of row.children ?? []) {
      const key = childId as unknown as string;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ id: childId, depth: depth + 1 });
    }
  }
  // Deepest-first so each node seeds its own cardType before any ancestor
  // variant node cascades onto it.
  out.sort((a, b) => b.depth - a.depth);
  return out;
}

/**
 * Paginated, self-rescheduling backfill over setName nodes. Each invocation
 * processes a small page of setName subtrees (see DEFAULT_SETS_PER_BATCH) and
 * reschedules itself with the next cursor until every set is drained.
 */
export const backfillCardFeaturesBatch = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    setsProcessed: v.number(),
    setsWithWrites: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const numItems = args.numItems ?? DEFAULT_SETS_PER_BATCH;
    const page = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "setName"))
      .paginate({ cursor: args.cursor, numItems });

    let setsWithWrites = 0;
    for (const setNameNode of page.page) {
      const writes = await backfillSetSubtree(ctx, setNameNode);
      if (writes > 0) setsWithWrites += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillCardFeatures.backfillCardFeaturesBatch,
        { cursor: page.continueCursor, numItems },
      );
    }

    return {
      setsProcessed: page.page.length,
      setsWithWrites,
      isDone: page.isDone,
    };
  },
});

/**
 * Admin-triggered entry point. Schedules the first batch; the batch
 * self-reschedules until every setName subtree is drained. Safe to re-run —
 * the fill-absent seed is idempotent (a second run writes nothing).
 */
export const runCardFeaturesBackfill = mutation({
  args: { numItems: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.scheduler.runAfter(
      0,
      internal.backfillCardFeatures.backfillCardFeaturesBatch,
      { cursor: null, numItems: args.numItems },
    );
    return null;
  },
});
