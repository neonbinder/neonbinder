/**
 * NEO-427 — what `intakePhotos.reattachIntakeRunPhotos` reads about a row. Its
 * own module because that action's is `"use node"`, which cannot define a query.
 */

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

/** Null when the row is gone or never saved. A line that is gone has no same quantity. */
export const reattachRowFacts = internalQuery({
  args: { matchId: v.id("intakeMatches") },
  returns: v.union(v.null(), v.object({ attached: v.boolean(), sameQuantity: v.boolean() })),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.matchId);
    if (!row?.savedCopyId) return null;
    const copy = await ctx.db.get(row.savedCopyId);
    return { attached: row.photos === "attached", sameQuantity: copy?.quantity === row.savedQuantity };
  },
});
