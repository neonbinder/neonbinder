import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { rehomeSetsFromBrandUnknown } from "./brandRehome";
import { selectorOptionFields } from "./schema";
import { MAX_SELECTOR_VALUE_LENGTH } from "./selectorSyncMatch";

/**
 * NEO-237 (D1, D9, D17) — the All Brands VIEW and the brand's set-name
 * prefix.
 *
 * "All Brands" used to be a manufacturer ROW minted from SportLots' no-filter
 * option, and the sets whose brand NB could not identify hung off it. It is
 * now two different things: a pinned entry at the top of the Manufacturers
 * column that is a view ("show every set in this year, brand alongside"),
 * selected by a client sentinel and never a document id; and an ordinary
 * manufacturer row called Unknown that holds the unidentified sets
 * (`metadata.isBrandUnknown`). This module is the view's read, and the write
 * for the one NB fact on a brand row that decides which sets are its.
 */

/**
 * Sets the view may list at once. A year's manufacturers × their sets; a
 * full baseball year is a few hundred, and the column's search box is
 * always on past eight rows. Past this the view is a worse tool than the
 * brand columns, which are each bounded by one brand.
 */
export const MAX_SETS_PER_YEAR_VIEW = 1000;

/**
 * Exactly what the Sets column renders and selects on, plus where the row
 * lives: `parentId` is what the cascade back-fills the Manufacturers column
 * from when a set is picked in the view, and `brand` is the muted suffix on
 * the row. Deliberately not the whole document — the column reads nothing
 * else, and a thousand full rows is a thousand `features` maps on the wire.
 */
const yearSetValidator = v.object({
  _id: v.id("selectorOptions"),
  value: v.string(),
  parentId: v.id("selectorOptions"),
  brand: v.string(),
  platformData: selectorOptionFields.platformData,
});

/**
 * Every set under every manufacturer of a year, brand alongside. Brands in
 * display order (by folded value); sets in index order within a brand — the
 * column sorts by display name itself. `[]` for an id that is not a year.
 */
export const getSetsUnderYear = query({
  args: { yearId: v.id("selectorOptions") },
  returns: v.array(yearSetValidator),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const year = await ctx.db.get(args.yearId);
    if (!year || year.level !== "year") return [];

    const manufacturers = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "manufacturer").eq("parentId", args.yearId),
      )
      .collect();

    const out: Array<{
      _id: Id<"selectorOptions">;
      value: string;
      parentId: Id<"selectorOptions">;
      brand: string;
      platformData: { bsc?: Record<string, string>; sportlots?: Record<string, string> };
    }> = [];
    for (const brand of manufacturers) {
      if (out.length >= MAX_SETS_PER_YEAR_VIEW) break;
      const sets = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "setName").eq("parentId", brand._id),
        )
        .collect();
      for (const set of sets) {
        if (out.length >= MAX_SETS_PER_YEAR_VIEW) break;
        out.push({
          _id: set._id,
          value: set.value,
          parentId: brand._id,
          brand: brand.value,
          platformData: set.platformData ?? {},
        });
      }
    }
    return out;
  },
});

/**
 * D1 + D9 — the operator's edit of a brand's set-name prefix, and the
 * re-home it triggers.
 *
 * Manufacturer rows only: the prefix is "a set whose name starts with this
 * belongs to this brand", which means nothing on a sport, a year or a set.
 * Refused on the year's Unknown row (`isBrandUnknown`): that row holds the
 * sets whose brand NB has NOT identified, so a prefix on it is a
 * contradiction — and the backfill that names it never writes one either.
 *
 * Trimmed; `""` removes the key (absent means "buckets nothing", never a
 * fallback to the name); capped at `MAX_SELECTOR_VALUE_LENGTH` like every
 * value that is compared against set names. A non-empty save then re-homes
 * the prefix-matching sets out of the year's Unknown row into this brand
 * (`brandRehome.ts` — a pure NB parent move, same `_id`, slots and cards
 * untouched, sibling name clashes left where they are and counted). A clear
 * re-homes nothing: sets already under the brand stay under it.
 *
 * Returns the count so the Attributes panel can say "N sets moved out of
 * Unknown" beside the row that caused it.
 */
export const setSelectorOptionSetNamePrefix = mutation({
  args: {
    id: v.id("selectorOptions"),
    setNamePrefix: v.string(),
  },
  returns: v.object({ rehomed: v.number() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(args.id);
    if (!row) {
      throw new ConvexError("That row is gone. Refresh and try again.");
    }
    if (row.level !== "manufacturer") {
      throw new ConvexError(
        "Brand is set on a brand — not on a sport, a year or a set.",
      );
    }
    if (row.metadata?.isBrandUnknown) {
      throw new ConvexError(
        "Unknown holds the sets whose brand isn't known yet — it doesn't get a Brand of its own.",
      );
    }
    const prefix = args.setNamePrefix.trim();
    if (prefix.length > MAX_SELECTOR_VALUE_LENGTH) {
      throw new ConvexError(
        `Brand is too long — keep it under ${MAX_SELECTOR_VALUE_LENGTH} characters.`,
      );
    }

    const next = { ...(row.metadata ?? {}) };
    if (prefix) next.setNamePrefix = prefix;
    else delete next.setNamePrefix;
    await ctx.db.patch(args.id, {
      // Every other key rides along untouched; an emptied object is dropped
      // rather than stored as `{}` — the `setSelectorOptionCardNumberPrefix`
      // discipline.
      metadata: Object.keys(next).length > 0 ? next : undefined,
      lastUpdated: Date.now(),
    });

    if (!prefix || !row.parentId) return { rehomed: 0 };
    const { rehomed } = await rehomeSetsFromBrandUnknown(ctx, {
      yearId: row.parentId,
      brandId: row._id,
      prefix,
    });
    return { rehomed };
  },
});
