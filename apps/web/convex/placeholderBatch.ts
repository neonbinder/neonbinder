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
  callProcessEntry,
  parsePreprocessErrorCode,
} from "./adapters/preprocess";

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
          await ctx.runMutation(internal.placeholderPipeline.markJobFailed, {
            jobId: args.jobId,
            errorCode: parsePreprocessErrorCode(message) ?? "EXTRACT_REJECTED",
            errorDetail: message.slice(0, 1000),
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
      await ctx.runMutation(internal.placeholderPipeline.markJobFailed, {
        jobId: args.jobId,
        errorCode: "EXTRACT_UNAVAILABLE",
        errorDetail: lastError.slice(0, 1000),
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
 * Process one image. This is the function the workpool enqueues, once per
 * accepted entry.
 *
 * Deliberately has no error handling and no state writes:
 *
 *  - It RETURNS the response body, which the pool delivers to
 *    `onImageComplete` as `result.returnValue`. Recording it here instead
 *    would double-write with the completion hook and lose the retry semantics.
 *  - It lets throws propagate. `NonRetryableError` (400/404 from the adapter)
 *    stops the pool retrying immediately; anything else (429, 5xx, network,
 *    timeout) burns one attempt of the configured ladder. Catching and
 *    returning a `{success:false}` object would read to the pool as success
 *    and silently disable retries for the entire batch.
 *
 * `returns: v.any()` rather than a precise object validator, on purpose: the
 * response shape is owned by the preprocess service, which is being built on
 * the same branch. A strict `v.object` rejects unknown fields, so the first
 * additive field added on the service side would fail every work item in the
 * pool rather than being ignored. The value is narrowed field-by-field where
 * it is actually consumed (`imageFieldsFromResult` in placeholderPipeline.ts),
 * which is the place that can drop a bad field without failing the batch.
 */
export const processEntryWorker = internalAction({
  args: {
    jobId: v.string(),
    userId: v.string(),
    entryIndex: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return callProcessEntry(ctx, {
      jobId: args.jobId,
      userId: args.userId,
      entryIndex: args.entryIndex,
    });
  },
});
