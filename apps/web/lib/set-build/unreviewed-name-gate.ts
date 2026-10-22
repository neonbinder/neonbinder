/**
 * NEO-339 — `UnreviewedNameFixer`'s Save gate, and the write it makes.
 *
 * A card is flagged "unreviewed name" when it carries typed names
 * (`pendingPlayerNames` / `pendingTeamNames`) no NB row stands behind yet. The
 * fixer's Save links real rows and retires those names in one write. The
 * attention walker's fixer and the set-building tool's `players+teams` answer
 * make that same write and must refuse the same writes; they used to carry two
 * copies of this gate. `selectorOptions.updateCard` enforces the part a server
 * can see on its own: typed names on a side are only ever retired by linking
 * that side.
 *
 * The gate, in order:
 *
 *  1. **The write must CLEAR the card** (`clearsCard`): a side with typed
 *     names must end with a link. Saving tells the walker the card is
 *     answered and moves past it, so a save that leaves the badge on is the
 *     worst outcome available — easy to reach on a card with an unlinked
 *     player AND an unlinked team: link the team, press Save, and the player
 *     name is still why the card was flagged. The team side counts as linked
 *     already when the row has real `teamOnCardIds`.
 *  2. **And it must change something**: the ids moved (`idsChanged`), or a
 *     linked side still carries typed names the write retires
 *     (`retiresNames`) — a card can reach commit with resolved ids AND a
 *     leftover typed name, and Save is what retires it.
 *
 * Pure and env-free, relative imports only, so the browser and a Node script
 * both load it.
 */

/** The fields of the card row the gate reads. */
export type UnreviewedNameRow<P extends string, T extends string> = {
  playerIds?: ReadonlyArray<P>;
  teamOnCardIds?: ReadonlyArray<T>;
  pendingPlayerNames?: ReadonlyArray<string>;
  pendingTeamNames?: ReadonlyArray<string>;
};

export type UnreviewedNameGate = {
  playerSideOpen: boolean;
  teamSideOpen: boolean;
  clearsCard: boolean;
  idsChanged: boolean;
  retiresNames: boolean;
  /** Save may go ahead (busy aside). */
  canSave: boolean;
  /** Why it may not, in the fixer's words; null when it may. DRAFT copy. */
  refusal: string | null;
};

/** DRAFT copy: a Save that would write nothing. */
export const NOTHING_TO_CHANGE = "Nothing to change here — skip this card.";

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** The typed names the card is flagged for, per side, as the fixer lists them. */
export function unlinkedNames<P extends string, T extends string>(
  row: UnreviewedNameRow<P, T>,
): { players: string[]; teams: string[] } {
  return {
    players: [...(row.pendingPlayerNames ?? [])],
    // A card with real teams is linked; a leftover typed team name on it is
    // not an open question.
    teams: (row.teamOnCardIds?.length ?? 0) > 0 ? [] : [...(row.pendingTeamNames ?? [])],
  };
}

/**
 * The gate for saving `playerCount` players and `teamCount` teams — counted
 * before any create runs, so a refusal writes nothing — with `ids` (the final
 * lists, once known) for the change test.
 */
export function unreviewedNameGate<P extends string, T extends string>(
  row: UnreviewedNameRow<P, T>,
  next: { playerIds: ReadonlyArray<P>; teamIds: ReadonlyArray<T> },
): UnreviewedNameGate {
  const open = unlinkedNames(row);
  const playerSideOpen = open.players.length > 0 && next.playerIds.length === 0;
  const teamSideOpen = open.teams.length > 0 && next.teamIds.length === 0;
  const clearsCard = !playerSideOpen && !teamSideOpen;
  const idsChanged =
    !sameIds(next.playerIds, row.playerIds ?? []) || !sameIds(next.teamIds, row.teamOnCardIds ?? []);
  const retiresNames =
    (next.playerIds.length > 0 && (row.pendingPlayerNames?.length ?? 0) > 0) ||
    (next.teamIds.length > 0 && (row.pendingTeamNames?.length ?? 0) > 0);
  const canSave = clearsCard && (idsChanged || retiresNames);
  const refusal = !clearsCard
    ? unreviewedNameSidesOpen(row, { players: next.playerIds.length, teams: next.teamIds.length })
    : !idsChanged && !retiresNames
      ? NOTHING_TO_CHANGE
      : null;
  return { playerSideOpen, teamSideOpen, clearsCard, idsChanged, retiresNames, canSave, refusal };
}

/**
 * The side-open half alone, from COUNTS: what the tool checks before it runs
 * any create, so a refused answer writes nothing. Same rule as `clearsCard`.
 */
export function unreviewedNameSidesOpen<P extends string, T extends string>(
  row: UnreviewedNameRow<P, T>,
  counts: { players: number; teams: number },
): string | null {
  const open = unlinkedNames(row);
  const playerSideOpen = open.players.length > 0 && counts.players === 0;
  const teamSideOpen = open.teams.length > 0 && counts.teams === 0;
  if (!playerSideOpen && !teamSideOpen) return null;
  // Says which side is still open, not a generic "link something": on a card
  // with two unlinked sides that is the instruction behind a half-answer.
  const missing = [...(playerSideOpen ? ["a player"] : []), ...(teamSideOpen ? ["a team"] : [])];
  return `Link ${missing.join(" and ")} to clear this card.`;
}

/**
 * The `updateCard` write Save makes: both sides in one call, and each side's
 * typed names retired only when that side GAINED a link — the other side's
 * names are written back unchanged. Read off the ROW (not the display list),
 * which is empty for a card that already has a linked team and would turn
 * "leave this side alone" into "clear it".
 */
export function unreviewedNameWrite<P extends string, T extends string>(
  row: UnreviewedNameRow<P, T>,
  next: { playerIds: ReadonlyArray<P>; teamIds: ReadonlyArray<T> },
): { playerIds: P[]; teamOnCardIds: T[]; pendingPlayerNames: string[]; pendingTeamNames: string[] } {
  return {
    playerIds: [...next.playerIds],
    teamOnCardIds: [...next.teamIds],
    pendingPlayerNames: next.playerIds.length > 0 ? [] : [...(row.pendingPlayerNames ?? [])],
    pendingTeamNames: next.teamIds.length > 0 ? [] : [...(row.pendingTeamNames ?? [])],
  };
}
