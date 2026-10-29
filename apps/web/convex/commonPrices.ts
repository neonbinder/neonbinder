/**
 * NEO-378 — a collector's common card price per exact variant.
 *
 * A dealer prices the plain cards of a variant (the Base set, one Refractor
 * parallel, one insert) at one floor: "commons go for 25¢". That floor is the
 * owner's, per variant, and set by hand (Jason, 2026-10-27: no auto-default,
 * because dealers' floors differ). A copy's own `minPriceCents` overrides
 * it; a copy with none sells at no less than its variant's common price,
 * read live, so changing the common price moves every such copy at once.
 *
 * Every function is signed-in (`requireSignedIn`) and reads or writes ONLY
 * the caller's rows (`ownerId` is the caller's Clerk subject, never an
 * argument). Nothing here is ever read by a public page.
 *
 * NB data only: a variant row is NB's, and no marketplace value fills a
 * price in.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import { COLLECTION_ERRORS, isPriceCents, refuse } from "./collection";

/** Variants one read may ask about (a set's scoreboard is well under this). */
export const MAX_COMMON_PRICE_READ = 200;
/** Common prices one collector may hold: one per variant they sell. */
export const MAX_COMMON_PRICES = 2000;

const VARIANT_LEVELS: ReadonlySet<string> = new Set(["variantType", "insert", "parallel"]);

export const commonPriceValidator = v.object({
  variantId: v.id("selectorOptions"),
  priceCents: v.number(),
});

/** A client's variant id, or null when it is not a variant row NB holds. */
async function parseVariantId(
  ctx: Pick<QueryCtx, "db">,
  raw: string,
): Promise<Id<"selectorOptions"> | null> {
  const id = ctx.db.normalizeId("selectorOptions", raw);
  if (!id) return null;
  const row = await ctx.db.get(id);
  return row && VARIANT_LEVELS.has(row.level) ? id : null;
}

async function ownRow(ctx: Pick<QueryCtx, "db">, ownerId: string, variantId: Id<"selectorOptions">) {
  return await ctx.db
    .query("variantCommonPrices")
    .withIndex("by_owner_and_variant", (q) => q.eq("ownerId", ownerId).eq("variantId", variantId))
    .unique();
}

/**
 * The caller's common prices for up to `MAX_COMMON_PRICE_READ` variants.
 * Only variants with a price are listed; an id that is not a variant (or not
 * an id) is skipped, never an error.
 */
export const forVariants = query({
  args: { variantIds: v.array(v.string()) },
  returns: v.array(commonPriceValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    if (args.variantIds.length > MAX_COMMON_PRICE_READ) {
      refuse(COLLECTION_ERRORS.limit, `Ask for at most ${MAX_COMMON_PRICE_READ} variants at once.`);
    }
    const out: (typeof commonPriceValidator.type)[] = [];
    for (const raw of new Set(args.variantIds)) {
      const id = ctx.db.normalizeId("selectorOptions", raw);
      if (!id) continue;
      const row = await ownRow(ctx, ownerId, id);
      if (row) out.push({ variantId: row.variantId, priceCents: row.priceCents });
    }
    return out;
  },
});

/**
 * Set (or with `null`, clear) the caller's common price for one variant.
 * Returns the price it replaced, so the undo is `set` with `previous`.
 */
export const set = mutation({
  args: { variantId: v.string(), priceCents: v.union(v.number(), v.null()) },
  returns: v.object({ previous: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const variantId = await parseVariantId(ctx, args.variantId);
    if (!variantId) {
      refuse(COLLECTION_ERRORS.notFound, "That variant isn't in the catalog any more.");
    }
    if (args.priceCents !== null && !isPriceCents(args.priceCents)) {
      refuse(COLLECTION_ERRORS.invalid, "Common price needs to be a dollar amount of zero or more.");
    }
    const row = await ownRow(ctx, ownerId, variantId);
    const previous = row ? row.priceCents : null;
    if (args.priceCents === null) {
      if (row) await ctx.db.delete(row._id);
      return { previous };
    }
    const now = Date.now();
    if (row) {
      if (row.priceCents !== args.priceCents) {
        await ctx.db.patch(row._id, { priceCents: args.priceCents, lastUpdated: now });
      }
      return { previous };
    }
    const held = await ctx.db
      .query("variantCommonPrices")
      .withIndex("by_owner_and_variant", (q) => q.eq("ownerId", ownerId))
      .take(MAX_COMMON_PRICES);
    if (held.length >= MAX_COMMON_PRICES) {
      refuse(COLLECTION_ERRORS.limit, `You already have ${MAX_COMMON_PRICES} common prices. Clear some first.`);
    }
    await ctx.db.insert("variantCommonPrices", {
      ownerId,
      variantId,
      priceCents: args.priceCents,
      lastUpdated: now,
    });
    return { previous };
  },
});
