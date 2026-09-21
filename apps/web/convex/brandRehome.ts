/**
 * NEO-237 — moving a set out of the year's Unknown row and under a brand.
 *
 * A PURE NB OPERATION. The set row keeps its `_id`, its subtree, its
 * marketplace slots and its cards; the only writes are `parentId` on the row
 * and the `children` caches of the two parents (filtered off the old one,
 * unioned into the new one — `unionChildren`, the precedent being
 * `applyParallelGroupings`' reparenting). Nothing here reads a marketplace
 * value: the prefix comes from the brand row's `metadata.setNamePrefix`, and
 * the only name compared is the set row's own NB display value.
 *
 * ONE DIRECTION ONLY: Unknown → brand. Three doors call it —
 *
 *   • `addCustomSelectorOption` at the manufacturer level (a new brand
 *     claims the sets whose names start with its prefix);
 *   • `setSelectorOptionSetNamePrefix` (an edited prefix claims likewise —
 *     "Choice" typed with prefix "Choice Biloxi" moves nothing, and fixing
 *     the prefix is how the operator moves it);
 *   • the Sync Sets BSC phase (`routeBscSets`' `moves`: a set whose BSC id
 *     sits under Unknown and whose upstream name now matches a brand).
 *
 * Never brand → brand, and never from a sync on a row already under a brand:
 * a placement is linkage, and the sync's job is to route a marketplace's
 * update to the row linked to it, not to second-guess where the row lives.
 *
 * SIBLING CLASH. Two rows under one parent must not fold to one name (the
 * NEO-219 rule every picker and drill util relies on), so a set whose name
 * already exists under the target brand STAYS under Unknown, counted and
 * logged, never renamed and never merged. The operator resolves it by hand —
 * which is the right outcome, because two same-named sets under one brand is
 * a question about which one is which, and a sync must not answer it.
 */

import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  matchesBrandPrefix,
  selectorValueKey,
  valuesDeepEqual,
} from "./selectorSyncMatch";
import { unionChildren } from "./selectorSyncStore";

/**
 * The "N sets moved out of Unknown" notice, one sentence for the two doors
 * that write it into `selectorSyncStatus` (`addCustomSelectorOption`, and
 * `setSelectorOptionSetNamePrefix` in brandView.ts). Counts only — a set name
 * is operator content and the status message is reactive state (NEO-47).
 */
export function rehomedNotice(count: number): string {
  return `${count} ${count === 1 ? "set" : "sets"} moved out of Unknown`;
}

export type RehomeResult = {
  /** Rows whose `parentId` now names the brand. */
  rehomed: number;
  /** Rows left under their old parent because the brand already had that name. */
  clashes: number;
};

/**
 * The year's brand-unknown row, found by its NB ROLE and nothing else. `null`
 * when the year has none yet (nothing has been synced under it).
 *
 * One indexed read over the year's manufacturers. The first flagged row wins
 * if a year somehow carries two — `ensureBrandUnknownRow` never mints a
 * second, so that is a hand-edit, and the sync should still behave.
 */
export async function findBrandUnknownRow(
  ctx: { db: QueryCtx["db"] },
  yearId: Id<"selectorOptions">,
): Promise<Doc<"selectorOptions"> | null> {
  const manufacturers = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "manufacturer").eq("parentId", yearId),
    )
    .collect();
  return manufacturers.find((m) => m.metadata?.isBrandUnknown === true) ?? null;
}

/**
 * Move specific setName rows under `brandId`. The shared core: the two
 * name-driven doors above filter Unknown's sets by prefix and hand the
 * survivors here; the sync hands over the rows `routeBscSets` named by id.
 *
 * `rows` must be `setName` rows; anything else is skipped and counted as
 * nothing. A row already under the brand is a no-op, not a clash.
 */
export async function rehomeSetRowsToBrand(
  ctx: MutationCtx,
  args: { rows: readonly Doc<"selectorOptions">[]; brandId: Id<"selectorOptions"> },
): Promise<RehomeResult> {
  const brand = await ctx.db.get(args.brandId);
  if (!brand || brand.level !== "manufacturer") {
    throw new Error("rehomeSetRowsToBrand: target is not a manufacturer row");
  }
  if (brand.metadata?.isBrandUnknown === true) {
    throw new Error("rehomeSetRowsToBrand: target is the brand-unknown row");
  }

  // The target's IN-TRANSACTION name set, grown as rows land, so two Unknown
  // rows that fold to one name cannot both move.
  const targetSiblings = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "setName").eq("parentId", args.brandId),
    )
    .collect();
  const takenKeys = new Set(targetSiblings.map((r) => selectorValueKey(r.value)));

  const now = Date.now();
  const movedIds: Id<"selectorOptions">[] = [];
  const removedFrom = new Map<Id<"selectorOptions">, Set<Id<"selectorOptions">>>();
  let clashes = 0;

  for (const row of args.rows) {
    if (row.level !== "setName") continue;
    if (row.parentId === args.brandId) continue;
    const key = selectorValueKey(row.value);
    if (takenKeys.has(key)) {
      clashes++;
      continue;
    }
    takenKeys.add(key);
    await ctx.db.patch(row._id, { parentId: args.brandId, lastUpdated: now });
    movedIds.push(row._id);
    if (row.parentId) {
      const set = removedFrom.get(row.parentId) ?? new Set<Id<"selectorOptions">>();
      set.add(row._id);
      removedFrom.set(row.parentId, set);
    }
  }

  if (movedIds.length > 0) {
    // NEO-85: write-if-changed on every `children` cache, as everywhere else
    // in this tree — a byte-identical patch still reflows every column
    // watching the parent.
    for (const [fromId, ids] of removedFrom) {
      const from = await ctx.db.get(fromId);
      if (!from) continue;
      const next = (from.children ?? []).filter((id) => !ids.has(id));
      if (!valuesDeepEqual(from.children ?? [], next)) {
        await ctx.db.patch(fromId, { children: next, lastUpdated: now });
      }
    }
    const nextChildren = unionChildren(brand.children, movedIds);
    if (!valuesDeepEqual(brand.children ?? [], nextChildren)) {
      await ctx.db.patch(args.brandId, { children: nextChildren, lastUpdated: now });
    }
  }

  if (clashes > 0) {
    // Counts only — a set name is operator content and the log is not the
    // place for it (NEO-47's rule, applied to logs).
    console.warn(
      `[brandRehome] ${clashes} set(s) stayed under their old parent: the ` +
        `target brand already has a set of that name.`,
    );
  }
  return { rehomed: movedIds.length, clashes };
}

/**
 * Re-home every set under the year's Unknown row whose NB name starts with
 * `prefix` (whole word, `matchesBrandPrefix`) to `brandId`.
 *
 * The name compared is the SET ROW'S OWN VALUE — NB data — against a prefix
 * that is NB data on the brand row. An empty prefix moves nothing, and a year
 * with no Unknown row has nothing to move; both return zeros rather than
 * throwing, because "nothing to do" is the ordinary case on a fresh year.
 */
export async function rehomeSetsFromBrandUnknown(
  ctx: MutationCtx,
  args: {
    yearId: Id<"selectorOptions">;
    brandId: Id<"selectorOptions">;
    prefix: string;
  },
): Promise<RehomeResult> {
  const prefix = args.prefix.trim();
  if (!prefix) return { rehomed: 0, clashes: 0 };

  const unknown = await findBrandUnknownRow(ctx, args.yearId);
  if (!unknown || unknown._id === args.brandId) return { rehomed: 0, clashes: 0 };

  const sets = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "setName").eq("parentId", unknown._id),
    )
    .collect();
  const matching = sets.filter((row) => matchesBrandPrefix(row.value, prefix));
  if (matching.length === 0) return { rehomed: 0, clashes: 0 };

  return await rehomeSetRowsToBrand(ctx, { rows: matching, brandId: args.brandId });
}
