/**
 * NEO-339 — does a checklist sync diff hold anything a human has to look at?
 *
 * One answer for both callers: `CardChecklist` asks it before mounting the
 * sync-review dialog (a re-sync that changed nothing and orphaned nothing must
 * not put a modal in front of the operator that they can only click through),
 * and the set-building tool asks it before a commit (it builds checklists and
 * refuses to re-sync one). They used to carry two copies kept in step by a
 * comment.
 *
 * Conflicts count as reviewable even though the operator cannot resolve them
 * into the commit: cards being held back is exactly the kind of thing that
 * must not happen silently.
 *
 * Structural rather than the query's return type, so this stays pure and
 * env-free (a Node script loads it) and both callers' diff types fit.
 */

export type SyncReviewDiff = {
  conflicts: ReadonlyArray<unknown>;
  removedUpstream: { fullyOrphaned: ReadonlyArray<unknown> };
  cards: ReadonlyArray<{ bucket: string }>;
};

/** A card the diff says changed: a reformatting or a real content change. */
export function isChangedSyncCard(card: { bucket: string }): boolean {
  return card.bucket === "formattingOnly" || card.bucket === "contentChanges";
}

export function needsSyncReview(diff: SyncReviewDiff): boolean {
  return (
    diff.conflicts.length > 0 ||
    diff.removedUpstream.fullyOrphaned.length > 0 ||
    diff.cards.some(isChangedSyncCard)
  );
}
