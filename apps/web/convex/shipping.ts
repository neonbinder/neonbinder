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

/** How many purchases the history view shows. Reprints are a recent-item need. */
const PURCHASE_HISTORY_LIMIT = 25;

/**
 * The current user's saved return address, or null when they haven't set one.
 *
 * Returns the stored address AND a separately-resolved name, rather than one
 * merged object, because the two consumers need different things: the label
 * prints `resolvedName`, while the editor has to show the *stored* value so a
 * deliberately-blank name stays blank instead of being silently promoted into
 * a saved one.
 *
 * `resolvedName` is the stored name if the seller typed one, else their public
 * display name, else their username. A seller's name is already on their public
 * profile; making them retype it on a second screen — and keep the two in sync
 * forever after — is the kind of duplication this avoids.
 *
 * `/labels` treats null as "not set up yet" and renders the setup prompt rather
 * than an unprintable half-blank label.
 */
export const getMyReturnAddress = query({
  args: {},
  returns: v.union(
    v.object({
      address: postalAddressValidator,
      resolvedName: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return null;

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    const address = profile?.returnAddress;
    if (!address) return null;

    let resolvedName = address.name.trim();
    if (resolvedName === "") {
      const publicProfile = await ctx.db
        .query("publicProfiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      resolvedName =
        publicProfile?.displayName?.trim() ||
        publicProfile?.username?.trim() ||
        "";
    }

    return { address, resolvedName };
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
    // `name` is deliberately absent: a blank name is a valid saved state,
    // meaning "use my display name", and getMyReturnAddress resolves it.
    const required = ["line1", "city", "state", "postalCode"] as const;
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

/**
 * NEO-120 — record a label the seller has already paid for.
 *
 * Called after the purchase succeeds, from `postage.buyLetterLabel`. Kept as a
 * plain mutation rather than folded into the action because by the time it runs
 * the money is spent: a failure here must never be able to fail the purchase,
 * so the caller logs rather than throws.
 *
 * Minimal by design — this is not NEO-121's `shipments` table. No scan events,
 * no status machine, no sale linkage. It exists so a seller can see what they
 * spent and reprint a label they have already bought.
 */
export const recordLabelPurchase = mutation({
  args: {
    easypostShipmentId: v.string(),
    trackingCode: v.string(),
    costCents: v.number(),
    weightOz: v.number(),
    toAddress: postalAddressValidator,
    labelUrl: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    await ctx.db.insert("labelPurchases", {
      userId,
      easypostShipmentId: args.easypostShipmentId,
      trackingCode: args.trackingCode,
      costCents: args.costCents,
      weightOz: args.weightOz,
      // A snapshot, not a reference: what was printed on the label is a
      // historical fact and must not change if anything else is edited later.
      toAddress: args.toAddress,
      labelUrl: args.labelUrl,
      purchasedAt: Date.now(),
    });

    return null;
  },
});

/**
 * The seller's recent label purchases, newest first — for reprinting and for
 * seeing what postage has cost.
 */
export const listMyLabelPurchases = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("labelPurchases"),
      _creationTime: v.number(),
      userId: v.string(),
      easypostShipmentId: v.string(),
      trackingCode: v.string(),
      costCents: v.number(),
      weightOz: v.number(),
      toAddress: postalAddressValidator,
      labelUrl: v.string(),
      purchasedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return [];

    return await ctx.db
      .query("labelPurchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(PURCHASE_HISTORY_LIMIT);
  },
});
