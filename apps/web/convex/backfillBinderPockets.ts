/**
 * Every card in a collector's binder sits in a pocket. Until this rule, a
 * copy filed into a binder from its details, or moved in from another screen,
 * kept no `slot`, and the binder showed it on "Not in a pocket yet" pages.
 * The write paths now give such a copy the first open pocket
 * (`firstOpenPocket` in `collection.ts`); this backfill does the same for the
 * copies stored before.
 *
 * Per binder (Main included), its unplaced lines take the first open
 * pockets in the order they were stored. Only `slot` (and the binder's
 * `openPocket` hint) changes: no line folds, so no count or tally moves.
 * Boxes and smart binders are left alone. Safe to re-run: a binder with no unplaced lines is a no-op.
 *
 * ## Operator command
 *
 *   # Dry run: one page of binders, what it would place (writes nothing)
 *   npx convex run backfillBinderPockets:run '{}'
 *   #    (next page: '{"cursor":"<continueCursor>"}')
 *
 *   # Armed: places every page, rescheduling itself until done
 *   npx convex run backfillBinderPockets:run '{"arm":true}'
 *
 *   # production: the same with --prod
 *
 * No `--identity`: an internal function, and the deploy credential is the gate.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { firstOpenPocket, keepsPockets } from "./collection";

/** Containers read per page. Most are binders with a handful of lines. */
export const CONTAINER_PAGE = 20;
/** Unplaced lines placed per binder per run; a bigger binder is revisited. */
export const LINES_PER_BINDER = 200;

export const run = internalMutation({
  args: { arm: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  returns: v.object({
    armed: v.boolean(),
    binders: v.number(),
    placed: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const armed = args.arm === true;
    const page = await ctx.db
      .query("collectionContainers")
      .paginate({ numItems: CONTAINER_PAGE, cursor: args.cursor ?? null });
    let binders = 0;
    let placed = 0;
    let revisit = false;
    for (const home of page.page) {
      if (!keepsPockets(home)) continue;
      const loose = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_home_slot", (q) =>
          q.eq("ownerId", home.ownerId).eq("homeId", home._id).eq("slot", undefined),
        )
        .take(LINES_PER_BINDER + 1);
      if (loose.length === 0) continue;
      if (loose.length > LINES_PER_BINDER) revisit = true;
      binders += 1;
      if (!armed) {
        placed += Math.min(loose.length, LINES_PER_BINDER);
        continue;
      }
      for (const line of loose.slice(0, LINES_PER_BINDER)) {
        await ctx.db.patch(line._id, { slot: await firstOpenPocket(ctx, home.ownerId, home._id) });
        placed += 1;
      }
    }
    // A binder with more than a run's worth comes round again on the same page.
    const next = armed && revisit ? (args.cursor ?? "") : page.continueCursor;
    const isDone = page.isDone && !(armed && revisit);
    if (armed && !isDone) {
      await ctx.scheduler.runAfter(0, internal.backfillBinderPockets.run, {
        arm: true,
        ...(next ? { cursor: next } : {}),
      });
    }
    console.log(JSON.stringify({ event: "backfillBinderPockets", armed, binders, placed, isDone }));
    return { armed, binders, placed, continueCursor: next, isDone };
  },
});
