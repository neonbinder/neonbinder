/**
 * The Wikidata workpool instance, its completion backstop, and the enqueue
 * mutations that feed it (NEO-99).
 *
 * Kept in its own module, separate from adapters/wikidata.ts and
 * entityReviewQueue.ts, for the same concrete reason as placeholderPool.ts:
 * this is the only file that touches `components.wikidataPool`, and therefore
 * the only file that cannot be loaded without the generated component types.
 * The lookup body (runEntityReviewLookup) and the backstop math
 * (backstopEntityReviewRowImpl) live elsewhere so the unit tests can drive them
 * without mounting the workpool component, which convex-test cannot register.
 *
 * WHY THIS POOL EXISTS — the "Looking up…" hang (NEO-99):
 * Wikidata documents a hard limit of 5 parallel SPARQL queries per client IP,
 * and Convex Cloud egresses every one of a deployment's outbound requests from
 * a single IP. The review wizard used to pace lookups PER BATCH (a serial chain
 * per fetch), which is not the same thing at all: several review batches
 * draining at once — a fresh 100+ entity set, multiple admin tabs, the 8 E2E
 * runners — each ran their own serial chain and still summed well past 5
 * parallel. Wikidata then throttled the whole IP, a lookup stalled, and (before
 * the fetch timeout) its `await` never returned, so the row was never patched
 * out of `pending` and the wizard sat on "Looking up…" forever.
 *
 * Pinning ONE pool to `maxParallelism: 5` and routing every SPARQL caller
 * through it turns "N batches × their own pacing" into "5 in flight, deployment
 * wide, always" — so we stay under Wikidata's ceiling and it never throttles us.
 */

import { v } from "convex/values";
import { Workpool } from "@convex-dev/workpool";
import type { RunResult } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { backstopEntityReviewRowImpl } from "./entityReviewQueue";
import {
  enrichmentCompletionLogLine,
  type WikidataLookupKind,
} from "../lib/errors/wikidata-unavailable";

/**
 * Wikidata's documented ceiling: 5 parallel queries per client IP. Unlike the
 * preprocess pool's parallelism (which tracks per-environment Cloud Run
 * capacity and is therefore env-driven), this number is a property of Wikidata,
 * not of our infrastructure — it is the same on prod, dev, and every preview —
 * so it is a plain constant. See the file header for why 5, not more.
 */
export const WIKIDATA_MAX_PARALLELISM = 5;

/**
 * NEO-301 — the retry ladder for a work item that could not reach Wikidata.
 *
 * ## What is retried, and what is not
 *
 * Only a THROW is retried, and the four work items throw a retryable error for
 * one reason: the lookup was UNAVAILABLE — a SPARQL call's last attempt timed
 * out, failed on the network, or got a 5xx or a 429 (`WikidataUnavailableError`,
 * lib/errors/wikidata-unavailable.ts; `throwIfUnavailable` in
 * adapters/wikidata.ts). A genuine no-match — a 200 with no binding — returns
 * normally and is final, so a name Wikidata has never heard of costs one
 * lookup, never five. The review lookup's NEO-294 write failure is thrown as a
 * `NonRetryableError`, so it still settles at once. A thrown query or write
 * inside `enrichPlayer` / `enrichTeam` is also retried; those are transient
 * platform failures the same ladder is right for, and the marker guard makes
 * a repeat harmless.
 *
 * Before this the pool had no retries, on the reasoning that a timeout and a
 * miss "mean the same thing" and a re-sync is the natural retry. That was
 * wrong for the rows that matter most: enrichment runs ONCE, at creation
 * (NEO-203), so a player created during a bad minute on query.wikidata.org
 * stayed bare for good — no QID, no career years, no Hall-of-Fame flag — and
 * nothing re-sync does reaches it.
 *
 * ## The ladder (verified against @convex-dev/workpool 0.4.12,
 * src/component/loop.ts `rescheduleJob` and `withJitter`)
 *
 * After the k-th failed attempt the next start is delayed by
 *
 *     initialBackoffMs * base^(k-1) * jitter,   jitter uniform in [0.5, 1.5)
 *
 * so with 30 s / base 2 and 5 attempts the four nominal backoffs are
 * 30 s, 60 s, 120 s, 240 s = 450 s (7.5 min) in total; at the extremes of the
 * jitter the sum is 225 s (3.75 min) to 675 s (11.25 min). A retrying item goes
 * back to the pool's pending queue for its backoff and does NOT hold one of the
 * five slots while it waits, so a degraded endpoint slows the lane only by the
 * attempts themselves.
 *
 *  - Why this long. The measured failures (adapters/wikidata.ts,
 *    `WIKIDATA_FETCH_TIMEOUT_MS`) come in runs: slow answers and 502s cluster
 *    for minutes. Even at the shortest jitter the ladder spans 225 s of
 *    waiting plus five attempts, so an item cannot run out of attempts inside
 *    a degradation shorter than ~4 minutes, and nominally it keeps asking for
 *    7.5 minutes.
 *  - Why not longer. The review wizard shows a row as "Looking up…" for the
 *    whole ladder, and the stale-row cron is measured from row creation
 *    (below). Past ~10 minutes of continuous failure the endpoint is down, and
 *    a bare row plus a `wikidata_*_unavailable` log line is the honest outcome.
 *
 * ## The worst case, against every clock that watches these items
 *
 * One attempt is bounded by the adapter (`WIKIDATA_FETCH_TIMEOUT_MS`):
 * 73 s for a player or league (search + detail, 36.5 s each), 83 s for a team
 * (ESPN's 10 s first). From an item's first start to its final failure:
 *
 *     team:   5 × 83 s + 1.5 × 450 s = 415 + 675 = 1090 s ≈ 18.2 min
 *     player: 5 × 73 s + 1.5 × 450 s = 365 + 675 = 1040 s ≈ 17.3 min
 *
 * plus any wait for a free slot after each backoff.
 *
 *  - Convex's 10-minute action limit applies per ATTEMPT (each is its own
 *    action run): 83 s.
 *  - The workpool's own recovery scan only inspects runs older than 5 min;
 *    no attempt gets near that.
 *  - `ENTITY_REVIEW_STALE_MS` (entityReviewQueue.ts, 30 min, measured from the
 *    row's `_creationTime`, swept every 15 min): an item that starts promptly
 *    gives up by 18.2 min, leaving 11.8 min for queueing. A large batch
 *    draining through a sustained outage CAN queue past that, and the sweep
 *    then ages the row to "error" while a retry is still scheduled. That is
 *    deliberately left alone rather than heartbeated: the early "error" is
 *    self-correcting — a later attempt that gets an answer still writes
 *    "ready" (`applyLookupResult` guards only DECIDED rows), and a later
 *    final failure's backstop no-ops on a row that is no longer pending — and
 *    after 30 minutes of Wikidata failing, "error" is the right thing to show.
 *  - `ENTITY_REVIEW_ABANDONED_MS` (24 h) and the placeholder wedge watchdog
 *    (a different pool) are not in reach.
 *  - A retry after the row was deleted (batch committed or cancelled, player
 *    merged away) reads `null` and returns; after an operator filled the row
 *    in, the creation-only marker guard skips it. Nothing is written by an
 *    unavailable attempt, so neither guard can be tripped by our own retry.
 */
export const WIKIDATA_POOL_RETRY = {
  maxAttempts: 5,
  initialBackoffMs: 30_000,
  base: 2,
} as const;

/**
 * The queue in front of query.wikidata.org. Retries per `WIKIDATA_POOL_RETRY`
 * (NEO-301) — every item on this pool is a Wikidata lookup, so the ladder is
 * the pool default rather than a per-enqueue option someone can forget.
 */
export const wikidataPool = new Workpool(components.wikidataPool, {
  maxParallelism: WIKIDATA_MAX_PARALLELISM,
  retryActionsByDefault: true,
  defaultRetryBehavior: { ...WIKIDATA_POOL_RETRY },
});

/**
 * Runs once per review-row work item after it finally succeeds, fails, or is
 * canceled — the guarantee that a row can NEVER be stranded on `pending`.
 *
 * `runEntityReviewLookup` already resolves the row to "ready"/"error" on its own
 * happy and caught-error paths, so in the common case this finds the row already
 * resolved and no-ops. It earns its place on the residue that path cannot reach
 * from inside itself: an UNCAUGHT throw, an action-level timeout, or a pool
 * cancellation — in every one of those the action never ran its own patch, and
 * this ages the still-`pending` row to "error" instead.
 *
 * SAFE against the workpool's batched-inline `onComplete` (the trap that
 * stranded the NEO-170 placeholder counter): that bug bites a read-modify-write
 * on a SHARED document, because several `onComplete`s can run in ONE
 * transaction and lose all but one update. Here every completion writes its OWN
 * distinct `entityReviewQueue` row keyed by `rowId`, and there is no shared
 * counter — the wizard's "N of M reviewed" is derived by `getBatch` counting
 * rows live, not stored — so batched completions cannot interfere. No per-key
 * serialization is needed, unlike placeholderPipeline's `withJobSettleLock`.
 */
export const onEntityReviewLookupComplete = wikidataPool.defineOnComplete({
  context: v.object({ rowId: v.id("entityReviewQueue") }),
  handler: async (
    ctx: MutationCtx,
    { context, result }: { context: { rowId: Id<"entityReviewQueue"> }; result: RunResult },
  ) => {
    // NEO-301: the workpool calls this only once retries are exhausted (or
    // the item succeeded, or was non-retryable/canceled) — never between
    // attempts — so a row whose lookup was unavailable stays `pending` for
    // the whole ladder and is aged to "error" here only after the last one.
    await backstopEntityReviewRowImpl(ctx, context.rowId, result);
  },
});

/**
 * NEO-301 — completion for a row-ENRICHMENT item (`enrichPlayer` /
 * `enrichTeam` / `enrichLeague`), run once after its final attempt.
 *
 * It writes nothing: an un-enriched row is a valid end state, and there is no
 * status to age. What it adds is the one signal that was missing — after the
 * retry ladder is spent without ever reaching Wikidata, the row is bare and
 * nobody knew. It now logs `wikidata_{player|team|league}_unavailable` with
 * the row's id, the transport reason and the attempt count (never a name), and
 * any other failure as `wikidata_enrichment_failed`. A success logs nothing.
 *
 * No shared document is read or written, so the batched-inline `onComplete`
 * trap (NEO-170, see `onEntityReviewLookupComplete`) cannot bite.
 */
const enrichmentKindValidator = v.union(
  v.literal("player"),
  v.literal("team"),
  v.literal("league"),
);

export const onEnrichmentLookupComplete = wikidataPool.defineOnComplete({
  context: v.object({ kind: enrichmentKindValidator, id: v.string() }),
  handler: async (
    _ctx: MutationCtx,
    {
      context,
      result,
    }: { context: { kind: WikidataLookupKind; id: string }; result: RunResult },
  ) => {
    const line = enrichmentCompletionLogLine(
      context,
      result,
      WIKIDATA_POOL_RETRY.maxAttempts,
    );
    if (line) console.warn(JSON.stringify(line));
  },
});

/**
 * How many rows one enqueue mutation enqueues before self-scheduling the rest.
 *
 * A first-time real-set sync can surface 100s of unknown names, and each
 * `enqueueAction` is a few writes into the pool's own tables — so enqueuing all
 * of them in the single mutation `startBatch` scheduled would build a
 * transaction that grows with the batch. Chunking keeps each enqueue mutation a
 * fixed size regardless of batch size; the pool caps concurrency at 5 anyway, so
 * enqueuing faster than this would buy nothing. Mirrors placeholderPipeline's
 * ENQUEUE_CHUNK_SIZE reasoning.
 */
export const WIKIDATA_ENQUEUE_CHUNK_SIZE = 25;

/**
 * Enqueue one chunk of a review batch's pending rows onto the pool, then
 * self-schedule for the remainder. Scheduled (not called inline) by
 * `startBatch`, so the mutation the user's fetch is waiting on stays small and
 * the enqueuing happens in the background — the same split as
 * `startPlaceholderBatch` → `enqueueImageChunk`.
 *
 * `rowIds` is re-passed to each chunk rather than re-queried: `startBatch` just
 * inserted these ids, and the list is bounded by the batch size. A row that a
 * concurrent Cancel deleted between scheduling and here is enqueued harmlessly —
 * `runEntityReviewLookup` no-ops on a missing row and the completion backstop
 * finds nothing to age.
 */
export const enqueueEntityReviewLookups = internalMutation({
  args: {
    rowIds: v.array(v.id("entityReviewQueue")),
    from: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const from = args.from ?? 0;
    const chunk = args.rowIds.slice(from, from + WIKIDATA_ENQUEUE_CHUNK_SIZE);

    for (const rowId of chunk) {
      await wikidataPool.enqueueAction(
        ctx,
        internal.adapters.wikidata.runEntityReviewLookup,
        { rowId },
        {
          onComplete: internal.wikidataPool.onEntityReviewLookupComplete,
          context: { rowId },
        },
      );
    }

    const nextFrom = from + WIKIDATA_ENQUEUE_CHUNK_SIZE;
    if (nextFrom < args.rowIds.length) {
      await ctx.scheduler.runAfter(0, internal.wikidataPool.enqueueEntityReviewLookups, {
        rowIds: args.rowIds,
        from: nextFrom,
      });
    }
    return null;
  },
});

/**
 * Enqueue id-based enrichment (post-creation `enrichPlayer` / `enrichTeam`)
 * onto the SAME 5-wide lane, so this path shares Wikidata's IP budget with the
 * review-wizard drain instead of competing with it.
 *
 * ## CONTRACT (NEO-203): pass ONLY ids you just inserted
 *
 * Jason, 2026-09-02: "the enrichment writes should only fire if the team is
 * new. We should never be firing that on an update. Team data generally
 * doesn't change." And, for players: "if the player is already known we should
 * not try to look up the data again."
 *
 * So every automatic caller of this mutation must pass ids for rows created in
 * the SAME operation — which each of them knows at insert time, and none of
 * them has to go looking up.
 *
 * A row that already exists must never be enqueued here. Passing one is not a
 * silent no-op — `enrichPlayer`/`enrichTeam` carry a structural guard that
 * skips and logs — but the guard is a belt, not the contract. Do not lean on it.
 *
 * ## AND `teamIds` HAS NO AUTOMATIC CALLER AT ALL (NEO-254)
 *
 * Players and leagues still enqueue themselves at creation. Teams do not, and
 * the difference is not an oversight to be tidied up. Jason, 2026-09-10: "we
 * do not need to enrich anymore on team creation because all major teams are
 * created already; if at some point there is a rare case of needing to create
 * a team it will need to be manual."
 *
 * `enrichTeam` is also the expensive one: it finishes in
 * `teamColorSources.resolveTeamColors`, a live ~1.5MB read of
 * teamcolorcodes.com's sitemap whose own module header forbids "a loop, a
 * background queue, or a render path". Enqueued per created team it was
 * exactly that — and it shares THIS 5-wide lane with the review wizard's
 * lookups, so a checklist commit's worth of new teams starved the lookups the
 * operator was waiting on and the wizard sat on "N still looking up".
 *
 * `teamIds` therefore exists today for one caller: `teams.enrichFromWikidata`,
 * with `force`. Adding an automatic one puts that bulk loop back.
 *
 * `force` is the ONE sanctioned exception to the creation-only rule and
 * belongs to human-initiated re-enrichment only:
 * `teams.enrichFromWikidata` / `players.enrichFromWikidata`, the admin-gated
 * operator remedy for a wrong franchise or a bad match. No automatic path may
 * set it.
 *
 * NEO-301 — retried, and completed with a LOG, not a write. An un-enriched
 * row is still a valid end state (a genuine miss is final and never retried),
 * but "Wikidata could not be asked" no longer ends there: the work item throws,
 * the pool's ladder (`WIKIDATA_POOL_RETRY`) asks again, and
 * `onEnrichmentLookupComplete` logs `wikidata_{kind}_unavailable` if the last
 * attempt still could not. Before this there was no `onComplete` here and no
 * retry, so a creation during a bad minute left the row bare with no trace.
 * The retry never re-enqueues, so the creation-only contract above is
 * untouched: it is the same work item, for the same just-created id.
 *
 * Players before teams so a card render gets HoF/career-team flags first, same
 * ordering intent the removed `processEnrichmentQueue` had.
 */
export const enqueueEnrichment = internalMutation({
  args: {
    playerIds: v.optional(v.array(v.id("players"))),
    teamIds: v.optional(v.array(v.id("teams"))),
    /**
     * NEO-240: leagues share this lane for the same reason teams do — every
     * SPARQL caller in the deployment spends ONE 5-wide budget, and a league
     * lookup that opened its own would put the shared IP back over Wikidata's
     * ceiling. The same creation-only contract above applies unchanged.
     */
    leagueIds: v.optional(v.array(v.id("leagues"))),
    /** Operator re-enrichment only — see the contract note above. */
    force: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    for (const playerId of args.playerIds ?? []) {
      await wikidataPool.enqueueAction(
        ctx,
        internal.adapters.wikidata.enrichPlayer,
        { playerId, force: args.force },
        {
          onComplete: internal.wikidataPool.onEnrichmentLookupComplete,
          context: { kind: "player", id: playerId },
        },
      );
    }
    for (const teamId of args.teamIds ?? []) {
      await wikidataPool.enqueueAction(
        ctx,
        internal.adapters.wikidata.enrichTeam,
        { teamId, force: args.force },
        {
          onComplete: internal.wikidataPool.onEnrichmentLookupComplete,
          context: { kind: "team", id: teamId },
        },
      );
    }
    // Leagues last: a card render needs the player's HoF/career-team flags
    // first and the team's colours second, and a league's abbreviation and
    // span are context an operator reads on the admin page rather than
    // anything a collector-facing screen blocks on.
    for (const leagueId of args.leagueIds ?? []) {
      await wikidataPool.enqueueAction(
        ctx,
        internal.adapters.wikidata.enrichLeague,
        { leagueId, force: args.force },
        {
          onComplete: internal.wikidataPool.onEnrichmentLookupComplete,
          context: { kind: "league", id: leagueId },
        },
      );
    }
    return null;
  },
});
