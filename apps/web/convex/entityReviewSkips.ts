/**
 * NEO-212 security review — the read-back and undo for entity-review skips.
 *
 * ## The defect this closes
 *
 * `entityReviewSkips` was write-only. `commitCardChecklistPrelude` inserted
 * rows and `resolveUnknownsAndStartBatch` consulted them, and there was no
 * query that could list one and no mutation that could remove one. That makes
 * a skip a PERMANENT, INVISIBLE SUPPRESSION: a mis-click on a real player's
 * name takes that name out of the review wizard for that set forever, no
 * surface shows it happened, and the only remedy was a hand-edit in the Convex
 * dashboard. "Silent and irreversible" is a bad shape for any suppression
 * list, and a worse one for a list an operator populates by pressing a button
 * labelled "Skip Remaining".
 *
 * The two functions here are the whole fix: see what is suppressed for a set,
 * and un-suppress one entry.
 *
 * ## What "undo" means, exactly
 *
 * `clearSkip` deletes the row and does NOTHING else. It does not re-run a
 * lookup, does not touch `entityReviewQueue`, does not modify any card, and
 * does not create a player or team. The effect is entirely on the NEXT sync of
 * that set: `resolveUnknownsAndStartBatch` no longer finds a matching skip, so
 * the name re-enters the review wizard as an unknown and the operator gets to
 * decide again. That deferred re-entry IS the undo — there is nothing else to
 * roll back, because a skip's only durable effect was this row.
 *
 * Cards already committed while the name was suppressed are untouched and stay
 * correct: a skip never altered a card, it only kept the name as free text.
 *
 * ## Auth and what is returned
 *
 * Both are `requireAdmin`, matching every other operator-facing function in
 * the checklist pipeline — these read and mutate global taxonomy state, not
 * anything user-scoped.
 *
 * `listForSet` NEVER returns `skippedByUserId`. Same rule as
 * `players.createdByUserId` (see `toPublicPlayer`): admin-gating is not a
 * licence to ship an audit field to a client, the returns validator is what
 * enforces the omission, and the validator is part of the public API. The
 * operator needs to know WHAT is suppressed, not who suppressed it; `batchId`
 * is returned in its place, which gives a log search a handle without naming a
 * person.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./auth";

/**
 * Every name suppressed from the review wizard for one set.
 *
 * Reads the `(selectorOptionId, kind, nameNormalized)` index by its
 * selectorOptionId prefix — the same index the per-name point lookup uses, so
 * this surface needs no index of its own.
 *
 * Sorted by display `name`, not by the index's own order. The index orders by
 * `kind` then `nameNormalized`, and a normalized key is token-sorted
 * ("SPONSORED BY ACME" → "acme by sponsored"), so index order reads as
 * scrambled to a human scanning the list for the name they mis-skipped.
 *
 * Uncapped by design, and safe: the row count is bounded by the distinct junk
 * names on ONE set's checklist — a few dozen at the outside — because the
 * whole table is per-set scoped. A cap here would be the more dangerous
 * choice: a truncated suppression list reads as "that is everything that is
 * hidden", which is exactly the wrong belief to hand an operator hunting for a
 * missing player.
 */
export const listForSet = query({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: v.array(
    v.object({
      _id: v.id("entityReviewSkips"),
      kind: v.union(v.literal("player"), v.literal("team")),
      name: v.string(),
      skippedAt: v.number(),
      batchId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const rows = await ctx.db
      .query("entityReviewSkips")
      .withIndex("by_selector_option_and_kind_and_name", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();

    return rows
      .map((row) => ({
        _id: row._id,
        kind: row.kind,
        name: row.name,
        skippedAt: row.skippedAt,
        // Spread-conditional rather than `batchId: row.batchId`, so a legacy
        // row written before the field existed comes back with the key absent
        // rather than explicitly undefined.
        ...(row.batchId !== undefined ? { batchId: row.batchId } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Un-suppress one name: delete its skip row.
 *
 * The name re-enters the wizard on the NEXT sync of that set — see the note at
 * the top of this file for why that deferred re-entry is the whole of the
 * undo, and why nothing else is touched.
 *
 * Idempotent. A row that is already gone is success, not an error: the caller's
 * intent ("this name should not be suppressed") is satisfied either way, and
 * two admins clearing the same stale entry from two tabs is an ordinary race,
 * not a failure worth surfacing as one.
 */
export const clearSkip = mutation({
  args: { skipId: v.id("entityReviewSkips") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const existing = await ctx.db.get(args.skipId);
    if (!existing) return null;

    await ctx.db.delete(args.skipId);
    return null;
  },
});
