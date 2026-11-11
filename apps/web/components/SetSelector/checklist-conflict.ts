/**
 * NEO-478 — the operator's published checklist and a marketplace disagree
 * about a card. Pure: no React, no Convex.
 *
 * The fetch matches each published row to a card by number (rule 7: only an
 * exactly-one match on both sides), and when the two say different players
 * or teams it sends BOTH lists on the card as `checklistConflict`. Neither is
 * settled silently: the wizard's "Checklist says otherwise" step puts each
 * one to the operator, and the answer is applied to the card here, on the
 * client, before the commit. Nothing about the answer is stored (wizard
 * answers are never stored); the card simply goes in carrying the chosen
 * side, and the commit refuses any card still carrying a conflict.
 */

/**
 * How a card's team was settled at fetch time:
 *  - "answered"  — BSC's per-card lookup replied (with a team or with none);
 *  - "failed"    — that lookup failed;
 *  - "checklist" — the operator's published checklist named it (NEO-478).
 * Absent when no lookup ran. "checklist" is a data claim (wrapper rule 8): no
 * inference rule may write a different team over it.
 */
export type TeamLookupOutcome = "answered" | "failed" | "checklist";

/** Both sides of one disagreement, as the fetch sends it. */
export type ChecklistSides = { marketplace: string[]; checklist: string[] };

/** What the checklist and the marketplace disagree about on one card. */
export type ChecklistConflict = {
  players?: ChecklistSides;
  teams?: ChecklistSides;
};

/** The operator's answer for one card. */
export type ChecklistChoice = "marketplace" | "checklist";

/** The slice of a card this module reads and writes. */
export type ChecklistConflictCard = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  teams?: string[];
  teamLookup?: TeamLookupOutcome;
  checklistConflict?: ChecklistConflict;
};

/** Does this card carry a disagreement the operator still has to settle? */
export function hasChecklistConflict(card: { checklistConflict?: ChecklistConflict }): boolean {
  const c = card.checklistConflict;
  return !!c && (c.players !== undefined || c.teams !== undefined);
}

/** Positions in `cards` the "Checklist says otherwise" step is about. */
export function checklistConflictIndexes(
  cards: readonly { checklistConflict?: ChecklistConflict }[],
): number[] {
  const out: number[] = [];
  cards.forEach((card, i) => {
    if (hasChecklistConflict(card)) out.push(i);
  });
  return out;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The card as it goes to the commit once the operator has answered: the
 * chosen side's players and/or teams, and no `checklistConflict`.
 *
 * - A players answer also renames a one-player card whose name WAS the
 *   losing player ("Rhett Lowder" → "Rhett Loder"), so the card's name and
 *   its player never disagree. Any other card name is left alone.
 * - A teams answer records where the team came from: the checklist's is a
 *   checklist claim (`teamLookup: "checklist"`); the marketplace's is the
 *   lookup's answer (`"answered"`).
 *
 * Returns a new object; the input is never touched. A card with nothing to
 * settle comes back as it is (minus an empty `checklistConflict`).
 */
export function applyChecklistChoice<T extends ChecklistConflictCard>(
  card: T,
  choice: ChecklistChoice,
): T {
  const conflict = card.checklistConflict;
  const next: T = { ...card };
  delete next.checklistConflict;
  if (!conflict) return next;
  if (conflict.players) {
    const chosen = conflict.players[choice];
    const other = conflict.players[choice === "checklist" ? "marketplace" : "checklist"];
    next.players = [...chosen];
    if (chosen.length === 1 && other.length === 1 && sameName(card.cardName, other[0])) {
      next.cardName = chosen[0];
    }
  }
  if (conflict.teams) {
    next.teams = [...conflict.teams[choice]];
    next.teamLookup = choice === "checklist" ? "checklist" : "answered";
  }
  return next;
}

/** "Rhett Lowder", "Alonso, Schwarber and Soto", or "nobody named". */
export function sideText(names: readonly string[], empty: string): string {
  if (names.length === 0) return empty;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The slice of a review row `orphanedReviewRowIds` reads. */
export type OrphanCandidateRow = {
  _id: string;
  kind?: "player" | "team" | "league";
  name?: string;
  source?:
    | { kind: "careerTeamOf"; playerRowId: string }
    | { kind: "leagueOf"; teamRowId: string }
    | null;
};

/**
 * NEO-478 — the review rows no card needs once the conflicts are answered.
 *
 * The server queues the unknown names on BOTH sides of every disagreement, so
 * either answer finds its players and teams ready. The side the operator turns
 * down leaves rows behind for names no card carries; walking them would ask
 * about people the set will never hold. This names those rows, so the wizard
 * leaves them out of the walk. Nothing is stored: the rows stay in the batch,
 * undecided, and the commit (which works from the cards' names) never reads
 * them.
 *
 * A row is dropped only when its name sits on a side of some disagreement AND
 * no card carries it — after the answers are applied, and not counting a
 * field still in dispute (an unanswered card carries neither side yet). So a
 * name the rest of the set also uses is always kept. Rows staged FOR a dropped
 * row (a dropped player's career New Team steps, a dropped team's league) go
 * with it, unless a card carries that team itself.
 *
 * `normalize` is the batch's own name key (`normalizeEntityName`), passed in
 * so this module stays free of the name rules' imports.
 */
export function orphanedReviewRowIds(
  rows: readonly OrphanCandidateRow[],
  cards: readonly ChecklistConflictCard[],
  choices: Readonly<Record<number, ChecklistChoice>>,
  normalize: (name: string) => string,
): Set<string> {
  const dropped = new Set<string>();
  const contested = { player: new Set<string>(), team: new Set<string>() };
  const carried = { player: new Set<string>(), team: new Set<string>() };
  const add = (into: Set<string>, names: readonly string[] | undefined) => {
    for (const name of names ?? []) {
      const key = normalize(name);
      if (key) into.add(key);
    }
  };
  cards.forEach((card, i) => {
    const conflict = hasChecklistConflict(card) ? card.checklistConflict : undefined;
    if (conflict?.players) {
      add(contested.player, conflict.players.marketplace);
      add(contested.player, conflict.players.checklist);
    }
    if (conflict?.teams) {
      add(contested.team, conflict.teams.marketplace);
      add(contested.team, conflict.teams.checklist);
    }
    const choice = choices[i];
    const settled = conflict && choice ? applyChecklistChoice(card, choice) : card;
    if (!conflict?.players || choice) add(carried.player, settled.players);
    if (!conflict?.teams || choice) add(carried.team, settled.teams);
  });
  if (contested.player.size === 0 && contested.team.size === 0) return dropped;

  const keyOf = (row: OrphanCandidateRow) => (row.name ? normalize(row.name) : "");
  for (const row of rows) {
    if (row.source) continue;
    const kind = row.kind ?? "player";
    if (kind === "league") continue;
    const key = keyOf(row);
    if (key && contested[kind].has(key) && !carried[kind].has(key)) dropped.add(row._id);
  }
  if (dropped.size === 0) return dropped;
  // Steps staged for a dropped row, and steps staged for those (a league of a
  // dropped career team). Two passes reach the deepest chain there is.
  for (let pass = 0; pass < 2; pass++) {
    for (const row of rows) {
      if (!row.source || dropped.has(row._id)) continue;
      const owner =
        row.source.kind === "careerTeamOf" ? row.source.playerRowId : row.source.teamRowId;
      if (!dropped.has(owner)) continue;
      if (row.kind === "team" && carried.team.has(keyOf(row))) continue;
      dropped.add(row._id);
    }
  }
  return dropped;
}

/** The step's subtitle and growth-line words. */
export const CHECKLIST_STEP_SUBTITLE = "Checklist says otherwise";
export const CHECKLIST_GROWTH_REASON = "checklist disagreements";
