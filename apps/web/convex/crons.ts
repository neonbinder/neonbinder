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

export default crons;
