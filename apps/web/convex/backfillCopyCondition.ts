/**
 * NEO-380 — a raw copy always has a condition. Until this rule, a copy saved
 * without one (the copy form's "Not set", every quick count, every "I have
 * this one") stored none. The write paths now fill in the collector's default
 * condition (`defaultConditionOf` in `collection.ts`); this backfill does the
 * same for the copies stored before, so the marketplaces (which list by
 * condition, NEO-370) can list them.
 *
 * A raw copy (no `grading`) with no `condition` takes its OWNER's default as
 * it stands when the backfill reaches it: their Profile → Settings pick, else
 * Excellent. A graded copy is left alone (it has a grade, not a condition).
 * Only `condition` changes: no line folds and no count, tally, slot or
 * `lastUpdated` moves. Safe to re-run: a copy that has a condition is skipped.
 *
 * NEO-370: a box copy is for sale, and its condition picks the marketplace
 * row it lists on (a copy with none lists nowhere). So a set copy that sits
 * in a box of an owner who lists is queued for listing, the way every copy
 * write queues it (`collection.applyCopyChanges`). The page only notes the
 * cards; `listingOutbox.queueOwnerCards` queues them, `LISTING_CHUNK` cards a
 * run, so the page's own budget stays the copies' patches. An owner who lists
 * nowhere costs one read per page.
 *
 * ## Operator command
 *
 *   # Dry run: one page, how many copies it would set (writes nothing)
 *   npx convex run backfillCopyCondition:run '{}'
 *   #    (next page: '{"cursor":"<continueCursor>"}')
 *
 *   # Armed: sets every page, rescheduling itself until done
 *   npx convex run backfillCopyCondition:run '{"arm":true}'
 *
 *   # production: the same with --prod
 *
 * No `--identity`: an internal function, and the deploy credential is the gate.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { defaultConditionOf, HomeSides, type Condition } from "./collection";
import { listsAnywhere } from "./listingOutbox";

/** Copies read per page: one read each, plus one profile read per owner on the page. */
export const COPY_PAGE = 500;

/** Cards one `queueOwnerCards` run queues (the house enable-walk page). */
export const LISTING_CHUNK = 200;

export const run = internalMutation({
  args: { arm: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  returns: v.object({
    armed: v.boolean(),
    scanned: v.number(),
    set: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const armed = args.arm === true;
    const page = await ctx.db
      .query("collectionCopies")
      .paginate({ numItems: COPY_PAGE, cursor: args.cursor ?? null });
    const defaults = new Map<string, Condition>();
    // Owner → their box copies' cards to queue, or null when they list nowhere.
    const listing = new Map<string, { sides: HomeSides; cardIds: Set<Id<"cardChecklist"> | Id<"privateCards">> } | null>();
    let set = 0;
    for (const row of page.page) {
      if (row.condition !== undefined || row.grading !== undefined) continue;
      set += 1;
      if (!armed) continue;
      let condition = defaults.get(row.ownerId);
      if (condition === undefined) {
        condition = await defaultConditionOf(ctx, row.ownerId);
        defaults.set(row.ownerId, condition);
      }
      await ctx.db.patch(row._id, { condition });
      let owner = listing.get(row.ownerId);
      if (owner === undefined) {
        owner = (await listsAnywhere(ctx, row.ownerId))
          ? { sides: new HomeSides(ctx, row.ownerId), cardIds: new Set() }
          : null;
        listing.set(row.ownerId, owner);
      }
      if (owner && (await owner.sides.is(row.homeId, "inventory"))) owner.cardIds.add(row.cardId);
    }
    for (const [ownerId, owner] of listing) {
      const cardIds = [...(owner?.cardIds ?? [])];
      for (let i = 0; i < cardIds.length; i += LISTING_CHUNK) {
        await ctx.scheduler.runAfter(0, internal.listingOutbox.queueOwnerCards, {
          ownerId,
          cardIds: cardIds.slice(i, i + LISTING_CHUNK),
        });
      }
    }
    if (armed && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.backfillCopyCondition.run, {
        arm: true,
        cursor: page.continueCursor,
      });
    }
    console.log(
      JSON.stringify({ event: "backfillCopyCondition", armed, scanned: page.page.length, set, isDone: page.isDone }),
    );
    return { armed, scanned: page.page.length, set, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});
