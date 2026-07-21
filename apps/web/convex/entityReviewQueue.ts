import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";

/**
 * NEO-92: backs the step-through "new players & teams" review wizard that
 * replaced the old single-screen UnknownEntitiesDialog checkbox list. See
 * the `entityReviewQueue` table doc comment in schema.ts for the full model.
 *
 * Lifecycle: fetchCardChecklist (an action — transitively admin-gated via
 * its own call to getAncestorChain, which requires admin) calls `startBatch`
 * for any unknown names it surfaces. The wizard subscribes to `getBatch` and
 * calls `recordDecision` once per row as the user reviews. `commitCardChecklist`
 * (admin-gated) reads the finished batch to resolve create/link decisions,
 * then schedules `cleanupBatch`. `cancelBatch` is the wizard's Cancel action —
 * it only ever touches these throwaway rows, never `players`/`teams`/
 * `cardChecklist`. Every public function here is admin-gated (requireAdmin),
 * matching every other function in selectorOptions.ts — even though the
 * blast radius of this table alone is small, there's no reason a non-admin
 * should be able to read/mutate it at all.
 */

const enrichmentValidator = v.object({
  wikidataId: v.optional(v.string()),
  careerTeams: v.optional(v.array(v.object({
    name: v.string(),
    fromYear: v.number(),
    toYear: v.optional(v.number()),
  }))),
  isHallOfFame: v.optional(v.boolean()),
  league: v.optional(v.string()),
  city: v.optional(v.string()),
  yearsActive: v.optional(v.object({
    from: v.number(),
    to: v.optional(v.number()),
  })),
  colors: v.optional(v.object({
    primary: v.optional(v.string()),
    secondary: v.optional(v.string()),
  })),
  espnId: v.optional(v.string()),
});

const decisionValidator = v.union(
  v.object({ action: v.literal("create") }),
  v.object({
    action: v.literal("link"),
    linkedPlayerId: v.optional(v.id("players")),
    linkedTeamId: v.optional(v.id("teams")),
  }),
);

const rowValidator = v.object({
  _id: v.id("entityReviewQueue"),
  _creationTime: v.number(),
  selectorOptionId: v.id("selectorOptions"),
  batchId: v.string(),
  kind: v.union(v.literal("player"), v.literal("team")),
  name: v.string(),
  sport: v.string(),
  status: v.union(v.literal("pending"), v.literal("ready"), v.literal("error")),
  enrichment: v.optional(enrichmentValidator),
  decision: v.optional(decisionValidator),
});

/**
 * Start (or resume) a review batch for a selectorOption. Called from
 * fetchCardChecklist's action via ctx.runMutation — internal, no public
 * surface needed since only that action calls it.
 *
 * If a batch already exists for this selectorOptionId, resume it (return
 * its id, touch nothing) rather than deleting + restarting: a batch only
 * exists while mid-review (commit and cancel both delete their batch's rows
 * on completion), so finding one means a previous tab/click is still
 * reviewing it — silently discarding that progress would be a real bug.
 * This holds even once every row is decided but not yet committed (the
 * wizard's final "All reviewed — save?" screen) — a page refresh in that
 * state should resume the same fully-decided batch, not lose it.
 *
 * Safe to key this purely on "any row exists" (not "any UNDECIDED row")
 * because commitCardChecklist deletes a batch's rows SYNCHRONOUSLY, in the
 * same transaction as the commit itself — there is no async window where a
 * fully-decided batch could be observed here after it's already been
 * committed. See the delete site in commitCardChecklist for why that
 * matters (an earlier scheduled-delete version of this had exactly that
 * race).
 */
export const startBatch = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    sport: v.string(),
    playerNames: v.array(v.string()),
    teamNames: v.array(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const existing = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .first();
    if (existing) return existing.batchId;

    const batchId = crypto.randomUUID();
    const ids: Array<Id<"entityReviewQueue">> = [];
    for (const name of args.playerNames) {
      ids.push(
        await ctx.db.insert("entityReviewQueue", {
          selectorOptionId: args.selectorOptionId,
          batchId,
          kind: "player",
          name,
          sport: args.sport,
          status: "pending",
        }),
      );
    }
    for (const name of args.teamNames) {
      ids.push(
        await ctx.db.insert("entityReviewQueue", {
          selectorOptionId: args.selectorOptionId,
          batchId,
          kind: "team",
          name,
          sport: args.sport,
          status: "pending",
        }),
      );
    }
    if (ids.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.adapters.wikidata.processEntityReviewQueue,
        { ids },
      );
    }
    return batchId;
  },
});

/**
 * What the wizard subscribes to. Fully reactive — a row's `status` flips
 * live as the background queue (processEntityReviewQueue) drains, so the
 * client sees each Wikidata lookup complete without polling.
 */
export const getBatch = query({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.array(rowValidator),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    return await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
  },
});

/**
 * Record the user's decision for one reviewed row. Patched immediately
 * (not batched client-side) so wizard progress survives a page refresh —
 * the whole point of persisting decisions server-side rather than only in
 * React state.
 *
 * A "link" decision is validated against the row before being trusted —
 * commitCardChecklist later uses `linkedPlayerId`/`linkedTeamId` verbatim to
 * populate a real card's playerIds/teamOnCardIds, so this is the boundary
 * that must reject a mismatched or missing id rather than silently
 * dropping the name later at commit time.
 */
export const recordDecision = mutation({
  args: {
    reviewRowId: v.id("entityReviewQueue"),
    action: v.union(v.literal("create"), v.literal("link")),
    linkedPlayerId: v.optional(v.id("players")),
    linkedTeamId: v.optional(v.id("teams")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const row = await ctx.db.get(args.reviewRowId);
    if (!row) throw new Error("Review row not found");

    if (args.action === "create") {
      await ctx.db.patch(args.reviewRowId, { decision: { action: "create" } });
      return null;
    }

    if (row.kind === "player") {
      if (!args.linkedPlayerId) {
        throw new Error("linkedPlayerId is required to link a player");
      }
      const linked = await ctx.db.get(args.linkedPlayerId);
      if (!linked) throw new Error("Linked player not found");
      if (linked.primarySport !== row.sport) {
        throw new Error(
          `Linked player's sport (${linked.primarySport}) doesn't match ${row.sport}`,
        );
      }
      await ctx.db.patch(args.reviewRowId, {
        decision: { action: "link", linkedPlayerId: args.linkedPlayerId },
      });
    } else {
      if (!args.linkedTeamId) {
        throw new Error("linkedTeamId is required to link a team");
      }
      const linked = await ctx.db.get(args.linkedTeamId);
      if (!linked) throw new Error("Linked team not found");
      if (linked.sport !== row.sport) {
        throw new Error(
          `Linked team's sport (${linked.sport}) doesn't match ${row.sport}`,
        );
      }
      await ctx.db.patch(args.reviewRowId, {
        decision: { action: "link", linkedTeamId: args.linkedTeamId },
      });
    }
    return null;
  },
});

/**
 * Bulk fast-path: mark every not-yet-decided row in this batch as
 * "create", in one mutation. A first-time real-set sync can surface
 * hundreds of genuinely-new names (the common case, not the exception —
 * e.g. every rookie in a brand-new set) where reviewing one at a time has
 * real value ONLY when something looks wrong; when everything's fine, the
 * user needs a fast path instead of hundreds of individual taps. Rows
 * still "pending" (their Wikidata lookup hasn't finished yet) are
 * included too — commitCardChecklist's create branch already treats
 * `enrichment` as optional, so those just create a bare, unenriched row
 * (identical to how any player/team looked up with no Wikidata match
 * behaves) rather than blocking on the lookup queue draining.
 */
export const recordAllRemainingAsCreate = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    await requireAdmin(ctx);

    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
    let count = 0;
    for (const row of rows) {
      if (row.decision) continue;
      await ctx.db.patch(row._id, { decision: { action: "create" } });
      count++;
    }
    return count;
  },
});

/**
 * Wizard Cancel. Only ever deletes these throwaway rows — players, teams,
 * and cardChecklist are never touched during review, so cancelling has
 * exactly the same all-or-nothing semantics as today's dialog.
 */
export const cancelBatch = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

/** Internal — read one row for the background queue action. */
export const getInternal = internalQuery({
  args: { id: v.id("entityReviewQueue") },
  returns: v.union(rowValidator, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

/** Internal — the background queue patches status/enrichment as each lookup completes. */
export const applyLookupResult = internalMutation({
  args: {
    id: v.id("entityReviewQueue"),
    status: v.union(v.literal("ready"), v.literal("error")),
    enrichment: v.optional(enrichmentValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: args.status,
      enrichment: args.enrichment,
    });
    return null;
  },
});

/**
 * Internal — deletes a batch's rows. NOT called by commitCardChecklist
 * (which deletes its batch's rows synchronously, inline, using the rows it
 * already read to resolve decisions — see the delete site there for why a
 * scheduled/async cleanup was replaced: it left a race where a re-fetch of
 * the same selectorOptionId could observe and wrongly resume an
 * already-committed batch). Kept as a standalone utility for clearing a
 * genuinely abandoned batch (e.g. the user closed the tab mid-review,
 * never confirmed or cancelled) — nothing currently calls it in the
 * commit/cancel path, both of which clean up their own rows directly.
 */
export const cleanupBatch = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});
