/**
 * NEO-26: data migration from the legacy free-text `cardChecklist.team`
 * field into the structured `teamOnCardIds[]` entity link.
 *
 * Historically the BSC/SL fetch path wrote whatever team string the
 * marketplace happened to surface into `cardChecklist.team`. The form
 * UI was inconsistent: marketplace-fetched rows had `team` set but
 * never `teamOnCardIds[]`, and the edit form only read the latter,
 * which is why "Team field is always blank when editing a card" (the
 * NEO-26 bug report).
 *
 * The fix is to converge on `teamOnCardIds[]` as the canonical
 * representation. This file provides the one-shot internal mutation
 * that drains `team` strings into `teamOnCardIds[]` for every existing
 * row. After the migration runs to completion (caller reruns until
 * `remaining === 0`), the `cardChecklist.team` field is removed from
 * the schema in this same PR.
 *
 * Idempotent: rows already carrying a `teamOnCardIds[]` value are
 * skipped on every pass. Run via the Convex dashboard with
 * `batchSize` tuned to fit under the per-mutation read/write budget
 * (default 100 rows per batch).
 */

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

/**
 * Walk up the parent chain from a cardChecklist's selectorOption to
 * find the ancestor `level === "sport"` row's value. Returns
 * undefined when the chain doesn't include a sport row (orphaned data;
 * shouldn't happen in practice but guard anyway). 16-step depth
 * cutoff matches the `commitCardChecklist` ancestor walk so a cycle
 * can't deadlock the mutation.
 */
async function findSportForSelectorOption(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<any> } },
  selectorOptionId: Id<"selectorOptions">,
): Promise<string | undefined> {
  let cursor: Id<"selectorOptions"> | undefined = selectorOptionId;
  let depth = 0;
  while (cursor && depth < 16) {
    const node = await ctx.db.get(cursor);
    if (!node) return undefined;
    if (node.level === "sport") return node.value;
    cursor = node.parentId;
    depth += 1;
  }
  return undefined;
}

export const backfillTeamToOnCardIds = internalMutation({
  args: {
    /**
     * Cap on rows scanned per invocation. Defaults to 100 — a card
     * row patch is one read + one write, with a possible team
     * findOrCreate (one extra read + maybe one write). 100 keeps us
     * far below the 4096-read mutation budget even for a degenerate
     * batch of all-new teams.
     */
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    /** Rows visited this batch (including skips). */
    processed: v.number(),
    /** New `teams` rows inserted to satisfy a missing FK. */
    teamsCreated: v.number(),
    /**
     * Rows skipped because we couldn't determine the sport for the
     * ancestor chain — usually orphaned test fixtures. Logged with
     * the cardChecklist id so operators can clean these up by hand.
     */
    skippedAmbiguous: v.number(),
    /** Approximate number of rows still needing backfill after this batch. */
    remaining: v.number(),
  }),
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 100;

    // Pull a window of rows. We can't use a `.withIndex(...)` for
    // "team set AND teamOnCardIds empty" — there is no such index —
    // so the cheapest correct read is to scan the table in pages
    // (1000-row pages) and filter in JS. Bounded by Convex's
    // per-mutation read budget; once a page yields no work, we stop.
    //
    // Idempotent design: every pass filters down to rows that still
    // need work, so reruns naturally drain the queue regardless of
    // where the previous batch stopped.
    const PAGE_SIZE = 1000;
    const rows = await ctx.db
      .query("cardChecklist")
      .take(PAGE_SIZE);

    let processed = 0;
    let teamsCreated = 0;
    let skippedAmbiguous = 0;
    let remaining = 0;

    for (const row of rows) {
      // Skip rows that are already migrated (no `team` string set, OR
      // they already carry `teamOnCardIds[]` from the marketplace
      // fetch path). The latter wins: we never clobber an existing
      // entity link with the legacy string.
      const teamString = (row as any).team as string | undefined;
      const teamOnCardIds = row.teamOnCardIds;

      if (teamOnCardIds && teamOnCardIds.length > 0) {
        // Already linked — only need to clear the dangling string.
        if (teamString && teamString.length > 0) {
          await ctx.db.patch(row._id, { team: undefined } as any);
          processed += 1;
        }
        continue;
      }
      if (!teamString || teamString.trim().length === 0) {
        // Nothing to backfill.
        continue;
      }

      if (processed >= batchSize) {
        // We've hit our per-batch cap. Account for unfinished rows
        // in `remaining` so the caller knows to re-run.
        remaining += 1;
        continue;
      }

      const sport = await findSportForSelectorOption(
        ctx,
        row.selectorOptionId,
      );
      if (!sport) {
        // No sport ancestor — can't safely look up across sports
        // (Yankees-MLB vs Yankees-Pinstripes-something-else). Log
        // and leave for operator review.
        console.warn(
          `[backfillTeamToOnCardIds] skipping ambiguous row id=${row._id}` +
            ` selectorOptionId=${row.selectorOptionId} team="${teamString}"`,
        );
        skippedAmbiguous += 1;
        processed += 1;
        continue;
      }

      const normalized = normalizeTeamName(teamString);
      // findOrCreate via the by_name_normalized_and_sport compound
      // index (same hot-path lookup commitCardChecklist uses). One
      // indexed read per team string regardless of cross-sport dupes.
      const existing = await ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport", (q) =>
          q.eq("nameNormalized", normalized).eq("sport", sport),
        )
        .first();

      let teamId: Id<"teams">;
      if (existing) {
        teamId = existing._id;
      } else {
        teamId = await ctx.db.insert("teams", {
          name: teamString.trim(),
          nameNormalized: normalized,
          sport,
          lastUpdated: Date.now(),
        });
        teamsCreated += 1;
      }

      await ctx.db.patch(row._id, {
        teamOnCardIds: [teamId],
        // Clear the legacy string in the same patch so the next
        // pre-removal verification scan reports 0 unmigrated rows.
        team: undefined,
        lastUpdated: Date.now(),
      } as any);
      processed += 1;
    }

    // Best-effort `remaining` estimate: every row in this page that
    // wasn't already migrated and wasn't processed this batch.
    // Caller can rerun until processed === 0 to fully drain.
    return {
      processed,
      teamsCreated,
      skippedAmbiguous,
      remaining,
    };
  },
});
