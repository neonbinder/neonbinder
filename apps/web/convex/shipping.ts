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

import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUserId } from "./auth";
import {
  postalAddressValidator,
  trackerSnapshotValidator,
  trackingScanValidator,
} from "./schema";
import { sanitizeSnapshot } from "./shipmentTracking";

/**
 * Drop keys whose value is `undefined`.
 *
 * {@link sanitizeSnapshot} returns `undefined` for every field the tracker did
 * not carry, which is exactly right for a `patch` (there it REMOVES the field,
 * so a snapshot replaces rather than merges) and wrong for an `insert`, where
 * an explicitly-undefined field is not a Convex value. One-line difference, one
 * helper, rather than a second sanitiser that would drift.
 */
function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/** How many purchases the history view shows. Reprints are a recent-item need. */
const PURCHASE_HISTORY_LIMIT = 25;

/**
 * One `labelPurchases` document, as every reader of the table sees it.
 *
 * Shared by {@link listMyLabelPurchases} and {@link getLabelPurchaseForUser}
 * rather than written out twice: NEO-121 added eight optional fields, and two
 * hand-maintained copies of the same object is exactly how a reader ends up
 * silently missing a field that the other one returns.
 *
 * **Every NEO-121 field here is seller-forgeable and none of it is proof of
 * delivery** — see the module comment in convex/shipmentTracking.ts.
 */
const labelPurchaseDocValidator = v.object({
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
  trackerId: v.optional(v.string()),
  trackingStatus: v.optional(v.string()),
  trackingStatusDetail: v.optional(v.string()),
  trackerUpdatedAt: v.optional(v.number()),
  lastScanAt: v.optional(v.number()),
  estDeliveryAt: v.optional(v.number()),
  publicTrackingUrl: v.optional(v.string()),
  scans: v.optional(v.array(trackingScanValidator)),
  lastRefreshAt: v.optional(v.number()),
});

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
 * separate mutation rather than folded into the action because by the time it
 * runs the money is spent: a failure here must never be able to fail the
 * purchase, so the caller logs rather than throws.
 *
 * Minimal by design — this is not NEO-121's `shipments` table. No scan events,
 * no status machine, no sale linkage. It exists so a seller can see what they
 * spent and reprint a label they have already bought.
 *
 * ## Why `internalMutation` with an explicit `userId` (NEO-213)
 * A row here is not just history any more — `getLabelPurchaseForUser` treats it
 * as PROOF that a shipment belongs to the caller, and `postage.refreshLabelUrl`
 * forwards the `easypostShipmentId` off the row straight to EasyPost. As a
 * public mutation this was therefore a way to mint that proof: any signed-in
 * seller could insert a row naming someone else's shipment id under their own
 * userId, then "reprint" it. The ownership check downstream would pass, because
 * the row really was theirs — it was the *shipment id on it* that was not.
 *
 * Closing that means the write can only come from the server, so it is internal
 * and takes the userId as an argument. The one caller (`postage.buyLetterLabel`)
 * derives that from its own verified Clerk subject and passes a shipment id it
 * got back from the purchase, never one a client supplied.
 */
export const recordLabelPurchase = internalMutation({
  args: {
    userId: v.string(),
    easypostShipmentId: v.string(),
    trackingCode: v.string(),
    costCents: v.number(),
    weightOz: v.number(),
    toAddress: postalAddressValidator,
    labelUrl: v.string(),
    // NEO-121 — the tracker EasyPost returns inline with a bought shipment.
    // Optional: a browser revision that predates scan visibility does not send
    // one, and the purchase must record either way.
    tracker: v.optional(trackerSnapshotValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("labelPurchases", {
      userId: args.userId,
      easypostShipmentId: args.easypostShipmentId,
      trackingCode: args.trackingCode,
      costCents: args.costCents,
      weightOz: args.weightOz,
      // A snapshot, not a reference: what was printed on the label is a
      // historical fact and must not change if anything else is edited later.
      toAddress: args.toAddress,
      labelUrl: args.labelUrl,
      purchasedAt: Date.now(),
      // Through the SAME sanitiser the webhook path uses — truncated strings,
      // capped scans, https-only public URL. One definition of "stored", so
      // the two write paths cannot disagree about what a snapshot becomes.
      ...(args.tracker ? withoutUndefined(sanitizeSnapshot(args.tracker)) : {}),
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
  returns: v.array(labelPurchaseDocValidator),
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

/**
 * NEO-213 — one purchase row, but only if it belongs to `userId`.
 *
 * Exists because `postage.refreshLabelUrl` is an action and an action has no
 * `ctx.db`. The alternative — letting the client hand the action an
 * `easypostShipmentId` directly — would make a reprint call work for ANY
 * shipment id the caller could guess or scrape, since the browser service only
 * checks that the *key* belongs to the seller, not that the *shipment* does.
 * So the id the action forwards to EasyPost is derived here, from a row this
 * query has already proved is the caller's.
 *
 * Same rule, same reason as `adapters/placeholderUploads.ts:343-355`: an
 * argument that names someone else's object turns a URL minter into a
 * cross-user read oracle. Ownership is resolved server-side from the verified
 * Clerk subject, never trusted from the argument.
 *
 * That only holds because `recordLabelPurchase` is internal. This query proves
 * the ROW is the caller's; it cannot tell whether the shipment id written on
 * that row was ever theirs. While the write was public, a seller could file a
 * row of their own naming any shipment id they liked and this check would wave
 * it through. The two functions are one boundary, not two — do not make the
 * write public again without moving the shipment-id check somewhere else.
 *
 * Not-found and not-yours both return null, deliberately — a distinct "that
 * isn't yours" would confirm the id exists, which is the oracle again in a
 * smaller form. The caller renders one message for both.
 *
 * `internalQuery`, so it is unreachable from any client; the only caller is the
 * action, which supplies the userId it read off the token.
 */
export const getLabelPurchaseForUser = internalQuery({
  args: {
    purchaseId: v.id("labelPurchases"),
    userId: v.string(),
  },
  returns: v.union(labelPurchaseDocValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.purchaseId);
    if (!row || row.userId !== args.userId) return null;
    return row;
  },
});
