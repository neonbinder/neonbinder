/**
 * "3m ago" — coarse relative timestamps for operator screens (NEO-170).
 *
 * WHY NOT `Intl.RelativeTimeFormat`: it formats ONE unit you have already
 * chosen ("in 3 minutes" / "3 minutes ago"), so the part that actually matters
 * here — picking the unit, and doing it monotonically — is still hand-written.
 * What it would add is locale-correct wording, and this string is read by an
 * operator triaging a pipeline next to `12/40 images`; short and dense beats
 * grammatical.
 *
 * `now` is a parameter, not a `Date.now()` call inside the branches, for two
 * reasons: a list of twenty rows must be measured against ONE instant (rows
 * formatted a few milliseconds apart could otherwise disagree about which side
 * of a boundary they are on), and it makes every case below testable without
 * faking timers.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Anything fresher than this reads as "just now" rather than "0m ago" or a
 * seconds counter that changes on every render.
 */
const JUST_NOW_MS = 45 * SECOND;

/**
 * A short, past-tense relative time — "just now", "5m ago", "3h ago", "2d ago".
 *
 * Units step at their own boundary and never round up into the next one:
 * `Math.floor` with a floor of 1 means 59.9 minutes is "59m ago", not "60m
 * ago", and 23.9 hours is "23h ago", not "24h ago". Rounding produced labels
 * that named a unit the value had not reached yet, which on a page whose whole
 * job is "how long has this been stuck" is the one thing it must not do.
 *
 * A timestamp in the future — clock skew between the server that wrote it and
 * the browser reading it — is reported as "just now" rather than a negative
 * age, because "in 2 minutes ago" is worse than slightly wrong.
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const elapsed = now - timestamp;
  if (!Number.isFinite(elapsed) || elapsed < JUST_NOW_MS) return "just now";
  if (elapsed < HOUR) return `${Math.max(1, Math.floor(elapsed / MINUTE))}m ago`;
  if (elapsed < DAY) return `${Math.max(1, Math.floor(elapsed / HOUR))}h ago`;
  return `${Math.max(1, Math.floor(elapsed / DAY))}d ago`;
}

/**
 * The full timestamp, for the `title` and `dateTime` of a `<time>` element.
 *
 * The relative label is what an operator reads; this is what they need when
 * they have to correlate a run with a log line, and it is why the relative
 * label can afford to be coarse.
 */
export function formatAbsoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}
