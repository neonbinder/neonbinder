/**
 * NEO-91: unit tests for `enrichTeam`'s multi-source merge logic
 * (convex/adapters/wikidata.ts) — ESPN (adapters/espn.ts, current-team
 * city/colors/league) tried first, Wikidata always also queried (only
 * source for yearsActive/wikidataId, and the fallback source for
 * city/league when ESPN has no match for a defunct/historical team).
 *
 * Lives at the convex/ ROOT (not co-located under convex/adapters/) for
 * the same reason documented in convex/bscTeamEnrichmentQueue.test.ts:
 * convex-test's `import.meta.glob(...)` module registry breaks when the
 * glob is invoked from within convex/adapters/ itself — `enrichTeam` is an
 * `internalAction` that needs the real convex-test action harness, unlike
 * convex/adapters/espn.test.ts's pure-function `fetchEspnTeamInfo` tests
 * (no Convex runtime, so that constraint doesn't apply there).
 *
 * Fetch mocking follows this session's `vi.stubGlobal("fetch", ...)`
 * convention, routing by URL substring to distinguish ESPN's teams-list
 * endpoint from Wikidata's two distinct SPARQL calls (entity search vs.
 * detail query) on the same `query.wikidata.org` host — the detail query
 * is identified by its unique `wdt:P118`/`wdt:P571` predicates, which the
 * search query never contains.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

type EspnFixtureTeam = {
  id?: string;
  displayName?: string;
  location?: string;
  color?: string;
  alternateColor?: string;
};

function makeEspnListBody(teams: EspnFixtureTeam[]) {
  return { sports: [{ leagues: [{ teams: teams.map((team) => ({ team })) }] }] };
}

type SparqlBindingFixture = { type: string; value: string };

function uriBinding(qid: string): SparqlBindingFixture {
  return { type: "uri", value: `http://www.wikidata.org/entity/${qid}` };
}
function literalBinding(value: string): SparqlBindingFixture {
  return { type: "literal", value };
}

function makeSparqlSearchBody(qid: string | null) {
  return { results: { bindings: qid ? [{ team: uriBinding(qid) }] : [] } };
}

function makeSparqlDetailBody(opts: {
  league?: string;
  city159?: string;
  city276?: string;
  inceptionYear?: number;
  dissolvedYear?: number;
}) {
  const row: Record<string, SparqlBindingFixture> = {};
  if (opts.league !== undefined) row.leagueLabel = literalBinding(opts.league);
  if (opts.city159 !== undefined) row.city159Label = literalBinding(opts.city159);
  if (opts.city276 !== undefined) row.city276Label = literalBinding(opts.city276);
  if (opts.inceptionYear !== undefined) {
    row.inception = literalBinding(`${opts.inceptionYear}-01-01T00:00:00Z`);
  }
  if (opts.dissolvedYear !== undefined) {
    row.dissolved = literalBinding(`${opts.dissolvedYear}-01-01T00:00:00Z`);
  }
  return { results: { bindings: Object.keys(row).length ? [row] : [] } };
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

/**
 * Routes a stubbed global `fetch` by URL substring:
 *  - `site.api.espn.com` → the ESPN current-teams-list response
 *  - `query.wikidata.org` with `wdt:P118`/`wdt:P571` in the decoded query
 *    string → the Wikidata *detail* query (only enrichTeam's detail query
 *    asks for these predicates)
 *  - any other `query.wikidata.org` call → the Wikidata *search* query
 *    (findTeamQid's EntitySearch lookup)
 */
function makeFetchStub(opts: {
  espnTeams: EspnFixtureTeam[];
  wikidataQid: string | null;
  wikidataDetail?: Parameters<typeof makeSparqlDetailBody>[0];
}): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("site.api.espn.com")) {
      return jsonResponse(makeEspnListBody(opts.espnTeams));
    }
    if (u.includes("query.wikidata.org")) {
      const decoded = decodeURIComponent(u);
      const isDetailQuery = decoded.includes("wdt:P118") || decoded.includes("wdt:P571");
      if (isDetailQuery) {
        return jsonResponse(makeSparqlDetailBody(opts.wikidataDetail ?? {}));
      }
      return jsonResponse(makeSparqlSearchBody(opts.wikidataQid));
    }
    throw new Error(`unexpected fetch url in enrichTeam test: ${u}`);
  }) as unknown as typeof fetch;
}

async function insertTeam(
  t: ReturnType<typeof convexTest>,
  name: string,
  sport = "Baseball",
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name,
      nameNormalized: normalizeTeamName(name),
      sport,
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

const getTeam = (t: ReturnType<typeof convexTest>, id: Id<"teams">) =>
  t.run(async (ctx) => ctx.db.get(id));

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// enrichTeam
// ===========================================================================

describe("enrichTeam", () => {
  test("ESPN matches AND Wikidata matches: city/league/colors from ESPN, yearsActive/wikidataId from Wikidata, espnId persisted", async () => {
    const t = convexTest(schema, modules);
    const teamId = await insertTeam(t, "Washington Nationals");

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        espnTeams: [
          {
            id: "20",
            displayName: "Washington Nationals",
            location: "Washington",
            color: "0d2340",
            alternateColor: "ba122b",
          },
        ],
        wikidataQid: "Q1421",
        wikidataDetail: {
          league: "National League",
          city159: "Washington, D.C.",
          inceptionYear: 1969,
        },
      }),
    );

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const team = await getTeam(t, teamId);
    // ESPN wins for city/league even though Wikidata also resolved them.
    expect(team!.league).toBe("Major League Baseball");
    expect(team!.city).toBe("Washington");
    expect(team!.colors).toEqual({ primary: "#0d2340", secondary: "#ba122b" });
    // Wikidata is the only source for yearsActive/wikidataId.
    expect(team!.yearsActive?.from).toBe(1969);
    expect(team!.yearsActive?.to).toBeUndefined();
    expect(team!.externalIds?.wikidataId).toBe("Q1421");
    expect(team!.externalIds?.espnId).toBe("20");
  });

  test("ESPN matches, Wikidata has no QID at all: persists ESPN's city/league/colors/espnId, no wikidataId, no yearsActive", async () => {
    const t = convexTest(schema, modules);
    const teamId = await insertTeam(t, "Washington Nationals");

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        espnTeams: [
          {
            id: "20",
            displayName: "Washington Nationals",
            location: "Washington",
            color: "0d2340",
            alternateColor: "ba122b",
          },
        ],
        wikidataQid: null,
      }),
    );

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const team = await getTeam(t, teamId);
    expect(team!.league).toBe("Major League Baseball");
    expect(team!.city).toBe("Washington");
    expect(team!.colors).toEqual({ primary: "#0d2340", secondary: "#ba122b" });
    expect(team!.externalIds?.espnId).toBe("20");
    expect(team!.externalIds?.wikidataId).toBeUndefined();
    expect(team!.yearsActive).toBeUndefined();
  });

  test("ESPN has no match (defunct-team-shaped), Wikidata resolves: city/league from Wikidata, colors not set at all", async () => {
    const t = convexTest(schema, modules);
    const teamId = await insertTeam(t, "Montreal Expos");

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        // ESPN's current MLB roster simply doesn't contain this defunct
        // franchise — an empty list is a legitimate "no match" response.
        espnTeams: [],
        wikidataQid: "Q1130155",
        wikidataDetail: {
          league: "National League",
          city159: "Montreal",
          inceptionYear: 1969,
          dissolvedYear: 2004,
        },
      }),
    );

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const team = await getTeam(t, teamId);
    expect(team!.league).toBe("National League");
    expect(team!.city).toBe("Montreal");
    expect(team!.yearsActive).toEqual({ from: 1969, to: 2004 });
    expect(team!.externalIds?.wikidataId).toBe("Q1130155");
    expect(team!.externalIds?.espnId).toBeUndefined();
    // colors key must be genuinely absent, not an empty object.
    expect(team!.colors).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(team!, "colors")).toBe(false);
  });

  test("neither source matches: no DB write happens at all", async () => {
    const t = convexTest(schema, modules);
    const teamId = await insertTeam(t, "Some Unresolvable Team");
    const before = await getTeam(t, teamId);

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        espnTeams: [],
        wikidataQid: null,
      }),
    );

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const after = await getTeam(t, teamId);
    expect(after).toEqual(before);
    expect(after!.lastUpdated).toBe(before!.lastUpdated);
  });

  test("P159 (headquarters) absent but P276 (location) present: city falls back to the P276 value", async () => {
    const t = convexTest(schema, modules);
    const teamId = await insertTeam(t, "Montreal Expos");

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        espnTeams: [], // ESPN's city would otherwise win — keep it out of the picture
        wikidataQid: "Q1130155",
        wikidataDetail: {
          league: "National League",
          city276: "Montreal, Quebec",
          inceptionYear: 1969,
          dissolvedYear: 2004,
        },
      }),
    );

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const team = await getTeam(t, teamId);
    expect(team!.city).toBe("Montreal, Quebec");
  });
});
