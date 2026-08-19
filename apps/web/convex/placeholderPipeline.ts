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
 *       (restart)                            processing ──(all images done)──▶ pairing
 *          │                                        │                              │
 *        failed ◀──────────markJobFailed────────────┴──────────────────────────────┤
 *          ▲                                                                       ▼
 *          └────cancelPlaceholderBatch────                                     succeeded
 *
 * There is a second way in, added later in NEO-170 and living in
 * convex/placeholderStream.ts: a "stream" job starts in "collecting" and takes
 * one image at a time from a scanner, joining the diagram at "processing" (work
 * still draining) or "pairing" (nothing left) when the user closes it. Only the
 * ENTRY differs — everything from `recordImageOutcomeImpl` onward is shared, and
 * `mode` is read in exactly one place in this file (`startPlaceholderBatch`
 * refuses a stream job, because there is no archive to extract).
 *
 * Pairing no longer waits for the end. `recordImageOutcomeImpl` schedules a
 * debounced pairing run after image completions in both modes, so pairs stream
 * into `placeholderPairs` as soon as both halves of a card are processed; those
 * runs are provisional and make no terminal decision. The terminal pass is
 * unchanged and still runs exactly once, from the last-one-done transition
 * below (zip, and stream-after-close) or from `closePlaceholderStream` when
 * there was nothing left to drain.
 *
 * "failed" is the hub, not a dead end. It is the only non-initial status a
 * batch may be started from, cancel forces a wedged job into it, and a restart
 * re-registers the zip's entries OVER the existing image rows rather than
 * deleting them — every image already "done" is kept, so recovery never
 * re-pays for work that already succeeded. That is one design, not three
 * features: making cancel terminal is only affordable because restart is
 * cheap, and restart is only correct because the upload is write-once.
 *
 * SECURITY: `jobId` is the only client-supplied handle in this entire module.
 * No function takes `objectPath`, and none ever will — see the placeholderJobs
 * table comment in schema.ts for why that rule is load-bearing rather than
 * stylistic. Every public function resolves the job row from `jobId` and
 * checks `row.userId === identity.subject` before doing anything else.
 */

import { action, mutation, internalMutation, query, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { RunResult, WorkId } from "@convex-dev/workpool";
import { getCurrentUserId, requireAdmin } from "./auth";
import { preprocessPool } from "./placeholderPool";

/**
 * How many images are handled per chunked mutation — registration, enqueuing,
 * and the stale-row sweep all use it.
 *
 * ====================================================================
 * SIZED AGAINST `MAX_ZIP_ENTRIES` IN THE PREPROCESS REPO
 * (services/preprocess/app/jobs/zipsafe.py, currently 1000).
 * ====================================================================
 * That constant is the only thing bounding how many entries `/extract` can
 * hand back, and therefore the only thing bounding how much work the
 * registration path is asked to do in one go. It lives in another repository
 * on another release cadence, exactly like `preprocess_max_instances` does for
 * convex/preprocessCapacity.ts — and like that number, nothing mechanical
 * catches the drift.
 *
 * What breaks if it grows: registration, enqueuing and sweeping are each a
 * write per image, so an unchunked pass over 10× the entries would build a
 * transaction 10× the size, with a correspondingly larger chance of an OCC
 * conflict retry and a real chance of hitting Convex's per-transaction limits.
 * Chunking is what makes this path indifferent to that number — raising
 * MAX_ZIP_ENTRIES costs more chunks, not a bigger transaction. The chunk size
 * itself needs no change; the pool caps concurrency anyway, so enqueuing
 * faster would buy nothing.
 */
export const ENQUEUE_CHUNK_SIZE = 50;

/** Statuses a batch may be started from. See `startPlaceholderBatch`. */
const STARTABLE_STATUSES = new Set(["pending", "uploaded", "failed"]);

/**
 * Statuses that mean "this batch is still consuming capacity".
 *
 * Used by the per-user cap in `startPlaceholderBatch` AND in
 * `startPlaceholderStream` — one set, so the cap counts both modes' jobs and a
 * user cannot get four in flight by alternating between them.
 *
 * Deliberately NOT derived from `STARTABLE_STATUSES` by negation: "pending" is
 * neither active nor terminal (nothing is running for it), and counting it would
 * make a user with two un-started uploads unable to start either.
 *
 * "collecting" IS active even though nothing is running for it at that instant.
 * A collecting job is a live scanner session that can enqueue paid work at any
 * moment, and it holds its slot until it is closed or the idle sweep closes it —
 * which is exactly the property that makes the sweep necessary rather than
 * merely tidy.
 */
export const ACTIVE_STATUSES = new Set([
  "collecting",
  "extracting",
  "processing",
  "pairing",
]);

/**
 * Statuses in which a completed image is allowed to trigger an incremental
 * pairing run.
 *
 * Both modes, and only the two states where more images may still be coming:
 * "processing" (a zip fanned out, or a closed stream still draining) and
 * "collecting" (a stream still open). Anything else is either not yet producing
 * images or already terminal, and re-pairing there would fight with the run
 * that owns the terminal decision.
 */
export const INCREMENTAL_PAIRING_STATUSES = new Set(["collecting", "processing"]);

/**
 * How long a "collecting" stream job may go untouched before the idle sweep
 * closes it (crons.ts, every 10 minutes).
 *
 * Thirty minutes is sized against what the timeout is FOR: a scanner session
 * the user walked away from. Long enough that a genuine pause — feeding the
 * next stack of cards into the sheet feeder, answering the door — never closes
 * a batch out from under someone, short enough that an abandoned session frees
 * its active-job slot within the hour rather than blocking the user's next
 * upload until they notice and cancel it by hand.
 *
 * Activity is generous on purpose: an upload-URL allocation, a confirm, and an
 * image completion all count. The last one matters most — a large image can
 * take minutes to process, and a user who queued five of them and is waiting is
 * not idle just because they have stopped typing.
 */
export const PLACEHOLDER_STREAM_IDLE_MS = 30 * 60 * 1000;

/**
 * Delay between an image completion and the incremental pairing run it
 * schedules. The `pairingScheduled` latch bounds how many runs are QUEUED
 * (one); this bounds their RATE. Each run recomputes the full pairBatch over
 * every done row, so with a zero delay a 1000-image session pays an O(N²)
 * read bill — one full recompute per completion. Five seconds collapses a
 * burst of completions into one run while adding at most five seconds to
 * when a pair first appears, against a ~40s/image processing time nobody
 * perceives it next to. The FINAL run is never delayed — the terminal
 * verdict should land the moment the last image does.
 */
export const PAIRING_DEBOUNCE_MS = 5 * 1000;

/**
 * How many batches one user may have in flight at once.
 *
 * Two, not one, so a user can start the next sheet while the previous one is
 * still pairing — and not more, because a batch is the unit of paid work.
 * Each one is up to MAX_ZIP_ENTRIES `/process-entry` calls, every one of which
 * is a Vision round-trip and a model inference we pay for, and `/extract` runs
 * OUTSIDE the workpool (one request per job, see placeholderBatch.ts) so it is
 * the pool's parallelism cap that concurrent jobs bypass. The cap is therefore
 * doing two jobs at once: bounding concurrent extract load against a
 * three-instance service, and bounding how fast a single account can replay
 * paid API spend by hammering Start.
 */
export const MAX_ACTIVE_JOBS_PER_USER = 2;

/**
 * Which client started a run — a display hint for the admin page, not a security
 * boundary. See the `source` comment in schema.ts: the client supplies it, the
 * server stores it verbatim, and nothing is gated on it. Shared by both start
 * paths and both readers so the one spelling of the union lives in one place.
 */
export const SOURCE_VALIDATOR = v.union(v.literal("scanner"), v.literal("web"));

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
export async function findOwnedJob(
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
export async function requireUserId(ctx: QueryCtx): Promise<string> {
  const userId = await getCurrentUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

/** Load a job by id without an ownership check — internal callers only. */
export async function findJob(
  ctx: QueryCtx,
  jobId: string,
): Promise<Doc<"placeholderJobs"> | null> {
  return ctx.db
    .query("placeholderJobs")
    .withIndex("by_job", (q) => q.eq("jobId", jobId))
    .unique();
}

// ---------------------------------------------------------------------------
// Public: warm-on-intent
// ---------------------------------------------------------------------------

/**
 * Warm the preprocess service NOW, at the first sign the user is heading toward
 * an upload — before a job even exists.
 *
 * The on-start warm-ups (in `startPlaceholderBatch` / `startPlaceholderStream`)
 * fire when a batch begins; this one fires earlier still. A web upload page
 * calls it on mount, and the scanner CLI calls it at `yarn start` — both
 * minutes before the first image, so the multi-GB BiRefNet model loads while the
 * user is picking a set or selecting files, and the first real `/process-entry`
 * finds it already resident.
 *
 * Fire-and-forget by construction: it SCHEDULES the shared `warmupPreprocess`
 * fan-out and returns immediately, so the caller is never held for the (up to a
 * minute, cold) warm-up round trips. It cannot fail a page mount — the only
 * throw is the auth check, which is correct (an unauthenticated caller has no
 * business spending our Cloud Run capacity), and `warmupPreprocess` itself
 * swallows every warm-up failure.
 *
 * No dedup and no cost concern when already warm: a warm instance answers
 * `/warmup` immediately, so N callers hitting it in the same minute is cheap and
 * harmless. The on-start warm-ups stay as a backstop for clients that never call
 * this (a raw API consumer, an older CLI).
 *
 * `requireUserId` (any signed-in user), NOT `requireAdmin`: warming is a benign
 * self-serve nicety, and gating it behind admin would defeat the point.
 */
export const warmPreprocess = action({
  args: {},
  returns: v.object({ warming: v.boolean() }),
  handler: async (ctx): Promise<{ warming: boolean }> => {
    // `getCurrentUserId` (not `requireUserId`, which is typed for QueryCtx) —
    // same effect: an unauthenticated caller is refused.
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Schedule the SAME internal fan-out the start paths use, and return. The
    // warm-up round trips happen in the background; nothing here waits on them.
    await ctx.scheduler.runAfter(0, internal.placeholderBatch.warmupPreprocess, {});
    return { warming: true };
  },
});

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
 * behavior, not an error worth surfacing as a red toast. The same shape
 * carries the per-user active-batch refusal, which is likewise a "not now",
 * not a fault.
 *
 * This mutation writes ONE row and schedules two things. It deliberately does
 * no bulk cleanup of its own: an earlier version deleted the previous
 * attempt's images inline, which on a full 1000-entry zip is ~1000 reads plus
 * ~1000 deletes inside the mutation the user is waiting on — straight through
 * the 7-second budget for the one interaction that must feel instant. Both
 * halves of the cleanup moved out: pairs are swept by a chunked internal
 * mutation, and images are not deleted at all (see registerExtractedImages,
 * which upserts over them and keeps the ones that already succeeded).
 */
export const startPlaceholderBatch = mutation({
  // `source` is an optional display hint the web pages pass as "web"; see the
  // `source` comment in schema.ts. Absent leaves it absent.
  args: { jobId: v.string(), source: v.optional(SOURCE_VALIDATOR) },
  returns: v.object({
    started: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) throw new Error("Job not found");

    // Checked BEFORE the status guard, and that ordering is the whole point.
    // A collecting stream job is already refused by the guard below (its status
    // is not startable), so the only case this catches is a stream job that has
    // reached "failed" — which IS a startable status, and is reachable by
    // cancelling one. Starting it would schedule `/extract` against
    // `placeholders/{user}/{job}/input.zip`, an object that does not exist and
    // never will, and the batch would fail again with a 404 INPUT_NOT_FOUND that
    // reads as an infrastructure problem rather than "Start does not apply
    // here". Restart-from-failed stays a zip-only affordance: recovering a
    // stream job means starting a new scanner session, because the images were
    // never archived anywhere we could replay them from.
    if (job.mode === "stream") {
      return {
        started: false,
        reason: "this is a scanner batch — start a new scan instead of restarting it",
      };
    }

    if (!STARTABLE_STATUSES.has(job.status)) {
      return { started: false, reason: `job is already ${job.status}` };
    }

    // Per-user concurrency cap. Read through `by_user` — this is the caller's
    // own jobs only, never a scan of everyone's. (If placeholder job history
    // per user ever grows large enough for this read to matter, the fix is a
    // ["userId","status"] index, not a looser cap.)
    const ownJobs = await ctx.db
      .query("placeholderJobs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const activeCount = ownJobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
    if (activeCount >= MAX_ACTIVE_JOBS_PER_USER) {
      return {
        started: false,
        reason: `you already have ${activeCount} active batches (limit ${MAX_ACTIVE_JOBS_PER_USER}) — wait for one to finish`,
      };
    }

    await ctx.db.patch(job._id, {
      status: "extracting",
      startedAt: Date.now(),
      // Store the client hint when given; a restart from a page that passes it
      // updates it, and one that does not leaves whatever was there. Only ever
      // set from the argument, never inferred.
      ...(args.source ? { source: args.source } : {}),
      // Zeroed rather than preserved: what the previous attempt counted is not
      // yet known to be true of this one. registerExtractedImages recomputes
      // all four from the rows once it knows what the zip contains — including
      // `processedImages`, which comes back as the number of already-done rows
      // it kept.
      totalImages: 0,
      processedImages: 0,
      failedImages: 0,
      rejectedEntries: 0,
      // Reset with the counters, for the same reason: the previous attempt's
      // pairs are being swept, so its resolver spend describes work that no
      // longer exists. Carrying it forward would make a restarted batch look
      // like it had paid for identity resolution it is about to redo from
      // scratch — and reading 0 on a healthy batch is this number's entire job.
      // Cleared rather than set to 0 so "absent" stays the single
      // representation of zero; every reader defaults it.
      resolverCalls: undefined,
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

    // Drop the previous attempt's pairs. Safe to run concurrently with (or
    // behind) extract: pairing is the only writer of that table and it does
    // not run until every image has completed, which is minutes away at the
    // earliest. Unconditional rather than gated on `status === "failed"`
    // because on a first run it is a single mutation that finds nothing.
    await ctx.scheduler.runAfter(0, internal.placeholderPipeline.sweepJobPairs, {
      jobId: args.jobId,
    });

    // Warm the preprocess service in the background so the model loads WHILE the
    // zip is extracting, ahead of the per-image fan-out. Fire-and-forget:
    // scheduled, never awaited, and `warmupPreprocess` cannot fail — a cold
    // start simply happens the old way if it does nothing.
    await ctx.scheduler.runAfter(0, internal.placeholderBatch.warmupPreprocess, {});

    return { started: true };
  },
});

/**
 * Delete a chunk of this job's pairs, then self-schedule until none are left.
 *
 * The pair rows of a previous attempt have to go: pairing rewrites them from
 * scratch, and a leftover row would leave `pairCount` reporting two runs'
 * worth of pairs. Chunked and scheduled rather than inline for the reason
 * given on `startPlaceholderBatch` — bulk deletes do not belong in the
 * mutation a user is waiting on.
 */
export const sweepJobPairs = internalMutation({
  args: { jobId: v.string() },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const pairs = await ctx.db
      .query("placeholderPairs")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .take(ENQUEUE_CHUNK_SIZE);

    for (const pair of pairs) {
      await ctx.db.delete(pair._id);
    }

    const done = pairs.length < ENQUEUE_CHUNK_SIZE;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.placeholderPipeline.sweepJobPairs, {
        jobId: args.jobId,
      });
    }
    return { deleted: pairs.length, done };
  },
});

/**
 * Cancel an in-flight batch, and force it terminal.
 *
 * Two separate things happen here, and the second one is the important one:
 *
 *  1. Every outstanding work item is canceled in the pool. Work already
 *     running is allowed to finish — the pool cancels pending work and stops
 *     retrying running work rather than killing an in-flight request.
 *  2. The job is patched to "failed" with `errorCode: "CANCELED"`.
 *
 * Step 2 used to be deliberately omitted, on the reasoning that a canceled
 * work item still runs onComplete (`kind: "canceled"`), so the counters would
 * converge on `processed + failed === total` and the batch would reach a
 * terminal status by the normal route. That reasoning holds only while the
 * chain is intact. If any link is lost — a scheduled function that never ran,
 * a work item whose completion never fired, an image row that vanished — the
 * counters never reach the total, the transition never fires, and the job sits
 * in "processing" forever with no way out: it is not terminal, so it is not
 * startable either. Cancel was the natural recovery lever and it did not
 * recover anything.
 *
 * Forcing the terminal state makes cancel that lever. "failed" is a startable
 * status, so the user's next action is Start, and a restart is now cheap
 * rather than a full re-run: registerExtractedImages keeps every image that
 * already reached "done" (see there), so recovery re-pays for nothing that
 * already succeeded.
 *
 * Late completions from the canceled work stay harmless. They arrive at
 * `recordImageOutcomeImpl`, which ignores rows already terminal, no-ops on
 * rows that are gone, and only fires the pairing transition when the job is
 * still "processing" — which it no longer is.
 *
 * Cancelling a "collecting" stream job works through this same function, with
 * one addition: its `awaiting_upload` rows are swept behind the cancel. Those
 * rows have no `workId` (nothing was ever enqueued for them), so the loop below
 * skips them and there is nothing in the pool to cancel — but leaving them
 * would leave the job advertising images that will never arrive.
 */
/**
 * The one shape both cancel entry points answer with.
 *
 * Declared ABOVE its first use, not below. A validator is a `const` evaluated
 * when the module loads and `mutation({...})` is called, so a reference from an
 * earlier line is a temporal-dead-zone ReferenceError at import time — which
 * takes down every function in the module, not just the one that reached for it.
 */
const CANCEL_RESULT_VALIDATOR = v.object({
  canceled: v.boolean(),
  canceledCount: v.number(),
  reason: v.optional(v.string()),
});

export const cancelPlaceholderBatch = mutation({
  args: { jobId: v.string() },
  returns: CANCEL_RESULT_VALIDATOR,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) throw new Error("Job not found");
    return cancelJobImpl(ctx, job, "user");
  },
});

/**
 * Everything cancelling a batch actually DOES, with no opinion about who is
 * allowed to do it.
 *
 * The authorization and the effect are deliberately separated: `cancelPlaceholderBatch`
 * proves ownership, `adminCancelPlaceholderBatch` proves the admin role, and both
 * then call this. There is exactly one implementation of what cancel MEANS —
 * which work is cancelled, what the terminal state is, what gets swept behind it
 * — so the admin path cannot drift into a second, subtly different cancel. That
 * is not a tidiness argument: the failure mode of two implementations here is an
 * admin "cancelling" a job in a way that leaves work running or leaves the job
 * non-terminal, which is precisely the wedge cancel exists to resolve.
 *
 * Takes the resolved job DOC rather than a jobId, so it cannot be called without
 * the caller having already looked the job up — and therefore cannot be called
 * without having had the chance to authorize.
 *
 * `canceledBy` affects only the human-readable `errorDetail`. The user-facing
 * distinction is real and worth keeping — a user who is told "canceled by user"
 * about something an administrator did would go looking for a click they never
 * made — but it changes nothing about the semantics, and `errorCode` stays
 * `CANCELED` for both so anything grouping or alerting on the code sees one
 * event type.
 */
/**
 * Cancel every active batch the caller owns — a testing-only slot-freeing reset.
 *
 * Exists for one concrete E2E problem. The per-user cap counts all of
 * ACTIVE_STATUSES, and `closePlaceholderStream` moves a stream job
 * collecting → pairing, which is STILL active — so only reaching a terminal
 * status frees a slot, and only `cancelJobImpl` does that. Back-to-back E2E runs
 * therefore accumulate active jobs until the seed page can no longer start one.
 * This gives an entry page a way to clear the caller's own slots before seeding
 * a fresh run.
 *
 * Gated exactly like the seeders in convex/testing.ts — presence of
 * `TESTING_RESET_SECRET`, which is set on dev and preview and unset in prod, so
 * this throws in production and can never mass-cancel a real user's live
 * batches. Kept HERE rather than in testing.ts specifically so it can call the
 * module-private `cancelJobImpl` without exporting it — the whole point of that
 * helper is that there is ONE cancel implementation, and widening its visibility
 * to reach a test seeder would start to undo that.
 *
 * Caller-scoped: no `userId` argument, reads through `by_user` for the verified
 * subject only, so it cannot reach across users even with the gate open. Each
 * job goes through `cancelJobImpl` — the same path `cancelPlaceholderBatch`
 * uses — so the workpool items are actually cancelled and the awaiting-upload
 * sweep is scheduled, rather than a status being patched out from under running
 * work.
 *
 * Idempotent: a second call finds nothing active (the first left every job
 * terminal) and returns `{ canceled: 0 }`.
 */
export const seedCancelMyActivePlaceholderJobs = mutation({
  args: {},
  returns: v.object({
    canceled: v.number(),
    canceledWorkItems: v.number(),
  }),
  handler: async (ctx) => {
    // Fail closed in production: the enabling flag is unset there.
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test placeholder cancellation is not enabled on this deployment");
    }

    const userId = await requireUserId(ctx);

    const ownJobs = await ctx.db
      .query("placeholderJobs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    let canceled = 0;
    let canceledWorkItems = 0;
    for (const job of ownJobs) {
      if (!ACTIVE_STATUSES.has(job.status)) continue;
      // Through the shared impl, NOT a status patch: an active job may hold
      // in-flight workpool items that have to be cancelled and awaiting_upload
      // rows that have to be swept. `canceledBy: "user"` — this is the caller
      // clearing their OWN runs, not an operator reaching into someone else's.
      const result = await cancelJobImpl(ctx, job, "user");
      if (result.canceled) {
        canceled += 1;
        canceledWorkItems += result.canceledCount;
      }
    }

    return { canceled, canceledWorkItems };
  },
});

async function cancelJobImpl(
  ctx: MutationCtx,
  job: Doc<"placeholderJobs">,
  canceledBy: "user" | "admin",
): Promise<{ canceled: boolean; canceledCount: number; reason?: string }> {
  if (job.status === "succeeded" || job.status === "failed") {
    return { canceled: false, canceledCount: 0, reason: `job is already ${job.status}` };
  }

  const images = await ctx.db
    .query("placeholderImages")
    .withIndex("by_job_and_index", (q) => q.eq("jobId", job.jobId))
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

  await ctx.db.patch(job._id, {
    status: "failed",
    errorCode: "CANCELED",
    errorDetail:
      canceledBy === "admin" ? "canceled by an administrator" : "canceled by user",
    finishedAt: Date.now(),
  });

  // Unconditional rather than gated on `mode === "stream"`, for the same
  // reason `startPlaceholderBatch` schedules `sweepJobPairs` unconditionally:
  // on a zip job it is one mutation that finds nothing, and a gate is one more
  // thing that can be wrong. Scheduled rather than inline because a job whose
  // uploads were abandoned can hold up to PLACEHOLDER_MAX_ENTRY_INDEX of these
  // rows, and bulk deletes do not belong in the mutation a user is waiting on.
  await ctx.scheduler.runAfter(0, internal.placeholderStream.sweepAwaitingUploads, {
    jobId: job.jobId,
    from: 0,
  });

  return { canceled: true, canceledCount };
}

// ---------------------------------------------------------------------------
// Internal: batch registration and fan-out
// ---------------------------------------------------------------------------

/**
 * Record what the extract step found, reconciling it against whatever rows a
 * previous attempt left behind, and move the job into "processing".
 *
 * This is an UPSERT, not an insert, and that is the whole point. A restart
 * used to delete the previous attempt's images and start from nothing, which
 * meant every image that had already been cropped, oriented, classified and
 * hashed was processed again — a second Vision round-trip and a second model
 * inference per image, paid for, to re-derive a result we already had. The
 * zip is write-once (a job id maps to exactly one uploaded object, forever),
 * so an entry that succeeded once will produce the same answer if run again;
 * there is nothing to gain by re-running it and real money to lose.
 *
 * Per accepted entry, keyed on (jobId, entryIndex):
 *
 *   - no row            → insert, "queued"
 *   - row is "done"     → KEEP it, clearing only `pairStatus` (pairing re-runs
 *                         from scratch and re-decides that field)
 *   - row is anything
 *     else              → reset to "queued", dropping the previous attempt's
 *                         workId, identity fields and error fields, so nothing
 *                         from a half-finished run survives into this one
 *
 * `enqueueImageChunk` then only enqueues "queued" rows, so the kept rows cost
 * nothing further — that skip is load-bearing here, not just re-entrancy
 * insurance.
 *
 * Chunked and self-scheduling for the reason given on ENQUEUE_CHUNK_SIZE. The
 * `entries` array is re-passed to each chunk rather than re-fetched: extract
 * is a network call that cannot be re-made from a mutation, and the list is
 * bounded by MAX_ZIP_ENTRIES.
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
    // `index` here is the wire field name from `/extract`; it lands in the
    // `entryIndex` column.
    entries: v.array(
      v.object({
        index: v.number(),
        name: v.string(),
        accepted: v.boolean(),
      }),
    ),
    /** Chunk cursor into the deduped accepted list. Absent means "start". */
    from: v.optional(v.number()),
    /** Running count of already-"done" rows kept, carried across chunks. */
    keptDone: v.optional(v.number()),
  },
  returns: v.object({
    totalImages: v.number(),
    rejectedEntries: v.number(),
    /**
     * Already-"done" rows this registration kept, cumulative across chunks.
     * On a first run it is always 0; on a restart it is the number of images
     * that will NOT be re-processed, which is the whole point of the upsert
     * and the number to look at when asking whether a restart was cheap.
     */
    keptDone: v.number(),
    done: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const job = await findJob(ctx, args.jobId);
    if (!job) throw new Error("Job not found");
    if (job.userId !== args.userId) {
      // An internal-caller invariant, not a user-facing check: runExtract is
      // handed the userId off the job row it was scheduled from. If these ever
      // disagree, something upstream is passing an attacker-influenced value.
      throw new Error("Job ownership mismatch");
    }

    // Dedupe on entry index, first occurrence wins. (jobId, entryIndex) is the
    // key this table is read by, and `unique()` on that index throws if two
    // rows share it — so a duplicated index in the response would not produce
    // a duplicate row, it would poison every later read of the job. Two
    // entries claiming the same index is a service-side bug either way; the
    // job survives it rather than being taken down by it.
    const acceptedByIndex = new Map<number, { index: number; name: string }>();
    for (const entry of args.entries) {
      if (!entry.accepted) continue;
      if (acceptedByIndex.has(entry.index)) continue;
      acceptedByIndex.set(entry.index, { index: entry.index, name: entry.name });
    }
    const accepted = [...acceptedByIndex.values()];
    // Counted from the flag, not as "everything that isn't accepted": a
    // duplicate index is dropped above but is not something extract rejected,
    // and reporting it as a rejection would misattribute a bug of ours to the
    // user's zip.
    const rejectedEntries = args.entries.filter((e) => !e.accepted).length;

    const from = args.from ?? 0;
    let keptDone = args.keptDone ?? 0;

    // The batch is only allowed to advance while it is still the batch that
    // was started. Extract is a network call that can be in flight for
    // minutes, and `cancelPlaceholderBatch` now makes the job terminal
    // immediately — so without this check, a cancel during extraction would be
    // silently undone: the job would flip back to "processing" and enqueue a
    // full zip's worth of paid work the user had already stopped. Same guard
    // covers a restart landing mid-registration; the newer chain owns the job.
    if (job.status !== "extracting") {
      return {
        totalImages: accepted.length,
        rejectedEntries,
        keptDone,
        done: true,
      };
    }

    for (const entry of accepted.slice(from, from + ENQUEUE_CHUNK_SIZE)) {
      const existing = await ctx.db
        .query("placeholderImages")
        .withIndex("by_job_and_index", (q) =>
          q.eq("jobId", args.jobId).eq("entryIndex", entry.index),
        )
        .unique();

      if (!existing) {
        await ctx.db.insert("placeholderImages", {
          jobId: args.jobId,
          userId: job.userId,
          entryIndex: entry.index,
          originalName: entry.name,
          status: "queued",
        });
      } else if (existing.status === "done") {
        keptDone += 1;
        if (existing.pairStatus !== undefined) {
          await ctx.db.patch(existing._id, { pairStatus: undefined });
        }
      } else {
        await ctx.db.patch(existing._id, {
          status: "queued",
          originalName: entry.name,
          workId: undefined,
          players: undefined,
          team: undefined,
          cardNumber: undefined,
          side: undefined,
          rotationDegrees: undefined,
          orientConfidence: undefined,
          textCount: undefined,
          croppedSource: undefined,
          dhash: undefined,
          errorCode: undefined,
          errorDetail: undefined,
          pairStatus: undefined,
        });
      }
    }

    const nextFrom = from + ENQUEUE_CHUNK_SIZE;
    if (nextFrom < accepted.length) {
      await ctx.scheduler.runAfter(0, internal.placeholderPipeline.registerExtractedImages, {
        jobId: args.jobId,
        userId: args.userId,
        entries: args.entries,
        from: nextFrom,
        keptDone,
      });
      return { totalImages: accepted.length, rejectedEntries, keptDone, done: false };
    }

    // Last chunk. Every counter is set from what the rows now say rather than
    // being incremented from wherever the previous attempt left them:
    // `processedImages` starts at the number of done rows we kept, which is
    // what makes `processed + failed === total` still the batch-complete
    // condition after a partial restart.
    await ctx.db.patch(job._id, {
      status: "processing",
      totalImages: accepted.length,
      processedImages: keptDone,
      failedImages: 0,
      rejectedEntries,
    });

    await ctx.scheduler.runAfter(0, internal.placeholderPipeline.pruneUnregisteredImages, {
      jobId: args.jobId,
      acceptedIndexes: accepted.map((e) => e.index),
      from: 0,
    });

    return { totalImages: accepted.length, rejectedEntries, keptDone, done: true };
  },
});

/**
 * Delete this job's image rows whose entry index is not in the accepted set,
 * then hand the batch on to enqueuing (or straight to pairing).
 *
 * A row like that should not be able to exist: the upload is write-once, so a
 * second extract of the same job sees the same zip and produces the same entry
 * indexes. This is a guard on that invariant rather than a routine cleanup —
 * if the assumption were ever wrong, the orphan would be enqueued (it is
 * "queued" from the previous attempt), complete, and increment
 * `processedImages` past `totalImages`, at which point the equality that ends
 * the batch is stepped over and the job never finishes. Cheap guard, expensive
 * failure.
 *
 * It also owns the hand-off, which is why it runs BEFORE enqueuing rather than
 * alongside it: deleting a row the pool is already working on is exactly the
 * race the guard exists to prevent.
 */
export const pruneUnregisteredImages = internalMutation({
  args: {
    jobId: v.string(),
    acceptedIndexes: v.array(v.number()),
    from: v.number(),
  },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const acceptedIndexes = new Set(args.acceptedIndexes);
    const rows = await ctx.db
      .query("placeholderImages")
      .withIndex("by_job_and_index", (q) =>
        q.eq("jobId", args.jobId).gte("entryIndex", args.from),
      )
      .take(ENQUEUE_CHUNK_SIZE);

    let deleted = 0;
    for (const row of rows) {
      if (acceptedIndexes.has(row.entryIndex)) continue;
      await ctx.db.delete(row._id);
      deleted += 1;
    }

    if (rows.length === ENQUEUE_CHUNK_SIZE) {
      await ctx.scheduler.runAfter(0, internal.placeholderPipeline.pruneUnregisteredImages, {
        jobId: args.jobId,
        acceptedIndexes: args.acceptedIndexes,
        from: rows[rows.length - 1].entryIndex + 1,
      });
      return { deleted, done: false };
    }

    const job = await findJob(ctx, args.jobId);
    // Same reasoning as the guard in registerExtractedImages: only hand the
    // batch onward if it is still the running batch. A cancel between
    // registration and this sweep must not be undone by scheduling the next
    // stage on top of it.
    if (!job || job.status !== "processing") return { deleted, done: true };

    const totalImages = job.totalImages ?? 0;
    const settled = (job.processedImages ?? 0) + (job.failedImages ?? 0);
    if (totalImages === 0 || settled >= totalImages) {
      // Two ways to get here, one mechanism: nothing will be enqueued, so no
      // onComplete will ever fire, so the "last one done" transition can never
      // run and the job would spin forever. Either the upload produced no
      // usable images at all, or a restart kept every image already done. Hand
      // it straight to pairing, which owns both terminal decisions.
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

    return { deleted, done: true };
  },
});

/**
 * Enqueue up to ENQUEUE_CHUNK_SIZE queued images onto the pool, then
 * self-schedule for the next chunk.
 *
 * Reads through `by_job_and_index` starting at `from`, so the walk is an index
 * range scan rather than a full-table filter and each chunk resumes exactly
 * where the last one stopped.
 */
export const enqueueImageChunk = internalMutation({
  args: { jobId: v.string(), from: v.number() },
  returns: v.object({ enqueued: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    // Re-checked on EVERY chunk, not just the first. Enqueuing a 1000-image
    // zip is twenty of these mutations, and a cancel landing in the middle
    // must stop the remaining nineteen — each one is fifty more paid
    // `/process-entry` calls. Cancel can only cancel work that exists; this is
    // what stops more of it from being created behind its back.
    const job = await findJob(ctx, args.jobId);
    if (!job || job.status !== "processing") return { enqueued: 0, done: true };

    const rows = await ctx.db
      .query("placeholderImages")
      .withIndex("by_job_and_index", (q) =>
        q.eq("jobId", args.jobId).gte("entryIndex", args.from),
      )
      .take(ENQUEUE_CHUNK_SIZE);

    let enqueued = 0;
    for (const row of rows) {
      // Anything not "queued" is skipped, and that covers two different cases
      // that must both hold: a row already enqueued by an earlier chunk (or a
      // retried invocation of this one — Convex may re-run this mutation on an
      // OCC conflict), and a row a restart deliberately kept in "done". The
      // second is how registerExtractedImages avoids re-paying for work that
      // already succeeded, so this condition must stay a status check and
      // never become "enqueue everything in range".
      if (row.status !== "queued") continue;
      const workId = await preprocessPool.enqueueAction(
        ctx,
        internal.placeholderBatch.processEntryWorker,
        { jobId: args.jobId, userId: row.userId, entryIndex: row.entryIndex },
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
        from: last.entryIndex + 1,
      });
    }

    return { enqueued, done };
  },
});

// ---------------------------------------------------------------------------
// Internal: per-image completion
// ---------------------------------------------------------------------------

/**
 * Size caps on everything the classifier hands back.
 *
 * These fields are a language model's reading of an image the USER uploaded,
 * which makes their content attacker-influenced even though the model is ours:
 * a card scan can be made to carry any text at all, and the classifier will
 * dutifully transcribe it. Nothing downstream needs a player name longer than
 * a couple of hundred characters or more than a handful of names on one card,
 * so the ceiling costs nothing real — and without one, a single oversized
 * value pushes the row past Convex's 1MB document limit, the patch inside the
 * onComplete mutation throws, and the image is left non-terminal forever with
 * the job's counters one short of their total. That is the same failure mode
 * `asDhash` and the `errorDetail` slice exist to prevent: a bad value must
 * cost its own field, never the batch.
 */
export const MAX_FIELD_CHARS = 200;
const MAX_PLAYERS = 8;

/** Narrow an unknown to a non-empty string, capped at MAX_FIELD_CHARS. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_FIELD_CHARS)
    : undefined;
}

/** Narrow an unknown to a finite number, or undefined. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrow an unknown to an array of strings, or undefined — capped at
 * MAX_PLAYERS entries of MAX_FIELD_CHARS each.
 *
 * A mixed array (any non-string element) is rejected outright rather than
 * filtered: dropping elements would silently renumber the list, and
 * `players[0]` is the headline name every caller reads.
 */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string");
  if (strings.length !== value.length) return undefined;
  return strings.slice(0, MAX_PLAYERS).map((s) => s.slice(0, MAX_FIELD_CHARS));
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
    // `body.player` is deliberately not stored: the service derives it as
    // `players[0]`, so a column for it could only ever be a copy that goes
    // stale. Readers take `players[0]` themselves.
    players: asStringArray(body.players),
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

  const totalImages = job.totalImages ?? 0;
  // Exactly one invocation observes equality — Convex mutations are
  // serializable, so the increment and the comparison are in one transaction
  // and two completions cannot both read the same pre-increment counters.
  //
  // Unchanged in substance by the streaming work, and unchanged on purpose. A
  // collecting job never satisfies it (its status is "collecting", not
  // "processing"), which is exactly right: while the scanner is still feeding
  // the job, `processed + failed === total` means "caught up", not "finished".
  // `closePlaceholderStream` is what puts a stream job into "processing", and
  // from that instant this is the same last-one-done trigger zip mode uses.
  const isBatchComplete =
    job.status === "processing" &&
    totalImages > 0 &&
    processedImages + failedImages === totalImages;

  // Incremental pairing: re-pair after a completion so pairs reach the client's
  // `listPlaceholderPairs` subscription as soon as both halves of a card are
  // processed, rather than all at once at the end. Skipped when this completion
  // is the last one — the terminal run below recomputes everything anyway, and
  // scheduling both would race two writers onto the same rows for no gain.
  //
  // `pairingScheduled` is the debounce: at most one run is queued per job at a
  // time, so a batch running three-wide costs a handful of pairing passes rather
  // than one per image. The run clears the latch BEFORE it reads any rows, so a
  // completion landing mid-run always schedules a successor and the last run
  // always sees the last row.
  const shouldScheduleIncrementalPairing =
    !isBatchComplete &&
    INCREMENTAL_PAIRING_STATUSES.has(job.status) &&
    !job.pairingScheduled;

  await ctx.db.patch(job._id, {
    processedImages,
    failedImages,
    // An image finishing is the user's batch making progress, so it counts as
    // activity — otherwise a job whose images each take minutes could be closed
    // by the idle sweep while it was working perfectly well.
    ...(job.status === "collecting" ? { lastActivityAt: Date.now() } : {}),
    ...(shouldScheduleIncrementalPairing ? { pairingScheduled: true } : {}),
  });

  if (isBatchComplete) {
    await ctx.db.patch(job._id, { status: "pairing" });
    await ctx.scheduler.runAfter(0, internal.placeholderPairing.runPairing, {
      jobId: context.jobId,
      userId: job.userId,
      final: true,
    });
  } else if (shouldScheduleIncrementalPairing) {
    // Delayed on purpose — see PAIRING_DEBOUNCE_MS. Completions landing inside
    // the window find `pairingScheduled` already set and ride this run.
    await ctx.scheduler.runAfter(PAIRING_DEBOUNCE_MS, internal.placeholderPairing.runPairing, {
      jobId: context.jobId,
      userId: job.userId,
      final: false,
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
 * `markJobFailed`; together with `cancelPlaceholderBatch` — which makes the
 * same terminal transition from a user-facing mutation, and so cannot call
 * `markJobFailed` — they are the only writers of `finishedAt`, so "the job is
 * over" and "finishedAt is set" can never disagree.
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
      // Absent means "zip" — see the schema comment. Carried here only so the
      // terminal failure detail can say "no images were uploaded" to a scanner
      // user instead of "no images were accepted from the upload", which is zip
      // vocabulary for something they never did.
      mode: v.optional(v.string()),
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
      mode: job.mode,
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
 * the zip, so reading through `by_job_and_index` is part of the algorithm's
 * input, not a display preference.
 *
 * `_id` is returned alongside `entryIndex` so the pairing pass can write its
 * results back BY ID. Pairing runs in an action, so an unbounded stretch of
 * wall-clock time separates this read from those writes; re-finding the row by
 * (jobId, entryIndex) at write time would re-resolve a key that may by then
 * point at a row a restart has replaced. The id either still names the row
 * pairing actually read, or names nothing at all.
 *
 * `pairStatus` comes back too, and is not display data here: incremental pairing
 * re-runs many times per batch, and it patches a row only when the verdict it
 * just computed DIFFERS from what the row already says. Without the current
 * value that comparison is impossible and every run would rewrite every row —
 * which is a reactive re-render of the whole grid per completed image.
 */
export const listDoneImagesForPairing = internalQuery({
  args: { jobId: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("placeholderImages"),
      entryIndex: v.number(),
      originalName: v.string(),
      players: v.optional(v.array(v.string())),
      team: v.optional(v.string()),
      cardNumber: v.optional(v.string()),
      side: v.optional(v.string()),
      textCount: v.optional(v.number()),
      dhash: v.optional(v.string()),
      pairStatus: v.optional(v.union(v.literal("paired"), v.literal("unmatched"))),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("placeholderImages")
      .withIndex("by_job_and_index", (q) => q.eq("jobId", args.jobId))
      .collect();
    return rows
      .filter((r) => r.status === "done")
      .map((r) => ({
        _id: r._id,
        entryIndex: r.entryIndex,
        originalName: r.originalName,
        players: r.players,
        team: r.team,
        cardNumber: r.cardNumber,
        side: r.side,
        textCount: r.textCount,
        dhash: r.dhash,
        pairStatus: r.pairStatus,
      }));
  },
});

/**
 * Resolve one image for a download-URL mint, or answer null.
 *
 * ONE null for every reason it could fail — no such job, someone else's job, no
 * such entry, an entry whose output does not exist yet — so the action above it
 * emits a single indistinguishable error. The first two must be
 * indistinguishable for the reason `findOwnedJob` gives (otherwise this is an
 * existence oracle for other users' job ids). The last two are collapsed in
 * with them because they are the same statement to the caller: there is no
 * image here to hand you. A client that wants to know WHY is already
 * subscribed to `listPlaceholderImages`, which reports every image's status
 * reactively and is the right place to learn that one is still processing.
 *
 * Takes `entryIndex`, never a path — see the `placeholderJobs` table comment in
 * schema.ts. The caller derives the object key from the userId on the verified
 * token, the job it just proved ownership of, and this index.
 */
export const getImageForDownload = internalQuery({
  args: { jobId: v.string(), userId: v.string(), entryIndex: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      imageId: v.id("placeholderImages"),
      /** Absent until the first mint for this image probes for it. */
      outputExtension: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await findOwnedJob(ctx, args.jobId, args.userId);
    if (!job) return null;

    const image = await ctx.db
      .query("placeholderImages")
      .withIndex("by_job_and_index", (q) =>
        q.eq("jobId", args.jobId).eq("entryIndex", args.entryIndex),
      )
      .unique();
    if (!image) return null;
    // "done" is the only status under which `/process-entry` wrote an output
    // object. Minting a URL for anything else hands the caller a link to a 404
    // that looks like an infrastructure fault rather than "not ready yet".
    if (image.status !== "done") return null;

    return { imageId: image._id, outputExtension: image.outputExtension };
  },
});

/**
 * Memoise the extension a download mint discovered for an image's output.
 *
 * Pure cache maintenance — see the `outputExtension` comment in schema.ts. The
 * write is skipped when the column already agrees, so repeated mints for the
 * same image do not wake every `listPlaceholderImages` subscriber, and a row
 * that vanished (a restart swept it while the action was signing) is a no-op
 * rather than an error.
 */
export const recordOutputExtension = internalMutation({
  args: {
    imageId: v.id("placeholderImages"),
    extension: v.union(v.literal("jpg"), v.literal("png"), v.literal("webp")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) return null;
    if (image.outputExtension === args.extension) return null;
    await ctx.db.patch(image._id, { outputExtension: args.extension });
    return null;
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
//
// Return validators follow one rule, and the split is deliberate:
//
//   OURS  (job status, image status, pairStatus, confidence, mechanism) →
//         mirror the schema's literal union exactly. These vocabularies are
//         defined in this repo and written only by code in this repo, so a
//         value outside the union is a bug we want surfaced at the boundary,
//         and every writer is a function whose failure is visible to the
//         caller that triggered it.
//
//   THEIRS (side, croppedSource, errorCode) → stay `v.string()`. The
//         vocabulary belongs to the preprocess service's classifier, and the
//         value is written inside the pool's onComplete mutation. A validator
//         rejection there does not surface anywhere useful: it strands the
//         image row in a non-terminal status, the job's counters never reach
//         their total, and the batch hangs — a whole batch lost because the
//         service added a fourth crop source. Our own literals have no such
//         writer, which is exactly why they can afford to be strict.

const JOB_STATUS_VALIDATOR = v.union(
  v.literal("pending"),
  v.literal("uploaded"),
  v.literal("collecting"),
  v.literal("extracting"),
  v.literal("processing"),
  v.literal("pairing"),
  v.literal("succeeded"),
  v.literal("failed"),
);

export const getPlaceholderJob = query({
  args: { jobId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      jobId: v.string(),
      status: JOB_STATUS_VALIDATOR,
      // Absent means "zip" — the field was added with streaming intake and
      // pre-existing rows never carried it. A client rendering the two flows
      // differently must read it as `mode ?? "zip"`, not as a boolean.
      mode: v.optional(v.union(v.literal("zip"), v.literal("stream"))),
      // Display hint, passed through as stored. Absent stays absent.
      source: v.optional(SOURCE_VALIDATOR),
      createdAt: v.number(),
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
      // Only ever set on a stream job. Returned so the UI can show how long a
      // collecting session has left before the idle sweep closes it
      // (lastActivityAt + PLACEHOLDER_STREAM_IDLE_MS), which is the difference
      // between a batch that "vanished" and one the user was warned about.
      lastActivityAt: v.optional(v.number()),
      totalImages: v.number(),
      processedImages: v.number(),
      failedImages: v.number(),
      rejectedEntries: v.number(),
      pairCount: v.number(),
      // Cumulative identity-resolver calls across every pairing run — see the
      // schema comment. 0 is the healthy value: the adjacency pre-pass should
      // pair a well-ordered scan without consulting identity once. Surfaced so
      // the release E2E can assert it and catch a regression that silently
      // starts paying per image.
      resolverCalls: v.number(),
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
      mode: job.mode,
      source: job.source,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      lastActivityAt: job.lastActivityAt,
      totalImages: job.totalImages ?? 0,
      processedImages: job.processedImages ?? 0,
      failedImages: job.failedImages ?? 0,
      rejectedEntries: job.rejectedEntries ?? 0,
      pairCount: pairs.length,
      resolverCalls: job.resolverCalls ?? 0,
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
      entryIndex: v.number(),
      originalName: v.string(),
      status: v.union(
        // Stream mode only: an upload URL was handed out for this entry and the
        // browser has not confirmed the bytes landed. Not counted in
        // `totalImages`, so a client showing progress must not treat this row as
        // part of the denominator.
        v.literal("awaiting_upload"),
        v.literal("queued"),
        v.literal("processing"),
        v.literal("done"),
        v.literal("failed"),
      ),
      players: v.optional(v.array(v.string())),
      team: v.optional(v.string()),
      cardNumber: v.optional(v.string()),
      side: v.optional(v.string()),
      rotationDegrees: v.optional(v.number()),
      orientConfidence: v.optional(v.number()),
      textCount: v.optional(v.number()),
      croppedSource: v.optional(v.string()),
      dhash: v.optional(v.string()),
      pairStatus: v.optional(
        v.union(v.literal("paired"), v.literal("unmatched")),
      ),
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
      .withIndex("by_job_and_index", (q) => q.eq("jobId", args.jobId))
      .collect();

    return rows.map((r) => ({
      entryIndex: r.entryIndex,
      originalName: r.originalName,
      status: r.status,
      players: r.players,
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

/**
 * The front/back pairs found for a job so far.
 *
 * **These pairs are PROVISIONAL until the job's status is terminal**
 * ("succeeded" or "failed"). Pairing re-runs after image completions rather than
 * only at the end, so this query starts returning rows while the batch is still
 * "collecting" or "processing" — and a later image can legitimately change what
 * an earlier run decided. A card matched by the pool's identity scoring can be
 * re-matched to a better candidate that arrived afterwards, which shows up here
 * as a pair disappearing and a different one taking its place, and an image
 * currently reported `pairStatus: "unmatched"` may still find its partner.
 *
 * Each run recomputes the whole batch from the images done at that moment and
 * writes the difference, so the sequence converges: the state after the terminal
 * run is exactly what a single end-of-batch run would have produced. A UI is
 * therefore free to render these rows live — it just must not present them as
 * final, or persist anything downstream from them, before `finishedAt` is set.
 */
export const listPlaceholderPairs = query({
  args: { jobId: v.string() },
  returns: v.array(
    v.object({
      frontIndex: v.number(),
      backIndex: v.number(),
      player: v.optional(v.string()),
      team: v.optional(v.string()),
      cardNumber: v.optional(v.string()),
      confidence: v.union(
        v.literal("exact"),
        v.literal("fuzzy"),
        v.literal("side-only"),
      ),
      mechanism: v.union(v.literal("adjacency"), v.literal("pool")),
      score: v.number(),
      // The system field, not a column of our own. Renamed on the way out so
      // the client shape stays camelCase and does not look like it is reading an
      // internal field.
      //
      // This is when the pair was FIRST found, not when it was last revised:
      // incremental pairing patches a surviving row in place rather than
      // replacing it, precisely so a pair that has not changed does not churn.
      // A row that flickers here is a genuinely different pair, not the same one
      // re-created.
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
      createdAt: p._creationTime,
    }));
  },
});

// ---------------------------------------------------------------------------
// Admin surface
// ---------------------------------------------------------------------------
//
// Everything above this line is scoped to the caller's own jobs, and the
// ownership check is the security boundary. The two functions below are the
// deliberate exception: an operator has to be able to see that a user's batch is
// wedged and stop it, and neither is possible from inside a per-user view.
//
// The boundary does not disappear, it MOVES — from "is this your job?" to "are
// you an admin?" (`requireAdmin`, which reads the `role` claim on the Convex JWT
// template). Two things follow, and both are deliberate:
//
//   - Cross-user data in the response is the POINT here. `adminListPlaceholderJobs`
//     returns other people's `userId`s and `jobId`s, because an operator who
//     cannot tell whose batch is stuck cannot act on it. That is a different
//     decision from the one the per-user queries make, taken knowingly, for a
//     surface only admins can reach.
//   - The no-objectPath rule does NOT move. It is not an ownership rule — it
//     exists because both service accounts hold bucket-wide read on the
//     placeholder bucket, so a path in ANY response is a step toward turning that
//     grant into a read oracle. Nothing path-shaped appears below.
//
// Placed at the end of the file so these can share `JOB_STATUS_VALIDATOR` with
// the public queries: it is a `const`, so a reference from above it would be a
// temporal dead zone error at module load rather than a compile error.

/**
 * How many jobs one admin page returns.
 *
 * Deliberately a flat cap with no pagination in v1. This is an operator's
 * triage list — "what is running, what is stuck, right now" — and the answer to
 * a question about the present is always near the top of a newest-first list. A
 * hundred rows is far more than the platform produces in a day, and taking a
 * fixed slice off the default `by_creation_time` index means no new index and no
 * unbounded scan. If this ever needs history rather than triage, the fix is a
 * cursor, not a bigger number.
 */
const ADMIN_JOB_PAGE_SIZE = 100;

/**
 * Every user's most recent placeholder jobs, newest first — the operator view.
 *
 * `.order("desc")` on the default creation-time index, then `.take(N)`. No new
 * index is needed for that and none was added: an index exists to make a
 * FILTERED read cheap, and this read has no filter — it is the last N rows of
 * the table, which the default index already answers directly.
 *
 * **`pairCount` is deliberately absent**, unlike `getPlaceholderJob`. Computing
 * it means a `placeholderPairs` query per job, so including it would turn one
 * indexed read into 1 + 100 of them on every poll of an admin page that is
 * expected to sit open and refresh. It also answers a question triage does not
 * ask: an operator deciding whether to abort a run needs its status and its
 * progress counters, not how many cards it has paired so far. An admin who wants
 * that detail for one job can open that job.
 *
 * `mode` is defaulted here rather than returned raw — absent means "zip", per the
 * schema's reader rule — so the UI never has to encode that rule a second time.
 */
export const adminListPlaceholderJobs = query({
  args: {},
  returns: v.array(
    v.object({
      jobId: v.string(),
      // Another user's id, on purpose. See the section comment.
      userId: v.string(),
      mode: v.union(v.literal("zip"), v.literal("stream")),
      // Which client started it — the "scanner CLI vs web app" column. Absent
      // stays absent (older rows, or a client that did not say).
      source: v.optional(SOURCE_VALIDATOR),
      status: JOB_STATUS_VALIDATOR,
      totalImages: v.number(),
      processedImages: v.number(),
      failedImages: v.number(),
      rejectedEntries: v.number(),
      // Same regression signal the per-user query exposes, defaulted the same
      // way — an operator scanning the triage list should be able to spot a
      // batch that fell through to the resolver without opening it.
      resolverCalls: v.number(),
      createdAt: v.number(),
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
      lastActivityAt: v.optional(v.number()),
      errorCode: v.optional(v.string()),
      // NOTE: no `objectPath`, and no `errorDetail`. The first is the standing
      // rule (see the section comment). The second is a judgement: `errorDetail`
      // can carry an upstream phrase about one user's upload, and a triage list
      // needs the low-cardinality `errorCode` it groups on, not free text about
      // someone else's data.
    }),
  ),
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const jobs = await ctx.db
      .query("placeholderJobs")
      .order("desc")
      .take(ADMIN_JOB_PAGE_SIZE);

    return jobs.map((job) => ({
      jobId: job.jobId,
      userId: job.userId,
      mode: job.mode ?? ("zip" as const),
      // Passed through as stored — absent stays absent (unlike `mode`, there is
      // no sensible default for "which client", so the UI shows "unknown").
      source: job.source,
      status: job.status,
      totalImages: job.totalImages ?? 0,
      processedImages: job.processedImages ?? 0,
      failedImages: job.failedImages ?? 0,
      rejectedEntries: job.rejectedEntries ?? 0,
      resolverCalls: job.resolverCalls ?? 0,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      lastActivityAt: job.lastActivityAt,
      errorCode: job.errorCode,
    }));
  },
});

/**
 * Abort any user's batch, as an operator.
 *
 * The same cancel as the user's own — literally, via `cancelJobImpl`. Only the
 * authorization differs: `requireAdmin` in place of the ownership check, and the
 * job is resolved with `findJob` (no owner filter) rather than `findOwnedJob`.
 * Everything after that point is shared code, so an admin abort and a user
 * cancel cannot diverge in what they leave behind.
 *
 * The audit line is written BEFORE the cancel runs, not after, and that ordering
 * is the point of having one: a trace that only appears on success is not an
 * audit trail, it is a success log. If the cancel throws — an OCC conflict, a
 * pool error — the record that an administrator reached into another user's job
 * still exists. It names the admin, the target user and the job, and nothing
 * else; there is no free text and no upload detail in it.
 *
 * Returns the same `{canceled, canceledCount, reason?}` shape as the user path,
 * including the soft `{canceled: false}` for an already-terminal job — an
 * operator clicking Abort on a run that finished a second ago is ordinary UI
 * behaviour, not an error.
 */
export const adminCancelPlaceholderBatch = mutation({
  args: { jobId: v.string() },
  returns: CANCEL_RESULT_VALIDATOR,
  handler: async (ctx, args) => {
    const adminUserId = await requireAdmin(ctx);

    const job = await findJob(ctx, args.jobId);
    // A plain throw, unlike the user path's deliberately-ambiguous "Job not
    // found": there is no existence oracle to protect against here, because the
    // caller is already authorized to enumerate every job in the table.
    if (!job) throw new Error("Job not found");

    console.log(
      JSON.stringify({
        msg: "admin_cancel",
        jobId: job.jobId,
        targetUserId: job.userId,
        adminUserId,
      }),
    );

    return cancelJobImpl(ctx, job, "admin");
  },
});
