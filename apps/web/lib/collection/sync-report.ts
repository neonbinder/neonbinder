/**
 * NEO-536 — which held-back cards a collector can report to the admin team.
 *
 * A sync holds a card back for one of NB's own reasons
 * (`convex/schema.ts` `listingProblemReasonValidator`). Some of those the
 * collector fixes themselves (a price, a condition, a photo, their eBay
 * settings); the rest live in NB's shared catalog or in how NB reads the
 * platform, so only the admin team can fix them. Only that second kind is
 * reportable, and a failed sync is not a report at all (NB tries it again on
 * the next sync).
 *
 * Env-free: the dashboard decides whether to offer "Report" with this, and
 * `convex/syncReports.ts` decides what a report copies with the same rule.
 */

/** Reasons only the admin team can fix: the card's link, its sheet row, or what the platform said. */
export const REPORTABLE_SYNC_REASONS = [
  "noLink",
  "sharedLink",
  "numberMismatch",
  "notOnSheet",
  "rejected",
  "missingAspect",
] as const;

export type ReportableSyncReason = (typeof REPORTABLE_SYNC_REASONS)[number];

const REPORTABLE: ReadonlySet<string> = new Set(REPORTABLE_SYNC_REASONS);

/** True for a held-back reason the collector cannot fix themselves. */
export function isReportableSyncReason(reason: string): reason is ReportableSyncReason {
  return REPORTABLE.has(reason);
}

/** Does any of these held-back cards carry a reason worth reporting? */
export function hasReportableCard(cards: ReadonlyArray<{ reason: string }>): boolean {
  return cards.some((c) => isReportableSyncReason(c.reason));
}

/** Held-back cards one report keeps (the rest still count in its `heldBack`). */
export const MAX_SYNC_REPORT_CARDS = 30;
/** Open reports one collector may hold at once. */
export const MAX_OPEN_SYNC_REPORTS = 50;
/** A collector's note on a report, and an admin's note when closing one. */
export const MAX_SYNC_REPORT_NOTE = 500;
/** The problem detail a report snapshots, for `rejected` and `missingAspect` only. */
export const MAX_SYNC_REPORT_DETAIL = 200;
/**
 * Reports one admin "close" settles at once (every open report on that set
 * and platform). Past it the close refuses rather than half-doing it.
 */
export const MAX_SYNC_REPORT_GROUP = 100;
/**
 * The admin queue counts the other collectors who reported the same set at
 * most this far: `alsoReportedBy` equal to it reads "20+".
 */
export const SYNC_REPORT_GROUP_COUNT_CAP = 20;

/**
 * The detail a report keeps for one held-back card: what the platform said
 * (`rejected`) or the field it asked for (`missingAspect`), trimmed and cut
 * to `MAX_SYNC_REPORT_DETAIL`. Display-only for the admin, never NB data.
 * Every other reason keeps none.
 */
export function syncReportDetail(reason: string, detail: string | undefined): string | undefined {
  if (reason !== "rejected" && reason !== "missingAspect") return undefined;
  const trimmed = detail?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_SYNC_REPORT_DETAIL ? trimmed.slice(0, MAX_SYNC_REPORT_DETAIL) : trimmed;
}

/**
 * What a report copies from a sync's held-back list: the reportable problems
 * that name an NB card (a platform row NB cannot tie to a card names none),
 * at most `MAX_SYNC_REPORT_CARDS`, and how many there are in all.
 */
export function reportableProblems<R extends string, C>(
  problems: ReadonlyArray<{ cardId?: C; reason: R; detail?: string }>,
): { cards: Array<{ cardId: C; reason: R; detail?: string }>; heldBack: number } {
  const cards: Array<{ cardId: C; reason: R; detail?: string }> = [];
  let heldBack = 0;
  for (const p of problems) {
    if (p.cardId === undefined || !isReportableSyncReason(p.reason)) continue;
    heldBack += 1;
    if (cards.length >= MAX_SYNC_REPORT_CARDS) continue;
    const detail = syncReportDetail(p.reason, p.detail);
    cards.push({ cardId: p.cardId, reason: p.reason, ...(detail !== undefined ? { detail } : {}) });
  }
  return { cards, heldBack };
}
