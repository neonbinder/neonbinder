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

import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireAdmin } from "./auth";
// NEO-236: these two paths LOOK UP a team and link it; neither may create one.
// See `convex/lib/teamRow.ts` and the notes on each handler below.
import { findTeamByFullName } from "./lib/teamRow";
import { teamFullName } from "../lib/teams/team-name";

/**
 * Walk up the parent chain from a cardChecklist's selectorOption to
 * find the ancestor `level === "sport"` row's value. Returns
 * undefined when the chain doesn't include a sport row (orphaned data;
 * shouldn't happen in practice but guard anyway). 16-step depth
 * cutoff matches the `commitCardChecklist` ancestor walk so a cycle
 * can't deadlock the mutation.
 */
/**
 * NEO-96: returns the sport-level ancestor's ROW ID, not its display value.
 * It used to return `node.value` (raw case) while `fetchCardChecklist` returned
 * the same node's value lowercased — two writers, two casings, into the same
 * `teams.sport` string column. Returning the id removes the disagreement by
 * construction.
 */
export async function findSportForSelectorOption(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<any> } },
  selectorOptionId: Id<"selectorOptions">,
): Promise<Id<"selectorOptions"> | undefined> {
  let cursor: Id<"selectorOptions"> | undefined = selectorOptionId;
  let depth = 0;
  while (cursor && depth < 16) {
    const node = await ctx.db.get(cursor);
    if (!node) return undefined;
    if (node.level === "sport") return node._id;
    cursor = node.parentId;
    depth += 1;
  }
  return undefined;
}

export const backfillTeamToOnCardIds = internalMutation({
  args: {
    /**
     * Cap on rows scanned per invocation. Defaults to 100 — a card
     * row patch is one read + one write, plus one indexed team lookup.
     * 100 keeps us far below the 4096-read mutation budget.
     */
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    /** Rows visited this batch (including skips). */
    processed: v.number(),
    /**
     * NEO-236: rows whose legacy `team` string matches no team we hold.
     *
     * This used to be `teamsCreated`, and the rename is the behaviour change:
     * the migration inserted a `teams` row for every unrecognised string a
     * marketplace had ever written onto a card. Creation now takes Location +
     * Name from an operator, and this path has neither, so an unmatched row is
     * LEFT ALONE — both its `team` string and its empty `teamOnCardIds` stay
     * put, so the attention walker's missing-team lane still surfaces it and a
     * rerun after the operator creates the team picks it up.
     *
     * **This changes the operator's exit condition.** The old advice was
     * "rerun until `processed === 0`", which assumed every row could be
     * migrated. An unmatched row stays eligible forever by design, so a run
     * whose `processed === unmatched` has done everything it can — anything
     * further needs the teams to exist first.
     */
    unmatched: v.number(),
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
    let unmatched = 0;
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

      const sportId = await findSportForSelectorOption(
        ctx,
        row.selectorOptionId,
      );
      if (!sportId) {
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

      // NEO-236: the shared identity lookup (`by_name_normalized_and_sport_id`
      // keyed on the composed full name), so a legacy string still resolves
      // onto a row that has since been split into location + nickname. One
      // indexed read per team string.
      const existing = await findTeamByFullName(ctx, sportId, teamString);

      if (!existing) {
        // NEO-236: no match, so no link — and NOT an insert. Deliberately
        // leaves `team` set as well: the string is the only record of what the
        // marketplace claimed, and clearing it would destroy the evidence an
        // operator needs to create the right team. The row simply stays
        // unmigrated and a later pass will link it once the team exists.
        unmatched += 1;
        processed += 1;
        continue;
      }
      const teamId: Id<"teams"> = existing._id;

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
      unmatched,
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
      !row.teamCheckDoneAt &&
      // NEO-102: an operator already settled this card as carrying no team.
      // "Empty teams" is no longer the same statement as "not looked up yet",
      // and every path that used to treat them as one has to say which it
      // means. Spending a live BSC request to re-derive an answer a human
      // already gave is the cheapest half of the problem; the expensive half
      // is `applyBscTeamResolution` then writing a team over that answer.
      !row.teamNoneConfirmedAt;
    // NEO-137: platformData.bsc is now {ref, src}; the BSC card id is the ref.
    return { bscCardId: row.platformData.bsc.ref, needsCheck };
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
    /**
     * NEO-236: BSC named a team we do not hold, so nothing was linked.
     *
     * Replaces `teamCreated`. This path used to insert a `teams` row from
     * whatever string BSC's per-card endpoint returned — a globally-shared row
     * created by a background queue, from a marketplace string, with no
     * operator in the loop. Creation takes Location + Name now, and a queue
     * has neither, so a miss leaves the card teamless for the attention
     * walker's missing-team lane to surface.
     */
    unmatched: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.cardChecklistId);
    if (!row) return { applied: false, unmatched: false };

    // NEO-102: an operator confirmed this card carries no team. A background
    // writer must never overturn that.
    //
    // Checked HERE, inside the writing mutation, on a fresh read — not at
    // enqueue time — for the same reason the `teamOnCardIds` check below is:
    // the confirmation can land while this lookup is in flight (the queue
    // walks a whole set at one request every 300ms, and the operator is
    // working the same checklist at the same time). An enqueue-time filter
    // would be checked minutes earlier and would be exactly the race.
    //
    // Stamps `teamCheckDoneAt` on the way out, mirroring the early return
    // below: the lookup HAS now been and gone for this card, and stamping it
    // also takes the row out of `enqueueBscTeamBackfill`'s scan.
    if (row.teamNoneConfirmedAt) {
      if (!row.teamCheckDoneAt) {
        await ctx.db.patch(row._id, { teamCheckDoneAt: Date.now() });
      }
      return { applied: false, unmatched: false };
    }

    if (row.teamOnCardIds && row.teamOnCardIds.length > 0) {
      if (!row.teamCheckDoneAt) {
        await ctx.db.patch(row._id, { teamCheckDoneAt: Date.now() });
      }
      return { applied: false, unmatched: false };
    }

    const teamName = args.teamName.trim();
    if (!teamName) {
      // No team on file for this card (insert/subset cards like League
      // Leaders) — remember we checked so it's never re-enqueued.
      await ctx.db.patch(row._id, { teamCheckDoneAt: Date.now() });
      return { applied: false, unmatched: false };
    }

    const sportId = await findSportForSelectorOption(ctx, row.selectorOptionId);
    if (!sportId) {
      // Same ambiguous case backfillTeamToOnCardIds guards against. Leave
      // teamCheckDoneAt unset so a future retry can still pick this up
      // once the ancestor chain is fixed.
      console.warn(
        `[applyBscTeamResolution] skipping ambiguous row id=${row._id}` +
          ` selectorOptionId=${row.selectorOptionId}`,
      );
      return { applied: false, unmatched: false };
    }

    // NEO-236: the shared identity lookup on BSC's full team string, so a row
    // already split into location + nickname still matches.
    const existing = await findTeamByFullName(ctx, sportId, teamName);

    if (!existing) {
      // NEO-236: link-or-leave. No insert, and no team on the card.
      //
      // `teamCheckDoneAt` is still STAMPED, and that is deliberate rather than
      // an oversight. It records "the BSC lookup has been and gone for this
      // card", which is true — the answer came back, we simply have no team to
      // point at. Leaving it unset would put the row straight back into
      // `enqueueBscTeamBackfill`'s scan and spend a live BSC request per pass
      // to re-learn the same string, forever. Contrast the `!sportId` branch
      // above, which leaves it unset precisely because that IS a retryable
      // condition (a broken ancestor chain an operator can fix).
      //
      // The card is not lost: an empty `teamOnCardIds` with no
      // `teamNoneConfirmedAt` is exactly what the attention walker's
      // missing-team lane looks for, and the operator resolves it there.
      await ctx.db.patch(row._id, { teamCheckDoneAt: Date.now() });
      return { applied: false, unmatched: true };
    }

    await ctx.db.patch(row._id, {
      teamOnCardIds: [existing._id],
      teamCheckDoneAt: Date.now(),
      lastUpdated: Date.now(),
    });

    return { applied: true, unmatched: false };
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
        !row.teamCheckDoneAt &&
        // NEO-102: never re-derive a team for a card an operator settled as
        // teamless. `applyBscTeamResolution` re-checks this too, so a row
        // enqueued before the confirmation still cannot be overwritten — this
        // clause is what stops the pointless live BSC request.
        !row.teamNoneConfirmedAt;
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

// ===========================================================================
// NEO-102 — reconciling a card that has no team
// ===========================================================================

/**
 * NEO-102 — the YEAR whose rosters a card's team suggestions come from.
 *
 * `features.season` on the card's own selectorOption is the cheap answer and
 * the one every other consumer already trusts (SKU generation and listing-title
 * generation both read it), so it wins and costs a single read. The `year`-level
 * ancestor is the fallback for a row whose feature snapshot predates the
 * `season` key.
 *
 * Returns undefined when neither exists. The caller then offers a player's
 * WHOLE career rather than nothing: a suggestion the operator can reject beats
 * an empty panel, and the operator is the one deciding either way.
 *
 * 16-step cutoff, matching `findSportForSelectorOption` above, so a cycle in
 * the parent chain cannot wedge a reactive query.
 */
async function findSetYearForSelectorOption(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<any> } },
  selectorOptionId: Id<"selectorOptions">,
): Promise<number | undefined> {
  const parseYear = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  };
  const leaf = await ctx.db.get(selectorOptionId);
  if (!leaf) return undefined;
  const fromFeatures = parseYear(leaf.features?.season);
  if (fromFeatures !== undefined) return fromFeatures;
  let cursor: Id<"selectorOptions"> | undefined = leaf.parentId;
  let depth = 0;
  while (cursor && depth < 16) {
    const node = await ctx.db.get(cursor);
    if (!node) return undefined;
    if (node.level === "year") return parseYear(node.value);
    cursor = node.parentId;
    depth += 1;
  }
  return undefined;
}

/**
 * NEO-102 — record that an operator has decided this card carries no team.
 *
 * ## Server-stamped, deliberately
 *
 * The only argument is the card. `teamNoneConfirmedAt` and
 * `teamNoneConfirmedByUserId` are written from `Date.now()` and the
 * `requireAdmin` return value — a timestamp on a client-supplied argument
 * would be operator-review suppression the client can mint for itself, and
 * this flag's whole job is to suppress both the BSC background lookup and the
 * "missing team" badge. Nothing on any client path anywhere in this feature
 * carries a timestamp.
 *
 * ## Refuses on a card that HAS teams
 *
 * Re-read inside the mutation and checked against the row as it stands, not
 * against whatever the client last rendered — the same shape as
 * `applyBscTeamResolution`'s guards. "No team" and "these three teams" cannot
 * both be true, and the operator clicking this on a stale render must not be
 * the way that contradiction gets written. `confirmed: false` is the honest
 * answer, not an error: the card already has the thing the operator was being
 * asked about.
 *
 * ## Idempotent, and does not re-stamp
 *
 * A second call on an already-confirmed card writes nothing and reports
 * `stamped: false`. That is not just tidiness: in Convex, patching a row even
 * with identical data invalidates every query that read it, which re-renders
 * the checklist (see `valuesDeepEqual`'s note in selectorOptions.ts). It also
 * keeps the audit stamp pointing at whoever actually made the call.
 *
 * `lastUpdated` is deliberately NOT touched. This is suppression bookkeeping,
 * not card content — the same treatment `teamCheckDoneAt` gets — and bumping
 * it would invalidate the `baseVersion` of a sync review the operator may have
 * open in another tab, turning an unrelated accepted diff stale.
 */
export const confirmCardNoTeam = mutation({
  args: { cardId: v.id("cardChecklist") },
  returns: v.object({
    /** The row now carries a "no team" confirmation. */
    confirmed: v.boolean(),
    /** THIS call wrote it. False when it was already confirmed, or refused. */
    stamped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx);

    const row = await ctx.db.get(args.cardId);
    if (!row) return { confirmed: false, stamped: false };
    if (row.teamOnCardIds && row.teamOnCardIds.length > 0) {
      return { confirmed: false, stamped: false };
    }
    if (row.teamNoneConfirmedAt) return { confirmed: true, stamped: false };

    await ctx.db.patch(row._id, {
      teamNoneConfirmedAt: Date.now(),
      teamNoneConfirmedByUserId: userId,
    });
    return { confirmed: true, stamped: true };
  },
});

/**
 * NEO-102 — career-team SUGGESTIONS for one card, from the players on it.
 *
 * Suggestions, never auto-fill. The operator accepts one with a keystroke and
 * the write goes through `selectorOptions.updateCard` like any other team edit;
 * nothing here writes anything, and confirming a card's team never writes back
 * to `players.teamYears` (card team and player career are different facts —
 * Mickey Mantle on a modern "Legend" insert is printed with the Yankees, which
 * says nothing new about his career).
 *
 * ## The year filter
 *
 * `players.teamYears` is a whole career (Wikidata P54 with P580/P582
 * qualifiers). For a 2024 set the useful answer is "who was he playing for in
 * 2024", so entries are filtered to `fromYear <= year <= (toYear ?? this
 * year)` — an open-ended entry is a current team. With no year resolvable
 * (see `findSetYearForSelectorOption`) the whole career is offered rather than
 * nothing.
 *
 * ## Deduped by teamId
 *
 * A multi-player card whose players share a team (the common League Leaders
 * case) yields one chip, attributed to the first player that produced it —
 * `playerName` is there so the operator can see WHY a team is being suggested,
 * which is the difference between a suggestion they can judge and a guess.
 *
 * Bounded: one read per distinct `playerId` on the card plus one per distinct
 * team those players name. A dangling player or team link is skipped rather
 * than surfaced as a blank chip.
 */
export const suggestedTeamsForCard = query({
  args: { cardId: v.id("cardChecklist") },
  returns: v.array(
    v.object({
      teamId: v.id("teams"),
      name: v.string(),
      source: v.literal("career"),
      /** Which player on the card this team came from. */
      playerName: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const row = await ctx.db.get(args.cardId);
    if (!row) return [];
    const playerIds = row.playerIds ?? [];
    if (playerIds.length === 0) return [];

    const year = await findSetYearForSelectorOption(ctx, row.selectorOptionId);
    const thisYear = new Date().getFullYear();
    const inYear = (fromYear: number, toYear?: number): boolean =>
      year === undefined
        ? true
        : fromYear <= year && year <= (toYear ?? thisYear);

    const out: Array<{
      teamId: Id<"teams">;
      name: string;
      source: "career";
      playerName: string;
    }> = [];
    const seenTeamIds = new Set<string>();
    const seenPlayerIds = new Set<string>();
    const teamNameById = new Map<string, string | null>();

    for (const playerId of playerIds) {
      // A card can legitimately list the same player twice (a dual-auto of one
      // player); read each distinct id once.
      if (seenPlayerIds.has(playerId)) continue;
      seenPlayerIds.add(playerId);
      const player = await ctx.db.get(playerId);
      if (!player) continue; // dangling link — soft data error, not fatal
      for (const entry of player.teamYears ?? []) {
        if (!inYear(entry.fromYear, entry.toYear)) continue;
        if (seenTeamIds.has(entry.teamId)) continue;
        if (!teamNameById.has(entry.teamId)) {
          const team = await ctx.db.get(entry.teamId);
          // NEO-236: the FULL name. This chip is a suggestion an operator
          // judges at a glance, and "Padres" does not say which Padres.
          teamNameById.set(entry.teamId, team ? teamFullName(team) : null);
        }
        const name = teamNameById.get(entry.teamId);
        if (!name) continue; // never suggest a blank chip
        seenTeamIds.add(entry.teamId);
        out.push({
          teamId: entry.teamId,
          name,
          source: "career",
          playerName: player.name,
        });
      }
    }

    return out;
  },
});
