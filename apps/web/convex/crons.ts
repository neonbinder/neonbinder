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

export default crons;
