/**
 * Wedged-batch watchdog (NEO-170).
 *
 * The safety net behind the per-job settle lock (f9eb1da). That lock closes the
 * KNOWN way a batch's progress counter can fall short of its terminal image rows
 * — the workpool settling several completions in one transaction and losing all
 * but one read-modify-write increment. This sweep is what catches the class the
 * lock does not: any FUTURE or unknown counter drift, a lost scheduled function,
 * a `/process-entry` whose completion never landed. It turns "the batch hangs at
 * '5 of 6 processed' forever, and nobody knows" into "the batch is detected,
 * an alert fires, and it self-heals within one threshold window".
 *
 * The single load-bearing signal is an INTEGRITY CHECK: count the terminal image
 * rows (`done` + `failed`) for a job through its by-job index, and compare that
 * to the job's own `processedImages + failedImages` counter. A mismatch is the
 * exact fingerprint of the stranded-counter bug — the images all reached a
 * terminal state (distinct rows) but the counter that decides "last one done"
 * fell behind, so `processed + failed === totalImages` is never observed and the
 * hand-off to pairing never fires.
 *
 * The remediation reuses the pipeline's own transitions rather than copying them
 * (`driveBatchToPairing`, `markJobFailedImpl` in placeholderPipeline.ts), so a
 * healed batch takes exactly the path a healthy one would have. It is
 * idempotent, ownership-preserving (it never changes `userId` and never reads or
 * writes an `objectPath`), and cheap: the common run reads a handful of empty
 * index ranges and stops.
 *
 * ── PostHog event ────────────────────────────────────────────────────────────
 *   event: "placeholder_batch_wedged"
 *   distinctId: the batch owner's Clerk user id (id only — never an email/name)
 *   properties:
 *     jobId, userId          // opaque ids, never a path — see schema.ts
 *     mode                   // "zip" | "stream"
 *     status                 // the job status when the wedge was detected
 *     remediation            // what the watchdog did (see WedgeRemediation)
 *     totalImages            // the job's expected image count
 *     storedProcessed        // processedImages BEFORE remediation
 *     storedFailed           // failedImages BEFORE remediation
 *     trueDone, trueFailed   // recounted from the actual rows
 *     trueTerminal           // trueDone + trueFailed
 *     nonTerminal            // rows still queued/processing/awaiting_upload
 *     mismatchDelta          // trueTerminal - (storedProcessed + storedFailed)
 *     countersDrifted        // the integrity check verdict
 *     stuckEntryIndexes      // sample of non-terminal entry indexes (positions, not PII)
 *     staleMs                // how long since the job last made progress
 *     deployment             // prod / dev / preview slug (NEO-43), so one PostHog
 *                            // project can alert per-environment
 *
 *   ALERT: this event should never fire in steady state — the settle lock keeps
 *   the fast path whole, so every occurrence is either a real regression of that
 *   invariant or a lost scheduled function. Wire a PostHog alert on the COUNT of
 *   `placeholder_batch_wedged` per rolling hour, filtered to
 *   `deployment = "first-starfish-800"` (prod — same environment filter the
 *   NEO-43 credential alerts use, so preview/dev noise never pages). A threshold
 *   of >0 per hour is defensible for prod; the `remediation` property tells the
 *   responder whether it healed (recompute_completed / repaired_pairing) or gave
 *   up (marked_wedged), and `jobId` points straight at the batch to inspect.
 *   The dual-written `console.warn` line (msg "placeholder_batch_wedged") is the
 *   fallback channel if POSTHOG_API_KEY is unset, matching observability.ts.
 */

import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  ENQUEUE_CHUNK_SIZE,
  driveBatchToPairing,
  markJobFailedImpl,
} from "./placeholderPipeline";
import { PLACEHOLDER_MAX_ENTRY_INDEX } from "./lib/placeholderObjects";
import { deploymentName } from "./observability";

/**
 * How long a job may go without making progress before the watchdog treats it
 * as wedged.
 *
 * Sized against the worst-case time for a SINGLE image to settle, not against
 * the whole batch — because `lastActivityAt` is a live progress heartbeat
 * (settle bumps it on every completion; see settleImageOutcome), so a healthy
 * batch of any size refreshes it every few seconds and never goes stale. The
 * only thing that makes it stale is genuinely no image completing.
 *
 * The worst-case single image is a preprocess call that exhausts its retry
 * budget: 5 attempts, each up to PREPROCESS_FETCH_TIMEOUT_MS (4 min), plus
 * ~75s of cumulative backoff (see placeholderPool.ts) — about 21 minutes before
 * that one image settles as failed, during which no OTHER image is completing
 * only if it is the last one in flight. Thirty minutes clears that worst case
 * with room to spare, so "no completion in 30 minutes" is a genuine stall rather
 * than a slow tail. It also comfortably outlasts extraction, which self-fails in
 * ~12 minutes (three attempts, see runExtract).
 *
 * Erring long is deliberate: a false positive here FAILS a healthy batch, while
 * a false negative only delays a heal the settle lock has already made rare.
 * This is a safety net, not a deadline — it does not need to be fast, it needs
 * to never fire on healthy work.
 */
export const PLACEHOLDER_WEDGE_STALE_MS = 30 * 60 * 1000;

/**
 * The non-terminal statuses this sweep inspects. Terminal ("succeeded",
 * "failed") jobs are done; "pending"/"uploaded" have not started, so there is
 * nothing to strand. Kept in sync with schema.ts by construction — a status
 * that is neither terminal nor pre-start is a status a batch can hang in.
 */
const WATCHDOG_SCAN_STATUSES = [
  "extracting",
  "processing",
  "pairing",
  "collecting",
] as const satisfies ReadonlyArray<Doc<"placeholderJobs">["status"]>;

/**
 * Jobs remediated per invocation before self-scheduling the remainder. Each
 * remediation reads up to one job's worth of image rows, so this bounds the
 * transaction the way sweepIdleStreams' ENQUEUE_CHUNK_SIZE take does — a mass
 * strand after an incident is drained across several runs, not one giant one.
 * Small because the common run has zero candidates and this only matters in the
 * pathological case.
 */
const WATCHDOG_MAX_JOBS_PER_RUN = 10;

/** How many non-terminal entry indexes to sample into the event. Low-cardinality
 *  on purpose: enough to point triage at the stuck images, not the whole list. */
const WATCHDOG_MAX_STUCK_SAMPLE = 20;

type WedgeRemediation =
  // Counters were short of the terminal rows; recomputed them and, because every
  // row was terminal, drove the same hand-off to pairing settle would have.
  | "recompute_completed"
  // Every row terminal but the job was stuck in "pairing" — the final pairing
  // run was lost; re-drove it.
  | "repaired_pairing"
  // Non-terminal rows remained past the threshold (their work was lost), or an
  // extract action was lost; failed the job terminally so it stops hanging.
  | "marked_wedged"
  // A still-collecting stream whose counter had drifted; fixed the counter only
  // — a live stream is never force-completed or failed by this sweep.
  | "recompute_collecting";

/**
 * Detect and self-heal batches whose progress has stranded — the cron target
 * (crons.ts). See the file header for the integrity check and the event schema.
 *
 * Reads through `by_status_and_activity` (equality on status, upper-bounded on
 * `lastActivityAt`), so the common run — nothing stale — reads a few empty index
 * ranges and returns. Bounded per invocation and self-scheduling for the
 * remainder, mirroring sweepIdleStreams.
 */
export const sweepWedgedBatches = internalMutation({
  args: {},
  returns: v.object({
    inspected: v.number(),
    remediated: v.number(),
    done: v.boolean(),
  }),
  handler: async (ctx) => {
    const cutoff = Date.now() - PLACEHOLDER_WEDGE_STALE_MS;

    // Gather stale candidates across every active status. `lastActivityAt` is
    // seeded when a job goes active and bumped on every completion, so a stale
    // value means "no progress in a while" for zip and stream jobs alike.
    const candidates: Doc<"placeholderJobs">[] = [];
    for (const status of WATCHDOG_SCAN_STATUSES) {
      const rows = await ctx.db
        .query("placeholderJobs")
        .withIndex("by_status_and_activity", (q) =>
          q.eq("status", status).lt("lastActivityAt", cutoff),
        )
        .take(ENQUEUE_CHUNK_SIZE);
      candidates.push(...rows);
    }

    let inspected = 0;
    let remediated = 0;
    for (const job of candidates) {
      if (inspected >= WATCHDOG_MAX_JOBS_PER_RUN) break;
      inspected += 1;
      if (await remediateWedgedJob(ctx, job)) remediated += 1;
    }

    // Self-schedule only when there is more real work AND this run made progress
    // (each remediated job leaves the stale set — its status goes terminal or its
    // heartbeat is refreshed — so the chain strictly shrinks and cannot loop on
    // candidates it keeps deciding to leave alone).
    const done = !(candidates.length > WATCHDOG_MAX_JOBS_PER_RUN && remediated > 0);
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.placeholderWatchdog.sweepWedgedBatches, {});
    }

    return { inspected, remediated, done };
  },
});

/**
 * Inspect one stale candidate and, if it is genuinely wedged, heal it. Returns
 * whether it acted (for the run's `remediated` count and its self-schedule
 * decision). Never throws for a data condition — a batch it cannot understand is
 * left untouched rather than damaged.
 */
async function remediateWedgedJob(
  ctx: MutationCtx,
  job: Doc<"placeholderJobs">,
): Promise<boolean> {
  const now = Date.now();
  // Defensive re-check against the job's own clock. `startedAt`/`createdAt` are
  // the fallbacks for a job that never recorded activity, so a freshly-started
  // batch that merely lacks a heartbeat is never mistaken for a stalled one.
  const lastActivity = job.lastActivityAt ?? job.startedAt ?? job.createdAt;
  if (lastActivity >= now - PLACEHOLDER_WEDGE_STALE_MS) return false;

  // Every image row for this job, in one bounded read: the by-job index prefix,
  // capped at the per-job entry ceiling so it is one batch's rows and never a
  // table scan. This is the integrity check's source of truth.
  const images = await ctx.db
    .query("placeholderImages")
    .withIndex("by_job_and_index", (q) => q.eq("jobId", job.jobId))
    .take(PLACEHOLDER_MAX_ENTRY_INDEX + 1);

  let trueDone = 0;
  let trueFailed = 0;
  const stuckEntryIndexes: number[] = [];
  for (const img of images) {
    if (img.status === "done") {
      trueDone += 1;
    } else if (img.status === "failed") {
      trueFailed += 1;
    } else if (stuckEntryIndexes.length < WATCHDOG_MAX_STUCK_SAMPLE) {
      // queued / processing / awaiting_upload — non-terminal. entryIndex is a
      // position in the batch, never a path or PII (see schema.ts).
      stuckEntryIndexes.push(img.entryIndex);
    }
  }
  const trueTerminal = trueDone + trueFailed;
  const nonTerminal = images.length - trueTerminal;

  const storedProcessed = job.processedImages ?? 0;
  const storedFailed = job.failedImages ?? 0;
  const totalImages = job.totalImages ?? 0;

  // THE fingerprint: the job's counter disagreeing with the terminal rows.
  const countersDrifted =
    trueDone !== storedProcessed || trueFailed !== storedFailed;

  let remediation: WedgeRemediation;

  if (job.status === "collecting") {
    // A live stream. Staleness alone is sweepIdleStreams' concern, not ours — so
    // the ONLY thing that justifies touching a collecting job is a counter drift,
    // which would otherwise strand it the moment the stream closes into
    // "processing". Fix the counter and nothing else: never force-complete or
    // fail a stream the scanner may still be feeding, and never touch
    // `lastActivityAt` (that is the idle clock sweepIdleStreams reads).
    if (!countersDrifted) return false;
    await ctx.db.patch(job._id, {
      processedImages: trueDone,
      failedImages: trueFailed,
    });
    remediation = "recompute_collecting";
  } else if (job.status === "extracting") {
    // runExtract self-terminates within ~12 minutes (placeholderBatch.ts); a job
    // still extracting past the threshold means the extract action itself was
    // lost, and there is no partial state to salvage. Fail it terminally so it
    // stops holding an active-job slot — "failed" is a startable status for zip,
    // so the user simply restarts and extraction re-runs cleanly.
    await markJobFailedImpl(
      ctx,
      job,
      "WEDGED",
      "extraction stalled past the wedge threshold without registering images",
    );
    remediation = "marked_wedged";
  } else {
    // "processing" or "pairing": the states a batch strands in when the
    // last-one-done transition (or the final pairing run) never fired.
    if (nonTerminal === 0) {
      // Every image is terminal, so the batch IS complete — recompute the
      // counter if it drifted, refresh the heartbeat so a self-scheduled pass
      // does not re-pick this same job, then drive the exact hand-off settle
      // makes. `driveBatchToPairing` is a no-op status-wise for a job already in
      // "pairing" and re-schedules its final run — which is precisely the repair
      // for a lost pairing action.
      await ctx.db.patch(job._id, {
        ...(countersDrifted
          ? { processedImages: trueDone, failedImages: trueFailed }
          : {}),
        lastActivityAt: now,
      });
      await driveBatchToPairing(ctx, job);
      remediation =
        job.status === "pairing" ? "repaired_pairing" : "recompute_completed";
    } else {
      // Non-terminal rows remain past the threshold: their workpool work was lost
      // and will never complete, so the batch can never reach its total. Fail it
      // terminally rather than let it hang; a restart keeps the rows already done.
      await markJobFailedImpl(
        ctx,
        job,
        "WEDGED",
        `${nonTerminal} of ${totalImages} images stalled non-terminal past the wedge threshold`,
      );
      remediation = "marked_wedged";
    }
  }

  await emitWedgedEvent(ctx, job, {
    jobId: job.jobId,
    userId: job.userId,
    mode: job.mode ?? "zip",
    status: job.status,
    remediation,
    totalImages,
    storedProcessed,
    storedFailed,
    trueDone,
    trueFailed,
    trueTerminal,
    nonTerminal,
    mismatchDelta: trueTerminal - (storedProcessed + storedFailed),
    countersDrifted,
    stuckEntryIndexes,
    staleMs: now - lastActivity,
  });

  return true;
}

/**
 * Dual-write the wedge signal: a structured `console.warn` line that survives an
 * unset POSTHOG_API_KEY (Convex logs are the fallback channel), then the PostHog
 * event through the same `internal.posthog.captureEvent` path `recordAdapterCall`
 * uses. Scheduled rather than awaited-as-an-action because this runs in a
 * mutation; a mutation cannot call an action inline, and observability must not
 * be able to fail the remediation it is reporting.
 *
 * The property bag is an explicit allowlist of ids, counts and positions — no
 * `objectPath`, no filename, no card content. See the event schema in the file
 * header and the no-PII rule in observability.ts.
 */
async function emitWedgedEvent(
  ctx: MutationCtx,
  job: Doc<"placeholderJobs">,
  properties: Record<string, unknown>,
): Promise<void> {
  const payload = { ...properties, deployment: deploymentName() };
  try {
    console.warn(JSON.stringify({ msg: "placeholder_batch_wedged", ...payload }));
  } catch {
    // unreachable but defensive — never let logging fail the sweep
  }
  await ctx.scheduler.runAfter(0, internal.posthog.captureEvent, {
    distinctId: job.userId,
    event: "placeholder_batch_wedged",
    properties: payload,
  });
}
