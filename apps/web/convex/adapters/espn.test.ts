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

import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchEspnTeamInfo } from "./espn";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchEspnTeamInfo", () => {
  test("sport not in the mapping table returns null without calling fetch", async () => {
    let fetchCalled = false;
    stubFetchOnce((async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called");
    }) as unknown as typeof fetch);

    const result = await fetchEspnTeamInfo("Soccer", "Inter Miami CF");
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
    const result = await fetchEspnTeamInfo("Baseball", "washington nationals");

    expect(requestedUrl).toBe("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams");
    expect(result).toEqual({
      espnId: "19",
      city: "Washington",
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

    const result = await fetchEspnTeamInfo("Basketball", "Boston Celtics");
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
    const result = await fetchEspnTeamInfo("Basketball", "Seattle SuperSonics");
    expect(result).toBeNull();
  });

  test("a non-2xx response returns null without throwing", async () => {
    stubFetchOnce((async () => new Response("error", { status: 500 })) as unknown as typeof fetch);

    await expect(fetchEspnTeamInfo("Football", "Los Angeles Rams")).resolves.toBeNull();
  });

  test("a thrown fetch error (network failure) returns null without throwing", async () => {
    stubFetchOnce((async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);

    await expect(fetchEspnTeamInfo("Hockey", "Winnipeg Jets")).resolves.toBeNull();
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

    const result = await fetchEspnTeamInfo("Football", "Green Bay Packers");
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

    const result = await fetchEspnTeamInfo("Football", "Detroit Lions");
    expect(result?.colorPrimary).toBeUndefined();
    expect(result?.colorAlternate).toBe("#b0b7bc");
  });
});
