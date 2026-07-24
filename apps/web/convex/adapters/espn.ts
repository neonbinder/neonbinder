/**
 * NEO-91: ESPN's public site API as a team-metadata source. Unauthenticated,
 * undocumented, read-only JSON — same risk profile already accepted for
 * BSC's per-card detail endpoint (adapters/buysportscards.ts). Confirmed
 * live against NBA/NFL/MLB/NHL: reliably returns a hex `color`/
 * `alternateColor` and `location` (city) for every CURRENT team in one call
 * per league. It has no historical/defunct-franchise coverage at all — that
 * gap is why `adapters/wikidata.ts`'s `enrichTeam` still falls back to
 * Wikidata rather than replacing it.
 */

const ESPN_API_BASE = "https://site.api.espn.com/apis/site/v2/sports";

// NeonBinder's `sport` values (as stored on `teams.sport`/`selectorOptions`
// sport-level nodes) → ESPN's {sport}/{league} URL segments + the league's
// full display name. The full name is used directly as `league` when ESPN
// matches a team — authoritative for a current team, no need to also ask
// Wikidata for it in that case. Confirmed via grep this session that these
// four are the only sport values referenced anywhere in this codebase
// (seed data, adapters, tests) — extend here if that ever changes.
const SPORT_TO_ESPN_LEAGUE: Record<string, { path: string; leagueName: string }> = {
  Baseball: { path: "baseball/mlb", leagueName: "Major League Baseball" },
  Football: { path: "football/nfl", leagueName: "National Football League" },
  Basketball: { path: "basketball/nba", leagueName: "National Basketball Association" },
  Hockey: { path: "hockey/nhl", leagueName: "National Hockey League" },
};

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
  city?: string;
  colorPrimary?: string;
  colorAlternate?: string;
  league: string;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Look up a team's current city + colors on ESPN by exact (case-insensitive)
 * display-name match within its sport's current team list. Returns null when
 * the sport isn't mapped, the fetch fails, or no team in the league's
 * current roster matches — all no-throw, matching the rest of this
 * codebase's adapter conventions (a miss here just means "fall back to
 * Wikidata", not an error).
 */
export async function fetchEspnTeamInfo(
  sport: string,
  teamName: string,
): Promise<EspnTeamInfo | null> {
  const league = SPORT_TO_ESPN_LEAGUE[sport];
  if (!league) return null;

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

  const teams = data.sports?.[0]?.leagues?.[0]?.teams ?? [];
  const target = normalize(teamName);
  const match = teams.find((t) => t.team?.displayName && normalize(t.team.displayName) === target);
  if (!match?.team) return null;

  return {
    espnId: match.team.id,
    city: match.team.location,
    colorPrimary: match.team.color ? `#${match.team.color}` : undefined,
    colorAlternate: match.team.alternateColor ? `#${match.team.alternateColor}` : undefined,
    league: league.leagueName,
  };
}
