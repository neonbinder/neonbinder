/**
 * NEO-339 — card evidence for a name-only Reconcile pair.
 *
 * The server's matcher (`computeMatches`) pairs a BSC set with a SportLots
 * set by label similarity. SportLots names no product for a set, and a
 * brand's SportLots review often does not exist, so a label match can pair
 * Topps Chrome's "1988 Topps Baseball Autographs Red" with the flagship's
 * "1988 Topps Autos Red" (269998). The cards tell them apart: previewing the
 * pair (`previewCardChecklist`, both ids) puts every card the two sides share
 * by number in `matched`, and a shared number whose two rosters disagree
 * carries `playersConflict`, the conflict Match Cards would ask about.
 *
 * The rule (invariant 7: the number is the strongest key, a number/player
 * disagreement is surfaced, never settled):
 *  - shared: matched cards paired with certainty (confidence 1: the number,
 *    BSC's own SportLots ref, a variation's counterpart). A fuzzy name match
 *    (confidence below 1) shares no number, so it is not evidence;
 *  - differing: a shared card whose rosters disagree (`playersConflict`), or,
 *    with no roster on it, whose names disagree (`nameConflict`);
 *  - agree: at least one shared card, and at most a third of them differ
 *    (`MAX_DIFFERING_SHARE`). The same product's two listings agree on nearly
 *    every card; the few that do not are misreads and spellings, which Match
 *    Cards asks about card by card. A set of another product that reuses the
 *    numbering names other players on most of them. A third leaves room for a
 *    misread in a short checklist (1 of 3) while refusing a coin flip;
 *  - otherwise (no shared number, or more than a third differ) the pair is
 *    not confirmed and stays an open decision.
 * Pure.
 */

/** The largest share of shared card numbers that may name different players in a confirmed pair. */
export const MAX_DIFFERING_SHARE = 1 / 3;

type EvidenceCard = {
  players?: string[];
  playersConflict?: unknown;
  nameConflict?: unknown;
};

export type PairEvidence =
  | { verdict: "agree"; shared: number; differing: number }
  | { verdict: "disagree"; shared: number; differing: number }
  | { verdict: "no-shared"; shared: 0; differing: 0 };

export function pairCardEvidence(preview: { matched: ReadonlyArray<{ card: EvidenceCard; confidence: number }> }): PairEvidence {
  const shared = preview.matched.filter((m) => m.confidence >= 1);
  if (shared.length === 0) return { verdict: "no-shared", shared: 0, differing: 0 };
  const differing = shared.filter(({ card }) =>
    card.playersConflict ? true : !(card.players?.length ?? 0) && !!card.nameConflict,
  ).length;
  const verdict = differing <= shared.length * MAX_DIFFERING_SHARE ? "agree" : "disagree";
  return { verdict, shared: shared.length, differing };
}

/** "3 of 4 shared card numbers name different players" / "their checklists share no card number". */
export function evidenceText(e: PairEvidence): string {
  if (e.verdict === "no-shared") return "their checklists share no card number";
  return `${e.differing} of ${e.shared} shared card number${e.shared === 1 ? "" : "s"} name${e.shared === 1 ? "s" : ""} different players`;
}
