/**
 * NEO-410 — smart binders the stuck sweep cannot see. `requeueStuckFits`
 * re-queues a binder pending since `pendingSince`, but two kinds of binder
 * have no `pendingSince` to find:
 *
 * - a smart binder with no `collectionBinderFitsState` row at all (a rule
 *   saved before stored fits, NEO-401, shipped): its empty slots read as
 *   "pending" and nothing ever computes them;
 * - one left pending before this change (no `pendingSince` stamped).
 *
 * Each gets `scheduleFits`, exactly as a rule save would: a state row
 * stamped pending now, and a recompute. Safe to re-run: a binder whose state
 * is settled, or pending with a `pendingSince`, is left alone.
 *
 * ## Operator command
 *
 *   # Dry run: one page of containers, what it would schedule (writes nothing)
 *   npx convex run backfillFitsState:run '{}'
 *   #    (next page: '{"cursor":"<continueCursor>"}')
 *
 *   # Armed: schedules every page, rescheduling itself until done
 *   npx convex run backfillFitsState:run '{"arm":true}'
 *
 *   # production: the same with --prod
 *
 * No `--identity`: an internal function, and the deploy credential is the gate.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { scheduleFits } from "./binderRules";

/** Containers read per page: one state read each, at most one schedule. */
export const CONTAINER_PAGE = 100;
/** Seconds between two armed pages, so their recomputes never stack up. */
const PAGE_SPACING_MS = 30_000;

export const run = internalMutation({
  args: { arm: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  returns: v.object({
    armed: v.boolean(),
    /** Smart binders with no state row. */
    missing: v.number(),
    /** Smart binders pending with no `pendingSince`. */
    unstamped: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const armed = args.arm === true;
    const page = await ctx.db
      .query("collectionContainers")
      .paginate({ numItems: CONTAINER_PAGE, cursor: args.cursor ?? null });
    let missing = 0;
    let unstamped = 0;
    for (const home of page.page) {
      if (!home.rule) continue;
      const state = await ctx.db
        .query("collectionBinderFitsState")
        .withIndex("by_binder", (q) => q.eq("binderId", home._id))
        .unique();
      if (!state) missing += 1;
      else if (state.pending === true && state.pendingSince === undefined) unstamped += 1;
      else continue;
      if (armed) await scheduleFits(ctx, home.ownerId, home._id);
    }
    if (armed && !page.isDone) {
      await ctx.scheduler.runAfter(PAGE_SPACING_MS, internal.backfillFitsState.run, {
        arm: true,
        cursor: page.continueCursor,
      });
    }
    console.log(
      JSON.stringify({ msg: "backfill_fits_state_page", armed, missing, unstamped, isDone: page.isDone }),
    );
    return { armed, missing, unstamped, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});
