import {
  entityNameQueryReadings,
  entityNameTokens,
} from "../entities/normalize-name";

/**
 * NEO-330 — what "this team matches what I typed" means, in ONE place.
 *
 * Team Management's filter used to be a substring test over the rows the list
 * query happened to return, and that list was the OLDEST 2000 teams in a table
 * several times that size — so a team created after the first 2000 could never
 * be found. The fix sends a typed filter to the server
 * (`teams.searchForManagement`), and the server and the browser now have to
 * agree on what a match is, or the list would reshuffle the moment the
 * server's answer replaced the browser's.
 *
 * The rule: EVERY typed word is the start of SOME word of the team's full name
 * (or of one of its aliases). "san diego" finds the San Diego Padres, "padres"
 * finds them too, and "pittsburgh crawfords" finds the Crawfords and not every
 * team from Pittsburgh — which is what the search index alone would answer,
 * because Convex search is OR over the words.
 *
 * Words, not substrings: "adres" no longer finds the Padres. That is the price
 * of agreeing with a search index, which only ever matches word prefixes.
 */

/**
 * The typed text as the matcher reads it — one reading, or two when the text
 * ends in a run of initials (see `entityNameQueryReadings`). Empty when nothing
 * matchable was typed, which matches every team.
 */
export function teamFilterReadings(raw: string): string[][] {
  return entityNameQueryReadings(raw).filter((tokens) => tokens.length > 0);
}

/**
 * Whether a team answers to the typed text.
 *
 * `nameNormalized` is the folded, punctuation-stripped tokens of the composed
 * full name (location + nickname), so it is read as-is; aliases are stored as
 * the operator typed them and are tokenised here the same way.
 */
export function teamMatchesFilter(
  team: { nameNormalized: string; aliases?: readonly string[] },
  readings: readonly (readonly string[])[],
): boolean {
  if (readings.length === 0) return true;
  const names = [
    team.nameNormalized.split(" ").filter(Boolean),
    ...(team.aliases ?? []).map((alias) => entityNameTokens(alias)),
  ];
  return readings.some((typed) =>
    names.some((words) =>
      typed.every((t) => words.some((word) => word.startsWith(t))),
    ),
  );
}
