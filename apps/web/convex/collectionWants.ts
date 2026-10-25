/**
 * NEO-359 — the cards a collector is looking for: the Want List.
 *
 * One want per (collector, card). A want may be scoped to one of the caller's
 * binders or boxes ("for my Ohtani rainbow"); wanting the card for another
 * one moves the want there. Absent scope means the Want List at large. At
 * most `MAX_WANTS` per collector.
 *
 * Every public function is signed-in (`requireSignedIn`) and touches only the
 * caller's wants. A want carries no denormalised variant or set (Jason): a
 * card moving between checklists never touches it, and a deleted card takes
 * its wants with it (`cardRowDelete.removeCardRow`, never a refusal). Neither
 * `set` nor `list` needs the Want List shelf row; its count moves only when it
 * exists (`collectionContainers.ensureSystem` makes it, counted).
 *
 * NB fields only.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import { COLLECTION_ERRORS, MAX_WANTS, moveSystemCount, refuse } from "./collection";
import { sweepCardWants, WANT_SWEEP_CONTINUATION_BATCH } from "./cardRowDelete";
import { internal } from "./_generated/api";

/** A want as the Want List reads it. */
export const wantValidator = v.object({
  cardId: v.id("cardChecklist"),
  /** The binder or box it is for; absent for the Want List at large. */
  binderId: v.optional(v.id("collectionContainers")),
  lastUpdated: v.number(),
});

/**
 * Whether the caller already holds `MAX_WANTS` wants. Counted off the wants
 * themselves (a bounded read, at most `MAX_WANTS` rows, cheap at the cap),
 * never off the Want List shelf row's `count`: a count that drifted low must
 * not let a collector past the cap, and one that drifted high must not refuse
 * a want under it.
 */
async function atWantCap(ctx: MutationCtx, ownerId: string): Promise<boolean> {
  const wants = await ctx.db
    .query("collectionWants")
    .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId))
    .take(MAX_WANTS);
  return wants.length >= MAX_WANTS;
}

/** The caller's wants, oldest card id order (the index), at most `MAX_WANTS`. */
export const list = query({
  args: {},
  returns: v.array(wantValidator),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const rows = await ctx.db
      .query("collectionWants")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId))
      .take(MAX_WANTS);
    return rows.map((row) => ({
      cardId: row.cardId,
      ...(row.binderId ? { binderId: row.binderId } : {}),
      lastUpdated: row.lastUpdated,
    }));
  },
});

/**
 * Want a card (`on`), for one binder or box (`binderId`) or the Want List at
 * large, or stop wanting it. Wanting a card already wanted elsewhere moves
 * the want to `binderId`. Idempotent: `changed` is false when the want
 * already read as asked. Refuses a `binderId` that is not one of the caller's
 * binders or boxes, a card that is not in the catalog, and a new want past
 * `MAX_WANTS`.
 */
export const set = mutation({
  args: {
    cardId: v.id("cardChecklist"),
    binderId: v.optional(v.id("collectionContainers")),
    on: v.boolean(),
  },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const existing = await ctx.db
      .query("collectionWants")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", args.cardId))
      .unique();
    if (!args.on) {
      if (!existing) return { changed: false };
      await ctx.db.delete(existing._id);
      await moveSystemCount(ctx, ownerId, "want", { copies: -1, lines: -1 });
      return { changed: true };
    }
    if (args.binderId !== undefined) {
      const binder = await ctx.db.get(args.binderId);
      if (!binder || binder.ownerId !== ownerId) {
        refuse(COLLECTION_ERRORS.notFound, "That binder or box isn't in your collection.");
      }
      if (binder.system !== undefined) {
        refuse(COLLECTION_ERRORS.invalid, "Want a card for one of your own binders or boxes, or just for the Want List.");
      }
    }
    const now = Date.now();
    if (existing) {
      if (existing.binderId === args.binderId) return { changed: false };
      await ctx.db.patch(existing._id, { binderId: args.binderId, lastUpdated: now });
      return { changed: true };
    }
    const card = await ctx.db.get(args.cardId);
    if (!card) {
      refuse(COLLECTION_ERRORS.notFound, "That card isn't in the catalog anymore.");
    }
    if (await atWantCap(ctx, ownerId)) {
      refuse(
        COLLECTION_ERRORS.limit,
        `Your Want List is full at ${MAX_WANTS.toLocaleString("en-US")} cards. Cross a few off first.`,
      );
    }
    await ctx.db.insert("collectionWants", {
      ownerId,
      cardId: args.cardId,
      ...(args.binderId ? { binderId: args.binderId } : {}),
      lastUpdated: now,
    });
    await moveSystemCount(ctx, ownerId, "want", { copies: 1, lines: 1 });
    return { changed: true };
  },
});

/**
 * Internal: the continuation of `removeCardRow`'s want sweep, for a deleted
 * card on more Want Lists than one transaction removes
 * (`cardRowDelete.WANT_SWEEP_BATCH`), `WANT_SWEEP_CONTINUATION_BATCH` a run.
 * Reschedules itself until none are left.
 */
export const sweepWantsOfDeletedCard = internalMutation({
  args: { cardId: v.id("cardChecklist") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const swept = await sweepCardWants(
      ctx,
      args.cardId as Id<"cardChecklist">,
      WANT_SWEEP_CONTINUATION_BATCH,
    );
    if (swept.hasMore) {
      await ctx.scheduler.runAfter(0, internal.collectionWants.sweepWantsOfDeletedCard, {
        cardId: args.cardId,
      });
    }
    return null;
  },
});
