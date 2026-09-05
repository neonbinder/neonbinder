/**
 * Scheduled jobs (NEO-170).
 *
 * Convex discovers crons from this file by name — `convex/crons.ts` with a
 * `cronJobs()` object as the default export — so a job that is not registered
 * here does not run, no matter what else references it.
 *
 * Keep the handlers themselves out of this file. Every entry below points at an
 * internal function that lives with the feature it belongs to, so the code that
 * knows WHY a sweep exists sits next to the code the sweep is cleaning up after,
 * and this file stays a schedule rather than a second place to look for
 * behaviour.
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Close scanner sessions the user walked away from.
 *
 * `interval` rather than a fixed time of day: this is a timeout, and a timeout
 * checked once a day would mean an abandoned session holding an active-job slot
 * for up to 24 hours. Ten minutes bounds the overshoot past
 * PLACEHOLDER_STREAM_IDLE_MS (30 minutes) at a third of the timeout itself,
 * which is close enough that "about half an hour" stays an honest description,
 * while keeping the sweep to 144 runs a day — and the common run reads one empty
 * index range and stops (see `sweepIdleStreams`).
 *
 * Deliberately NOT tuned to fire more often. The cost of being late is a slot
 * held slightly longer; there is no correctness deadline here, because a
 * collecting job is inert until its owner comes back.
 */
crons.interval(
  "close idle placeholder streams",
  { minutes: 10 },
  internal.placeholderStream.sweepIdleStreams,
  {},
);

/**
 * Detect and self-heal placeholder batches whose progress has stranded.
 *
 * The safety net behind the per-job settle lock (f9eb1da): that lock closes the
 * known counter-race, and this catches any future or unknown drift, a lost
 * scheduled function, or a completion that never landed — the failure that would
 * otherwise leave a batch hung at "5 of 6 processed" forever, unnoticed. See
 * `sweepWedgedBatches` for the integrity check and the alertable PostHog event.
 *
 * `interval`, and fifteen minutes: the detection threshold is thirty (a stalled
 * batch must miss it before this acts), so a tighter cadence would only re-scan
 * the same not-yet-stale jobs. Fifteen bounds the heal latency to about
 * threshold + interval while keeping this to 96 runs a day — and, like the idle
 * sweep above, the common run reads a few empty index ranges and stops, because
 * a healthy deployment has no stale active jobs to inspect.
 */
crons.interval(
  "heal wedged placeholder batches",
  { minutes: 15 },
  internal.placeholderWatchdog.sweepWedgedBatches,
  {},
);

/**
 * Age review rows stranded on `pending` to `error` (NEO-99).
 *
 * The last-resort net behind the Wikidata pool's `onComplete` backstop and the
 * `runSparql` fetch timeout: if a lookup work item is lost so completely that
 * its completion callback never fires, this is what stops the entity-review
 * wizard hanging on "Looking up…" forever. Like the two sweeps above it is an
 * `interval` (a timeout, not a time-of-day job), fifteen minutes against a
 * thirty-minute staleness threshold, and the common run reads the oldest few
 * pending rows, finds none stale, and stops — see `sweepStalePendingRows`.
 */
crons.interval(
  "age stale entity-review lookups",
  { minutes: 15 },
  internal.entityReviewQueue.sweepStalePendingRows,
  {},
);

/**
 * NEO-195 — reap checklist candidates whose fetch never finished.
 *
 * Confirm and cancel both clean up after themselves; this covers the run that
 * simply died — closed tab, unhandled throw. Hourly against a one-hour
 * staleness threshold, so a live fetch (~80s at worst) is never touched.
 */
crons.interval(
  "reap abandoned checklist candidates",
  { hours: 1 },
  internal.checklistCandidates.sweepStaleCandidates,
  {},
);

/**
 * NEO-221 — delete entity-review batches nobody is coming back to.
 *
 * A separate entry from "age stale entity-review lookups" above, and
 * deliberately so: that one is about a single row's LOOKUP hanging (30
 * minutes, `pending` → `error`, deletes nothing), while this is about the
 * SESSION ending — a closed tab leaves a batch of perfectly healthy rows that
 * `startBatch` would otherwise resume into the next fetch of that set, weeks
 * later, complete with decisions made against a card list that has moved on.
 *
 * Hourly against a 24-hour threshold, matching the checklist-candidate reaper
 * next to it: the cost of being an hour late is nothing, and the common run
 * samples the oldest few rows, finds them all fresh, and stops — see
 * `sweepAbandonedBatches`.
 */
crons.interval(
  "reap abandoned entity-review batches",
  { hours: 1 },
  internal.entityReviewQueue.sweepAbandonedBatches,
  {},
);

export default crons;
