/**
 * NEO-156 — matching a team name against the bundled colour data.
 *
 * Kept apart from `seed-team-colors.ts` so that file stays a plain data
 * listing: 165 rows nobody should have to read past to find the logic.
 */

import {
  RENAMED_FRANCHISES,
  SEED_TEAMS,
  type SeedLeagueCode,
  type SeedTeam,
} from "./seed-team-colors";
import { teamFullName, type TeamNameParts } from "./team-name";

/**
 * Match key for a team name.
 *
 * Mirrors `convex/adapters/teamColorCodes.ts#colorSourceMatchKey` — same
 * lowercase, same punctuation stripping, same trailing sport-word removal for
 * the `" baseball"` suffix our college rows carry — and deliberately does NOT
 * token-sort, so "Chiba Lotte Marines" and "Marines Lotte Chiba" stay
 * distinct. The two are separate functions because one lives in a Convex
 * adapter and one in shared lib code; they must stay in step, and the tests
 * assert they agree.
 */
const SPORT_SUFFIXES = [
  "baseball",
  "basketball",
  "football",
  "hockey",
  "soccer",
  "softball",
  "volleyball",
];

export function seedMatchKey(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  for (const suffix of SPORT_SUFFIXES) {
    s = s.replace(new RegExp(`\\s+${suffix}$`), "");
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Index built once at module load. 165 rows, so this costs nothing and saves a
 * linear scan per lookup.
 *
 * Stale names are indexed under their CURRENT key as well as their own, so a
 * lookup for "Cleveland Guardians" finds the row the dataset still calls
 * "Cleveland Indians". Both keys point at the same row rather than the row
 * being renamed, because the seeding path needs the original name too.
 *
 * NEO-236: keyed on the COMPOSED FULL name, and that is not an implementation
 * detail. Every caller arrives holding a full string — a `teams` row's
 * composed name, a teamcolorcodes.com page title, a marketplace payload — and
 * the source sites themselves are named "san diego padres". Keying on the
 * nickname would collide the two Chicago and two Los Angeles franchises in
 * baseball outright.
 */
const BY_KEY: Map<string, SeedTeam> = (() => {
  const map = new Map<string, SeedTeam>();
  for (const team of SEED_TEAMS) {
    const full = teamFullName(team);
    const key = seedMatchKey(full);
    if (!map.has(key)) map.set(key, team);
    const current = RENAMED_FRANCHISES[full];
    if (current) {
      const currentKey = seedMatchKey(teamFullName(current));
      if (!map.has(currentKey)) map.set(currentKey, team);
    }
  }
  return map;
})();

export interface SeedColorMatch {
  primary: string;
  secondary?: string;
  /** The dataset's own name for the team, for provenance. */
  matchedName: string;
  league: SeedLeagueCode;
}

/**
 * Colours for a team name, or null.
 *
 * Null covers three different situations that the caller treats alike — the
 * team is in a league this dataset does not carry (NPB, MiLB, NCAA), the name
 * does not match, or the row exists with an empty `hex` (every NBA row). All
 * three mean "ask the live source instead".
 */
export function findSeedColors(teamName: string): SeedColorMatch | null {
  const team = BY_KEY.get(seedMatchKey(teamName));
  if (!team || team.hex.length === 0) return null;
  return {
    primary: team.hex[0],
    secondary: team.hex[1],
    // NEO-236: the dataset's own FULL name — this is provenance shown to an
    // operator in Team Management ("matched: San Diego Padres"), and a bare
    // nickname would not tell them which row it matched.
    matchedName: teamFullName(team),
    league: team.league,
  };
}

/** The dataset's entry for a name, colours or not. Used by the seeding path. */
export function findSeedTeam(teamName: string): SeedTeam | null {
  return BY_KEY.get(seedMatchKey(teamName)) ?? null;
}

/**
 * The FULL name a franchise is known by TODAY, given its full name in the
 * dataset. Unchanged in and out for the 163 rows that are not stale.
 *
 * Seeding uses `currentFranchiseParts` below; this string form is what callers
 * comparing against a scraped or marketplace name want — see
 * `RENAMED_FRANCHISES`.
 */
export function currentFranchiseName(seedName: string): string {
  const renamed = RENAMED_FRANCHISES[seedName];
  return renamed ? teamFullName(renamed) : seedName;
}

/**
 * NEO-236 — the Location + Name a seeded row should be CREATED with.
 *
 * The seeder needs the two parts, not a string it would have to split again:
 * `teams` stores them separately and `teamRowFields` derives the dedup key
 * from the composition. For a renamed franchise that is the current name's
 * split ("Cleveland" / "Guardians"), which is why `RENAMED_FRANCHISES` stores
 * parts rather than a string.
 */
export function currentFranchiseParts(team: SeedTeam): TeamNameParts {
  const renamed = RENAMED_FRANCHISES[teamFullName(team)];
  if (renamed) return renamed;
  return { name: team.name, location: team.location };
}
