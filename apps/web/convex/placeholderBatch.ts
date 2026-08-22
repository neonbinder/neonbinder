"use node";

/**
 * The two actions that actually talk to the preprocess service (NEO-170).
 *
 * Split out of placeholderPipeline.ts because they need the Node runtime (the
 * OIDC handshake in convex/lib/cloudRunAuth.ts is google-auth-library, which is
 * Node-only) while the state machine itself runs in the default runtime. The
 * division is exactly: this file makes network calls and returns/records their
 * outcome; it stores no state of its own.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { isNonRetryableError } from "@convex-dev/workpool";
import {
  callExtract,
  callProcessEntryFast,
  callProcessEntryHeavy,
  callWarmupFast,
  callWarmupHeavy,
  parsePreprocessErrorCode,
} from "./adapters/preprocess";
import { PREPROCESS_MAX_PARALLELISM } from "./preprocessCapacity";

/**
 * Extract is retried inline rather than through the workpool.
 *
 * The pool exists to bound FAN-OUT — many simultaneous requests against a
 * service with three instances. Extract is one request per job, so it creates
 * no fan-out to bound, and routing it through the pool would put it behind the
 * image work of any other job that happened to be queued. A short inline retry
 * gets the same transient-failure protection without that head-of-line
 * blocking.
 *
 * Three attempts at 5s / 10s: extract's transient failures are cold starts and
 * deploy-window 503s (EXTRACT_NOT_CONFIGURED), both of which resolve in
 * seconds. A longer ladder would just make a genuinely-down service take
 * longer to report itself.
 */
const EXTRACT_MAX_ATTEMPTS = 3;
const EXTRACT_INITIAL_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the `errorDetail` a job carries into "failed" — WITHOUT the upstream
 * response body.
 *
 * `errorDetail` is returned by `getPlaceholderJob`, a public query, so
 * whatever goes in here is rendered in the owner's browser. The adapter's
 * thrown message deliberately carries up to 400 characters of the raw response
 * so the failure is debuggable from a log line, and that body is not ours: for
 * a shed request or a mid-deploy 503 it is Cloud Run's own HTML error page,
 * and for a service exception it can be a framework traceback. None of that is
 * information a user can act on, and all of it is internal infrastructure
 * detail that a public query has no business emitting.
 *
 * So the detail the JOB stores is reduced to two things a user can act on: a
 * fixed phrase saying which stage gave up, plus the HTTP status if there was
 * one. The machine-readable half is `errorCode`, which is what alerts group
 * on. The full message still reaches `console.warn` — the operator channel,
 * where it belongs.
 */
const HTTP_STATUS_RE = /\bHTTP (\d{3})\b/;

function safeErrorDetail(phrase: string, message: string): string {
  const status = HTTP_STATUS_RE.exec(message)?.[1];
  return status ? `${phrase} (HTTP ${status})` : phrase;
}

/**
 * Unzip the uploaded batch and register the entries it produced.
 *
 * Every exit path is terminal for this action: it either hands the entries to
 * `registerExtractedImages` (job → "processing") or marks the job failed. A
 * job left in "extracting" with nothing scheduled would be a permanently stuck
 * spinner, so there is no path that simply gives up quietly.
 */
export const runExtract = internalAction({
  args: { jobId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let entries: Awaited<ReturnType<typeof callExtract>> | null = null;
    let lastError = "no attempt made";

    for (let attempt = 1; attempt <= EXTRACT_MAX_ATTEMPTS; attempt++) {
      try {
        entries = await callExtract(ctx, { jobId: args.jobId, userId: args.userId });
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isNonRetryableError(err)) {
          // 400 / 404 / 413 / 422 — the upload itself is the problem and will
          // be the same problem next time. Fail the job now rather than
          // spending the retry ladder proving it.
          console.warn(`[runExtract] job=${args.jobId} rejected: ${message}`);
          await ctx.runMutation(internal.placeholderPipeline.markJobFailed, {
            jobId: args.jobId,
            errorCode: parsePreprocessErrorCode(message) ?? "EXTRACT_REJECTED",
            errorDetail: safeErrorDetail("the upload could not be extracted", message),
          });
          return null;
        }
        lastError = message;
        console.warn(
          `[runExtract] job=${args.jobId} attempt ${attempt}/${EXTRACT_MAX_ATTEMPTS} failed: ${message}`,
        );
        if (attempt < EXTRACT_MAX_ATTEMPTS) {
          await sleep(EXTRACT_INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
        }
      }
    }

    if (!entries) {
      console.warn(
        `[runExtract] job=${args.jobId} gave up after ${EXTRACT_MAX_ATTEMPTS} attempts: ${lastError}`,
      );
      await ctx.runMutation(internal.placeholderPipeline.markJobFailed, {
        jobId: args.jobId,
        errorCode: "EXTRACT_UNAVAILABLE",
        errorDetail: safeErrorDetail(
          `extraction did not respond after ${EXTRACT_MAX_ATTEMPTS} attempts`,
          lastError,
        ),
      });
      return null;
    }

    // Only the three fields the pipeline needs cross the boundary. The wire
    // shape also carries content_type / size_bytes / reason, which nothing
    // downstream reads — passing them would put a service-owned shape into a
    // Convex argument validator and make every additive change on the service
    // side a breaking one here.
    await ctx.runMutation(internal.placeholderPipeline.registerExtractedImages, {
      jobId: args.jobId,
      userId: args.userId,
      entries: entries.entries.map((e) => ({
        index: e.index,
        name: e.name,
        accepted: e.accepted,
      })),
    });

    return null;
  },
});

/**
 * Process one image against the FAST service. This is the function the FAST
 * workpool enqueues, once per accepted entry — the first stop for every image.
 *
 * Deliberately has no error handling and no state writes:
 *
 *  - It RETURNS the response body, which the pool delivers to
 *    `onImageComplete` as `result.returnValue`. That body carries the
 *    `needs_escalation` flag the settle reads to decide whether to route the
 *    image to the heavy pool; recording anything here would double-write with
 *    the completion hook and lose the retry semantics.
 *  - It lets throws propagate. `NonRetryableError` (400/404 from the adapter)
 *    stops the pool retrying immediately; anything else (429, 5xx, network,
 *    timeout) burns one attempt of the configured ladder. Catching and
 *    returning a `{success:false}` object would read to the pool as success
 *    and silently disable retries for the entire batch. A `needs_escalation:
 *    true` body is a genuine 200 success (the fast path ran and declined), so
 *    it flows to onComplete unretried, which is correct.
 *
 * `returns: v.any()` rather than a precise object validator, on purpose: the
 * response shape is owned by the preprocess service. A strict `v.object`
 * rejects unknown fields, so the first additive field on the service side would
 * fail every work item in the pool rather than being ignored. The value is
 * narrowed field-by-field where it is actually consumed (`imageFieldsFromResult`
 * and the escalation read in placeholderPipeline.ts), which is the place that
 * can drop a bad field without failing the batch.
 */
export const processEntryWorker = internalAction({
  args: {
    jobId: v.string(),
    userId: v.string(),
    entryIndex: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return callProcessEntryFast(ctx, {
      jobId: args.jobId,
      userId: args.userId,
      entryIndex: args.entryIndex,
    });
  },
});

/**
 * Process one ESCALATED image against the HEAVY service. Enqueued by the HEAVY
 * workpool (`enqueueHeavyImage` in placeholderHeavyPool.ts) after the fast path
 * declined the image. Same no-error-handling / no-state-writes contract as the
 * fast worker; its result always carries `needs_escalation: false`, and the
 * shared settle terminates the row on it.
 */
export const processHeavyEntryWorker = internalAction({
  args: {
    jobId: v.string(),
    userId: v.string(),
    entryIndex: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return callProcessEntryHeavy(ctx, {
      jobId: args.jobId,
      userId: args.userId,
      entryIndex: args.entryIndex,
    });
  },
});

/**
 * Warm the FAST fan-out AND one HEAVY preprocess instance, in the background, at
 * the start of a batch.
 *
 * Scheduled fire-and-forget from `startPlaceholderStream` and
 * `startPlaceholderBatch` (via `ctx.scheduler.runAfter(0, ...)`), so the start
 * mutation returns inside the 7-second UI budget and instances are up WHILE the
 * user uploads or scans. The fast service cold-starts in seconds, so its warm-up
 * is a smaller win, but it is free and keeps the first fast image off even that
 * short cold start.
 *
 * Fires PREPROCESS_MAX_PARALLELISM fast warm-ups CONCURRENTLY to spread across
 * the fast instances Cloud Run will run, plus ONE heavy warm-up.
 *
 * Heavy IS warmed on start now (NEO-175 revision, at the user's request): its
 * ~191s cold load is the dominant latency an escalation pays, and starting it
 * here — rather than only when the first image escalates — overlaps that load
 * with the entire fast phase, so a mid-batch escalation waits far less (often
 * nothing) for the model. The cost is one heavy instance per batch that scales
 * back to zero on idle if nothing escalates. It does NOT suppress the cold-start
 * notice: `heavyWarmStartedAt` is still set on the first escalation
 * (placeholderPipeline.ts), so a batch that escalates before the load finishes
 * shows the notice exactly as before. The on-escalation warm-gate stays as a
 * cheap belt-and-suspenders fallback for the rare batch that skipped this.
 *
 * `callWarmupFast`/`callWarmupHeavy` never throw, so this action cannot fail;
 * `Promise.all` over non-throwing calls is safe.
 */
export const warmupPreprocess = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const requested = PREPROCESS_MAX_PARALLELISM;
    const [fastResults, heavy] = await Promise.all([
      Promise.all(Array.from({ length: requested }, () => callWarmupFast(ctx))),
      callWarmupHeavy(ctx),
    ]);
    const warmed = fastResults.filter((r) => r.warmed).length;
    console.log(
      JSON.stringify({
        msg: "preprocess_warmup",
        requested,
        warmed,
        heavyWarmed: heavy.warmed,
      }),
    );
    return null;
  },
});

/**
 * The HEAVY warm-gate: warm ONE heavy instance, fired the first time a batch
 * escalates an image (scheduled fire-and-forget from `settleImageOutcome`).
 *
 * A single warm-up, NOT the fast fan-out's N-wide burst, and that asymmetry is
 * the whole point (requirement #4): the heavy service cold-loads ~191s, and
 * escalations are a minority of images, so pre-warming all N heavy instances for
 * what may be one escalation would stampede N cold heavy instances. Warming one
 * and letting the heavy pool's `maxParallelism` queue the escalations behind
 * that warming instance is what keeps the heavy footprint proportional to the
 * escalation load. The fast path is never gated on this — fast cards stream in
 * regardless.
 *
 * `callWarmupHeavy` never throws, so this action cannot fail. It runs entirely
 * in the background; the escalations it precedes get the pool's full 4-minute
 * per-request budget, which clears a heavy cold start.
 */
export const warmupHeavyPreprocess = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const result = await callWarmupHeavy(ctx);
    console.log(
      JSON.stringify({ msg: "preprocess_heavy_warmup", warmed: result.warmed }),
    );
    return null;
  },
});
