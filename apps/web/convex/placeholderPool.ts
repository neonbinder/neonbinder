/**
 * The FAST preprocess workpool instance and its completion hook (NEO-170; split
 * fast/heavy for NEO-175). This is the queue every image is enqueued onto first;
 * the heavy pool it can escalate to lives in placeholderHeavyPool.ts.
 *
 * Kept in its own module, separate from placeholderPipeline.ts, for one
 * concrete reason: this is the only file that touches
 * `components.fastPreprocessPool`, and therefore the only file that cannot be
 * loaded without the generated component types. Everything the unit tests
 * exercise lives in placeholderPipeline.ts and can be reached without
 * mounting the component (convex-test cannot register the workpool's nested
 * batch-worker component, so mounting it is not an option).
 */

import { v } from "convex/values";
import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { PREPROCESS_MAX_PARALLELISM } from "./preprocessCapacity";
import { recordImageOutcomeImpl } from "./placeholderPipeline";

/**
 * The queue in front of the FAST preprocess Cloud Run service.
 *
 * `maxParallelism` is pinned to the FAST service's Cloud Run instance ceiling
 * FOR THIS ENVIRONMENT. It is resolved from the deployment's
 * `PREPROCESS_MAX_PARALLELISM` variable at module load and read here when the
 * pool is constructed, so a deployment picks up its own capacity without a code
 * change. See convex/preprocessCapacity.ts for why this stopped being a
 * compiled-in constant, why the two numbers must be equal WITHIN an environment,
 * and what breaks (quietly) in each direction when they are not.
 *
 * `retryActionsByDefault: true` is safe here specifically because the enqueued
 * action is idempotent: `/process-entry` re-derives its input from the job id
 * and writes its output to a write-once GCS path, so running it twice produces
 * the same object. A fast decline (`needs_escalation: true`) is likewise
 * deterministic and side-effect-free, so a retried fast call re-declines rather
 * than double-escalating. The workpool README is explicit that this flag should
 * only be set for idempotent actions, and that is the reason it qualifies.
 *
 * The retry budget (5 attempts, 5s initial backoff, doubling: 5s → 10s → 20s →
 * 40s) is sized against the failure it exists for — a Cloud Run cold start.
 * (The fast service cold-starts in seconds, but the budget is harmless when
 * unused and terminal errors never consume any of it — the adapter throws
 * NonRetryableError for those, which stops the pool immediately.)
 */
export const fastPreprocessPool = new Workpool(components.fastPreprocessPool, {
  maxParallelism: PREPROCESS_MAX_PARALLELISM,
  retryActionsByDefault: true,
  defaultRetryBehavior: {
    maxAttempts: 5,
    initialBackoffMs: 5000,
    base: 2,
  },
});

/**
 * Runs once per work item, after it finally succeeds, fails, or is canceled —
 * NOT once per attempt. That is what makes it safe to use as the counter
 * increment: a retried image contributes exactly 1 to the totals, no matter how
 * many times it was tried.
 *
 * A canceled item flows through here too, which is why
 * `cancelPlaceholderBatch` does not have to touch the counters itself: every
 * enqueued image is accounted for exactly once regardless of how its work ended.
 *
 * The body is a one-line delegation on purpose. `recordImageOutcomeImpl` is a
 * plain exported function rather than a registered mutation so the tests can
 * drive the whole completion path — counter math, the last-one-done transition,
 * the failure branches — through `t.run(...)` without the workpool component
 * being mounted.
 */
export const onImageComplete = fastPreprocessPool.defineOnComplete({
  context: v.object({
    jobId: v.string(),
    imageId: v.id("placeholderImages"),
  }),
  handler: async (ctx: MutationCtx, { context, result }) => {
    // `recordImageOutcomeImpl` reads `needs_escalation` off the result: a fast
    // completion that declined routes the image to the heavy pool from inside
    // the settle rather than settling it here. Both pools' onComplete share this
    // one function, so the per-job settle lock serializes fast and heavy
    // completions of the same job (and OCC serializes the two pools' separate
    // transactions).
    await recordImageOutcomeImpl(ctx, context, result);
  },
});
