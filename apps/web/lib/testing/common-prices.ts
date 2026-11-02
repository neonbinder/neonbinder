/**
 * NEO-370 — give an owner a common price on every variant row in a test
 * deployment, so a collector set up for syncing can add to a listed box
 * (`convex/listingGate.ts` refuses an add with no price). For the tests
 * whose subject is something else (the outbox, the sales poll, the intake
 * settle); the gate itself is `convex/listingGate.test.ts`.
 *
 * Lives under lib/ rather than convex/ so it is never deployed as a module.
 */

import type { convexTest } from "convex-test";

type T = ReturnType<typeof convexTest>;

const VARIANT_LEVELS = new Set(["variantType", "insert", "parallel"]);

/** One `variantCommonPrices` row per variant row that has none (at `priceCents`). Idempotent. Returns how many it wrote. */
export async function priceEveryVariant(t: T, ownerId: string, priceCents = 25): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("selectorOptions").collect();
    let n = 0;
    for (const row of rows) {
      if (!VARIANT_LEVELS.has(row.level)) continue;
      const held = await ctx.db
        .query("variantCommonPrices")
        .withIndex("by_owner_and_variant", (q) => q.eq("ownerId", ownerId).eq("variantId", row._id))
        .unique();
      if (held) continue;
      await ctx.db.insert("variantCommonPrices", { ownerId, variantId: row._id, priceCents, lastUpdated: 0 });
      n += 1;
    }
    return n;
  });
}
