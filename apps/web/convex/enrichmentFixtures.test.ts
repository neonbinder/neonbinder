/**
 * NEO-289 — recorded enrichment lookups.
 *
 * Three layers, one file:
 *  - the pure fixture module (`adapters/enrichmentFixtures.ts`): key
 *    normalisation, the switch, `readFixture`'s hit/miss/knownQid rules;
 *  - the wrappers in `adapters/wikidata.ts`: a hit makes NO request (a
 *    throwing `fetch` proves it), a miss or an inert switch falls through to
 *    the live body (a counting `fetch` proves that);
 *  - the armed CLI actions (`convex/enrichmentFixtures.ts`): the gate, the
 *    name list, the transport guard on capture, and the coverage report.
 *
 * Lives at the convex/ ROOT for the reason every other adapter-action test
 * does: convex-test's `import.meta.glob` registry breaks when invoked from
 * inside convex/adapters/.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  __setEnrichmentFixtureForTests,
  enrichmentFixturesEnabled,
  fixtureKey,
  normaliseLookupName,
  parseFixtureFile,
  readFixture,
  toFixtureEntry,
  type EnrichmentFixtureFile,
} from "./adapters/enrichmentFixtures";
import {
  lookupLeagueEnrichment,
  lookupPlayerEnrichment,
  lookupTeamEnrichment,
  type SportEnrichmentContext,
} from "./adapters/wikidata";
import { __resetEspnTeamListCache } from "./adapters/espn";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const SPORT_QID = "Q5369";
const SPORT: SportEnrichmentContext = {
  label: "Baseball",
  espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
  wikidata: { sportQid: SPORT_QID, hallOfFameQid: "Q809892" },
};

const CONFIRM = "CAPTURE_ENRICHMENT_FIXTURES" as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixtureOn() {
  vi.stubEnv("NEONBINDER_ENRICHMENT_FIXTURES", "1");
  vi.stubEnv("TESTING_RESET_SECRET", "test-secret");
}

function fixtureWith(entries: EnrichmentFixtureFile["entries"]): EnrichmentFixtureFile {
  return { version: 1, capturedAt: "2026-09-20T00:00:00.000Z", sportQid: SPORT_QID, entries };
}

/** A `fetch` that fails the test if anything reaches it. */
function forbidFetch(): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", (async (input: unknown) => {
    calls += 1;
    throw new Error(`forbiddenFetch: ${String(input)}`);
  }) as unknown as typeof fetch);
  return { calls: () => calls };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const uri = (qid: string) => ({ type: "uri", value: `http://www.wikidata.org/entity/${qid}` });
const lit = (value: string) => ({ type: "literal", value });

type Route = (url: string, query: string) => Response | Promise<Response>;

/**
 * A `fetch` that answers ESPN and Wikidata by URL/query shape and counts its
 * calls. `route` returns a Response for the calls the test cares about; an
 * unrouted SPARQL call gets an empty binding set (a no-match).
 */
function countingFetch(route: Route = () => jsonResponse({ results: { bindings: [] } })) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const query = url.includes("query.wikidata.org")
      ? decodeURIComponent(new URL(url).searchParams.get("query") ?? "")
      : "";
    return route(url, query);
  }) as unknown as typeof fetch);
  return { calls };
}

const espnListBody = {
  sports: [
    {
      leagues: [
        {
          teams: [
            {
              team: {
                id: "25",
                displayName: "San Diego Padres",
                location: "San Diego",
                color: "2f241d",
                alternateColor: "ffc425",
              },
            },
          ],
        },
      ],
    },
  ],
};

/** The full happy-path router: one player, one team, one league, all found. */
const happyRoute: Route = (url, query) => {
  if (url.includes("site.web.api.espn.com")) return jsonResponse(espnListBody);
  if (query.includes("mwapi:search")) {
    if (query.includes("?player ")) return jsonResponse({ results: { bindings: [{ player: uri("Q1000") }] } });
    if (query.includes("?team ")) return jsonResponse({ results: { bindings: [{ team: uri("Q2000") }] } });
    if (query.includes("?league ")) return jsonResponse({ results: { bindings: [{ league: uri("Q3000") }] } });
  }
  if (query.includes("p:P54")) {
    return jsonResponse({
      results: {
        bindings: [
          {
            team: uri("Q2000"),
            teamLabel: lit("San Diego Padres"),
            teamSport: uri(SPORT_QID),
            start: lit("1982-01-01T00:00:00Z"),
            end: lit("2001-01-01T00:00:00Z"),
            descr: lit("American baseball player"),
            dob: lit("1960-05-09T00:00:00Z"),
          },
        ],
      },
    });
  }
  if (query.includes("wdt:P118")) {
    return jsonResponse({
      results: {
        bindings: [
          { league: uri("Q3000"), leagueLabel: lit("Major League Baseball"), inception: lit("1969-01-01T00:00:00Z") },
        ],
      },
    });
  }
  if (query.includes("wdt:P1813")) {
    return jsonResponse({
      results: { bindings: [{ shortName: lit("MLB"), inception: lit("1903-01-01T00:00:00Z"), countryLabel: lit("United States") }] },
    });
  }
  return jsonResponse({ results: { bindings: [] } });
};

const recordedPlayer = {
  wikidataId: "Q1000",
  careerTeams: [{ name: "San Diego Padres", fromYear: 1982, toYear: 2001, wikidataId: "Q2000" }],
  isHallOfFame: true,
  description: "American baseball player",
  birthYear: 1960,
};

const recordedTeam = {
  wikidataId: "Q2000",
  league: "Major League Baseball",
  leagueWikidataId: "Q3000",
  location: "San Diego",
  yearsActive: { from: 1969 },
  colors: { primary: "#2f241d", secondary: "#ffc425" },
  espnId: "25",
};

beforeEach(() => {
  __resetEspnTeamListCache();
  __setEnrichmentFixtureForTests(undefined);
});

afterEach(() => {
  __setEnrichmentFixtureForTests(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

describe("fixtureKey — one normaliser", () => {
  test("case, surrounding and internal whitespace collapse to one key", () => {
    const canonical = fixtureKey("player", SPORT_QID, "Tony Gwynn");
    expect(canonical).toBe("player|Q5369|tony gwynn");
    expect(fixtureKey("player", SPORT_QID, "  TONY   gwynn\t")).toBe(canonical);
    expect(fixtureKey("player", SPORT_QID, "tony gwynn")).toBe(canonical);
  });

  test("NFKC folds compatibility forms (full-width letters, ligatures)", () => {
    expect(normaliseLookupName("Ｔｏｎｙ　Ｇｗｙｎｎ")).toBe("tony gwynn");
    expect(normaliseLookupName("Griﬃn")).toBe("griffin");
  });

  test("diacritics are kept — a different Wikidata search is a different key", () => {
    expect(fixtureKey("player", SPORT_QID, "José Ramírez")).not.toBe(
      fixtureKey("player", SPORT_QID, "Jose Ramirez"),
    );
  });

  test("kind and sport are part of the key", () => {
    expect(fixtureKey("team", SPORT_QID, "x")).not.toBe(fixtureKey("player", SPORT_QID, "x"));
    expect(fixtureKey("team", "Q41323", "x")).not.toBe(fixtureKey("team", SPORT_QID, "x"));
  });
});

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

describe("enrichmentFixturesEnabled", () => {
  test("off by default", () => {
    expect(enrichmentFixturesEnabled()).toBe(false);
  });

  test("on only with BOTH the flag and TESTING_RESET_SECRET", () => {
    vi.stubEnv("NEONBINDER_ENRICHMENT_FIXTURES", "1");
    expect(enrichmentFixturesEnabled()).toBe(false);
    vi.stubEnv("TESTING_RESET_SECRET", "s");
    expect(enrichmentFixturesEnabled()).toBe(true);
  });

  test("the secret alone does not enable it", () => {
    vi.stubEnv("TESTING_RESET_SECRET", "s");
    expect(enrichmentFixturesEnabled()).toBe(false);
  });

  test("flag without secret warns exactly once per process", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEONBINDER_ENRICHMENT_FIXTURES", "1");
    enrichmentFixturesEnabled();
    enrichmentFixturesEnabled();
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("enrichment_fixture_flag_without_secret"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// readFixture
// ---------------------------------------------------------------------------

describe("readFixture", () => {
  test("logs `off` and misses when the switch is off, even with an entry", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("player", SPORT_QID, "Tony Gwynn")]: { kind: "player", name: "Tony Gwynn", result: recordedPlayer } }),
    );
    expect(readFixture("player", SPORT_QID, "Tony Gwynn")).toEqual({ hit: false });
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      msg: "enrichment_fixture",
      outcome: "off",
      kind: "player",
      name: "Tony Gwynn",
    });
  });

  test("a recorded null is a HIT that returns null", () => {
    fixtureOn();
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("player", SPORT_QID, "Nobody Here")]: { kind: "player", name: "Nobody Here", result: null } }),
    );
    expect(readFixture("player", SPORT_QID, "Nobody Here")).toEqual({ hit: true, result: null });
  });

  test("knownQid: honoured when equal or when the record has no id; a mismatch misses", () => {
    fixtureOn();
    __setEnrichmentFixtureForTests(
      fixtureWith({
        [fixtureKey("team", SPORT_QID, "San Diego Padres")]: { kind: "team", name: "San Diego Padres", result: recordedTeam },
        [fixtureKey("team", SPORT_QID, "Espn Only")]: {
          kind: "team",
          name: "Espn Only",
          result: { league: "Major League Baseball", location: "Espn" },
        },
      }),
    );
    expect(readFixture("team", SPORT_QID, "San Diego Padres", "Q2000").hit).toBe(true);
    expect(readFixture("team", SPORT_QID, "San Diego Padres").hit).toBe(true);
    expect(readFixture("team", SPORT_QID, "San Diego Padres", "Q9999").hit).toBe(false);
    expect(readFixture("team", SPORT_QID, "Espn Only", "Q9999").hit).toBe(true);
  });

  test("knownQid + recorded null ⇒ miss (an id-path lookup goes live); no knownQid ⇒ the null is honoured", () => {
    fixtureOn();
    __setEnrichmentFixtureForTests(
      fixtureWith({
        [fixtureKey("team", SPORT_QID, "Sydney Blue Sox")]: { kind: "team", name: "Sydney Blue Sox", result: null },
        [fixtureKey("league", SPORT_QID, "Some League")]: { kind: "league", name: "Some League", result: null },
      }),
    );
    expect(readFixture("team", SPORT_QID, "Sydney Blue Sox", "Q4000")).toEqual({ hit: false });
    expect(readFixture("team", SPORT_QID, "Sydney Blue Sox")).toEqual({ hit: true, result: null });
    expect(readFixture("league", SPORT_QID, "Some League", "Q5000")).toEqual({ hit: false });
    expect(readFixture("league", SPORT_QID, "Some League")).toEqual({ hit: true, result: null });
  });

  test("an entry under the right key but the wrong kind is a miss", () => {
    fixtureOn();
    __setEnrichmentFixtureForTests(
      fixtureWith({
        // Hand-forged: the key says team, the entry says player.
        [fixtureKey("team", SPORT_QID, "Padres")]: { kind: "player", name: "Padres", result: null },
      }),
    );
    expect(readFixture("team", SPORT_QID, "Padres")).toEqual({ hit: false });
  });
});

// ---------------------------------------------------------------------------
// The wrappers in adapters/wikidata.ts
// ---------------------------------------------------------------------------

describe("lookup wrappers — hit means zero requests", () => {
  test("player hit returns the recorded narrowed shape and never fetches", async () => {
    fixtureOn();
    const fetch = forbidFetch();
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("player", SPORT_QID, "Tony Gwynn")]: { kind: "player", name: "Tony Gwynn", result: recordedPlayer } }),
    );
    await expect(lookupPlayerEnrichment("  tony GWYNN ", SPORT)).resolves.toEqual(recordedPlayer);
    expect(fetch.calls()).toBe(0);
  });

  test("team hit makes no ESPN call and no Wikidata call", async () => {
    fixtureOn();
    const fetch = forbidFetch();
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("team", SPORT_QID, "San Diego Padres")]: { kind: "team", name: "San Diego Padres", result: recordedTeam } }),
    );
    await expect(lookupTeamEnrichment("San Diego Padres", SPORT)).resolves.toEqual(recordedTeam);
    await expect(lookupTeamEnrichment("San Diego Padres", SPORT, "Q2000")).resolves.toEqual(recordedTeam);
    expect(fetch.calls()).toBe(0);
  });

  test("league hit returns the recorded shape (no country) and never fetches", async () => {
    fixtureOn();
    const fetch = forbidFetch();
    const recorded = { wikidataId: "Q3000", abbreviation: "MLB", yearsActive: { from: 1903 } };
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("league", SPORT_QID, "Major League Baseball")]: { kind: "league", name: "Major League Baseball", result: recorded } }),
    );
    await expect(lookupLeagueEnrichment("Major League Baseball", SPORT_QID, "Q3000")).resolves.toEqual(recorded);
    expect(fetch.calls()).toBe(0);
  });

  test("a recorded null player returns null with no fetch", async () => {
    fixtureOn();
    const fetch = forbidFetch();
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("player", SPORT_QID, "Minor Leaguer")]: { kind: "player", name: "Minor Leaguer", result: null } }),
    );
    await expect(lookupPlayerEnrichment("Minor Leaguer", SPORT)).resolves.toBeNull();
    expect(fetch.calls()).toBe(0);
  });
});

describe("lookup wrappers — miss, off and mismatch fall through to the live body", () => {
  test("a name with no entry goes live", async () => {
    fixtureOn();
    const fetch = countingFetch();
    __setEnrichmentFixtureForTests(fixtureWith({}));
    await expect(lookupPlayerEnrichment("Tony Gwynn", SPORT)).resolves.toBeNull();
    expect(fetch.calls.length).toBeGreaterThan(0);
    expect(fetch.calls[0]).toContain("query.wikidata.org");
  });

  test("flag set but TESTING_RESET_SECRET unset ⇒ inert: the entry is ignored and the call goes live", async () => {
    vi.stubEnv("NEONBINDER_ENRICHMENT_FIXTURES", "1");
    const fetch = countingFetch(happyRoute);
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("player", SPORT_QID, "Tony Gwynn")]: { kind: "player", name: "Tony Gwynn", result: null } }),
    );
    const live = await lookupPlayerEnrichment("Tony Gwynn", SPORT);
    expect(live?.wikidataId).toBe("Q1000");
    expect(fetch.calls.length).toBe(2);
  });

  test("switch fully off ⇒ the live path, unchanged", async () => {
    const fetch = countingFetch(happyRoute);
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("player", SPORT_QID, "Tony Gwynn")]: { kind: "player", name: "Tony Gwynn", result: null } }),
    );
    const live = await lookupPlayerEnrichment("Tony Gwynn", SPORT);
    expect(live?.wikidataId).toBe("Q1000");
    expect(live?.careerTeams).toEqual([{ name: "San Diego Padres", fromYear: 1982, toYear: 2001, wikidataId: "Q2000" }]);
    expect(fetch.calls.length).toBe(2);
  });

  test("team knownQid mismatch ⇒ live (ESPN and Wikidata are asked)", async () => {
    fixtureOn();
    const fetch = countingFetch(happyRoute);
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("team", SPORT_QID, "San Diego Padres")]: { kind: "team", name: "San Diego Padres", result: recordedTeam } }),
    );
    const live = await lookupTeamEnrichment("San Diego Padres", SPORT, "Q7777");
    expect(live?.wikidataId).toBe("Q7777");
    expect(fetch.calls.some((u) => u.includes("site.web.api.espn.com"))).toBe(true);
    expect(fetch.calls.some((u) => u.includes("query.wikidata.org"))).toBe(true);
  });

  test("a staged career team with a Wikidata id bypasses a recorded null and reads its record live", async () => {
    fixtureOn();
    const fetch = countingFetch(happyRoute);
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("team", SPORT_QID, "San Diego Padres")]: { kind: "team", name: "San Diego Padres", result: null } }),
    );
    const live = await lookupTeamEnrichment("San Diego Padres", SPORT, "Q2000");
    expect(live?.wikidataId).toBe("Q2000");
    // Id path: the detail query ran, the name search did not.
    expect(fetch.calls.some((u) => decodeURIComponent(u).includes("wdt:P118"))).toBe(true);
    expect(fetch.calls.some((u) => decodeURIComponent(u).includes("?team wikibase:apiOutputItem"))).toBe(false);
    // And without the id, the same recorded null is honoured with no request.
    fetch.calls.length = 0;
    await expect(lookupTeamEnrichment("San Diego Padres", SPORT)).resolves.toBeNull();
    expect(fetch.calls).toEqual([]);
  });

  test("a custom sport (no sportQid) has no fixture key and goes live", async () => {
    fixtureOn();
    const fetch = countingFetch();
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("league", SPORT_QID, "Some League")]: { kind: "league", name: "Some League", result: null } }),
    );
    await lookupLeagueEnrichment("Some League", undefined);
    expect(fetch.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseFixtureFile / toFixtureEntry
// ---------------------------------------------------------------------------

describe("parseFixtureFile", () => {
  test("accepts a well-formed file", () => {
    const parsed = parseFixtureFile(
      fixtureWith({ [fixtureKey("player", SPORT_QID, "Tony Gwynn")]: { kind: "player", name: "Tony Gwynn", result: recordedPlayer } }),
    );
    expect(parsed.ok).toBe(true);
  });

  test.each([
    ["wrong version", { ...fixtureWith({}), version: 2 }],
    ["entries not an object", { ...fixtureWith({}), entries: [] }],
    ["key/name mismatch", fixtureWith({ "player|Q5369|someone else": { kind: "player", name: "Tony Gwynn", result: null } })],
    [
      "non-QID wikidataId",
      fixtureWith({
        [fixtureKey("league", SPORT_QID, "X")]: { kind: "league", name: "X", result: { wikidataId: "not-a-qid" } },
      }),
    ],
  ])("rejects: %s", (_label, raw) => {
    expect(parseFixtureFile(raw).ok).toBe(false);
  });
});

describe("toFixtureEntry", () => {
  test("strips undefined fields and, for a league, the country", () => {
    expect(
      toFixtureEntry("team", "Padres", { wikidataId: "Q2000", location: undefined, colors: { primary: "#000", secondary: undefined } }),
    ).toEqual({ kind: "team", name: "Padres", result: { wikidataId: "Q2000", colors: { primary: "#000" } } });
    expect(
      toFixtureEntry("league", "MLB", { wikidataId: "Q3000", abbreviation: "MLB", country: "United States", yearsActive: undefined }),
    ).toEqual({ kind: "league", name: "MLB", result: { wikidataId: "Q3000", abbreviation: "MLB" } });
    expect(toFixtureEntry("player", "Nobody", null)).toEqual({ kind: "player", name: "Nobody", result: null });
  });
});

// ---------------------------------------------------------------------------
// The CLI actions
// ---------------------------------------------------------------------------

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T, value = "Baseball", sportQid: string = SPORT_QID) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid, hallOfFameQid: "Q809892" },
      },
    }),
  );
}

async function seedNames(t: T, sportId: Id<"selectorOptions">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("players", {
      name: "Tony Gwynn",
      nameNormalized: "gwynn tony",
      sportId,
      lastUpdated: 1,
    });
    await ctx.db.insert("teams", {
      name: "Padres",
      location: "San Diego",
      nameNormalized: normalizeTeamName("San Diego Padres"),
      sportId,
      externalIds: { wikidataId: "Q2000" },
      lastUpdated: 1,
    });
    await ctx.db.insert("leagues", {
      name: "Major League Baseball",
      nameNormalized: "major league baseball",
      sportId,
      externalIds: { wikidataId: "Q3000" },
      lastUpdated: 1,
    });
  });
}

function armed() {
  vi.stubEnv("ALLOW_ENRICHMENT_FIXTURE_CAPTURE", "true");
}

describe("captureFromCli / coverageReportFromCli — the gate", () => {
  test("capture unarmed refuses with the right confirm", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t);
    await expect(
      t.action(internal.enrichmentFixtures.captureFromCli, { confirm: CONFIRM, sportQid: SPORT_QID }),
    ).rejects.toThrow(/not armed/);
  });

  test("coverage unarmed refuses with the right confirm", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t);
    await expect(
      t.action(internal.enrichmentFixtures.coverageReportFromCli, { confirm: CONFIRM, sportQid: SPORT_QID }),
    ).rejects.toThrow(/not armed/);
  });

  test("armed but wrong confirm literal still throws (the validator)", async () => {
    armed();
    const t = convexTest(schema, modules);
    await seedSport(t);
    await expect(
      t.action(internal.enrichmentFixtures.captureFromCli, {
        // @ts-expect-error — deliberately wrong literal
        confirm: "NOT_THE_PHRASE",
        sportQid: SPORT_QID,
      }),
    ).rejects.toThrow();
    await expect(
      t.action(internal.enrichmentFixtures.coverageReportFromCli, {
        // @ts-expect-error — deliberately wrong literal
        confirm: "NOT_THE_PHRASE",
        sportQid: SPORT_QID,
      }),
    ).rejects.toThrow();
  });

  test("an unknown or ambiguous sport QID is refused", async () => {
    armed();
    const t = convexTest(schema, modules);
    await expect(
      t.action(internal.enrichmentFixtures.captureFromCli, { confirm: CONFIRM, sportQid: "Q1" }),
    ).rejects.toThrow(/exactly one sport row/);
    await seedSport(t, "Baseball");
    await seedSport(t, "Baseball again");
    await expect(
      t.action(internal.enrichmentFixtures.captureFromCli, { confirm: CONFIRM, sportQid: SPORT_QID }),
    ).rejects.toThrow(/found 2/);
  });
});

describe("captureFromCli", () => {
  test("records every name for the sport under its fixture key, bypassing the switch", async () => {
    armed();
    // The switch is ON with a recording that says "nothing found" — capture
    // must ignore it and go live.
    fixtureOn();
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("player", SPORT_QID, "Tony Gwynn")]: { kind: "player", name: "Tony Gwynn", result: null } }),
    );
    const fetch = countingFetch(happyRoute);
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedNames(t, sportId);
    // A row in ANOTHER sport must not be captured.
    const other = await seedSport(t, "Football", "Q41323");
    await t.run(async (ctx) => {
      await ctx.db.insert("players", { name: "Jerry Rice", nameNormalized: "jerry rice", sportId: other, lastUpdated: 1 });
    });

    const out = await t.action(internal.enrichmentFixtures.captureFromCli, { confirm: CONFIRM, sportQid: SPORT_QID });

    expect(out.fixture.version).toBe(1);
    expect(out.fixture.sportQid).toBe(SPORT_QID);
    expect(out.total).toBe(3);
    expect(out.scanned).toBe(3);
    expect(out.skippedTransport).toEqual([]);
    expect(Object.keys(out.fixture.entries).sort()).toEqual([
      fixtureKey("league", SPORT_QID, "Major League Baseball"),
      fixtureKey("player", SPORT_QID, "Tony Gwynn"),
      fixtureKey("team", SPORT_QID, "San Diego Padres"),
    ]);
    expect(out.fixture.entries[fixtureKey("player", SPORT_QID, "Tony Gwynn")]).toEqual({
      kind: "player",
      name: "Tony Gwynn",
      result: {
        wikidataId: "Q1000",
        careerTeams: [{ name: "San Diego Padres", fromYear: 1982, toYear: 2001, wikidataId: "Q2000" }],
        // The sport has a Hall QID and no award matched: the live body answers
        // a definite `false`, and the recording keeps it.
        isHallOfFame: false,
        description: "American baseball player",
        birthYear: 1960,
      },
    });
    // The team is captured under its COMPOSED name, with ESPN's colours, and
    // its stored QID was used as knownQid (no team search was issued).
    expect(out.fixture.entries[fixtureKey("team", SPORT_QID, "San Diego Padres")]).toEqual({
      kind: "team",
      name: "San Diego Padres",
      result: recordedTeam,
    });
    expect(fetch.calls.some((u) => decodeURIComponent(u).includes("?team wikibase:apiOutputItem"))).toBe(false);
    // The league drops `country` on the way into the recording.
    expect(out.fixture.entries[fixtureKey("league", SPORT_QID, "Major League Baseball")]).toEqual({
      kind: "league",
      name: "Major League Baseball",
      result: { wikidataId: "Q3000", abbreviation: "MLB", yearsActive: { from: 1903 } },
    });
    // Live, not the recording: the player search was actually issued.
    expect(fetch.calls.some((u) => decodeURIComponent(u).includes("?player wikibase:apiOutputItem"))).toBe(true);
  });

  test("offset/limit page the stable name order", async () => {
    armed();
    countingFetch(happyRoute);
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedNames(t, sportId);

    const page = await t.action(internal.enrichmentFixtures.captureFromCli, {
      confirm: CONFIRM,
      sportQid: SPORT_QID,
      offset: 1,
      limit: 1,
    });
    expect(page.total).toBe(3);
    expect(page.scanned).toBe(1);
    // Order is player, team, league — so offset 1 is the team.
    expect(Object.keys(page.fixture.entries)).toEqual([fixtureKey("team", SPORT_QID, "San Diego Padres")]);
  });

  test("a Wikidata transport failure is reported, never recorded as no-match", async () => {
    armed();
    countingFetch((url, query) => {
      if (url.includes("site.web.api.espn.com")) return jsonResponse(espnListBody);
      // The player search is throttled; everything else answers.
      if (query.includes("?player ")) return jsonResponse({}, 429);
      return happyRoute(url, query);
    });
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedNames(t, sportId);

    const out = await t.action(internal.enrichmentFixtures.captureFromCli, { confirm: CONFIRM, sportQid: SPORT_QID });
    expect(out.skippedTransport).toEqual([{ kind: "player", name: "Tony Gwynn", reason: "wikidata_transport" }]);
    expect(out.fixture.entries[fixtureKey("player", SPORT_QID, "Tony Gwynn")]).toBeUndefined();
    expect(Object.keys(out.fixture.entries)).toHaveLength(2);
  });

  test("a genuine no-match IS recorded as null", async () => {
    armed();
    countingFetch((url, query) => {
      if (url.includes("site.web.api.espn.com")) return jsonResponse(espnListBody);
      if (query.includes("?player ")) return jsonResponse({ results: { bindings: [] } });
      return happyRoute(url, query);
    });
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedNames(t, sportId);

    const out = await t.action(internal.enrichmentFixtures.captureFromCli, { confirm: CONFIRM, sportQid: SPORT_QID });
    expect(out.skippedTransport).toEqual([]);
    expect(out.fixture.entries[fixtureKey("player", SPORT_QID, "Tony Gwynn")]).toEqual({
      kind: "player",
      name: "Tony Gwynn",
      result: null,
    });
  });

  test("ESPN unavailable ⇒ every team is skipped, players and leagues still record", async () => {
    armed();
    countingFetch((url, query) => {
      if (url.includes("site.web.api.espn.com")) return jsonResponse({}, 503);
      return happyRoute(url, query);
    });
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedNames(t, sportId);

    const out = await t.action(internal.enrichmentFixtures.captureFromCli, { confirm: CONFIRM, sportQid: SPORT_QID });
    expect(out.skippedTransport).toEqual([{ kind: "team", name: "San Diego Padres", reason: "espn_unavailable" }]);
    expect(Object.keys(out.fixture.entries).sort()).toEqual([
      fixtureKey("league", SPORT_QID, "Major League Baseball"),
      fixtureKey("player", SPORT_QID, "Tony Gwynn"),
    ]);
  });
});

describe("coverageReportFromCli", () => {
  test("counts the deployment's names the fixture in force answers and lists the rest", async () => {
    armed();
    const fetch = forbidFetch();
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("player", SPORT_QID, "Tony Gwynn")]: { kind: "player", name: "Tony Gwynn", result: null } }),
    );
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedNames(t, sportId);

    const out = await t.action(internal.enrichmentFixtures.coverageReportFromCli, { confirm: CONFIRM, sportQid: SPORT_QID });
    expect(out).toEqual({
      covered: 1,
      missing: ["team: San Diego Padres", "league: Major League Baseball"],
    });
    expect(fetch.calls()).toBe(0);
  });

  test("reads the file regardless of the fixture switch", async () => {
    armed();
    forbidFetch();
    // Switch OFF (no env), the report still consults the fixture.
    __setEnrichmentFixtureForTests(
      fixtureWith({ [fixtureKey("team", SPORT_QID, "San Diego Padres")]: { kind: "team", name: "San Diego Padres", result: recordedTeam } }),
    );
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedNames(t, sportId);

    const out = await t.action(internal.enrichmentFixtures.coverageReportFromCli, { confirm: CONFIRM, sportQid: SPORT_QID });
    expect(out.covered).toBe(1);
    expect(out.missing).toEqual(["player: Tony Gwynn", "league: Major League Baseball"]);
  });
});
