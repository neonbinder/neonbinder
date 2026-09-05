/**
 * NEO-91: unit tests for `fetchEspnTeamInfo` (convex/adapters/espn.ts).
 *
 * Pure function, no Convex runtime involved — just a mocked global `fetch`,
 * so this does NOT need `convex-test`/`import.meta.glob` at all (unlike the
 * `enrichTeam` wiring tests in convex/wikidataEnrichTeam.test.ts, which DO
 * need the real action harness and therefore live at convex/ root per
 * convex-test's module-glob constraint — see that file's header comment).
 * Mocking follows this session's `vi.stubGlobal("fetch", ...)` convention
 * (convex/bscTeamEnrichmentQueue.test.ts et al.).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { __resetEspnTeamListCache, fetchEspnTeamInfo, fetchEspnTeamList } from "./espn";

type EspnFixtureTeam = {
  id?: string;
  displayName?: string;
  location?: string;
  color?: string;
  alternateColor?: string;
};

function makeEspnListResponse(teams: EspnFixtureTeam[]) {
  return {
    sports: [
      {
        leagues: [
          {
            teams: teams.map((team) => ({ team })),
          },
        ],
      },
    ],
  };
}

function stubFetchOnce(impl: typeof fetch): void {
  vi.stubGlobal("fetch", impl);
}

// NEO-236: `fetchEspnTeamList` memoises a league's list for the life of the
// module, and these cases reuse league paths with different stubbed fetches.
beforeEach(() => {
  __resetEspnTeamListCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetEspnTeamListCache();
});

describe("fetchEspnTeamInfo", () => {
  test("sport not in the mapping table returns null without calling fetch", async () => {
    let fetchCalled = false;
    stubFetchOnce((async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called");
    }) as unknown as typeof fetch);

    const result = await fetchEspnTeamInfo(undefined, "Inter Miami CF");
    expect(result).toBeNull();
    expect(fetchCalled).toBe(false);
  });

  test("exact case-insensitive displayName match returns the mapped shape with #-prefixed colors", async () => {
    let requestedUrl: string | undefined;
    stubFetchOnce((async (url: string | URL) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify(
          makeEspnListResponse([
            {
              id: "19",
              displayName: "Washington Nationals",
              location: "Washington",
              color: "0d2340",
              alternateColor: "ba122b",
            },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch);

    // Case-insensitive: fixture is title-case, lookup is lowercased.
    const result = await fetchEspnTeamInfo({ path: "baseball/mlb", leagueName: "Major League Baseball" }, "washington nationals");

    expect(requestedUrl).toBe("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams");
    expect(result).toEqual({
      espnId: "19",
      location: "Washington",
      colorPrimary: "#0d2340",
      colorAlternate: "#ba122b",
      league: "Major League Baseball",
    });
  });

  test("league in the result comes from the mapping table, not the API response (which has no league field)", async () => {
    stubFetchOnce((async () =>
      new Response(
        JSON.stringify(
          makeEspnListResponse([
            { id: "1", displayName: "Boston Celtics", location: "Boston", color: "007a33" },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch);

    const result = await fetchEspnTeamInfo({ path: "basketball/nba", leagueName: "National Basketball Association" }, "Boston Celtics");
    // The ESPN list response fixture above never contains a "league" key
    // anywhere — this value can only have come from SPORT_TO_ESPN_LEAGUE.
    expect(result?.league).toBe("National Basketball Association");
  });

  test("team not present in the league's current roster returns null", async () => {
    stubFetchOnce((async () =>
      new Response(
        JSON.stringify(
          makeEspnListResponse([
            { id: "1", displayName: "Boston Celtics", location: "Boston", color: "007a33" },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch);

    // Defunct/relocated franchise absent from ESPN's current-teams list.
    const result = await fetchEspnTeamInfo({ path: "basketball/nba", leagueName: "National Basketball Association" }, "Seattle SuperSonics");
    expect(result).toBeNull();
  });

  test("a non-2xx response returns null without throwing", async () => {
    stubFetchOnce((async () => new Response("error", { status: 500 })) as unknown as typeof fetch);

    await expect(fetchEspnTeamInfo({ path: "football/nfl", leagueName: "National Football League" }, "Los Angeles Rams")).resolves.toBeNull();
  });

  test("a thrown fetch error (network failure) returns null without throwing", async () => {
    stubFetchOnce((async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);

    await expect(fetchEspnTeamInfo({ path: "hockey/nhl", leagueName: "National Hockey League" }, "Winnipeg Jets")).resolves.toBeNull();
  });

  test("a team with color but no alternateColor leaves colorAlternate undefined (not an empty string or literal)", async () => {
    stubFetchOnce((async () =>
      new Response(
        JSON.stringify(
          makeEspnListResponse([
            { id: "5", displayName: "Green Bay Packers", location: "Green Bay", color: "203731" },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch);

    const result = await fetchEspnTeamInfo({ path: "football/nfl", leagueName: "National Football League" }, "Green Bay Packers");
    expect(result?.colorPrimary).toBe("#203731");
    expect(result?.colorAlternate).toBeUndefined();
  });

  test("a team with alternateColor but no color leaves colorPrimary undefined", async () => {
    stubFetchOnce((async () =>
      new Response(
        JSON.stringify(
          makeEspnListResponse([
            {
              id: "6",
              displayName: "Detroit Lions",
              location: "Detroit",
              alternateColor: "b0b7bc",
            },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch);

    const result = await fetchEspnTeamInfo({ path: "football/nfl", leagueName: "National Football League" }, "Detroit Lions");
    expect(result?.colorPrimary).toBeUndefined();
    expect(result?.colorAlternate).toBe("#b0b7bc");
  });
});

/**
 * NEO-236 — the per-league list is the unit the split migration works in.
 *
 * `splitTeamLocations` asks for a league's teams once per ROW it touches
 * (~80 rows, four leagues), so the memo is what keeps that four fetches rather
 * than eighty. These pin both halves of the contract: a hit is served without
 * a second request, and a MISS is never memoised — an ESPN blip must not
 * disable ESPN for the rest of the isolate's life.
 */
describe("fetchEspnTeamList (NEO-236)", () => {
  test("returns every team in the league, with ESPN's own location field", async () => {
    stubFetchOnce((async () =>
      new Response(
        JSON.stringify(
          makeEspnListResponse([
            { id: "25", displayName: "San Francisco Giants", location: "San Francisco", color: "fd5a1e" },
            { id: "30", displayName: "Tampa Bay Rays", location: "Tampa Bay", color: "092c5c" },
          ]),
        ),
        { status: 200 },
      )) as unknown as typeof fetch);

    const teams = await fetchEspnTeamList({ path: "baseball/mlb" });
    expect(teams).toEqual([
      { id: "25", displayName: "San Francisco Giants", location: "San Francisco", color: "fd5a1e" },
      { id: "30", displayName: "Tampa Bay Rays", location: "Tampa Bay", color: "092c5c" },
    ]);
  });

  test("an undefined league returns null without fetching", async () => {
    let fetchCalled = false;
    stubFetchOnce((async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called");
    }) as unknown as typeof fetch);

    await expect(fetchEspnTeamList(undefined)).resolves.toBeNull();
    expect(fetchCalled).toBe(false);
  });

  test("a second call for the same league is served from the memo — one fetch, not two", async () => {
    let calls = 0;
    stubFetchOnce((async () => {
      calls += 1;
      return new Response(
        JSON.stringify(
          makeEspnListResponse([{ id: "1", displayName: "Atlanta Hawks", location: "Atlanta" }]),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch);

    const first = await fetchEspnTeamList({ path: "basketball/nba" });
    const second = await fetchEspnTeamList({ path: "basketball/nba" });
    expect(calls).toBe(1);
    expect(second).toEqual(first);

    // And the memo feeds the by-name lookup too — that is what makes the
    // migration cheap, since it is `fetchEspnTeamInfo` most callers use.
    const info = await fetchEspnTeamInfo(
      { path: "basketball/nba", leagueName: "National Basketball Association" },
      "Atlanta Hawks",
    );
    expect(calls).toBe(1);
    expect(info?.location).toBe("Atlanta");
  });

  test("a different league is a different memo key", async () => {
    const paths: string[] = [];
    stubFetchOnce((async (url: string) => {
      paths.push(String(url));
      return new Response(
        JSON.stringify(makeEspnListResponse([{ id: "1", displayName: "A Team" }])),
        { status: 200 },
      );
    }) as unknown as typeof fetch);

    await fetchEspnTeamList({ path: "baseball/mlb" });
    await fetchEspnTeamList({ path: "hockey/nhl" });
    expect(paths).toHaveLength(2);
  });

  test("a FAILED fetch is not memoised — the next call tries again", async () => {
    let calls = 0;
    stubFetchOnce((async () => {
      calls += 1;
      if (calls === 1) return new Response("nope", { status: 503 });
      return new Response(
        JSON.stringify(makeEspnListResponse([{ id: "7", displayName: "Denver Nuggets", location: "Denver" }])),
        { status: 200 },
      );
    }) as unknown as typeof fetch);

    await expect(fetchEspnTeamList({ path: "basketball/nba" })).resolves.toBeNull();
    const retry = await fetchEspnTeamList({ path: "basketball/nba" });
    expect(calls).toBe(2);
    expect(retry).toEqual([{ id: "7", displayName: "Denver Nuggets", location: "Denver" }]);
  });

  test("an EMPTY list is not memoised either — an off-season or shape change is not an answer", async () => {
    let calls = 0;
    stubFetchOnce((async () => {
      calls += 1;
      const teams = calls === 1 ? [] : [{ id: "9", displayName: "Vegas Golden Knights", location: "Vegas" }];
      return new Response(JSON.stringify(makeEspnListResponse(teams)), { status: 200 });
    }) as unknown as typeof fetch);

    await expect(fetchEspnTeamList({ path: "hockey/nhl" })).resolves.toEqual([]);
    const retry = await fetchEspnTeamList({ path: "hockey/nhl" });
    expect(calls).toBe(2);
    expect(retry).toEqual([{ id: "9", displayName: "Vegas Golden Knights", location: "Vegas" }]);
  });
});
