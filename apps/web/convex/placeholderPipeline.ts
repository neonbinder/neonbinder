/**
 * Placeholder print-sheet batch pipeline — the state machine (NEO-170).
 *
 * Convex owns ALL orchestration here. The preprocess Cloud Run service is
 * stateless: it can unzip an upload and it can process one entry, and it
 * remembers neither afterwards. Which entries exist, which are done, what to
 * retry, how far along the batch is, and what the user is allowed to see are
 * all decided in this file and stored in Convex tables. That split is what
 * lets an 18-image batch survive 429 shedding, cold starts, and cancellation
 * without the service growing a job table of its own.
 *
 * Lifecycle (placeholderJobs.status):
 *
 *   pending/uploaded ──startPlaceholderBatch──▶ extracting
 *          ▲                                        │ runExtract
 *          │                                        ▼
 *       (reset)                              processing ──(all images done)──▶ pairing
 *          │                                        │                              │
 *        failed ◀──────────markJobFailed────────────┴──────────────────────────────┤
 *                                                                                  ▼
 *                                                                             succeeded
 *
 * SECURITY: `jobId` is the only client-supplied handle in this entire module.
 * No function takes `objectPath`, and none ever will — see the placeholderJobs
 * table comment in schema.ts for why that rule is load-bearing rather than
 * stylistic. Every public function resolves the job row from `jobId` and
 * checks `row.userId === identity.subject` before doing anything else.
 */

import { mutation, internalMutation, query, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { RunResult, WorkId } from "@convex-dev/workpool";
import { getCurrentUserId } from "./auth";
import { preprocessPool } from "./placeholderPool";

/**
 * How many images are enqueued per `enqueueImageChunk` invocation.
 *
 * Enqueuing is a write per image (the workpool row) plus a patch per image
 * (storing the workId), so a 500-image zip in a single mutation would be a
 * very large transaction with a correspondingly large chance of an OCC
 * conflict retry. Chunking keeps each transaction small and bounded; the pool
 * caps concurrency anyway, so enqueuing faster would buy nothing.
 */
const ENQUEUE_CHUNK_SIZE = 50;

/** Statuses a batch may be started from. See `startPlaceholderBatch`. */
const STARTABLE_STATUSES = new Set(["pending", "uploaded", "failed"]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a job from its id and confirm the caller owns it.
 *
 * Returns `null` for BOTH "no such job" and "not your job", deliberately: a
 * distinguishable error would turn this function into an existence oracle for
 * other users' job ids. Callers that must fail loudly convert the null into a
 * single, identical error.
 */
async function findOwnedJob(
  ctx: QueryCtx,
  jobId: string,
  userId: string,
): Promise<Doc<"placeholderJobs"> | null> {
  const job = await ctx.db
    .query("placeholderJobs")
    .withIndex("by_job", (q) => q.eq("jobId", jobId))
    .unique();
  if (!job || job.userId !== userId) return null;
  return job;
}

/** The signed-in Clerk subject, or a thrown error. */
async function requireUserId(ctx: QueryCtx): Promise<string> {
  const userId = await getCurrentUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

/** Load a job by id without an ownership check — internal callers only. */
async function findJob(
  ctx: QueryCtx,
  jobId: string,
): Promise<Doc<"placeholderJobs"> | null> {
  return ctx.db
    .query("placeholderJobs")
    .withIndex("by_job", (q) => q.eq("jobId", jobId))
    .unique();
}

// ---------------------------------------------------------------------------
// Public: start / cancel
// ---------------------------------------------------------------------------

/**
 * Start (or restart) the batch for an uploaded placeholder zip.
 *
 * Returns immediately after scheduling the extract step — it does NOT wait for
 * it. Extraction alone can take minutes on a 500MB zip, which is far past the
 * 7-second UI response budget; progress reaches the client reactively through
 * `getPlaceholderJob` / `listPlaceholderImages` instead. A mutation that
 * awaited the pipeline would also hold a transaction open across a network
 * call, which Convex does not allow in the first place.
 *
 * `{started: false, reason}` rather than a throw for a wrong-status job: a
 * second click on Start while a batch is already running is ordinary UI
 * behavior, not an error worth surfacing as a red toast.
 */
export const startPlaceholderBatch = mutation({
  args: { jobId: v.string() },
  returns: v.object({
    started: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) throw new Error("Job not found");

    if (!STARTABLE_STATUSES.has(job.status)) {
      return { started: false, reason: `job is already ${job.status}` };
    }

    // Restarting a failed job is a genuine restart, not a resume: the previous
    // attempt's images and pairs are deleted so counters cannot double-count
    // and pairing cannot see a mix of two runs. Only "failed" needs this —
    // "pending" and "uploaded" precede any image ever being inserted.
    if (job.status === "failed") {
      const staleImages = await ctx.db
        .query("placeholderImages")
        .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
        .collect();
      for (const image of staleImages) {
        await ctx.db.delete(image._id);
      }
      const stalePairs = await ctx.db
        .query("placeholderPairs")
        .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
        .collect();
      for (const pair of stalePairs) {
        await ctx.db.delete(pair._id);
      }
    }

    await ctx.db.patch(job._id, {
      status: "extracting",
      startedAt: Date.now(),
      totalImages: 0,
      processedImages: 0,
      failedImages: 0,
      rejectedEntries: 0,
      // Clear any previous run's terminal fields so the UI never shows a stale
      // error next to a live progress bar.
      errorCode: undefined,
      errorDetail: undefined,
      finishedAt: undefined,
    });

    // `job.userId` — the SERVER's copy, never a client argument. Everything
    // downstream (including the preprocess service's path derivation) keys off
    // this value.
    await ctx.scheduler.runAfter(0, internal.placeholderBatch.runExtract, {
      jobId: args.jobId,
      userId: job.userId,
    });

    return { started: true };
  },
});

/**
 * Cancel an in-flight batch.
 *
 * Cancels the pool work items and stops there. It deliberately does NOT patch
 * the job to a terminal status: a canceled work item still runs the pool's
 * onComplete hook (with `kind: "canceled"`), so the per-image rows and the
 * counters still converge on `processed + failed === total`, and the batch
 * reaches its terminal status through the same code path as any other ending.
 * Short-circuiting the status here would leave the counters permanently
 * mid-flight and the completion transition permanently un-fired.
 *
 * Work already running is allowed to finish — the pool cancels pending work
 * and stops retrying running work rather than killing an in-flight request.
 */
export const cancelPlaceholderBatch = mutation({
  args: { jobId: v.string() },
  returns: v.object({
    canceled: v.boolean(),
    canceledCount: v.number(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) throw new Error("Job not found");

    if (job.status === "succeeded" || job.status === "failed") {
      return { canceled: false, canceledCount: 0, reason: `job is already ${job.status}` };
    }

    const images = await ctx.db
      .query("placeholderImages")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();

    let canceledCount = 0;
    for (const image of images) {
      if (!image.workId) continue;
      if (image.status === "done" || image.status === "failed") continue;
      // `WorkId` is a phantom-branded string; the stored column is a plain
      // string because the brand exists only in TypeScript.
      await preprocessPool.cancel(ctx, image.workId as WorkId);
      canceledCount += 1;
    }

    return { canceled: true, canceledCount };
  },
});

// ---------------------------------------------------------------------------
// Internal: batch registration and fan-out
// ---------------------------------------------------------------------------

/**
 * Record what the extract step found and move the job into "processing".
 *
 * `entries` carries every zip member the service looked at, accepted or not,
 * so the rejected count is derived here rather than trusted as a separate
 * number. Only accepted entries become rows: a rejected entry has no work to
 * do and would otherwise sit in the counters forever, since nothing will ever
 * call onComplete for it.
 */
export const registerExtractedImages = internalMutation({
  args: {
    jobId: v.string(),
    userId: v.string(),
    entries: v.array(
      v.object({
        index: v.number(),
        name: v.string(),
        accepted: v.boolean(),
      }),
    ),
  },
  returns: v.object({ totalImages: v.number(), rejectedEntries: v.number() }),
  handler: async (ctx, args) => {
    const job = await findJob(ctx, args.jobId);
    if (!job) throw new Error("Job not found");
    if (job.userId !== args.userId) {
      // An internal-caller invariant, not a user-facing check: runExtract is
      // handed the userId off the job row it was scheduled from. If these ever
      // disagree, something upstream is passing an attacker-influenced value.
      throw new Error("Job ownership mismatch");
    }

    const accepted = args.entries.filter((e) => e.accepted);
    const rejectedEntries = args.entries.length - accepted.length;

    for (const entry of accepted) {
      await ctx.db.insert("placeholderImages", {
        jobId: args.jobId,
        userId: job.userId,
        index: entry.index,
        originalName: entry.name,
        status: "queued",
      });
    }

    await ctx.db.patch(job._id, {
      status: "processing",
      totalImages: accepted.length,
      processedImages: 0,
      failedImages: 0,
      rejectedEntries,
    });

    if (accepted.length === 0) {
      // Nothing to enqueue means no onComplete will ever fire, so the
      // "last one done" transition can never run. Hand the job straight to
      // pairing, which owns the "zero usable images" terminal decision.
      await ctx.db.patch(job._id, { status: "pairing" });
      await ctx.scheduler.runAfter(0, internal.placeholderPairing.runPairing, {
        jobId: args.jobId,
        userId: job.userId,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.placeholderPipeline.enqueueImageChunk, {
        jobId: args.jobId,
        from: 0,
      });
    }

    return { totalImages: accepted.length, rejectedEntries };
  },
});

/**
 * Enqueue up to ENQUEUE_CHUNK_SIZE queued images onto the pool, then
 * self-schedule for the next chunk.
 *
 * Reads through `by_job_index` starting at `from`, so the walk is an index
 * range scan rather than a full-table filter and each chunk resumes exactly
 * where the last one stopped.
 */
export const enqueueImageChunk = internalMutation({
  args: { jobId: v.string(), from: v.number() },
  returns: v.object({ enqueued: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("placeholderImages")
      .withIndex("by_job_index", (q) => q.eq("jobId", args.jobId).gte("index", args.from))
      .take(ENQUEUE_CHUNK_SIZE);

    let enqueued = 0;
    for (const row of rows) {
      // Anything not "queued" was already enqueued by an earlier chunk (or by
      // a retried invocation of this one). Skipping keeps this mutation safe
      // to re-run, which matters because Convex may retry it on an OCC
      // conflict.
      if (row.status !== "queued") continue;
      const workId = await preprocessPool.enqueueAction(
        ctx,
        internal.placeholderBatch.processEntryWorker,
        { jobId: args.jobId, userId: row.userId, entryIndex: row.index },
        {
          onComplete: internal.placeholderPool.onImageComplete,
          context: { jobId: args.jobId, imageId: row._id },
        },
      );
      await ctx.db.patch(row._id, { workId, status: "processing" });
      enqueued += 1;
    }

    const done = rows.length < ENQUEUE_CHUNK_SIZE;
    if (!done) {
      const last = rows[rows.length - 1];
      await ctx.scheduler.runAfter(0, internal.placeholderPipeline.enqueueImageChunk, {
        jobId: args.jobId,
        from: last.index + 1,
      });
    }

    return { enqueued, done };
  },
});

// ---------------------------------------------------------------------------
// Internal: per-image completion
// ---------------------------------------------------------------------------

/** Narrow an unknown to a non-empty string, or undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Narrow an unknown to a finite number, or undefined. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Narrow an unknown to an array of strings, or undefined. */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string");
  return strings.length === value.length ? strings : undefined;
}

/**
 * A dHash is 16 lowercase hex characters (64 bits). Anything else is dropped
 * rather than stored: pairing's same-side collision check compares hashes by
 * Hamming distance, and a malformed hash would not fail loudly — it would
 * quietly produce meaningless distances and mis-pair cards.
 */
const DHASH_RE = /^[0-9a-f]{16}$/;

function asDhash(value: unknown): string | undefined {
  return typeof value === "string" && DHASH_RE.test(value) ? value : undefined;
}

/**
 * Translate a `/process-entry` response body into a placeholderImages patch.
 *
 * The wire shape is snake_case and arrives through the workpool typed as
 * `any`, so every field is narrowed rather than trusted. Unrecognized or
 * wrongly-typed fields are omitted, which leaves the column undefined — the
 * same state as "not processed yet", which is the honest representation of
 * "the service did not give us a usable value".
 */
function imageFieldsFromResult(returnValue: unknown): Partial<Doc<"placeholderImages">> {
  if (!returnValue || typeof returnValue !== "object") return {};
  const body = returnValue as Record<string, unknown>;
  return {
    players: asStringArray(body.players),
    player: asString(body.player),
    team: asString(body.team),
    cardNumber: asString(body.card_number),
    side: asString(body.side),
    rotationDegrees: asNumber(body.rotation_degrees),
    orientConfidence: asNumber(body.orient_confidence),
    textCount: asNumber(body.text_count),
    croppedSource: asString(body.cropped_source),
    dhash: asDhash(body.dhash),
  };
}

/**
 * Apply one work item's final outcome: patch the image row, advance the job's
 * counters, and — on the invocation that observes the last outstanding image —
 * hand the batch to pairing.
 *
 * Exported as a plain function (a `function` declaration, so the circular
 * import with placeholderPool.ts resolves through hoisting) because this is
 * the seam the unit tests drive. convex-test cannot mount the workpool
 * component, so the tests call this directly via `t.run` instead of going
 * through `onImageComplete`.
 *
 * Idempotent by construction: an image already in a terminal state is ignored,
 * so a duplicated completion cannot double-count. The counters are what decide
 * when the batch is finished, and a batch that never reaches its total never
 * finishes — that is the failure mode worth being paranoid about.
 */
export async function recordImageOutcomeImpl(
  ctx: MutationCtx,
  context: { jobId: string; imageId: Id<"placeholderImages"> },
  result: RunResult,
): Promise<null> {
  const image = await ctx.db.get(context.imageId);
  // The row can legitimately be gone: restarting a failed job deletes the
  // previous run's images while its work may still be draining. Nothing to
  // record, and throwing would make the pool retry a mutation that can never
  // succeed.
  if (!image) return null;
  if (image.status === "done" || image.status === "failed") return null;

  const job = await findJob(ctx, context.jobId);
  if (!job) return null;

  const succeeded = result.kind === "success";

  if (succeeded) {
    await ctx.db.patch(image._id, {
      ...imageFieldsFromResult(result.returnValue),
      status: "done",
    });
  } else {
    await ctx.db.patch(image._id, {
      status: "failed",
      errorCode: result.kind === "canceled" ? "CANCELED" : "PROCESS_ENTRY_FAILED",
      errorDetail:
        result.kind === "failed"
          ? result.error.slice(0, 1000)
          : "canceled before completion",
    });
  }

  const processedImages = (job.processedImages ?? 0) + (succeeded ? 1 : 0);
  const failedImages = (job.failedImages ?? 0) + (succeeded ? 0 : 1);
  await ctx.db.patch(job._id, { processedImages, failedImages });

  const totalImages = job.totalImages ?? 0;
  // Exactly one invocation observes equality — Convex mutations are
  // serializable, so the increment and the comparison are in one transaction
  // and two completions cannot both read the same pre-increment counters.
  if (
    job.status === "processing" &&
    totalImages > 0 &&
    processedImages + failedImages === totalImages
  ) {
    await ctx.db.patch(job._id, { status: "pairing" });
    await ctx.scheduler.runAfter(0, internal.placeholderPairing.runPairing, {
      jobId: context.jobId,
      userId: job.userId,
    });
  }

  return null;
}

/**
 * Registered wrapper around `recordImageOutcomeImpl`, so the completion path is
 * reachable as a Convex function (and from `t.mutation`) as well as directly.
 */
export const recordImageOutcome = internalMutation({
  args: {
    jobId: v.string(),
    imageId: v.id("placeholderImages"),
    result: v.union(
      v.object({ kind: v.literal("success"), returnValue: v.any() }),
      v.object({ kind: v.literal("failed"), error: v.string() }),
      v.object({ kind: v.literal("canceled") }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    return recordImageOutcomeImpl(
      ctx,
      { jobId: args.jobId, imageId: args.imageId },
      args.result as RunResult,
    );
  },
});

/**
 * Put a job into its terminal failure state.
 *
 * `errorCode` is the low-cardinality tag (ZIP_REJECTED, EXTRACT_FAILED,
 * TOO_MANY_IMAGE_FAILURES, …) that dashboards and alerts group on;
 * `errorDetail` is free text for a human reading one specific job. Keeping
 * them separate is the same discipline `classifyAdapterError` enforces for
 * adapter telemetry — group on the tag, never on the message.
 */
export const markJobFailed = internalMutation({
  args: {
    jobId: v.string(),
    errorCode: v.string(),
    errorDetail: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await findJob(ctx, args.jobId);
    if (!job) return null;
    await ctx.db.patch(job._id, {
      status: "failed",
      errorCode: args.errorCode,
      errorDetail: args.errorDetail,
      finishedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Put a job into its terminal success state. The counterpart to
 * `markJobFailed`; both are the only two writers of `finishedAt`, so "the job
 * is over" and "finishedAt is set" can never disagree.
 */
export const markJobSucceeded = internalMutation({
  args: { jobId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await findJob(ctx, args.jobId);
    if (!job) return null;
    await ctx.db.patch(job._id, {
      status: "succeeded",
      finishedAt: Date.now(),
      errorCode: undefined,
      errorDetail: undefined,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal queries used by the "use node" / action side
// ---------------------------------------------------------------------------

/** Job row for internal callers (actions can't touch ctx.db). */
export const getJobInternal = internalQuery({
  args: { jobId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      jobId: v.string(),
      userId: v.string(),
      status: v.string(),
      totalImages: v.number(),
      processedImages: v.number(),
      failedImages: v.number(),
      rejectedEntries: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await findJob(ctx, args.jobId);
    if (!job) return null;
    return {
      jobId: job.jobId,
      userId: job.userId,
      status: job.status,
      totalImages: job.totalImages ?? 0,
      processedImages: job.processedImages ?? 0,
      failedImages: job.failedImages ?? 0,
      rejectedEntries: job.rejectedEntries ?? 0,
    };
  },
});

/**
 * The successfully-processed images of a job, in zip order.
 *
 * Order is not cosmetic: pairing's adjacency pre-pass is built on the
 * assumption that a scanned sheet's front and back land next to each other in
 * the zip, so reading through `by_job_index` is part of the algorithm's input,
 * not a display preference.
 */
export const listDoneImagesForPairing = internalQuery({
  args: { jobId: v.string() },
  returns: v.array(
    v.object({
      index: v.number(),
      originalName: v.string(),
      players: v.optional(v.array(v.string())),
      player: v.optional(v.string()),
      team: v.optional(v.string()),
      cardNumber: v.optional(v.string()),
      side: v.optional(v.string()),
      textCount: v.optional(v.number()),
      dhash: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("placeholderImages")
      .withIndex("by_job_index", (q) => q.eq("jobId", args.jobId))
      .collect();
    return rows
      .filter((r) => r.status === "done")
      .map((r) => ({
        index: r.index,
        originalName: r.originalName,
        players: r.players,
        player: r.player,
        team: r.team,
        cardNumber: r.cardNumber,
        side: r.side,
        textCount: r.textCount,
        dhash: r.dhash,
      }));
  },
});

// ---------------------------------------------------------------------------
// Public reactive queries
// ---------------------------------------------------------------------------
//
// All three take `jobId` and nothing else, and all three answer with the empty
// value (null / []) when the job is missing OR belongs to someone else. Same
// reasoning as `findOwnedJob`: a distinguishable "forbidden" would let anyone
// probe whether a given job id exists. The empty answer is also the right one
// for a reactive UI — a job that vanished and a job that was never yours both
// render as "nothing here".

export const getPlaceholderJob = query({
  args: { jobId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      jobId: v.string(),
      status: v.string(),
      createdAt: v.number(),
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
      totalImages: v.number(),
      processedImages: v.number(),
      failedImages: v.number(),
      rejectedEntries: v.number(),
      pairCount: v.number(),
      errorCode: v.optional(v.string()),
      errorDetail: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) return null;

    const pairs = await ctx.db
      .query("placeholderPairs")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();

    return {
      jobId: job.jobId,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      totalImages: job.totalImages ?? 0,
      processedImages: job.processedImages ?? 0,
      failedImages: job.failedImages ?? 0,
      rejectedEntries: job.rejectedEntries ?? 0,
      pairCount: pairs.length,
      errorCode: job.errorCode,
      errorDetail: job.errorDetail,
      // NOTE: `objectPath` is deliberately NOT returned. It is server-only
      // state; handing it to the client would re-create by the back door the
      // client-supplied-path problem the whole design exists to prevent.
    };
  },
});

export const listPlaceholderImages = query({
  args: { jobId: v.string() },
  returns: v.array(
    v.object({
      index: v.number(),
      originalName: v.string(),
      status: v.string(),
      players: v.optional(v.array(v.string())),
      player: v.optional(v.string()),
      team: v.optional(v.string()),
      cardNumber: v.optional(v.string()),
      side: v.optional(v.string()),
      rotationDegrees: v.optional(v.number()),
      orientConfidence: v.optional(v.number()),
      textCount: v.optional(v.number()),
      croppedSource: v.optional(v.string()),
      dhash: v.optional(v.string()),
      pairStatus: v.optional(v.string()),
      errorCode: v.optional(v.string()),
      errorDetail: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) return [];

    const rows = await ctx.db
      .query("placeholderImages")
      .withIndex("by_job_index", (q) => q.eq("jobId", args.jobId))
      .collect();

    return rows.map((r) => ({
      index: r.index,
      originalName: r.originalName,
      status: r.status,
      players: r.players,
      player: r.player,
      team: r.team,
      cardNumber: r.cardNumber,
      side: r.side,
      rotationDegrees: r.rotationDegrees,
      orientConfidence: r.orientConfidence,
      textCount: r.textCount,
      croppedSource: r.croppedSource,
      dhash: r.dhash,
      pairStatus: r.pairStatus,
      errorCode: r.errorCode,
      errorDetail: r.errorDetail,
      // `workId` is intentionally omitted — it is a handle into the workpool
      // component, not something a client has any use for.
    }));
  },
});

export const listPlaceholderPairs = query({
  args: { jobId: v.string() },
  returns: v.array(
    v.object({
      frontIndex: v.number(),
      backIndex: v.number(),
      player: v.optional(v.string()),
      team: v.optional(v.string()),
      cardNumber: v.optional(v.string()),
      confidence: v.string(),
      mechanism: v.string(),
      score: v.number(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) return [];

    const pairs = await ctx.db
      .query("placeholderPairs")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();

    return pairs.map((p) => ({
      frontIndex: p.frontIndex,
      backIndex: p.backIndex,
      player: p.player,
      team: p.team,
      cardNumber: p.cardNumber,
      confidence: p.confidence,
      mechanism: p.mechanism,
      score: p.score,
      createdAt: p.createdAt,
    }));
  },
});
