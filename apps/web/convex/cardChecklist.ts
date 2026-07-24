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

import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { normalizeTeamName } from "./teams";

/**
 * Walk up the parent chain from a cardChecklist's selectorOption to
 * find the ancestor `level === "sport"` row's value. Returns
 * undefined when the chain doesn't include a sport row (orphaned data;
 * shouldn't happen in practice but guard anyway). 16-step depth
 * cutoff matches the `commitCardChecklist` ancestor walk so a cycle
 * can't deadlock the mutation.
 */
export async function findSportForSelectorOption(
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

/**
 * NEO-90: apply the result of a BSC per-card team lookup
 * (`adapters/buysportscards.ts`'s `resolveBscCardTeam`) to a single
 * cardChecklist row. Idempotent and race-safe: re-checks `teamOnCardIds`
 * is still empty before writing, since a concurrent edit or an earlier
 * queue pass may have already resolved it.
 */
/**
 * NEO-90: read-side half of the BSC per-card team lookup — lives here
 * (not `adapters/buysportscards.ts`, which is a `"use node"` action file
 * and can't define queries) so `resolveBscCardTeam` can check whether a
 * card still needs a lookup before making the HTTP call.
 */
export const getForBscTeamCheck = internalQuery({
  args: { cardChecklistId: v.id("cardChecklist") },
  returns: v.union(
    v.object({
      bscCardId: v.string(),
      needsCheck: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.cardChecklistId);
    if (!row || !row.platformData?.bsc) return null;
    const needsCheck =
      (!row.teamOnCardIds || row.teamOnCardIds.length === 0) &&
      !row.teamCheckDoneAt;
    return { bscCardId: row.platformData.bsc, needsCheck };
  },
});

export const applyBscTeamResolution = internalMutation({
  args: {
    cardChecklistId: v.id("cardChecklist"),
    /** Empty string means BSC's card-listing endpoint had no team on file. */
    teamName: v.string(),
  },
  returns: v.object({
    applied: v.boolean(),
    teamCreated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.cardChecklistId);
    if (!row) return { applied: false, teamCreated: false };

    if (row.teamOnCardIds && row.teamOnCardIds.length > 0) {
      if (!row.teamCheckDoneAt) {
        await ctx.db.patch(row._id, { teamCheckDoneAt: Date.now() });
      }
      return { applied: false, teamCreated: false };
    }

    const teamName = args.teamName.trim();
    if (!teamName) {
      // No team on file for this card (insert/subset cards like League
      // Leaders) — remember we checked so it's never re-enqueued.
      await ctx.db.patch(row._id, { teamCheckDoneAt: Date.now() });
      return { applied: false, teamCreated: false };
    }

    const sport = await findSportForSelectorOption(ctx, row.selectorOptionId);
    if (!sport) {
      // Same ambiguous case backfillTeamToOnCardIds guards against. Leave
      // teamCheckDoneAt unset so a future retry can still pick this up
      // once the ancestor chain is fixed.
      console.warn(
        `[applyBscTeamResolution] skipping ambiguous row id=${row._id}` +
          ` selectorOptionId=${row.selectorOptionId}`,
      );
      return { applied: false, teamCreated: false };
    }

    const normalized = normalizeTeamName(teamName);
    const existing = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized_and_sport", (q) =>
        q.eq("nameNormalized", normalized).eq("sport", sport),
      )
      .first();

    let teamId: Id<"teams">;
    let teamCreated = false;
    if (existing) {
      teamId = existing._id;
    } else {
      teamId = await ctx.db.insert("teams", {
        name: teamName,
        nameNormalized: normalized,
        sport,
        lastUpdated: Date.now(),
      });
      teamCreated = true;
    }

    await ctx.db.patch(row._id, {
      teamOnCardIds: [teamId],
      teamCheckDoneAt: Date.now(),
      lastUpdated: Date.now(),
    });

    return { applied: true, teamCreated };
  },
});

/**
 * NEO-90: one-shot operator trigger to backfill team data for sets synced
 * BEFORE the BSC per-card enrichment queue existed. No index exists for
 * "has platformData.bsc, missing teamOnCardIds AND teamCheckDoneAt", so this
 * pages through the table with a real cursor and filters in JS per page.
 *
 * MUST use a cursor (not a blind `.take(N)` re-scanned from the top every
 * call) — this table keeps growing from ongoing syncs, and a fixed "first N"
 * window's boundary can land in the middle of a single batch insert (a
 * commitCardChecklist call inserts many rows with near-identical
 * `_creationTime`s), permanently stranding whichever rows fall just past the
 * cutoff no matter how many times the migration reruns. Confirmed this
 * exact failure mode in practice: 47 of 335 cards in one set sat right at a
 * `.take(1000)` boundary and were unreachable by any rerun until this fix.
 * Operator reruns passing the returned `continueCursor` until `isDone`.
 *
 * IMPORTANT — do not rerun before the previous call's queue has drained.
 * Enqueued cards only stop looking "eligible" once `processBscTeamEnrichmentQueue`
 * actually resolves them (one every BSC_TEAM_ENRICH_DELAY_MS, serially), which
 * takes `enqueued * BSC_TEAM_ENRICH_DELAY_MS` in the best case. Rerunning
 * sooner re-scans the same still-pending rows and schedules a second,
 * overlapping queue for them — harmless (each resolve is idempotent and a
 * duplicate just no-ops once the other chain gets there first) but wastes a
 * real live HTTP call to BSC per duplicate. `estimatedDrainMs` below is that
 * lower bound — wait at least that long before calling again.
 */
export const enqueueBscTeamBackfill = internalMutation({
  args: {
    /** Cap on rows enqueued per page. Defaults to 200. */
    batchSize: v.optional(v.number()),
    /** Pagination cursor from a previous call's `continueCursor`. Omit/null to start from the beginning. */
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    enqueued: v.number(),
    /** Eligible rows in THIS page beyond batchSize — bump batchSize if nonzero. */
    remaining: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
    /** Minimum ms to wait before calling this again — see doc comment above. */
    estimatedDrainMs: v.number(),
  }),
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 200;
    const PAGE_SIZE = 1000;
    const page = await ctx.db
      .query("cardChecklist")
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE });

    const candidateIds: Id<"cardChecklist">[] = [];
    let remaining = 0;
    for (const row of page.page) {
      const needsCheck =
        !!row.platformData?.bsc &&
        (!row.teamOnCardIds || row.teamOnCardIds.length === 0) &&
        !row.teamCheckDoneAt;
      if (!needsCheck) continue;
      if (candidateIds.length < batchSize) {
        candidateIds.push(row._id);
      } else {
        remaining += 1;
      }
    }

    if (candidateIds.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.adapters.buysportscards.processBscTeamEnrichmentQueue,
        { cardChecklistIds: candidateIds },
      );
    }

    // Not imported directly — adapters/buysportscards.ts is a "use node"
    // action file and this one isn't; cross-runtime imports of a directive
    // file are unsupported in Convex's bundler. Keep in sync with
    // BSC_TEAM_ENRICH_DELAY_MS there.
    const BSC_TEAM_ENRICH_DELAY_MS = 300;
    return {
      enqueued: candidateIds.length,
      remaining,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      estimatedDrainMs: candidateIds.length * BSC_TEAM_ENRICH_DELAY_MS,
    };
  },
});
