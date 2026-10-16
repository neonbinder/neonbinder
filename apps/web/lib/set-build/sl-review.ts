/**
 * NEO-339 — the SportLots set review's Save payload, as a plain function.
 *
 * Moved out of `SlSetReviewModal`'s `handleSave` with no change in behaviour,
 * so the dialog and the set-building tool (`tools/setbuild/`) send the same
 * `applySlSetReview` decisions. The dialog keeps the pickers, the names it
 * holds and the refusals; it answers `answerOf` from those.
 *
 * Pure and env-free: no React, no `convex/react`, no `process.env`, and only
 * relative imports, so a Node script can load it.
 */

import type { Id } from "../../convex/_generated/dataModel";

type RowId = Id<"selectorOptions">;

/** The server's cap on one save (`MAX_REVIEW_DECISIONS`). */
export const MAX_REVIEW_DECISIONS = 200;

/** The part of one review line the payload reads. */
export type SlReviewDecisionEntry = {
  slId: string;
  label: string;
  /**
   * NEO-325 — what an own-set save names this line when no name is given
   * (the server's `candidateDefaultName`). Optional so an older payload reads
   * as the bare label.
   */
  defaultName?: string;
};

/**
 * The operator's answer for one line.
 *
 * `setId` + `typeId` file it under a variant type of another set; neither is
 * "its own set". `typedName` is the text in the line's name field — ONLY when
 * the line shows one (the dialog's `nameFieldOf`), never otherwise.
 */
export type SlReviewLineAnswer = {
  setId?: RowId;
  typeId?: RowId;
  typedName?: string;
};

/** One `applySlSetReview` decision, as the dialog sends it. */
export type SlReviewDecision = {
  slId: string;
  variantTypeId?: RowId;
  name?: string;
};

/**
 * The decisions Save sends: the first `MAX_REVIEW_DECISIONS` lines, in review
 * order, each filed under its variant type or as its own set.
 *
 * NEO-325 — the operator's name goes only when it says something the server's
 * default would not (an untouched own-set field is the default; blank is never
 * sent).
 */
export function buildSlReviewDecisions<E extends SlReviewDecisionEntry>(
  entries: readonly E[],
  answerOf: (entry: E) => SlReviewLineAnswer,
): SlReviewDecision[] {
  return entries.slice(0, MAX_REVIEW_DECISIONS).map((e) => {
    const d = answerOf(e);
    const typed = d.typedName?.trim();
    const name =
      typed && (d.setId || typed !== (e.defaultName ?? e.label)) ? typed : undefined;
    return {
      slId: e.slId,
      ...(d.setId && d.typeId ? { variantTypeId: d.typeId } : {}),
      ...(name ? { name } : {}),
    };
  });
}
