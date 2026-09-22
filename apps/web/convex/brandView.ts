import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import {
  rehomeSetRowsToBrand,
  rehomeSetsFromBrandUnknown,
} from "./brandRehome";
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
 * makes before it writes the all-brands link, on the same fields.
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
 * The ONE door for the via-All-Brands link after creation (NEO-237).
 *
 * `addCustomSelectorOption` writes SportLots' all-brands option as a new
 * brand's SportLots id whenever the year can be asked — unconditionally,
 * with no arg to decline it (Jason, 2026-09-21: "I cannot think of any time
 * I would not want that checked"). So this toggle is where the link is
 * turned OFF for a brand that should not match SportLots sets by name, and
 * where it is turned back on — or attached for the first time on a brand
 * created while the year had no SportLots ids, or before this ticket. A
 * brand without it is left with "SportLots skipped: no SportLots ids on
 * this path" on every SportLots fetch. `enabled: true` writes the sentinel
 * slot exactly as the create path does (`SL_ALL_BRANDS_BRAND_ID`, the row's
 * own value as the slot label, the slot helpers allocating the key);
 * `enabled: false` detaches that one slot and nothing else.
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
 *  - `enabled: true` when the chain cannot scope SportLots —
 *    `SL_NOT_RESOLVABLE`: a slot id on a path SportLots cannot be asked
 *    about is a link that can never be fetched. (The create path does not
 *    refuse here; it silently writes no slot. This door is explicit, so it
 *    says why.)
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

// ---------------------------------------------------------------------------
// NEO-294 — the operator moves a set to a different brand
// ---------------------------------------------------------------------------

/**
 * One destination the Attributes panel may offer, in the order the
 * Manufacturers column shows it.
 *
 * `isCurrent` is the set's own parent: returned rather than filtered out so
 * the panel can say which one it is leaving without a second read, and so a
 * future surface that wants to show it greyed has the fact. The panel's
 * picker drops it — "move it to where it already is" is not an option.
 */
const brandChoiceValidator = v.object({
  _id: v.id("selectorOptions"),
  value: v.string(),
  isCurrent: v.boolean(),
});

/**
 * The Manufacturers column's own order, so the picker and the column never
 * disagree about where a brand sits.
 *
 * `EntitySelector`'s comparator, exactly: the year's Unknown row leads
 * (`leadRow` in `ManufacturerSelector`, read off the NB flag and never off
 * the name), then two all-numeric names sort DESCENDING — years read
 * newest-first everywhere in this tree — and everything else by
 * `localeCompare`. `Number("")` is 0, so two empty names compare numerically;
 * that is the column's behaviour too, and a manufacturer row with an empty
 * name is not a thing the tree can produce.
 */
export function compareBrandChoices(
  a: Pick<Doc<"selectorOptions">, "value" | "metadata">,
  b: Pick<Doc<"selectorOptions">, "value" | "metadata">,
): number {
  const leadA = a.metadata?.isBrandUnknown === true ? 0 : 1;
  const leadB = b.metadata?.isBrandUnknown === true ? 0 : 1;
  if (leadA !== leadB) return leadA - leadB;
  const numA = Number(a.value);
  const numB = Number(b.value);
  if (!isNaN(numA) && !isNaN(numB)) return numB - numA;
  return a.value.localeCompare(b.value);
}

/**
 * NEO-294 — every brand a set could move to: the manufacturers of the set's
 * OWN year, Unknown among them.
 *
 * Scoped to the year because the move is a re-parent inside one year and
 * nothing else: a set's year is decided by where it was synced or created,
 * and moving it across years would be a different, larger claim about the
 * card. `[]` — never a throw — for an id that is not a set, or a set whose
 * chain is incomplete: the panel asks this the moment its picker opens, and
 * "there is nowhere to move it" is an ordinary answer.
 *
 * A separate query from `getSetsUnderYear` deliberately: that one is the All
 * Brands VIEW's read, keyed on a year and carrying a thousand sets, and the
 * picker wants one year's brand rows keyed on a set. Folding them would make
 * every picker open pay for the view's payload.
 */
export const getBrandsForYearOfSet = query({
  args: { setId: v.id("selectorOptions") },
  returns: v.array(brandChoiceValidator),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const set = await ctx.db.get(args.setId);
    if (!set || set.level !== "setName" || !set.parentId) return [];
    const currentBrand = await ctx.db.get(set.parentId);
    if (!currentBrand || currentBrand.level !== "manufacturer") return [];
    const yearId = currentBrand.parentId;
    if (!yearId) return [];

    const brands = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "manufacturer").eq("parentId", yearId),
      )
      .collect();
    return brands.sort(compareBrandChoices).map((brand) => ({
      _id: brand._id,
      value: brand.value,
      isCurrent: brand._id === currentBrand._id,
    }));
  },
});

/**
 * NEO-294 — move one set under a different brand of the same year.
 *
 * The operator's undo for every automatic placement: the prefix re-home, the
 * known-brands list that creates a brand and files a set under it, and the
 * sync's own bucketing. Auto-create is irreversible without it, which is why
 * it ships in the same ticket.
 *
 * A PURE NB RE-PARENT — `rehomeSetRowsToBrand` does the work, so the set keeps
 * its `_id`, its variant types, inserts and parallels, its cards and every
 * marketplace slot on all of them; only `parentId`, the row's `manufacturer`
 * feature snapshot and the two `children` caches change. Nothing here reads a
 * marketplace value: both ends are NB rows named by NB ids.
 *
 * UNKNOWN IS A LEGAL DESTINATION HERE, and nowhere else. `rehomeSetRowsToBrand`
 * refuses the year's flagged row for every automatic caller — a sync filing a
 * set INTO "NB has not identified this brand" would be throwing information
 * away — but an operator saying "this is not a Choice set, put it back" is
 * making exactly that claim on purpose, so this door passes the opt-in.
 *
 * MOVED TWICE IS STILL THE OPERATOR. The stamp makes every AUTOMATIC re-home
 * skip the row; this door passes `includeOperatorPlaced` so the operator can
 * change their mind as often as they like.
 *
 * AND THE MOVE STICKS. The row is stamped `metadata.brandSetByOperator`, which
 * every automatic re-home path skips: without it the next Sync Sets would see
 * a set under Unknown whose name matches a known brand and file it straight
 * back, and the operator's decision would survive until the next cron. Sync is
 * additive and id-keyed; it does not overrule a person.
 *
 * Refusals, in order, all `ConvexError` so the panel can show them as written:
 *
 *  - the source is not a `setName` row — nothing else has a brand to move
 *    between (a variant belongs to its set, not to a brand);
 *  - the target is not a `manufacturer` row;
 *  - the target is under a different year — the move is within one year;
 *  - the target is already the set's parent — refused rather than treated as a
 *    silent success, because a no-op that reports "Moved" is a lie about a
 *    write, and the panel never offers the current brand anyway;
 *  - a fold-equal sibling name already under the target
 *    (`SET_NAME_CLASH_AT_TARGET`), which is the NEO-219 one-name-per-parent
 *    rule. NOTHING IS MERGED AND NOTHING IS DELETED: two same-named sets under
 *    one brand is a question about which is which, and this mutation must not
 *    answer it. The refusal names the set already there so the operator can go
 *    and rename one of them.
 *
 * Returns the destination's NB name for the panel's toast; the panel has the
 * name already, but a confirmation that echoes the SERVER's row is the one
 * that means the write landed on the brand the operator picked.
 */
export const moveSetToBrand = mutation({
  args: {
    setId: v.id("selectorOptions"),
    brandId: v.id("selectorOptions"),
  },
  returns: v.object({ movedTo: v.string() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const set = await ctx.db.get(args.setId);
    if (!set) {
      throw new ConvexError("That set is gone. Refresh and try again.");
    }
    if (set.level !== "setName") {
      throw new ConvexError(
        "Only a set moves to another brand — not a sport, a year or a variant.",
      );
    }
    const target = await ctx.db.get(args.brandId);
    if (!target) {
      throw new ConvexError("That brand is gone. Refresh and try again.");
    }
    if (target.level !== "manufacturer") {
      throw new ConvexError("A set moves under a brand — that row is not one.");
    }
    if (!set.parentId) {
      throw new ConvexError(
        "This set has no brand above it. Refresh and try again.",
      );
    }
    if (set.parentId === target._id) {
      throw new ConvexError(`This set is already under ${target.value}.`);
    }
    const currentBrand = await ctx.db.get(set.parentId);
    if (!currentBrand || currentBrand.level !== "manufacturer") {
      throw new ConvexError(
        "This set has no brand above it. Refresh and try again.",
      );
    }
    if (!target.parentId || target.parentId !== currentBrand.parentId) {
      throw new ConvexError(
        `${target.value} is in a different year — a set moves between the brands of its own year.`,
      );
    }

    // The NEO-219 rule, checked here so the operator gets a refusal that names
    // the set in the way: `rehomeSetRowsToBrand` COUNTS a clash and leaves the
    // row where it is, which is right for a sync moving many rows and silent
    // for one moving exactly one.
    const key = selectorValueKey(set.value);
    const targetSets = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", target._id),
      )
      .collect();
    const clash = targetSets.find((row) => selectorValueKey(row.value) === key);
    if (clash) {
      throw new ConvexError({
        code: "SET_NAME_CLASH_AT_TARGET",
        existingId: clash._id,
        value: clash.value,
      });
    }

    const { rehomed } = await rehomeSetRowsToBrand(ctx, {
      rows: [set],
      brandId: target._id,
      // NEO-294 — the one caller allowed to file a set back into the year's
      // Unknown row, because a person is saying so.
      allowBrandUnknownTarget: true,
      // And the one caller allowed to re-place a row an operator already
      // placed: every automatic path skips a stamped row, but a second
      // decision by the same hand is still theirs. Without this the first
      // move would be the last one this control could make.
      includeOperatorPlaced: true,
    });
    if (rehomed !== 1) {
      // Every reason a row is skipped is checked above, so this is a row that
      // changed under the operator between the checks and the write.
      throw new ConvexError("That set didn't move. Refresh and try again.");
    }

    // Stamped AFTER the move and read fresh, so the flag lands on the row as
    // `rehomeSetRowsToBrand` left it rather than on a stale copy of it.
    const moved = await ctx.db.get(set._id);
    await ctx.db.patch(set._id, {
      metadata: { ...(moved?.metadata ?? {}), brandSetByOperator: true },
      lastUpdated: Date.now(),
    });

    return { movedTo: target.value };
  },
});
