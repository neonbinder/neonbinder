/**
 * "No Team" in a publisher checklist (NEO-489).
 *
 * A checklist's team cell may say exactly "No Team" (any case, any spacing).
 * That is a data claim: the card shows no team. It is not a team name, so it
 * never travels as one. The parsed row carries `noTeam: true` with
 * `teams: []`, and the server re-derives the flag from the team strings when
 * it re-checks the upload.
 *
 * Only the words "No Team" make the claim. "None", "N/A", "No team listed",
 * a dash, "TBD", "Unknown", "?" and a blank cell make no claim
 * (`NO_CLAIM_TEAM_CELLS`); the card's team is then still unknown and is
 * looked up or asked for as usual.
 *
 * Once a checklist row has been applied to a fetched card, the card records
 * the claim without a new field: `teamLookup: "checklist"` with no team
 * strings means the checklist said No Team. A checklist team the operator
 * ruled "not a team" still carries its (skipped) string, so it never reads as
 * a No Team claim. Both the client (to keep the card out of the Teams step)
 * and the server (to stamp confirmed no-team at commit) read the claim through
 * `checklistClaimsNoTeam`, so the two can never disagree.
 */

/** Skip reason for a row whose team cell(s) say "No Team" and name a team. */
export const NO_TEAM_AND_A_TEAM = "Says No Team and names a team — pick one.";

/** True when `text` is exactly "No Team", ignoring case and spacing. */
export function isNoTeamText(text: string): boolean {
  const folded = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  return /^no team$/i.test(folded);
}

/**
 * Whole team cells that mean "nothing here": no claim at all, the same as a
 * blank cell. Compared folded (`foldNoClaim`: NFKC, whitespace collapsed,
 * trimmed, lower case, one trailing period dropped, so "N/A." and "None."
 * count). Without this "N/A" would split on its "/" into two teams, and
 * "None" would read as a team named None. Only "No Team" is the No Team
 * claim. The client parser and the server re-check both read it.
 */
export const NO_CLAIM_TEAM_CELLS: ReadonlySet<string> = new Set([
  "none",
  "n/a",
  "na",
  "no team listed",
  "tbd",
  "unknown",
  "?",
  "-",
  "\u2013", // en dash
  "\u2014", // em dash
]);

/** The folded form `NO_CLAIM_TEAM_CELLS` holds. */
function foldNoClaim(text: string): string {
  const folded = text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  // "n/a." is "n/a"; a lone "." stays itself, never the empty string.
  return folded.length > 1 && folded.endsWith(".") ? folded.slice(0, -1).trimEnd() : folded;
}

/** True when a whole team cell says nothing (`NO_CLAIM_TEAM_CELLS`). */
export function isNoClaimTeamText(text: string): boolean {
  return NO_CLAIM_TEAM_CELLS.has(foldNoClaim(text));
}

/**
 * True when a fetched card's team answer came from a checklist that said
 * No Team: the team lookup is "checklist" and the card carries no team.
 */
export function checklistClaimsNoTeam(card: {
  teamLookup?: string;
  teams?: readonly string[];
  team?: string;
}): boolean {
  if (card.teamLookup !== "checklist") return false;
  const hasTeams = (card.teams ?? []).some((t) => t.trim() !== "");
  const hasTeam = (card.team ?? "").trim() !== "";
  return !hasTeams && !hasTeam;
}
