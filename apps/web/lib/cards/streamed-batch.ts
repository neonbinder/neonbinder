/**
 * NEO-341 — has the client SEEN the end of a checklist fetch?
 *
 * `fetchCardChecklist` publishes its candidates to `checklistCandidates`, then
 * patches BSC teams onto them in chunks through `ctx.runMutation`. A Convex
 * action's promise resolves on the action's own response, not when the
 * client's subscription has caught up with those writes — so a screen that
 * unlocks on the promise can commit the last chunk's cards without their
 * teams (and the entity-review wizard never sees those teams).
 *
 * The server writes a row `pending` only while a team lookup is outstanding
 * for it (every other row lands `ready`), so the subscription itself carries
 * the marker: this run's whole batch is present and every row is `ready`.
 * Both commit paths wait on it — the pairing dialog's Confirm and the
 * one-marketplace auto-keep.
 */

/** The parts of `getReadyCandidates`' value this reads. */
export type StreamedBatchView = {
  batchId?: string;
  total: number;
  ready: number;
  cards: readonly unknown[];
};

/** What the run knows once its fetch has resolved. */
export type StreamedBatchTarget = {
  /** `fetchCardChecklist`'s own count of the rows it published. */
  candidateCount: number;
  /**
   * The batch the subscription showed BEFORE the call. A view still showing
   * it is a stale snapshot from before this run's clear, however its counts
   * look. `undefined` means there was no batch to confuse it with.
   */
  previousBatchId: string | undefined;
};

export function streamedBatchSettled(
  live: StreamedBatchView | undefined,
  target: StreamedBatchTarget,
): boolean {
  if (!live) return false;
  if (
    target.previousBatchId !== undefined &&
    live.batchId === target.previousBatchId
  ) {
    return false;
  }
  return (
    live.total === target.candidateCount &&
    live.cards.length === live.total &&
    live.ready === live.total
  );
}
