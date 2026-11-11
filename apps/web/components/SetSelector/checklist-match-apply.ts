/**
 * NEO-490 — the operator's checklist links in Match Cards, as pure functions.
 *
 * When the publisher's checklist could not be paired to the fetched cards on
 * the server (its numbers differ and the names left ties, or the two lists
 * are different lengths), the leftover rows show up in Match Cards as a third
 * source, and the operator links each row to its card by hand. Nothing is
 * worked out here about what a link MEANS: the server answers that, through
 * the same helper its own number pairs use (`applyPublishedChecklistPairs`),
 * so a hand link and an automatic pair stamp a card identically. This module
 * only builds the question and folds the answer back onto the cards.
 *
 * Kept out of `CardPairingModal.tsx` so the dialog stays Convex-free and the
 * merge can be tested without rendering it.
 *
 * What a link never does: change the card's number (the card keeps the number
 * it was fetched with), touch `platformData`, or write a row anywhere. An
 * unlinked row is simply dropped at Confirm.
 */

import type { ChecklistConflict, TeamLookupOutcome } from "./checklist-conflict";

/** One row of the uploaded checklist, as the dialog lists it. */
export type ChecklistLinkRow = {
  number: string;
  players: readonly string[];
  teams: readonly string[];
  noNumber?: true;
};

/** What a linked card needs to carry into the question. */
export type ChecklistLinkCard = {
  cardNumber: string;
  players?: readonly string[];
  teams?: readonly string[];
};

/**
 * One operator link, as the server is asked about it: the card's CURRENT
 * players and teams (after any edit made in the dialog) beside the row.
 */
export type ChecklistPairRequest = {
  /** The card's `candidateKey` in the dialog; the answer comes back keyed by it. */
  cardKey: string;
  card: { cardNumber: string; players: string[]; teams: string[] };
  row: { number: string; players: string[]; teams: string[]; noNumber?: true };
};

/**
 * The server's answer for one link.
 *
 *  - `teams` + `teamLookup: "checklist"` — the row settles the card's team;
 *    the card carries the row's (resolved) teams and skips the BSC lookup's
 *    answer.
 *  - `checklistConflict` — the row and the card disagree about players or
 *    teams. The card keeps its own values; the wizard's "Checklist says
 *    otherwise" step settles it.
 *  - `fillPlayers` — the card had no players and the row names some.
 *
 * Any of these can be absent: a row naming no team makes no claim about it.
 */
export type ChecklistPairAnswer = {
  cardKey: string;
  teams?: string[];
  teamLookup?: "checklist";
  checklistConflict?: ChecklistConflict;
  fillPlayers?: string[];
};

/** The fields of a card a checklist answer may change. */
type AnswerableCard = ChecklistLinkCard & {
  teamLookup?: TeamLookupOutcome;
  checklistConflict?: ChecklistConflict;
  rawTeamName?: string;
};

function clean(names: readonly string[] | undefined): string[] {
  return (names ?? []).map((n) => n.trim()).filter(Boolean);
}

/**
 * The question for every link that still lands on a card being saved.
 *
 * A link whose card is not in `cards` (it was discarded) or whose row index
 * is out of range is left out: it has nothing to say about a saved card.
 * In `cards` order, so the request is stable for a given screen.
 */
export function buildChecklistPairRequests<C extends ChecklistLinkCard>(
  cards: readonly C[],
  links: ReadonlyMap<string, number>,
  rows: readonly ChecklistLinkRow[],
  keyOf: (card: C) => string,
): ChecklistPairRequest[] {
  const out: ChecklistPairRequest[] = [];
  for (const card of cards) {
    const cardKey = keyOf(card);
    const rowIndex = links.get(cardKey);
    if (rowIndex === undefined) continue;
    const row = rows[rowIndex];
    if (!row) continue;
    out.push({
      cardKey,
      card: {
        cardNumber: card.cardNumber,
        players: clean(card.players),
        teams: clean(card.teams),
      },
      row: {
        number: row.number,
        players: clean(row.players),
        teams: clean(row.teams),
        ...(row.noNumber ? { noNumber: true as const } : {}),
      },
    });
  }
  return out;
}

/**
 * Fold the server's answers onto the cards, the way step 3c of the fetch
 * stamps a number pair:
 *
 *  - players fill only a card that has none;
 *  - a disagreement rides on the card as `checklistConflict` and the card's
 *    own values stay;
 *  - a settled team replaces the card's teams and marks it
 *    `teamLookup: "checklist"`. BSC's raw team text goes with it: it was the
 *    hint for a card that might save with no team, and this one has one.
 *
 * Returns a new array; a card with no answer is returned by reference. The
 * number and `platformData` are never touched.
 */
export function applyChecklistAnswers<C extends AnswerableCard>(
  cards: readonly C[],
  answers: readonly ChecklistPairAnswer[],
  keyOf: (card: C) => string,
): C[] {
  const byKey = new Map<string, ChecklistPairAnswer>();
  for (const a of answers) byKey.set(a.cardKey, a);
  if (byKey.size === 0) return [...cards];
  return cards.map((card) => {
    const answer = byKey.get(keyOf(card));
    if (!answer) return card;
    const next: C = { ...card };
    // Written through the base shape: these are the fields this module owns.
    const out: AnswerableCard = next;
    const fill = clean(answer.fillPlayers);
    if (fill.length > 0 && clean(card.players).length === 0) {
      out.players = fill;
    }
    if (answer.checklistConflict) {
      out.checklistConflict = answer.checklistConflict;
    }
    const teams = clean(answer.teams);
    if (answer.teamLookup === "checklist" && teams.length > 0 && !answer.checklistConflict?.teams) {
      out.teams = teams;
      out.teamLookup = "checklist";
      delete out.rawTeamName;
    }
    return next;
  });
}

/** How many of these cards took their team from the checklist. */
export function countChecklistTeams(
  cards: readonly { teamLookup?: TeamLookupOutcome }[],
): number {
  return cards.filter((c) => c.teamLookup === "checklist").length;
}
