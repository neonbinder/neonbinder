import { SYNC_REPORT_GROUP_COUNT_CAP } from "@/lib/collection/sync-report";

/**
 * NEO-536 — the words the admin's Sync reports list and review say, and the
 * dashboard's "From collectors" rows with them. Admin copy: plain, short,
 * about the collector rather than to them.
 */

/** How many other collectors, spoken: "3", or "20 or more" at the server's count cap. */
function othersCount(n: number): string {
  return n >= SYNC_REPORT_GROUP_COUNT_CAP ? `${SYNC_REPORT_GROUP_COUNT_CAP} or more` : String(n);
}

/**
 * The short tag on a row, the same on Card Requests and the dashboard: "+3
 * reported", "20+ reported" at the server's count cap, nothing for none.
 * Seen only: a reader gets `alsoReportedSpoken` in its place.
 */
export function alsoReportedLine(n: number): string | null {
  if (n <= 0) return null;
  return n >= SYNC_REPORT_GROUP_COUNT_CAP ? `${SYNC_REPORT_GROUP_COUNT_CAP}+ reported` : `+${n} reported`;
}

/** What a reader hears for the tag: "also reported by 3 other collectors", "… 20 or more …". */
export function alsoReportedSpoken(n: number): string | null {
  if (n <= 0) return null;
  return `also reported by ${othersCount(n)} other ${n === 1 ? "collector" : "collectors"}`;
}

/** The review's long form: "Also reported by 2 other collectors. Closing this closes theirs too." */
export function alsoReportedSentence(n: number): string | null {
  const spoken = alsoReportedSpoken(n);
  if (!spoken) return null;
  return `${spoken.charAt(0).toUpperCase()}${spoken.slice(1)}. Closing this closes theirs too.`;
}

const DAY = 24 * 60 * 60 * 1000;

/** How long a report has waited: "sent today", "waiting 1 day", "waiting 12 days", "waiting 3 weeks". */
export function waitedFor(since: number, now: number): string {
  const days = Math.max(0, Math.floor((now - since) / DAY));
  if (days === 0) return "sent today";
  if (days < 14) return `waiting ${days} ${days === 1 ? "day" : "days"}`;
  return `waiting ${Math.floor(days / 7)} weeks`;
}

/**
 * When a report or an ask happened, one way everywhere it is shown: the
 * dashboard's crew rows (read, to tell two asks of one name apart) and the
 * admin's review. "Nov 13, 2026, 3:05 PM" in the reader's own locale, no seconds.
 */
export function syncReportWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The ink "+N reported" wears wherever it shows: the tag on the dashboard and
 * Card Requests (`AlsoReportedTag`) and the review's sentence. Blue, the
 * crew's colour, never the warning amber: more reports are news, not trouble.
 */
export const ALSO_REPORTED_INK = "text-neon-blue-text";

/** "1 card held back" / "12 cards held back". */
export function heldBackWords(n: number): string {
  return `${n} ${n === 1 ? "card" : "cards"} held back`;
}
