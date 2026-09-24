/**
 * The HEAVY preprocess workpool, its completion hook, and the escalation enqueue
 * (NEO-175). The fast pool every image starts on lives in placeholderPool.ts;
 * this is the queue in front of the full-BiRefNet-cascade service that the fast
 * path escalates to.
 *
 * Kept in its own module for the same reason as placeholderPool.ts and
 * wikidataPool.ts: this is the only file that touches
 * `components.heavyPreprocessPool`, so it is the only one that cannot be loaded
 * without the generated component types. The settle math it feeds
 * (`recordImageOutcomeImpl`) lives in placeholderPipeline.ts and is driven by
 * the unit tests directly, without mounting the component (convex-test cannot
 * register the workpool's nested batch-worker component).
 *
 * ESCALATION FLOW (see settleImageOutcome in placeholderPipeline.ts):
 *   fast `/process-entry` → onImageComplete → settle sees `needs_escalation` →
 *   marks the row `escalated`, schedules `enqueueHeavyImage` (this file) →
 *   heavy `/process-entry` → onHeavyImageComplete → settle terminates the row.
 *
 * The enqueue is a scheduled step rather than an inline call from settle so the
 * settle path (which the unit tests drive through `recordImageOutcomeImpl`) never
 * touches this component — exactly the split that keeps `enqueueImageChunk`'s
 * pool call out of the settle path too.
 */

import { v } from "convex/values";
import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { HEAVY_MAX_PARALLELISM } from "./preprocessCapacity";
import { findJob, recordImageOutcomeImpl } from "./placeholderPipeline";

/**
 * The queue in front of the HEAVY preprocess Cloud Run service.
 *
 * `maxParallelism` is pinned to the HEAVY service's own instance ceiling — set
 * independently of the fast pool's, because the heavy service is the BiRefNet
 * cold-loader (~180-240s model load, 16 GiB per instance) that only
 * escalations and heavy warm-ups reach. Resolved from
 * `HEAVY_PREPROCESS_MAX_PARALLELISM` at module load; the per-environment values
 * live in convex/preprocessCapacity.json.
 *
 * TWO kinds of work share these slots (NEO-299): escalated images
 * (`enqueueHeavyImage`) and heavy warm-ups (`enqueueHeavyWarmups`). The service
 * runs `container_concurrency = 1`, so a warm-up holding an instance for its
 * whole cold load is exactly as much capacity as an escalation holding it for
 * inference. Routing both through one pool is what keeps the total in flight at
 * or under the instance ceiling; firing warm-ups beside the pool, as the old
 * single-warm-up design did, let warm-ups and escalations together overshoot it
 * and the surplus came back as 429s.
 *
 * RETRY LADDER (verified against @convex-dev/workpool 0.4.12,
 * src/component/loop.ts `rescheduleJob` and `withJitter`): after the k-th
 * failed attempt the next start is delayed by
 *
 *     initialBackoffMs * base^(k-1) * jitter,   jitter uniform in [0.5, 1.5)
 *
 * so with 40s / base 2 the nominal backoffs between the five attempts are
 * 40s, 80s, 160s, 320s (600s nominal in total). A retrying item goes back to the
 * pool's pending queue for its backoff and does NOT hold a slot while it waits.
 *
 *  - Why the ladder is this long. The item that fails fast is a 429 / "no
 *    available instance", which Cloud Run returns while instances are still
 *    cold-loading the model (~180-240s). The old ladder (3 attempts, 5s then
 *    10s) could spend every attempt inside one cold load and fail the photo.
 *    With this ladder, even at the shortest
 *    jitter the four backoffs sum to 0.5 * 600s = 300s, longer than a 240s cold
 *    load, so an image cannot run out of attempts before the instances it was
 *    shed by have finished loading.
 *  - Why 5 attempts rather than more. A heavy attempt is expensive: its budget
 *    is PREPROCESS_HEAVY_TIMEOUT_MS (400s, sized in adapters/preprocess.ts to
 *    clear a cold start + inference), so a cold call succeeds on its FIRST
 *    attempt. The retries are for transients (429/503/network), not cold starts.
 *  - The watchdog. Worst case is five attempts that each run to the 400s
 *    timeout plus the longest jitter on every backoff: 5 * 400s + 1.5 * 600s =
 *    2900s, about 48 minutes, which is MORE than the 30-minute
 *    PLACEHOLDER_WEDGE_STALE_MS. The ladder therefore does not fit inside the
 *    watchdog on its own. What keeps a healthy retrying batch from being healed
 *    as wedged is the heartbeat: `processHeavyEntryWorker` bumps the job's
 *    `lastActivityAt` (placeholderPipeline.ts `touchJobActivity`) every time an
 *    attempt fails retryably, so between bumps a retrying escalation spends at
 *    most one backoff plus one attempt, 1.5 * 320s + 400s = 880s (under 15
 *    minutes), plus any wait for a free slot after its backoff. That wait is
 *    time the pool's other work is running, so it is short unless the heavy
 *    pool is saturated for a long stretch.
 */
export const heavyPreprocessPool = new Workpool(components.heavyPreprocessPool, {
  maxParallelism: HEAVY_MAX_PARALLELISM,
  retryActionsByDefault: true,
  defaultRetryBehavior: {
    maxAttempts: 5,
    initialBackoffMs: 40_000,
    base: 2,
  },
});

/**
 * Runs once per HEAVY work item after it finally succeeds, fails, or is
 * canceled. Delegates to the SAME settle as the fast pool: a heavy result always
 * carries `needs_escalation: false` and the row is already `escalated`, so settle
 * terminates it (marks it done/failed and counts it) rather than re-escalating —
 * the `!image.escalated` guard in settle makes that safe even against a buggy
 * heavy response. Sharing the one settle function is what puts fast and heavy
 * completions of the same job under the same per-job settle lock.
 */
export const onHeavyImageComplete = heavyPreprocessPool.defineOnComplete({
  context: v.object({
    jobId: v.string(),
    imageId: v.id("placeholderImages"),
  }),
  handler: async (ctx: MutationCtx, { context, result }) => {
    await recordImageOutcomeImpl(ctx, context, result);
  },
});

/**
 * Enqueue one escalated image onto the heavy pool. Scheduled by
 * `settleImageOutcome` the moment a fast completion declines an image.
 *
 * Guarded so it is a safe no-op in every race the escalation can lose:
 *  - the row was deleted (a restart swept it) → nothing to enqueue;
 *  - the row is no longer an un-enqueued escalation (`escalated` cleared, already
 *    given a heavy `workId`, or moved out of "processing") → a duplicate schedule
 *    or a stale one, skip;
 *  - the job is no longer draining work ("processing"/"collecting") → a cancel
 *    forced it terminal between the settle and here, so honour the cancel and do
 *    NOT create more paid heavy work behind its back.
 *
 * The warm-gate is NOT fired here — `settleImageOutcome` already scheduled the
 * heavy warm-up fan-out on the first escalation of the batch, so this only
 * places work.
 */
export const enqueueHeavyImage = internalMutation({
  args: { imageId: v.id("placeholderImages") },
  returns: v.object({ enqueued: v.boolean() }),
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) return { enqueued: false };
    if (image.status !== "processing" || image.escalated !== true || image.workId) {
      return { enqueued: false };
    }

    const job = await findJob(ctx, image.jobId);
    // Only while the batch is still consuming work. "processing" is the zip /
    // closed-stream draining state; "collecting" is an open stream that can still
    // escalate. Anything else means the batch is terminal or hasn't started, and
    // enqueuing heavy work would either be undone or resurrect a canceled batch.
    if (!job || (job.status !== "processing" && job.status !== "collecting")) {
      return { enqueued: false };
    }

    const workId = await heavyPreprocessPool.enqueueAction(
      ctx,
      internal.placeholderBatch.processHeavyEntryWorker,
      { jobId: image.jobId, userId: image.userId, entryIndex: image.entryIndex },
      {
        onComplete: internal.placeholderHeavyPool.onHeavyImageComplete,
        context: { jobId: image.jobId, imageId: image._id },
      },
    );
    await ctx.db.patch(image._id, { workId });
    return { enqueued: true };
  },
});

/**
 * Enqueue HEAVY_MAX_PARALLELISM heavy warm-ups onto the heavy pool — one per
 * heavy instance this environment runs (NEO-299: warm to the limit).
 *
 * Called by `warmupPreprocess` (batch start and warm-on-intent) and by
 * `warmupHeavyPreprocess` (the warm-gate on a batch's first escalation), both in
 * placeholderBatch.ts. Through the pool rather than fired directly, so warm-ups
 * and escalations share the same `maxParallelism` slots: the pool never has
 * more heavy requests in flight than there are heavy instances, whichever kind
 * they are, so a warm-up can never be the reason an escalation gets a 429.
 *
 * Why the full width is cheap after the first call. `container_concurrency = 1`
 * means N concurrent warm-ups land on N distinct instances, which is what
 * brings a cold fleet up to its limit. Against a fleet that is already warm, a
 * `/warmup` answers at once, so a second caller's N warm-ups pass through the
 * pool in a few seconds and hold nothing.
 *
 * `retry: false` because a warm-up is best-effort and `callWarmupHeavy` never
 * throws anyway; a retry would only re-send a request whose one useful effect
 * (starting the model load) has already happened. No `onComplete`: nothing
 * reads a warm-up's result, and `warmHeavyWorker` logs it.
 */
export const enqueueHeavyWarmups = internalMutation({
  args: {},
  returns: v.object({ enqueued: v.number() }),
  // Explicit return annotation: the handler references `internal`, whose type
  // includes this function, so leaving it inferred is a circular type.
  handler: async (ctx): Promise<{ enqueued: number }> => {
    const workIds: string[] = await heavyPreprocessPool.enqueueActionBatch(
      ctx,
      internal.placeholderBatch.warmHeavyWorker,
      Array.from({ length: HEAVY_MAX_PARALLELISM }, () => ({})),
      { retry: false },
    );
    return { enqueued: workIds.length };
  },
});
