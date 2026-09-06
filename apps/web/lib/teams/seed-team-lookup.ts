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
// NEO-253: the diacritics fold, shared with the NB identity keys and with
// `colorSourceMatchKey`. Only the FOLD is shared — the tail below is this key's
// own (drops hyphens, expands "&", preserves word order).
import { foldDiacritics } from "../entities/normalize-name";

/**
 * Match key for a team name.
 *
 * Mirrors `convex/adapters/teamColorCodes.ts#colorSourceMatchKey` — same fold,
 * same lowercase, same punctuation stripping, same trailing sport-word removal
 * for the `" baseball"` suffix our college rows carry — and deliberately does
 * NOT token-sort, so "Chiba Lotte Marines" and "Marines Lotte Chiba" stay
 * distinct. The two are separate functions because one lives in a Convex
 * adapter and one in shared lib code; they must stay in step, and
 * `teamColorCodes.test.ts` asserts they agree on a shared fixture set.
 *
 * The one deliberate difference: this key expands "&" to " and ", because the
 * bundled dataset spells "Brighton and Hove Albion" out. Parity is asserted on
 * fixtures without an ampersand for exactly that reason.
 *
 * NEO-253 added the fold. The bundled dataset is ASCII while `teams.name` holds
 * the franchise's real spelling, so "Montréal Expos" and "Águilas Cibaeñas"
 * matched nothing at all — an accented team quietly got no colours, and a spine
 * label printed grey with nothing anywhere saying why. Note this folds "ñ",
 * which is a LETTER in Spanish rather than an accent; that is correct HERE,
 * where the other side of the comparison is a fixed ASCII dataset, and it is
 * why the fold is shared but the rest of the key is not.
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
  let s = foldDiacritics(raw)
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
 */
const BY_KEY: Map<string, SeedTeam> = (() => {
  const map = new Map<string, SeedTeam>();
  for (const team of SEED_TEAMS) {
    const key = seedMatchKey(team.name);
    if (!map.has(key)) map.set(key, team);
    const current = RENAMED_FRANCHISES[team.name];
    if (current) {
      const currentKey = seedMatchKey(current);
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
    matchedName: team.name,
    league: team.league,
  };
}

/** The dataset's entry for a name, colours or not. Used by the seeding path. */
export function findSeedTeam(teamName: string): SeedTeam | null {
  return BY_KEY.get(seedMatchKey(teamName)) ?? null;
}

/**
 * The name a franchise is known by TODAY.
 *
 * Seeding uses this so a stale dataset name never creates a second row for a
 * franchise we already hold — see `RENAMED_FRANCHISES`.
 */
export function currentFranchiseName(seedName: string): string {
  return RENAMED_FRANCHISES[seedName] ?? seedName;
}
