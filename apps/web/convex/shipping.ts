/**
 * NEO-118 — the seller's return address.
 *
 * This lives in its own module rather than in userProfile.ts so that the
 * shipping surface has somewhere to grow. The two things queued behind it —
 * USPS address validation and PWE postage — are both server-side calls with
 * their own credentials and their own failure modes; folding them into the
 * general-purpose profile module later would be a worse refactor than starting
 * them here.
 *
 * Both functions write the SAME `userProfiles` row that userProfile.ts owns.
 * That is safe because `ctx.db.patch` merges rather than replaces, so saving an
 * address cannot clobber `siteCredentials` (which carries the credential lock
 * lease) or `marketplaceAccountIds`.
 */

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUserId } from "./auth";
import { postalAddressValidator } from "./schema";

/**
 * The current user's saved return address, or null when they haven't set one.
 *
 * `/labels` distinguishes the two: null renders the "set this up on your
 * profile first" empty state rather than an unprintable half-blank label.
 */
export const getMyReturnAddress = query({
  args: {},
  returns: v.union(postalAddressValidator, v.null()),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return null;

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    return profile?.returnAddress ?? null;
  },
});

/**
 * Create or replace the current user's return address.
 *
 * Deliberately takes the whole address as one object rather than field-by-field
 * args: an address is only meaningful complete, and a partial patch would let
 * the stored value drift into a state that prints a broken label.
 */
export const saveMyReturnAddress = mutation({
  args: { address: postalAddressValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Server-side completeness check. The form disables Save without these, but
    // the mutation is the actual boundary — a client is not a validator.
    const required = ["name", "line1", "city", "state", "postalCode"] as const;
    for (const field of required) {
      if (args.address[field].trim() === "") {
        throw new Error(`Return address is missing ${field}`);
      }
    }

    const existing = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      // patch (not replace) — leaves siteCredentials and its lock lease intact.
      await ctx.db.patch(existing._id, { returnAddress: args.address });
    } else {
      await ctx.db.insert("userProfiles", {
        userId,
        returnAddress: args.address,
      });
    }

    return null;
  },
});
