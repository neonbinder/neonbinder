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

/**
 * Wikidata's documented ceiling: 5 parallel queries per client IP. Unlike the
 * preprocess pool's parallelism (which tracks per-environment Cloud Run
 * capacity and is therefore env-driven), this number is a property of Wikidata,
 * not of our infrastructure — it is the same on prod, dev, and every preview —
 * so it is a plain constant. See the file header for why 5, not more.
 */
export const WIKIDATA_MAX_PARALLELISM = 5;

/**
 * The queue in front of query.wikidata.org.
 *
 * No retries (the default): a Wikidata miss, a 429, or a timed-out request all
 * mean the same thing to a review row — "no usable Wikidata data" — which the
 * row already represents as `status: "error"` ("No Wikidata match found" in the
 * wizard). Retrying would spend the 5-wide lane re-asking questions whose answer
 * is "not right now" and slow the whole batch, when a later re-sync is the
 * natural retry. This mirrors the old chained queue, which likewise never
 * retried a 429.
 */
export const wikidataPool = new Workpool(components.wikidataPool, {
  maxParallelism: WIKIDATA_MAX_PARALLELISM,
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
    await backstopEntityReviewRowImpl(ctx, context.rowId, result);
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
 * No `onComplete`: unlike a review row, an un-enriched player or team is a
 * perfectly valid end state (the long-standing "a miss is fall-back, not
 * failure" convention in adapters/wikidata.ts) — there is nothing to age, so a
 * completion callback would only add cost. `enrichPlayer`/`enrichTeam` write
 * their own results and are safe to retry-never for the same reason the pool is.
 *
 * Players before teams so a card render gets HoF/career-team flags first, same
 * ordering intent the removed `processEnrichmentQueue` had.
 */
export const enqueueEnrichment = internalMutation({
  args: {
    playerIds: v.optional(v.array(v.id("players"))),
    teamIds: v.optional(v.array(v.id("teams"))),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    for (const playerId of args.playerIds ?? []) {
      await wikidataPool.enqueueAction(
        ctx,
        internal.adapters.wikidata.enrichPlayer,
        { playerId },
      );
    }
    for (const teamId of args.teamIds ?? []) {
      await wikidataPool.enqueueAction(
        ctx,
        internal.adapters.wikidata.enrichTeam,
        { teamId },
      );
    }
    return null;
  },
});
