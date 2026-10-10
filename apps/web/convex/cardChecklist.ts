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
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireAdmin } from "./auth";
// NEO-236: these two paths LOOK UP a team and link it; neither may create one.
// See `convex/lib/teamRow.ts` and the notes on each handler below.
import { resolveTeamForSetYear } from "./lib/teamRow";
import { findSetYearForSelectorOption } from "./lib/selectorAncestry";
import { teamFullName } from "../lib/teams/team-name";
// NEO-335: the wizard's pre-save team suggestions (`teamSuggestionsForPreview`).
import { ConvexError } from "convex/values";
import { sameNamePlayers } from "./players";
// Called inside the handler only; `cardPlayerLinks.ts` imports this module
// back (for `findSportForSelectorOption`), which is safe for the same reason.
import { recentCardIdsForPlayer } from "./cardPlayerLinks";
import { normalizeEntityName } from "../lib/entities/normalize-name";
import {
  suggestTeamsForPlayer,
  type SuggestionCard,
  type TeamSuggestionTier,
} from "./lib/teamFill";

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
    /**
     * NEO-254 — the set year per selectorOption, walked once.
     *
     * The narrowing needs it per ROW, and this loop runs over a batch whose
     * rows share a handful of sets; the walk is several `ctx.db.get`s, so
     * repeating it per row would spend the mutation's read budget re-deriving
     * one number. `undefined` is a real answer (an orphaned subtree) and is
     * cached as such, so a miss is not re-walked either.
     */
    const setYearCache = new Map<string, number | undefined>();
    const setYearFor = async (
      selectorOptionId: Id<"selectorOptions">,
    ): Promise<number | undefined> => {
      const key = selectorOptionId as string;
      if (!setYearCache.has(key)) {
        setYearCache.set(
          key,
          await findSetYearForSelectorOption(ctx, selectorOptionId),
        );
      }
      return setYearCache.get(key);
    };
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
      //
      // NEO-254: narrowed by the SET'S year, because a name can now belong to
      // several eras — a 1985 "Winnipeg Jets" card and a 2015 one are
      // different franchises. The year is walked once per selectorOption and
      // memoised across the batch: it is a property of the set, and this loop
      // runs over hundreds of rows that share a handful of sets.
      const setYear = await setYearFor(row.selectorOptionId);
      const { teamId: resolvedTeamId } = await resolveTeamForSetYear(
        ctx,
        sportId,
        teamString,
        setYear,
        // NEO-307: a SET year — a card can show a team's past.
        { allowPastEra: true },
      );

      if (!resolvedTeamId) {
        // NEO-236: no match, so no link — and NOT an insert. Deliberately
        // leaves `team` set as well: the string is the only record of what the
        // marketplace claimed, and clearing it would destroy the evidence an
        // operator needs to create the right team. The row simply stays
        // unmigrated and a later pass will link it once the team exists.
        // NEO-254: this now also covers "several eras and the year did not
        // separate them", which lands in the same place for the same reason —
        // the string is kept, nothing is linked, and an operator decides.
        unmatched += 1;
        processed += 1;
        continue;
      }
      const teamId: Id<"teams"> = resolvedTeamId;

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

/**
 * NEO-236 — bound on the marketplace string kept in `cardChecklist.bscTeamName`.
 *
 * The same 120 as `teams.MAX_TEAM_NAME_LENGTH`, and for the same reason: this
 * is what an operator would copy into the create form, so anything a team name
 * could not be is not worth keeping. Truncated rather than refused — unlike a
 * stored team name this is only a hint, and dropping the whole hint because it
 * was long helps nobody. Duplicated rather than imported to keep this module
 * off `teams.ts`'s import graph, which is what let the NEO-236 rewrite take
 * the team lookup out of here cleanly.
 *
 * NEO-335: exported so the commit, which now stamps the same hint for a card
 * whose fetch-time lookup answered, caps it at the same length.
 */
export const MAX_BSC_TEAM_NAME_LENGTH = 120;

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
    //
    // NEO-254: narrowed by the set's year — the name may name several eras,
    // and BSC's string carries none of that.
    const { teamId: resolvedTeamId } = await resolveTeamForSetYear(
      ctx,
      sportId,
      teamName,
      await findSetYearForSelectorOption(ctx, row.selectorOptionId),
      // NEO-307: a SET year — a card can show a team's past.
      { allowPastEra: true },
    );

    if (!resolvedTeamId) {
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
      //
      // BSC's string is KEPT on the row as `bscTeamName`. Discarding it left
      // the operator staring at a card with no team and no clue which team it
      // was meant to be — the marketplace had the answer and we threw it away
      // on the way to not trusting it. `MissingTeamFixer` renders it as
      // "Marketplace says: …" so they can create the right Location + Name.
      //
      // A hint, never a team. It is deliberately NOT written to
      // `pendingTeamNames`, which `features/cardAttention.ts` reads as the
      // card HAVING a team — that would take the card out of the very lane
      // this branch exists to leave it in. Capped at the same length a stored
      // team name is capped at: this is a third party's string reaching an
      // admin screen, and nothing downstream should have to bound it again.
      await ctx.db.patch(row._id, {
        teamCheckDoneAt: Date.now(),
        bscTeamName: teamName.slice(0, MAX_BSC_TEAM_NAME_LENGTH),
      });
      return { applied: false, unmatched: true };
    }

    await ctx.db.patch(row._id, {
      teamOnCardIds: [resolvedTeamId],
      teamCheckDoneAt: Date.now(),
      // A matched card has a real team now, so the hint has nothing left to
      // say — and a stale "Marketplace says: …" beside a resolved team reads
      // as a disagreement rather than as history.
      bscTeamName: undefined,
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
 * ## The year filter, and when it lets go
 *
 * `players.teamYears` is a whole career (Wikidata P54 with P580/P582
 * qualifiers). For a 2024 set the useful answer is "who was he playing for in
 * 2024", so entries are filtered to `fromYear <= year <= (toYear ?? this
 * year)` — an open-ended entry is a current team. With no year resolvable
 * (see `findSetYearForSelectorOption`) the whole career is offered rather than
 * nothing.
 *
 * NEO-279: the same fallback applies when the year IS known but the filter
 * finds nothing. A retired player on a modern card — a 1960s Yankee on a 2026
 * "Legends" insert, the whole premise of a legends set — has no stint
 * covering the set year, and the filtered list came back empty, so the fixer
 * showed zero chips for a card whose answer was one lookup away. The career
 * is then offered whole, still deduped by team and attributed to the first
 * player naming it. Still suggestions: a chip the operator judges, never a
 * fill. The set-level "Fill teams" (`convex/teamFill.ts`) is where a
 * one-team career becomes a write, and only after a preview.
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

    // Players read once, up front, so the career fallback below re-walks the
    // same rows without a second round of reads. A card can legitimately list
    // the same player twice (a dual-auto of one player); each distinct id once.
    const players: Array<Doc<"players">> = [];
    const seenPlayerIds = new Set<string>();
    for (const playerId of playerIds) {
      if (seenPlayerIds.has(playerId)) continue;
      seenPlayerIds.add(playerId);
      const player = await ctx.db.get(playerId);
      if (!player) continue; // dangling link — soft data error, not fatal
      players.push(player);
    }

    type Suggestion = {
      teamId: Id<"teams">;
      name: string;
      source: "career";
      playerName: string;
    };
    const teamNameById = new Map<string, string | null>();

    const collect = async (
      inYear: (fromYear: number, toYear?: number) => boolean,
    ): Promise<Array<Suggestion>> => {
      const out: Array<Suggestion> = [];
      const seenTeamIds = new Set<string>();
      for (const player of players) {
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
          out.push({ teamId: entry.teamId, name, source: "career", playerName: player.name });
        }
      }
      return out;
    };

    const wholeCareer = () => true;
    if (year === undefined) return collect(wholeCareer);

    const filtered = await collect(
      (fromYear, toYear) => fromYear <= year && year <= (toYear ?? thisYear),
    );
    if (filtered.length > 0) return filtered;
    // Nothing covers the set year: the retired-player case (see "when it lets
    // go" above). Offer the career rather than an empty fixer.
    return collect(wholeCareer);
  },
});

// ===========================================================================
// NEO-335 — team suggestions for the cards a sync is ABOUT to save
// ===========================================================================

/**
 * The most players one `teamSuggestionsForPreview` call answers for.
 *
 * Over-length is REFUSED, not truncated — a short answer would read as "no
 * evidence" for the players it dropped. The wizard asks in slices of this size
 * (one subscription per slice), so it never trips this; a direct call that
 * does gets a count, never the names.
 */
export const TEAM_SUGGESTION_MAX_PLAYERS = 32;

/**
 * How many of one player's card links a call reads, newest first.
 *
 * The stored tiers want the player's cards under at most three nodes of ONE
 * set, but `cardPlayerLinks` can only be asked "this player's cards in this
 * sport", which for a star is every set he appears in. Newest first, because
 * the set being synced — and its base, synced just before it — are the
 * player's most recent cards far more often than not. A player whose evidence
 * sits past this window simply falls through to the career tiers: the bound
 * can cost a suggestion, never produce a wrong one.
 *
 * Per call: 32 players × (24 links + 24 cards + the player + the name lookup)
 * is ~1,700 reads plus the teams it names — inside a query's comfortable
 * budget with the ancestor walk to spare.
 */
export const TEAM_SUGGESTION_LINKS_PER_PLAYER = 24;

/** How many unselected candidates one player may offer. */
export const TEAM_SUGGESTION_MAX_CANDIDATES = 6;

/** A name past this is not a player name; it is not looked up at all. */
const TEAM_SUGGESTION_MAX_NAME_LENGTH = 200;

/** How many of the set's children are read to find its base checklist. */
const TEAM_SUGGESTION_SET_CHILD_SCAN = 64;

const teamSuggestionTierValidator = v.union(
  v.literal("sameNode"),
  v.literal("parallelOf"),
  v.literal("baseSet"),
  v.literal("oneTeamCareer"),
  v.literal("oneStintInYear"),
);

const suggestedTeamValidator = v.object({
  teamId: v.id("teams"),
  /** NEO-236: the FULL name — "Padres" does not say which Padres. */
  name: v.string(),
  /** The team's livery, for the chip. Absent for teams ESPN does not carry. */
  colors: v.optional(
    v.object({
      primary: v.optional(v.string()),
      secondary: v.optional(v.string()),
    }),
  ),
});

type SuggestedTeam = {
  teamId: Id<"teams">;
  name: string;
  colors?: { primary?: string; secondary?: string };
};

type PlayerSuggestionResult = {
  playerId: Id<"players"> | null;
  answer: { tier: TeamSuggestionTier; teams: Array<SuggestedTeam> } | null;
  candidates: Array<SuggestedTeam>;
};

/**
 * NEO-335 — per-player team evidence for the entity review wizard's final
 * step, BEFORE the cards are saved.
 *
 * The wizard holds the confirmed cards in client state; some will save with
 * no team (SportLots never emits one, a BSC blank, a name skipped as "not a
 * team"). For the players on those cards, this answers "is there exactly one
 * team?" from what NB already holds:
 *
 *  - stored rows — the player's own cards under the node being synced, the
 *    node it copies (a parallel), and the set's base checklist;
 *  - the player row — a one-team career, or one stint covering the set year.
 *
 * The tiers, and why an ambiguous stored tier stops the search, are
 * `lib/teamFill.ts`'s. Batch evidence (another card in the same preview) and
 * players CREATED in this wizard are answered in the browser — neither has a
 * row to read yet.
 *
 * Each entry names a player by `playerId` (linked in the wizard) or by `name`
 * (a checklist name that resolved without review). A name is resolved the
 * commit's way for an exactly-one match — `sameNamePlayers` in the set's
 * sport — and anything else is no evidence, never a guess at which of two
 * same-name players is meant. Results come back in input order.
 *
 * Suggestions only: nothing here writes, and nothing reads a marketplace
 * value or name — every key is an NB id or an NB role (`metadata.isBase`).
 */
export const teamSuggestionsForPreview = query({
  args: {
    /** The node the incoming cards will be saved under. */
    selectorOptionId: v.id("selectorOptions"),
    players: v.array(
      v.object({
        playerId: v.optional(v.id("players")),
        name: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({
    /** The year the career tiers compared against, so the browser's own
     *  career answer (players created in the wizard) uses the same one. */
    setYear: v.union(v.number(), v.null()),
    players: v.array(
      v.object({
        playerId: v.union(v.id("players"), v.null()),
        answer: v.union(
          v.null(),
          v.object({
            tier: teamSuggestionTierValidator,
            teams: v.array(suggestedTeamValidator),
          }),
        ),
        candidates: v.array(suggestedTeamValidator),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (args.players.length > TEAM_SUGGESTION_MAX_PLAYERS) {
      throw new ConvexError(
        `Too many players to suggest teams for at once (${args.players.length}; max ${TEAM_SUGGESTION_MAX_PLAYERS}).`,
      );
    }

    const empty = (): PlayerSuggestionResult => ({
      playerId: null,
      answer: null,
      candidates: [],
    });

    const node = await ctx.db.get(args.selectorOptionId);
    if (!node) return { setYear: null, players: args.players.map(empty) };

    // One walk up the chain for the two facts it holds: the sport (the card
    // links are filed under the CARD's sport) and the setName row whose
    // children hold the base checklist.
    let sportId: Id<"selectorOptions"> | undefined;
    let setNameNode: Doc<"selectorOptions"> | null = null;
    {
      let cursor: Doc<"selectorOptions"> | null = node;
      let depth = 0;
      while (cursor && depth < 16) {
        if (cursor.level === "setName" && !setNameNode) setNameNode = cursor;
        if (cursor.level === "sport") {
          sportId = cursor._id;
          break;
        }
        cursor = cursor.parentId ? await ctx.db.get(cursor.parentId) : null;
        depth += 1;
      }
    }
    const setYear = await findSetYearForSelectorOption(ctx, node._id);

    const parallelOfNodeId =
      node.level === "parallel" && node.parentId ? node.parentId : null;

    // The base checklist, by its NB flag — never by the word "Base". Exactly
    // one flagged variantType, or the tier is skipped.
    let baseNodeId: Id<"selectorOptions"> | null = null;
    if (setNameNode) {
      const flagged: Array<Id<"selectorOptions">> = [];
      for (const childId of (setNameNode.children ?? []).slice(
        0,
        TEAM_SUGGESTION_SET_CHILD_SCAN,
      )) {
        const child = await ctx.db.get(childId);
        if (child?.level === "variantType" && child.metadata?.isBase === true) {
          flagged.push(child._id);
        }
      }
      if (flagged.length === 1) baseNodeId = flagged[0];
    }

    const relevantNodes = new Set<string>(
      [node._id, parallelOfNodeId, baseNodeId].filter(
        (id): id is Id<"selectorOptions"> => id !== null,
      ),
    );
    const currentYear = new Date().getFullYear();

    const teamCache = new Map<string, SuggestedTeam | null>();
    const readTeam = async (teamId: Id<"teams">): Promise<SuggestedTeam | null> => {
      if (!teamCache.has(teamId)) {
        const team = await ctx.db.get(teamId);
        // Same sport only: the commit refuses a whole save that names another
        // sport's team (`validateOperatorTeamIds`), so a cross-sport career
        // stint is not something to offer. A dangling id is dropped too.
        teamCache.set(
          teamId,
          team && team.sportId === sportId
            ? {
                teamId,
                name: teamFullName(team),
                ...(team.colors ? { colors: team.colors } : {}),
              }
            : null,
        );
      }
      return teamCache.get(teamId) ?? null;
    };

    const byPlayerId = new Map<string, PlayerSuggestionResult>();
    const answerFor = async (
      playerId: Id<"players">,
      preloaded?: Doc<"players">,
    ): Promise<PlayerSuggestionResult> => {
      const cached = byPlayerId.get(playerId);
      if (cached) return cached;

      const player = preloaded ?? (await ctx.db.get(playerId)) ?? undefined;
      const cards: Array<SuggestionCard> = [];
      if (sportId) {
        const cardIds = await recentCardIdsForPlayer(
          ctx,
          playerId,
          sportId,
          TEAM_SUGGESTION_LINKS_PER_PLAYER,
        );
        for (const cardId of cardIds) {
          const card = await ctx.db.get(cardId);
          if (card && relevantNodes.has(card.selectorOptionId)) cards.push(card);
        }
      }

      const suggestion = suggestTeamsForPlayer({
        playerId,
        player,
        cards,
        nodeId: node._id,
        parallelOfNodeId,
        baseNodeId,
        year: setYear,
        currentYear,
        maxCandidates: TEAM_SUGGESTION_MAX_CANDIDATES,
      });

      let answer: PlayerSuggestionResult["answer"] = null;
      const candidates: Array<SuggestedTeam> = [];
      if (suggestion.answer) {
        const teams: Array<SuggestedTeam> = [];
        for (const teamId of suggestion.answer.teamIds) {
          const team = await readTeam(teamId);
          if (team) teams.push(team);
        }
        // A dangling team in the answer makes it no longer the whole answer;
        // offer what is left to pick from instead of a partial pre-fill.
        if (teams.length === suggestion.answer.teamIds.length) {
          answer = { tier: suggestion.answer.tier, teams };
        } else {
          candidates.push(...teams);
        }
      }
      for (const teamId of suggestion.candidates) {
        const team = await readTeam(teamId);
        if (team) candidates.push(team);
      }
      const result: PlayerSuggestionResult = { playerId, answer, candidates };
      byPlayerId.set(playerId, result);
      return result;
    };

    const players: Array<PlayerSuggestionResult> = [];
    for (const entry of args.players) {
      if (entry.playerId) {
        players.push(await answerFor(entry.playerId));
        continue;
      }
      const trimmed = entry.name?.trim() ?? "";
      if (!sportId || !trimmed || trimmed.length > TEAM_SUGGESTION_MAX_NAME_LENGTH) {
        players.push(empty());
        continue;
      }
      const normalized = normalizeEntityName(trimmed);
      const matches = normalized ? await sameNamePlayers(ctx, normalized, sportId) : [];
      // Exactly one, or no evidence: two same-name players is a question for
      // the operator, and this query does not get to answer it.
      players.push(
        matches.length === 1 ? await answerFor(matches[0]._id, matches[0]) : empty(),
      );
    }

    return { setYear: setYear ?? null, players };
  },
});
