/**
 * Streaming intake for placeholder batches — the scanner path (NEO-170).
 *
 * Zip mode asks the user to produce a whole archive before anything happens: no
 * feedback until the upload finishes, no feedback until extraction finishes, and
 * a batch that is wrong is wrong in its entirety. A sheet-feed scanner does not
 * work that way — it emits one image at a time, for as long as the operator
 * keeps loading cards — and this module is that shape:
 *
 *   startPlaceholderStream          → job, status "collecting"
 *   createPlaceholderImageUploadUrl → allocate entry N, sign a POST for it
 *          (convex/adapters/placeholderUploads.ts — it needs the Node runtime)
 *   [browser POSTs the image straight to GCS]
 *   confirmPlaceholderImageUpload   → count it, enqueue it, process it NOW
 *   … repeat for as long as the operator keeps scanning …
 *   closePlaceholderStream          → no more images; finish what is left
 *
 * The job is open the whole time, work starts on image one rather than image
 * two hundred, and pairing (which re-runs after completions — see
 * placeholderPairing.ts) means the operator watches pairs appear while still
 * feeding the scanner.
 *
 * **What is deliberately NOT different.** Everything downstream of "an image
 * exists and is enqueued" is the zip path, unchanged: the same workpool, the
 * same `processEntryWorker`, the same `onImageComplete` → `recordImageOutcomeImpl`
 * counters, the same last-one-done transition, the same terminal decision in
 * `runPairing`. Close is a state transition, not a second pipeline. That is why
 * this module is small: the only genuinely new mechanics are an allocation
 * counter, an "the bytes arrived" confirmation, and a way to say "that's all".
 *
 * SECURITY: `jobId` (and, where an image is named, `entryIndex`) are the only
 * client-supplied handles here. No function takes an object path — the signed
 * upload key is derived server-side in convex/lib/placeholderObjects.ts from the
 * verified Clerk subject, the job id, and a SERVER-allocated index. See the
 * `placeholderJobs` table comment in schema.ts for why that rule is load-bearing
 * rather than stylistic. Every public function resolves the job row from `jobId`
 * and checks `row.userId === identity.subject` before doing anything else, and
 * answers a missing job and someone else's job identically.
 */

import { mutation, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { preprocessPool } from "./placeholderPool";
import {
  ACTIVE_STATUSES,
  ENQUEUE_CHUNK_SIZE,
  MAX_ACTIVE_JOBS_PER_USER,
  MAX_FIELD_CHARS,
  PLACEHOLDER_STREAM_IDLE_MS,
  findOwnedJob,
  requireUserId,
} from "./placeholderPipeline";
import {
  CLERK_USER_ID_RE,
  PLACEHOLDER_MAX_ENTRY_INDEX,
  placeholderJobPrefix,
} from "./lib/placeholderObjects";

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/**
 * Resolve a job the caller owns, or throw.
 *
 * `Job not found` for BOTH "no such job" and "not your job", exactly as
 * `findOwnedJob` intends — a distinguishable error would turn this into an
 * existence oracle for other users' job ids.
 *
 * Mode and status, by contrast, are reported precisely. Those are facts about a
 * job the caller has already proved they own, so there is nothing to leak, and
 * "job is processing, not collecting" is the difference between a user
 * understanding what happened and filing a bug.
 */
async function requireCollectingStreamJob(
  ctx: MutationCtx,
  jobId: string,
  userId: string,
): Promise<Doc<"placeholderJobs">> {
  const job = await findOwnedJob(ctx, jobId, userId);
  if (!job) throw new Error("Job not found");
  if (job.mode !== "stream") throw new Error("job is not a scanner batch");
  if (job.status !== "collecting") {
    throw new Error(`job is ${job.status}, not collecting`);
  }
  return job;
}

// ---------------------------------------------------------------------------
// Public: open a stream
// ---------------------------------------------------------------------------

/**
 * Open a scanner session: a placeholder job that accepts images one at a time.
 *
 * Takes no arguments, and that is a contract rather than an omission — the
 * `userId` on the row comes from the verified token and the `jobId` is generated
 * here, so there is nothing about this job a client gets to choose. It is the
 * same property `createPlaceholderUploadUrl` has, arrived at the same way.
 *
 * `jobId` is a UUID because the preprocess service insists on one:
 * `JOB_ID_PATTERN` in services/preprocess/app/jobs/layout.py refuses anything
 * else, and that check is what keeps job ids unguessable rather than
 * enumerable — the entire ownership model rests on it. `crypto.randomUUID()` is
 * available in Convex mutations (see `startBatch` in convex/entityReviewQueue.ts,
 * which does the same thing).
 *
 * `{started: false, reason}` rather than a throw for the active-job cap: a user
 * who already has two batches running is being told "not now", which is ordinary
 * UI state, not a fault. Same shape as `startPlaceholderBatch` for the same
 * reason.
 */
export const startPlaceholderStream = mutation({
  args: {},
  returns: v.object({
    started: v.boolean(),
    jobId: v.optional(v.string()),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    if (!CLERK_USER_ID_RE.test(userId)) {
      // Belt-and-suspenders, and the same check `createPlaceholderUploadUrl`
      // makes: this value becomes a literal GCS object-path segment for every
      // image in the session, so refuse to open the session at all rather than
      // build paths from an unvalidated string.
      throw new Error("Unexpected user id shape");
    }

    // Read through `by_user` — the caller's own jobs only, never a scan of
    // everyone's. ACTIVE_STATUSES is shared with `startPlaceholderBatch` and
    // includes "collecting", so the cap counts both modes: a user cannot get to
    // four in flight by alternating between a zip upload and a scan.
    const ownJobs = await ctx.db
      .query("placeholderJobs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const activeCount = ownJobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
    if (activeCount >= MAX_ACTIVE_JOBS_PER_USER) {
      return {
        started: false,
        reason: `you already have ${activeCount} active batches (limit ${MAX_ACTIVE_JOBS_PER_USER}) — finish or cancel one first`,
      };
    }

    const jobId = crypto.randomUUID();
    const now = Date.now();
    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId,
      // The job PREFIX, not an input.zip that will never exist. See the
      // `objectPath` comment in schema.ts.
      objectPath: placeholderJobPrefix(userId, jobId),
      createdAt: now,
      mode: "stream",
      status: "collecting",
      // A stream job is running from the moment it opens — there is no separate
      // Start for it, so created and started are the same instant.
      startedAt: now,
      // Zeroed explicitly rather than left absent. `totalImages` in particular
      // counts CONFIRMED images and grows one at a time, so "0 so far" is a
      // meaningfully different statement from "not known yet".
      totalImages: 0,
      processedImages: 0,
      failedImages: 0,
      rejectedEntries: 0,
      nextEntryIndex: 0,
      lastActivityAt: now,
    });

    return { started: true, jobId };
  },
});

// ---------------------------------------------------------------------------
// Internal: entry allocation (the counter behind createPlaceholderImageUploadUrl)
// ---------------------------------------------------------------------------

/**
 * Claim the next entry index for a stream job and create its image row.
 *
 * Split out of `createPlaceholderImageUploadUrl` because that is an action and
 * this must be a TRANSACTION. Two upload-URL requests in flight at once — a
 * client uploading two scans in parallel, or simply retrying — must get
 * different indexes; reading the counter in the action and writing it back later
 * would let both read 7, both sign a policy for `extracted/0007.jpg`, and the
 * second upload silently overwrite the first (or, with the generation-match
 * condition, fail with a 412 nobody can explain). Read-check-increment inside
 * one mutation makes that unrepresentable.
 *
 * The row is created here too, in the same transaction, so an allocated index
 * always has a row: an index with no row is invisible to every later sweep and
 * would leave an orphaned GCS object behind.
 *
 * The cap is the service's own bound, mirrored — see PLACEHOLDER_MAX_ENTRY_INDEX.
 * Refusing here turns "this batch is full" into something the user is told at
 * the moment they try, rather than a 422 from `/process-entry` after they have
 * already uploaded the bytes.
 *
 * Ownership is re-checked against the `userId` the action verified, not trusted
 * from it: this is an internal mutation, but it is one whose only caller is
 * holding a client-supplied `jobId`, and the check is what confines the object
 * path that gets signed afterwards.
 */
export const allocateStreamEntry = internalMutation({
  args: {
    jobId: v.string(),
    userId: v.string(),
    originalName: v.optional(v.string()),
  },
  returns: v.object({ entryIndex: v.number() }),
  handler: async (ctx, args) => {
    const job = await requireCollectingStreamJob(ctx, args.jobId, args.userId);

    const entryIndex = job.nextEntryIndex ?? 0;
    if (entryIndex > PLACEHOLDER_MAX_ENTRY_INDEX) {
      throw new Error(
        `this batch is full (${PLACEHOLDER_MAX_ENTRY_INDEX + 1} images) — close it and start another`,
      );
    }

    await ctx.db.patch(job._id, {
      nextEntryIndex: entryIndex + 1,
      lastActivityAt: Date.now(),
    });

    await ctx.db.insert("placeholderImages", {
      jobId: args.jobId,
      // From the JOB row, never from the argument — same discipline as
      // `registerExtractedImages`.
      userId: job.userId,
      entryIndex,
      // Capped like every other user- or model-supplied string on this table
      // (MAX_FIELD_CHARS): the value is a filename chosen by whoever is driving
      // the scanner, it is rendered by the review UI, and an unbounded one is a
      // way to push a row toward Convex's 1MB document limit. The fallback is
      // not cosmetic — `originalName` is required, and pairing reads it (only as
      // a log label, so a synthetic name is harmless).
      originalName: (args.originalName ?? `scan-${entryIndex}`).slice(0, MAX_FIELD_CHARS),
      status: "awaiting_upload",
    });

    return { entryIndex };
  },
});

// ---------------------------------------------------------------------------
// Public: confirm one image, close the stream
// ---------------------------------------------------------------------------

/**
 * Tell the server an image's bytes have landed, and start processing it.
 *
 * This is what makes `totalImages` mean something. The count is of CONFIRMED
 * images, never of allocated upload URLs, because an allocation is only a
 * capability — the browser may crash, the network may drop, the user may close
 * the tab — and counting one would put the batch-complete condition
 * (`processed + failed === total`) permanently out of reach for an upload that
 * never happened. An unconfirmed allocation costs a row that close/cancel
 * deletes, and nothing else.
 *
 * **Idempotent by design, and this is the load-bearing property.** A retrying
 * client, a double-clicked button, or a request that succeeded server-side but
 * whose response was lost all produce a second confirm for the same entry. The
 * second one finds the row past "awaiting_upload" and returns success without
 * touching anything, so it cannot double-count `totalImages` (which would strand
 * the batch one short forever) and cannot enqueue the image twice (which would
 * double the cost and produce two completions for one row).
 *
 * The enqueue is deliberately identical to `enqueueImageChunk`'s — same worker,
 * same `onComplete`, same context shape — so a stream image is indistinguishable
 * from a zip image from the pool onward. Anything else would mean two completion
 * paths to keep in step.
 *
 * **Deliberate trust decision (2026-08-17 security audit, F2): confirm does NOT
 * verify the bytes exist in GCS.** `totalImages` therefore counts CLAIMED
 * uploads, not verified ones. A client that confirms without uploading buys one
 * doomed worker attempt per phantom entry: `/process-entry` 404s, ENTRY_NOT_FOUND
 * is terminal (no retries), and the image fails without failing the batch. The
 * cost of a full phantom job is ~1001 single-attempt 404s against the caller's
 * own batch — nuisance-priced, bounded by the entry cap and the 2-active-jobs
 * cap, and only reachable by an authenticated account. Verifying here would
 * require making this an action (a HEAD per confirm) and moving the enqueue out
 * of the transaction, which costs every honest confirm to tax the dishonest
 * one. Revisit if PostHog shows ENTRY_NOT_FOUND failures at any real rate.
 */
export const confirmPlaceholderImageUpload = mutation({
  args: { jobId: v.string(), entryIndex: v.number() },
  returns: v.object({
    confirmed: v.boolean(),
    alreadyConfirmed: v.boolean(),
    totalImages: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    // Bounds first, before any row lookup: the index is client input that ends
    // up interpolated into a GCS key on the service side, so it gets the same
    // ge=0/le=MAX bound the service's own request model enforces. Same error
    // shape as an unallocated index — a caller learns nothing from the
    // difference.
    if (
      !Number.isInteger(args.entryIndex) ||
      args.entryIndex < 0 ||
      args.entryIndex > PLACEHOLDER_MAX_ENTRY_INDEX
    ) {
      throw new Error("Image not found");
    }
    const job = await requireCollectingStreamJob(ctx, args.jobId, userId);

    const image = await ctx.db
      .query("placeholderImages")
      .withIndex("by_job_and_index", (q) =>
        q.eq("jobId", args.jobId).eq("entryIndex", args.entryIndex),
      )
      .unique();
    // A confirm for an index that was never allocated is a client bug, not a
    // state to absorb: there is no object at that key and no row to enqueue.
    if (!image) throw new Error("Image not found");

    if (image.status !== "awaiting_upload") {
      return {
        confirmed: true,
        alreadyConfirmed: true,
        totalImages: job.totalImages ?? 0,
      };
    }

    const totalImages = (job.totalImages ?? 0) + 1;
    const now = Date.now();
    await ctx.db.patch(image._id, { status: "queued" });
    await ctx.db.patch(job._id, { totalImages, lastActivityAt: now });

    const workId = await preprocessPool.enqueueAction(
      ctx,
      internal.placeholderBatch.processEntryWorker,
      { jobId: args.jobId, userId: image.userId, entryIndex: image.entryIndex },
      {
        onComplete: internal.placeholderPool.onImageComplete,
        context: { jobId: args.jobId, imageId: image._id },
      },
    );
    await ctx.db.patch(image._id, { workId, status: "processing" });

    return { confirmed: true, alreadyConfirmed: false, totalImages };
  },
});

/**
 * Stop accepting images and let the batch finish.
 *
 * The public half of the close path; the cron sweep calls `closeStreamImpl`
 * directly for the same behaviour on an abandoned session. `{closed: false}`
 * rather than a throw for a job that is no longer collecting, because that is
 * what a double-clicked Finish button looks like and it is not an error.
 */
export const closePlaceholderStream = mutation({
  args: { jobId: v.string() },
  returns: v.object({
    closed: v.boolean(),
    status: v.optional(v.string()),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) throw new Error("Job not found");
    if (job.mode !== "stream") throw new Error("job is not a scanner batch");
    if (job.status !== "collecting") {
      return { closed: false, reason: `job is already ${job.status}` };
    }

    const status = await closeStreamImpl(ctx, job);
    return { closed: true, status };
  },
});

/**
 * Move a collecting job out of "collecting", and route it to whoever finishes
 * it. Shared by the public mutation and the idle sweep — one implementation, so
 * a timed-out session and a deliberately-closed one cannot diverge.
 *
 * Three outcomes, and only the third is new machinery:
 *
 *  - **Nothing was ever confirmed** (`totalImages === 0`). Hand it to the final
 *    pairing run, which owns the zero-images verdict already (it is the same
 *    rule a zip whose entries were all rejected hits). Reusing that rule rather
 *    than writing `markJobFailed` here is what keeps "what makes a batch a
 *    failure" in exactly one place.
 *  - **Work is still draining** (`processed + failed < totalImages`). Status
 *    becomes "processing" and nothing else happens — the last-one-done
 *    transition in `recordImageOutcomeImpl` was already going to fire, and from
 *    here on this is an ordinary batch. The transition is why the status must
 *    change at all: it only fires on "processing".
 *  - **Everything already finished while the user was still scanning.** Straight
 *    to "pairing" plus the final run. Without this branch the job would sit in
 *    "processing" forever waiting for a completion that has already happened —
 *    the same wedge `pruneUnregisteredImages` guards against on the zip side.
 *
 * The `awaiting_upload` sweep is scheduled rather than run inline for the reason
 * given on `startPlaceholderBatch`: an abandoned session can hold up to
 * PLACEHOLDER_MAX_ENTRY_INDEX of those rows, and a bulk delete does not belong in
 * the mutation a user is waiting on. Ordering is not a hazard — those rows are
 * invisible to everything downstream (pairing reads "done" rows; the counters
 * never counted them) so they can go at any time, and nothing can create another
 * one now that the job has left "collecting".
 */
export async function closeStreamImpl(
  ctx: MutationCtx,
  job: Doc<"placeholderJobs">,
): Promise<string> {
  await ctx.scheduler.runAfter(0, internal.placeholderStream.sweepAwaitingUploads, {
    jobId: job.jobId,
    from: 0,
  });

  const totalImages = job.totalImages ?? 0;
  const settled = (job.processedImages ?? 0) + (job.failedImages ?? 0);
  const now = Date.now();

  if (totalImages === 0 || settled >= totalImages) {
    await ctx.db.patch(job._id, { status: "pairing", lastActivityAt: now });
    await ctx.scheduler.runAfter(0, internal.placeholderPairing.runPairing, {
      jobId: job.jobId,
      userId: job.userId,
      final: true,
    });
    return "pairing";
  }

  await ctx.db.patch(job._id, { status: "processing", lastActivityAt: now });
  return "processing";
}

// ---------------------------------------------------------------------------
// Internal: sweeps
// ---------------------------------------------------------------------------

/**
 * Delete a chunk of this job's `awaiting_upload` rows, then self-schedule until
 * none are left.
 *
 * Scheduled behind close and behind cancel. An `awaiting_upload` row is an
 * upload URL that was handed out and never used; leaving it would show the user
 * a permanently pending image on a finished batch, and — because the row still
 * occupies its entry index — make a later reader of the table unable to tell an
 * abandoned allocation from a lost one.
 *
 * Walks `by_job_and_index` from a cursor rather than re-`take`ing from the
 * start, exactly like `pruneUnregisteredImages`. A plain `.take(N)` would be a
 * loop that never terminates here: unlike `sweepJobPairs`, this sweep does not
 * delete everything it reads, so a first chunk containing no `awaiting_upload`
 * rows would be re-read forever.
 *
 * Confirmed rows are never touched, at any status. Deleting one would erase an
 * image the counters have already counted, and the batch would never reach its
 * total.
 */
export const sweepAwaitingUploads = internalMutation({
  args: { jobId: v.string(), from: v.number() },
  returns: v.object({
    deleted: v.number(),
    done: v.boolean(),
    /**
     * The cursor the next chunk resumes from — absent on the last one.
     *
     * Returned as well as scheduled because it is derived from the rows this
     * chunk READ, and most of those no longer exist by the time it returns. A
     * caller replaying the chain by hand (the unit tests, since convex-test does
     * not auto-run scheduled functions) cannot recompute it from the surviving
     * rows: it would resume past the ones this chunk deliberately kept. Same
     * reason `registerExtractedImages` returns its carried `keptDone`.
     */
    nextFrom: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("placeholderImages")
      .withIndex("by_job_and_index", (q) =>
        q.eq("jobId", args.jobId).gte("entryIndex", args.from),
      )
      .take(ENQUEUE_CHUNK_SIZE);

    let deleted = 0;
    for (const row of rows) {
      if (row.status !== "awaiting_upload") continue;
      await ctx.db.delete(row._id);
      deleted += 1;
    }

    if (rows.length === ENQUEUE_CHUNK_SIZE) {
      const nextFrom = rows[rows.length - 1].entryIndex + 1;
      await ctx.scheduler.runAfter(0, internal.placeholderStream.sweepAwaitingUploads, {
        jobId: args.jobId,
        from: nextFrom,
      });
      return { deleted, done: false, nextFrom };
    }

    return { deleted, done: true };
  },
});

/**
 * Close every collecting job that has gone quiet — the cron target (crons.ts,
 * every 10 minutes).
 *
 * Without this, a scanner session the user walked away from stays "collecting"
 * forever: it is not terminal, so it never reaches a verdict; it holds one of
 * that user's two active-job slots, so it blocks their next batch; and any
 * images they DID confirm sit processed but unpaired and unreported. Nothing
 * else can rescue it, because every other transition is driven by a user action
 * that is not coming.
 *
 * Reads through `by_status_and_activity`, so this touches only the collecting
 * jobs that are already past the deadline — never a scan of the jobs table. That
 * matters more than it looks: this runs 144 times a day forever, and the common
 * case (nothing idle) must cost one empty index read.
 *
 * Bounded per invocation and self-scheduling for the remainder, because each
 * close is a patch plus one or two scheduled functions; a mass expiry after an
 * outage should not try to do all of it in one transaction.
 */
export const sweepIdleStreams = internalMutation({
  args: {},
  returns: v.object({ closed: v.number(), done: v.boolean() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - PLACEHOLDER_STREAM_IDLE_MS;
    const idle = await ctx.db
      .query("placeholderJobs")
      .withIndex("by_status_and_activity", (q) =>
        q.eq("status", "collecting").lt("lastActivityAt", cutoff),
      )
      .take(ENQUEUE_CHUNK_SIZE);

    for (const job of idle) {
      await closeStreamImpl(ctx, job);
    }

    const done = idle.length < ENQUEUE_CHUNK_SIZE;
    if (!done) {
      // Safe to re-run the same query: every job above has just left
      // "collecting", so the next pass reads different rows rather than the same
      // ones again.
      await ctx.scheduler.runAfter(0, internal.placeholderStream.sweepIdleStreams, {});
    }

    if (idle.length > 0) {
      console.log(
        JSON.stringify({
          msg: "placeholder_idle_streams_closed",
          closed: idle.length,
          idleMs: PLACEHOLDER_STREAM_IDLE_MS,
        }),
      );
    }

    return { closed: idle.length, done };
  },
});
