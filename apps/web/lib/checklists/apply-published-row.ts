/**
 * NEO-490 — what one official-checklist row does to the card it is paired
 * with. Pure: no Convex, no DOM.
 *
 * Two callers, and they must never disagree: `fetchCardChecklist` step 3c
 * (pairs the matcher made, by number or by player name) and
 * `applyPublishedChecklistPairs` (pairs the operator made in the Match Cards
 * dialog). Either way the card keeps its fetched number; the row only speaks
 * to players and teams.
 *
 * ## The rules (wrapper rules 3 and 8)
 *
 *  - The row's players fill a card that has none (`fillPlayers`). A card with
 *    players keeps them; a disagreement is `conflict.players`.
 *  - The row's teams, resolved as the card would carry them (`resolveText`
 *    for a text with a comma, the whole-name-first rule BSC's raw value
 *    takes), become the card's teams with `teamLookup: "checklist"`
 *    (`answered`), unless:
 *     - the card already names different teams: `conflict.teams` carries both
 *       sides (the checklist side RESOLVED, so "Use the checklist's" writes
 *       what a checklist-answered card would get) and the card keeps the
 *       marketplace's teams until the operator picks;
 *     - the row names no team: no claim, the card keeps its lookup;
 *       EXCEPT a row that says "No Team" (NEO-489, `noTeam`), which IS a
 *       claim: the card is answered with `teams: []` (`teamLookup:
 *       "checklist"` and no team, read back by `checklistClaimsNoTeam`) when
 *       it has no team of its own, and is a team conflict with an empty
 *       checklist side when it has one. That holds however the pair was made
 *       (number, name fallback, the operator's own link);
 *     - a text cannot be resolved, or the resolved list passes
 *       `MAX_CARD_TEAMS` (`teams: null`): the checklist says nothing usable
 *       about the team, the card keeps its lookup, and nothing is offered.
 */
import { MAX_CARD_TEAMS } from "../../convex/features/cardAttention";
import {
  checklistNameKey,
  compareChecklistRow,
  type ChecklistCardInput,
  type ChecklistConflict,
  type ChecklistRowInput,
} from "./match-published-checklist";

/** Only a team text with a comma can resolve to something other than itself. */
export function checklistTeamTextNeedsResolving(text: string): boolean {
  return text.includes(",");
}

export type AppliedChecklistRow = {
  /** The row's players, when the card has none. */
  fillPlayers?: string[];
  /**
   * The row's teams as the card would carry them: deduped, resolved. `[]`
   * when the row names no team; `null` when the row's teams are refused.
   */
  teams: string[] | null;
  /** Present only when the card and the row disagree, after resolution. */
  conflict?: ChecklistConflict;
  /** The card takes `teams` with `teamLookup: "checklist"` and needs no lookup. */
  answered: boolean;
};

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const key = (names: readonly string[]) =>
    [...new Set(names.map(checklistNameKey).filter(Boolean))].sort().join("|");
  return key(a) === key(b);
}

/**
 * Apply one row to one card. `resolveText` is asked only about a team text
 * with a comma (`checklistTeamTextNeedsResolving`) and answers the names the
 * card would carry for it, or `null` when it is refused (over the team cap, an
 * over-length part, or past the resolver's bound).
 */
export function applyChecklistRow(
  card: Pick<ChecklistCardInput, "players" | "teams" | "team">,
  row: Pick<ChecklistRowInput, "players" | "teams" | "noTeam">,
  resolveText: (text: string) => readonly string[] | null,
): AppliedChecklistRow {
  const compared = compareChecklistRow(card, row);

  let teams: string[] | null = [];
  for (const raw of row.teams) {
    const t = raw.trim();
    if (!t) continue;
    const names = checklistTeamTextNeedsResolving(t) ? resolveText(t) : [t];
    if (!names) {
      teams = null;
      break;
    }
    teams.push(...names);
  }
  if (teams) {
    teams = [...new Set(teams)];
    if (teams.length > MAX_CARD_TEAMS) teams = null;
  }

  // The disagreement as the operator will settle it: the checklist side is the
  // RESOLVED names. Resolved, they may turn out to be the card's own teams (no
  // disagreement at all); refused, there is nothing to offer.
  let conflict: ChecklistConflict | undefined = compared.conflict
    ? {
        ...(compared.conflict.players ? { players: compared.conflict.players } : {}),
        ...(compared.conflict.teams ? { teams: compared.conflict.teams } : {}),
      }
    : undefined;
  if (conflict?.teams) {
    const marketplace = conflict.teams.marketplace;
    if (!teams || sameNames(teams, marketplace)) {
      delete conflict.teams;
    } else {
      conflict.teams = { marketplace, checklist: teams };
    }
  }
  if (conflict && !conflict.players && !conflict.teams) conflict = undefined;

  // A team disagreement keeps the marketplace's teams; a row naming no team
  // makes no claim unless it says "No Team" (NEO-489: answered with `[]`); a
  // refused list says nothing usable.
  const answered =
    teams !== null && (teams.length > 0 || row.noTeam === true) && !conflict?.teams;

  return {
    ...(compared.fillPlayers ? { fillPlayers: compared.fillPlayers } : {}),
    teams,
    ...(conflict ? { conflict } : {}),
    answered,
  };
}
