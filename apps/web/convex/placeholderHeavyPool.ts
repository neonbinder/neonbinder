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
 * independently of the fast pool's, because the heavy service is the ~191s
 * BiRefNet cold-loader only escalations reach, so a deployment runs far fewer of
 * them than fast instances. Resolved from `HEAVY_PREPROCESS_MAX_PARALLELISM` at
 * module load; see convex/preprocessCapacity.ts.
 *
 * Same retry stance as the fast pool: idempotent action (write-once GCS output,
 * re-derived input), 5 attempts across ~75s of cumulative backoff — sized here
 * for the failure it actually exists for, a 191s heavy cold start, so a retry
 * does not abort a request that was about to succeed on a booting instance.
 */
export const heavyPreprocessPool = new Workpool(components.heavyPreprocessPool, {
  maxParallelism: HEAVY_MAX_PARALLELISM,
  retryActionsByDefault: true,
  defaultRetryBehavior: {
    maxAttempts: 5,
    initialBackoffMs: 5000,
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
 * The warm-gate is NOT fired here — `settleImageOutcome` already fired the single
 * heavy `/warmup` on the first escalation of the batch, so this only places work.
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
