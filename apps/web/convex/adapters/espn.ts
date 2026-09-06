/**
 * NEO-91: ESPN's public site API as a team-metadata source. Unauthenticated,
 * undocumented, read-only JSON — same risk profile already accepted for
 * BSC's per-card detail endpoint (adapters/buysportscards.ts). Confirmed
 * live against NBA/NFL/MLB/NHL: reliably returns a hex `color`/
 * `alternateColor` and `location` (the place part of the team name) for every
 * CURRENT team in one call
 * per league. It has no historical/defunct-franchise coverage at all — that
 * gap is why `adapters/wikidata.ts`'s `enrichTeam` still falls back to
 * Wikidata rather than replacing it.
 */

const ESPN_API_BASE = "https://site.api.espn.com/apis/site/v2/sports";

// NEO-96: `SPORT_TO_ESPN_LEAGUE`, a display-name-keyed map, used to live here
// and be consulted at runtime with `teams.sport`. It moved to
// convex/sportConfig.ts as a BOOTSTRAP DEFAULT, seeded onto the sport row's
// `sportConfig.espn` at creation; callers now pass that object in. The league's
// full display name is still used directly as `league` when ESPN matches a team
// — authoritative for a current team, no need to also ask Wikidata in that case.

const ESPN_FETCH_TIMEOUT_MS = 10_000;

interface EspnTeamListResponse {
  sports?: Array<{
    leagues?: Array<{
      teams?: Array<{
        team?: {
          id?: string;
          displayName?: string;
          location?: string;
          color?: string;
          alternateColor?: string;
        };
      }>;
    }>;
  }>;
}

export interface EspnTeamInfo {
  espnId?: string;
  /**
   * NEO-236: the place part of the franchise name — ESPN's own `location`
   * field, which is where the name it maps to came from. Location, not city:
   * ESPN answers "Tampa Bay", "New England", "Golden State" here too.
   */
  location?: string;
  colorPrimary?: string;
  colorAlternate?: string;
  league: string;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * One team as ESPN's per-league list reports it. Every field is optional
 * because ESPN's payload is undocumented and we do not control it — a caller
 * that needs `displayName` or `location` checks for it.
 */
export interface EspnTeamListEntry {
  id?: string;
  displayName?: string;
  /** ESPN's own place part — "San Diego", "Tampa Bay", "New England". */
  location?: string;
  /** Bare hex, no leading `#` — ESPN's wire format. */
  color?: string;
  alternateColor?: string;
}

/**
 * NEO-236 — process-lifetime memo of one league's team list, keyed by ESPN
 * path ("baseball/mlb").
 *
 * There are four such lists and ~80 team rows, so the split migration
 * (`convex/splitTeamLocations.ts`) asks for a league's list once per row it
 * touches. Without this that is 78 identical 10s-timeout fetches against a
 * third party for four distinct answers.
 *
 * **Successes only.** A failed or empty fetch is deliberately NOT memoised: a
 * Convex isolate outlives a single action invocation, so caching a transient
 * ESPN outage would silently suppress ESPN enrichment for every team that
 * isolate goes on to handle — an hours-long consequence for a seconds-long
 * failure. Re-fetching after a miss costs one request; memoising a miss costs
 * correctness.
 *
 * Not a persistent cache and not a substitute for one: it lives and dies with
 * the isolate, and nothing may depend on a value surviving between runs.
 */
const teamListCache = new Map<string, EspnTeamListEntry[]>();

/**
 * Test-only: drop the memo above.
 *
 * `convex/adapters/espn.test.ts` stubs a different `fetch` per case and reuses
 * league paths across them, so a memo that survived between tests would serve
 * one test's fixture to the next. Exported rather than reached into, so the
 * seam is visible from the module that owns the cache.
 */
export function __resetEspnTeamListCache(): void {
  teamListCache.clear();
}

/**
 * Every CURRENT team in one ESPN league, or null when the sport is unmapped or
 * the fetch fails. No-throw, like every adapter here — a miss means "fall back
 * to Wikidata", not an error.
 */
export async function fetchEspnTeamList(
  league: { path: string } | undefined,
): Promise<EspnTeamListEntry[] | null> {
  if (!league) return null;

  const cached = teamListCache.get(league.path);
  if (cached) return cached;

  let data: EspnTeamListResponse;
  try {
    const response = await fetch(`${ESPN_API_BASE}/${league.path}/teams`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "NeonBinder/1.0 (https://neonbinder.io; jburich@neonbinder.io)",
      },
      signal: AbortSignal.timeout(ESPN_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[espn] teams list fetch failed status=${response.status} league=${league.path}`);
      return null;
    }
    data = (await response.json()) as EspnTeamListResponse;
  } catch (error) {
    console.warn(`[espn] teams list fetch error league=${league.path}:`, error);
    return null;
  }

  const entries = (data.sports?.[0]?.leagues?.[0]?.teams ?? [])
    .map((t) => t.team)
    .filter((t): t is NonNullable<typeof t> => !!t);
  // An empty list is a shape change or an off-season quirk, not an answer —
  // leave it uncached so the next caller asks again.
  if (entries.length > 0) teamListCache.set(league.path, entries);
  return entries;
}

/**
 * Look up a team's current location + colors on ESPN by exact (case-insensitive)
 * display-name match within its sport's current team list. Returns null when
 * the sport isn't mapped, the fetch fails, or no team in the league's
 * current roster matches — all no-throw, matching the rest of this
 * codebase's adapter conventions (a miss here just means "fall back to
 * Wikidata", not an error).
 *
 * `teamName` is the COMPOSED FULL name ("San Diego Padres"): ESPN's
 * `displayName` is a full name, and NEO-236 split ours into `location` +
 * `name`, so callers pass `teamFullName(row)` rather than `row.name`.
 */
export async function fetchEspnTeamInfo(
  league: { path: string; leagueName: string } | undefined,
  teamName: string,
): Promise<EspnTeamInfo | null> {
  // NEO-96: the caller supplies the league from the sport row's
  // `sportConfig.espn` rather than this module looking it up by display name.
  // An unmapped/custom sport passes undefined and gets the same graceful null
  // as any other miss.
  if (!league) return null;

  const teams = await fetchEspnTeamList(league);
  if (!teams) return null;

  const target = normalize(teamName);
  const match = teams.find((t) => t.displayName && normalize(t.displayName) === target);
  if (!match) return null;

  return {
    espnId: match.id,
    location: match.location,
    colorPrimary: match.color ? `#${match.color}` : undefined,
    colorAlternate: match.alternateColor ? `#${match.alternateColor}` : undefined,
    league: league.leagueName,
  };
}
