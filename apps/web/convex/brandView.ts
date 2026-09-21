import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { rehomeSetsFromBrandUnknown } from "./brandRehome";
import { pausedSides } from "./marketplacePause";
import {
  resolvableSides,
  type ResolvableRow,
} from "./marketplaceResolvability";
import {
  allocateSlots,
  detachSlot,
  primarySlot,
  pruneEmptySides,
  slotEntries,
} from "./platformSlots";
import { selectorOptionFields } from "./schema";
import { MAX_SELECTOR_VALUE_LENGTH, selectorValueKey } from "./selectorSyncMatch";
import { SL_ALL_BRANDS_BRAND_ID, isSlAllBrandsBrandId } from "./slBrandAxis";

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
 * The refusal every brand-row write here shares when the row is not a brand.
 * One sentence, so the Attributes panel's toast reads the same whichever
 * control raised it.
 */
const NOT_A_BRAND_MESSAGE =
  "This is set on a brand — not on a sport, a year or a set.";

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
 * Refused with `PREFIX_TAKEN { existingId, value }` (security review S2)
 * when a SIBLING brand under the same year already holds the same prefix,
 * folded by `selectorValueKey` — the fold every matcher uses. Two brands
 * with one prefix would file each prefix-matching set by whichever the
 * routing walked first, with nothing to undo it; the operator resolves the
 * clash by hand, and the panel names the brand that holds it.
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
      throw new ConvexError(NOT_A_BRAND_MESSAGE);
    }
    if (row.metadata?.isBrandUnknown) {
      throw new ConvexError(
        "Unknown is where sets with no known brand wait — it doesn't get one of its own.",
      );
    }
    const prefix = args.setNamePrefix.trim();
    if (prefix.length > MAX_SELECTOR_VALUE_LENGTH) {
      throw new ConvexError(
        `Brand is too long — keep it under ${MAX_SELECTOR_VALUE_LENGTH} characters.`,
      );
    }

    if (prefix && row.parentId) {
      const key = selectorValueKey(prefix);
      const siblings = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "manufacturer").eq("parentId", row.parentId),
        )
        .collect();
      const taken = siblings.find(
        (s) =>
          s._id !== row._id &&
          s.metadata?.setNamePrefix !== undefined &&
          selectorValueKey(s.metadata.setNamePrefix) === key,
      );
      if (taken) {
        throw new ConvexError({
          code: "PREFIX_TAKEN",
          existingId: taken._id,
          value: taken.value,
        });
      }
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

/**
 * The ancestor chain a mutation needs to judge whether SportLots can be
 * asked at manufacturer level — the same walk `addCustomSelectorOption`
 * makes before it honours `slViaAllBrands`, on the same fields.
 */
async function loadParentChain(
  ctx: MutationCtx,
  leafId: Id<"selectorOptions"> | undefined,
): Promise<ResolvableRow[]> {
  const chain: ResolvableRow[] = [];
  let currentId: Id<"selectorOptions"> | undefined = leafId;
  while (currentId) {
    const row: Doc<"selectorOptions"> | null = await ctx.db.get(currentId);
    if (!row) break;
    chain.unshift({
      level: row.level,
      value: row.value,
      platformData: row.platformData ?? {},
      platformFacets: row.platformFacets,
    });
    currentId = row.parentId;
  }
  return chain;
}

/**
 * The repair door for the via-All-Brands link (collector review, NEO-237).
 *
 * `addCustomSelectorOption`'s `slViaAllBrands` tick is the one place a brand
 * gains SportLots' all-brands option as its SportLots id at creation. A
 * brand created without it — or before the control existed — is left with
 * "SportLots skipped: no SportLots ids on this path" on every SportLots
 * fetch, and no way back short of deleting the row. This is the way back,
 * and its undo: `enabled: true` writes the sentinel slot exactly as the
 * create path does (`SL_ALL_BRANDS_BRAND_ID`, the row's own value as the
 * slot label, the slot helpers allocating the key); `enabled: false`
 * detaches that one slot and nothing else.
 *
 * Refusals, in order:
 *
 *  - not a manufacturer row — the link means nothing anywhere else;
 *  - the year's Unknown row (`isBrandUnknown`) — it already holds the
 *    all-brands option by construction (D5/D6) and is never narrowed;
 *  - the row holds a SportLots id that is NOT the sentinel — a real link is
 *    never overwritten or stood beside (invariant 5), in either direction:
 *    turning the sentinel on would make two SportLots ids compete, and
 *    turning it off has nothing to turn off. The panel disables the toggle
 *    with the reason before this can fire; the refusal is the backstop.
 *  - `enabled: true` when the chain cannot scope SportLots — the same
 *    `SL_NOT_RESOLVABLE` shape as the create path, for the same reason: a
 *    slot id on a path SportLots cannot be asked about is a link that can
 *    never be fetched.
 *
 * Idempotent both ways: on when already on and off when already off touch
 * nothing. Nothing here reads a marketplace NAME — the sentinel is compared
 * through `isSlAllBrandsBrandId` inside the sync boundary, as everywhere.
 */
export const setManufacturerSlViaAllBrands = mutation({
  args: {
    id: v.id("selectorOptions"),
    enabled: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(args.id);
    if (!row) {
      throw new ConvexError("That row is gone. Refresh and try again.");
    }
    if (row.level !== "manufacturer") {
      throw new ConvexError(NOT_A_BRAND_MESSAGE);
    }
    if (row.metadata?.isBrandUnknown) {
      throw new ConvexError(
        "Unknown already sees every SportLots set — it doesn't match by name.",
      );
    }

    const slSlots = slotEntries(row, "sportlots");
    const sentinelSlot = slSlots.find((e) => isSlAllBrandsBrandId(e.id));
    const realSlot = slSlots.find((e) => !isSlAllBrandsBrandId(e.id));
    if (realSlot) {
      throw new ConvexError({
        code: "SL_LINKED",
        reason: "Linked to a SportLots brand of its own — that link stays.",
      });
    }

    if (args.enabled) {
      if (sentinelSlot) return null;
      const chain = await loadParentChain(ctx, row.parentId);
      const resolution = resolvableSides(chain, {
        level: "manufacturer",
        paused: pausedSides(),
      });
      if (!resolution.sportlots.resolvable) {
        throw new ConvexError({
          code: "SL_NOT_RESOLVABLE",
          reason:
            "This year has no SportLots ids to link a brand through All Brands with",
        });
      }
      const alloc = allocateSlots(row, {
        sportlots: [{ id: SL_ALL_BRANDS_BRAND_ID, label: row.value }],
      });
      const labelsPatch = pruneEmptySides({ ...alloc.platformLabels });
      const facetsPatch = pruneEmptySides({ ...alloc.platformFacets });
      await ctx.db.patch(row._id, {
        platformData: alloc.platformData,
        platformLabels:
          Object.keys(labelsPatch).length > 0 ? labelsPatch : undefined,
        platformFacets:
          Object.keys(facetsPatch).length > 0 ? facetsPatch : undefined,
        // The counter moves in the SAME patch as the map it guards
        // (`attachPlatformIds` discipline).
        platformSlotSeq:
          Object.keys(alloc.platformSlotSeq).length > 0
            ? alloc.platformSlotSeq
            : undefined,
        lastUpdated: Date.now(),
      });
      return null;
    }

    if (!sentinelSlot) return null;
    const isPrimary = sentinelSlot.slot === primarySlot(row, "sportlots");
    const detached = detachSlot(row, "sportlots", sentinelSlot.slot);
    const labelsPatch = pruneEmptySides({ ...detached.platformLabels });
    const facetsPatch = pruneEmptySides({ ...detached.platformFacets });
    let primaryPatch: { bsc?: string; sportlots?: string } | undefined;
    if (isPrimary) {
      primaryPatch = { ...(row.primaryPlatformId ?? {}) };
      delete primaryPatch.sportlots;
      if (Object.keys(primaryPatch).length === 0) primaryPatch = undefined;
    }
    await ctx.db.patch(row._id, {
      platformData: pruneEmptySides({ ...detached.platformData }),
      platformLabels:
        Object.keys(labelsPatch).length > 0 ? labelsPatch : undefined,
      platformFacets:
        Object.keys(facetsPatch).length > 0 ? facetsPatch : undefined,
      // `platformSlotSeq` is deliberately NOT patched — the key is retired
      // for good, as on every detach.
      ...(isPrimary ? { primaryPlatformId: primaryPatch } : {}),
      lastUpdated: Date.now(),
    });
    return null;
  },
});
