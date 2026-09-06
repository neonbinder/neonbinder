/**
 * NEO-91: unit tests for `enrichTeam`'s multi-source merge logic
 * (convex/adapters/wikidata.ts) — ESPN (adapters/espn.ts, current-team
 * location/colors/league) tried first, Wikidata always also queried (only
 * source for yearsActive/wikidataId, and the fallback source for
 * location/league when ESPN has no match for a defunct/historical team).
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { __resetEspnTeamListCache } from "./adapters/espn";

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

/**
 * NEO-236: `city159`/`city276` are gone. The detail query no longer ASKS for
 * P159/P276 — Wikidata's headquarters is not the place part of a team name
 * ("Nishi-Shinjuku" for the Chiba Lotte Marines), and this fixture no longer
 * offers a way to pretend otherwise. `location` comes from ESPN or nowhere.
 */
function makeSparqlDetailBody(opts: {
  league?: string;
  inceptionYear?: number;
  dissolvedYear?: number;
}) {
  const row: Record<string, SparqlBindingFixture> = {};
  if (opts.league !== undefined) row.leagueLabel = literalBinding(opts.league);
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
): Promise<Id<"teams">> {
  return t.run(async (ctx) => {
    // NEO-96: teams reference a sport ROW, and enrichment reads that row's
    // sportConfig for the ESPN league + Wikidata QIDs — so the fixture has to
    // carry the same config a real synced sport row gets at creation.
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      lastUpdated: 1_700_000_000_000,
    });
    return ctx.db.insert("teams", {
      name,
      nameNormalized: normalizeTeamName(name),
      sportId,
      lastUpdated: 1_700_000_000_000,
    });
  });
}

const getTeam = (t: ReturnType<typeof convexTest>, id: Id<"teams">) =>
  t.run(async (ctx) => ctx.db.get(id));

/**
 * NEO-156: enrichment reports a league NAME but stores a league ROW, so these
 * cases resolve the reference to assert on. A name-shaped assertion would have
 * kept passing against the free-text field this replaced.
 */
const getLeagueName = async (
  t: ReturnType<typeof convexTest>,
  id: Id<"teams">,
) =>
  t.run(async (ctx) => {
    const team = await ctx.db.get(id);
    if (!team?.leagueId) return undefined;
    return (await ctx.db.get(team.leagueId))?.name;
  });

// NEO-236: `fetchEspnTeamList` memoises per league path for the life of the
// module, and every case here stubs a different ESPN body for "baseball/mlb".
beforeEach(() => {
  __resetEspnTeamListCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// enrichTeam
// ===========================================================================

describe("enrichTeam", () => {
  test("ESPN matches AND Wikidata matches: location/league from ESPN, yearsActive/wikidataId from Wikidata, espnId persisted, colors from the bundled dataset", async () => {
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
          inceptionYear: 1969,
        },
      }),
    );

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const team = await getTeam(t, teamId);
    // ESPN wins for league; NEO-236 makes it the ONLY source for location,
    // and the location it supplies is split out of the stored name.
    expect(await getLeagueName(t, teamId)).toBe("Major League Baseball");
    expect(team!.location).toBe("Washington");
    expect(team!.name).toBe("Nationals");
    // NEO-156: colors do NOT come from ESPN for a team the bundled dataset
    // carries. `enrichTeam` runs the color resolver last, and a dedicated color
    // source outranks ESPN — the same precedence teamcolorcodes.com already
    // had. Washington Nationals is one of the dataset's 30 MLB rows.
    expect(team!.colors).toEqual({ primary: "#ab0003", secondary: "#11225b" });
    // Wikidata is the only source for yearsActive/wikidataId.
    expect(team!.yearsActive?.from).toBe(1969);
    expect(team!.yearsActive?.to).toBeUndefined();
    expect(team!.externalIds?.wikidataId).toBe("Q1421");
    expect(team!.externalIds?.espnId).toBe("20");
  });

  test("ESPN matches, Wikidata has no QID at all: persists ESPN's location/league/espnId, no wikidataId, no yearsActive", async () => {
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
    expect(await getLeagueName(t, teamId)).toBe("Major League Baseball");
    expect(team!.location).toBe("Washington");
    expect(team!.name).toBe("Nationals");
    // NEO-156: colors do NOT come from ESPN for a team the bundled dataset
    // carries. `enrichTeam` runs the color resolver last, and a dedicated color
    // source outranks ESPN — the same precedence teamcolorcodes.com already
    // had. Washington Nationals is one of the dataset's 30 MLB rows.
    //
    // NEO-236: and it still matches AFTER the split, because the colour
    // lookup composes the full name rather than reading `name`.
    expect(team!.colors).toEqual({ primary: "#ab0003", secondary: "#11225b" });
    expect(team!.externalIds?.espnId).toBe("20");
    expect(team!.externalIds?.wikidataId).toBeUndefined();
    expect(team!.yearsActive).toBeUndefined();
  });

  test("ESPN has no match (defunct-team-shaped), Wikidata resolves: league and years from Wikidata, NO location, colors not set at all", async () => {
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
          inceptionYear: 1969,
          dissolvedYear: 2004,
        },
      }),
    );

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const team = await getTeam(t, teamId);
    expect(await getLeagueName(t, teamId)).toBe("National League");
    // NEO-236: no ESPN match means no location, and the row keeps its whole
    // name. Wikidata is not consulted for it — see the next test.
    expect(team!.location).toBeUndefined();
    expect(team!.name).toBe("Montreal Expos");
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

  /**
   * NEO-236 — Wikidata is not a location source, and the query no longer even
   * asks.
   *
   * This test used to assert the opposite: P159 (headquarters), falling back
   * to P276, became `teams.location`. The dev data showed what that actually
   * produced — "Nishi-Shinjuku" for the Chiba Lotte Marines, "Aichi
   * Prefecture" for the Chunichi Dragons, "Tokorozawa" for the Saitama Seibu
   * Lions. None of those is the word at the front of the team's name, which is
   * the only thing `location` means.
   *
   * Asserting on the outgoing SPARQL rather than on the absent value, because
   * removing the properties from the query is the durable version of the
   * decision: a value nothing asks for cannot be reintroduced by a later edit
   * that "just wires up the binding we already fetch".
   */
  test("the detail SPARQL does not ask for P159/P276 at all", async () => {
    const t = convexTest(schema, modules);
    const teamId = await insertTeam(t, "Montreal Expos");

    const sparqlQueries: string[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("site.api.espn.com")) {
        return jsonResponse(makeEspnListBody([]));
      }
      if (u.includes("query.wikidata.org")) {
        const decoded = decodeURIComponent(u);
        sparqlQueries.push(decoded);
        if (decoded.includes("wdt:P118") || decoded.includes("wdt:P571")) {
          return jsonResponse(
            makeSparqlDetailBody({ league: "National League", inceptionYear: 1969 }),
          );
        }
        return jsonResponse(makeSparqlSearchBody("Q1130155"));
      }
      throw new Error(`unexpected fetch url: ${u}`);
    }) as unknown as typeof fetch);

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    expect(sparqlQueries.length).toBeGreaterThan(0);
    for (const query of sparqlQueries) {
      expect(query).not.toContain("P159");
      expect(query).not.toContain("P276");
    }
    // And nothing landed on the row.
    const team = await getTeam(t, teamId);
    expect(team!.location).toBeUndefined();
  });

  /**
   * NEO-236 — ESPN's `location` does not merely FILL the field, it SPLITS the
   * name the row already has.
   *
   * Every automatic creation path stores the whole franchise name in `name`,
   * because none of them has a location to pass. ESPN's is the one source that
   * answers "which words at the front of that name are the place", so
   * enrichment moves them rather than storing a second, redundant fact.
   */
  test("ESPN's location splits the stored name, leaving the dedup key untouched", async () => {
    const t = convexTest(schema, modules);
    const teamId = await insertTeam(t, "Washington Nationals");
    const keyBefore = (await getTeam(t, teamId))!.nameNormalized;

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        espnTeams: [
          { id: "20", displayName: "Washington Nationals", location: "Washington" },
        ],
        wikidataQid: null,
      }),
    );

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const team = await getTeam(t, teamId);
    expect(team!.location).toBe("Washington");
    expect(team!.name).toBe("Nationals");
    // The whole point: `normalizeTeamName` token-sorts, so moving a leading
    // word out of `name` cannot change the key. Every identity lookup that
    // resolved to this row before the split still resolves to it.
    expect(team!.nameNormalized).toBe(keyBefore);
    expect(team!.nameNormalized).toBe(normalizeTeamName("Washington Nationals"));
  });

  /**
   * NEO-236 — the split is refused when it would not be a clean prefix.
   *
   * ESPN answers "Anaheim" for a franchise our row calls "Los Angeles Angels".
   * That is a true fact about the club and a false answer to "what is the
   * front of this name", so nothing is written: no location, and above all no
   * rewritten name. Jason: no code path guesses a location without a source,
   * and a source that disagrees with the name is not a source for THIS field.
   */
  test("an ESPN location that is not a prefix of the name writes nothing", async () => {
    const t = convexTest(schema, modules);
    const teamId = await insertTeam(t, "Los Angeles Angels");

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        espnTeams: [
          { id: "3", displayName: "Los Angeles Angels", location: "Anaheim" },
        ],
        wikidataQid: null,
      }),
    );

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const team = await getTeam(t, teamId);
    expect(team!.location).toBeUndefined();
    expect(team!.name).toBe("Los Angeles Angels");
  });
});
