/**
 * NEO-426 — "this sport has no teams", read in exactly one place.
 *
 * A `level: "sport"` row may carry `hasNoTeams: true` (Pokémon, Magic, a
 * non-sport set). Every reader goes through `isTeamlessSport` (or the server
 * set built from it, `teamlessSportIdSet` in convex/sportTeamless.ts), never
 * through the sport's display name: the flag is NB's own fact about the row,
 * so renaming the sport never changes what it means (product invariant 4).
 *
 * Env-free and import-free so the browser bundle can share it with Convex.
 *
 * The flag is a DEFAULT, never a block. A card whose every player's home
 * sport is teamless saves as "No team" unless something names a team; it
 * never refuses, strips or hides a team that does arrive.
 */

/** The fields `isTeamlessSport` reads; a full `selectorOptions` doc fits. */
export type TeamlessSportRow = {
  level: string;
  hasNoTeams?: boolean;
};

/**
 * True only for a sport row an operator flagged. Any other level answers
 * false even if it somehow carries the field: the flag means nothing below
 * the sport.
 */
export function isTeamlessSport(row: TeamlessSportRow | null | undefined): boolean {
  return row?.level === "sport" && row.hasNoTeams === true;
}

/**
 * The commit's half of the NEO-426 rule: does this incoming card save as
 * "No team" by default? The wizard's half is `autoNoTeamIndexes`
 * (components/SetSelector/teams-on-cards.ts); the two must agree, and where
 * the server knows less it says no, which only sends a card to the
 * missing-team lane for a person.
 *
 * True only when ALL of these hold:
 *  - the card has at least one resolved player, and every one of them has a
 *    flagged home sport (`teamlessPlayerIds`);
 *  - no printed player name is still unaccounted for: each one resolved, or
 *    was ruled "not a person" (an unreviewed name is someone unknown);
 *  - the card carries no team and no pending team name;
 *  - nothing listed claims a team (a printed team string or BSC's raw value
 *    the operator did not rule "not a team") — invariant 8: data that names
 *    a team holds the guess back;
 *  - the team lookup did not fail (a missing answer goes to a person, it is
 *    not read as "no team").
 *
 * A team from the set level or already stored on a re-synced row still wins:
 * the answer this feeds (`teamNone`) is dropped by `settleCardTeamAnswer`
 * whenever the row ends the write with a team.
 */
export function defaultsToNoTeamOnCommit(card: {
  playerIds: readonly string[];
  unaccountedPlayerNameCount: number;
  teamlessPlayerIds: ReadonlySet<string>;
  teamCount: number;
  pendingTeamCount: number;
  hasListedTeamClaim: boolean;
  teamLookup?: "answered" | "failed";
}): boolean {
  return (
    card.playerIds.length > 0 &&
    card.playerIds.every((id) => card.teamlessPlayerIds.has(id)) &&
    card.unaccountedPlayerNameCount === 0 &&
    card.teamCount === 0 &&
    card.pendingTeamCount === 0 &&
    !card.hasListedTeamClaim &&
    card.teamLookup !== "failed"
  );
}
