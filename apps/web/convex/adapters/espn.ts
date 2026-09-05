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
 * Look up a team's current location + colors on ESPN by exact (case-insensitive)
 * display-name match within its sport's current team list. Returns null when
 * the sport isn't mapped, the fetch fails, or no team in the league's
 * current roster matches — all no-throw, matching the rest of this
 * codebase's adapter conventions (a miss here just means "fall back to
 * Wikidata", not an error).
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
    location: match.team.location,
    colorPrimary: match.team.color ? `#${match.team.color}` : undefined,
    colorAlternate: match.team.alternateColor ? `#${match.team.alternateColor}` : undefined,
    league: league.leagueName,
  };
}
