import { SYNC_REPORT_GROUP_COUNT_CAP } from "@/lib/collection/sync-report";

/**
 * NEO-536 — the words the admin's Sync reports list and review say. Admin
 * copy: plain, short, about the collector rather than to them.
 */

/** "+3 reported", "20+ more reported" at the server's count cap, nothing for none. */
export function alsoReportedLine(n: number): string | null {
  if (n <= 0) return null;
  return n >= SYNC_REPORT_GROUP_COUNT_CAP ? `${SYNC_REPORT_GROUP_COUNT_CAP}+ more reported` : `+${n} reported`;
}

/** The review's long form: "Also reported by 2 other collectors". */
export function alsoReportedSentence(n: number): string | null {
  if (n <= 0) return null;
  const count = n >= SYNC_REPORT_GROUP_COUNT_CAP ? `${SYNC_REPORT_GROUP_COUNT_CAP}+` : String(n);
  return `Also reported by ${count} other ${n === 1 ? "collector" : "collectors"}. Closing this closes theirs too.`;
}

const DAY = 24 * 60 * 60 * 1000;

/** How long a report has waited: "sent today", "waiting 1 day", "waiting 12 days", "waiting 3 weeks". */
export function waitedFor(since: number, now: number): string {
  const days = Math.max(0, Math.floor((now - since) / DAY));
  if (days === 0) return "sent today";
  if (days < 14) return `waiting ${days} ${days === 1 ? "day" : "days"}`;
  return `waiting ${Math.floor(days / 7)} weeks`;
}

/** "1 card held back" / "12 cards held back". */
export function heldBackWords(n: number): string {
  return `${n} ${n === 1 ? "card" : "cards"} held back`;
}
