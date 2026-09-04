/**
 * NEO-240 — unit tests for `enrichLeague` and the `lookupLeagueEnrichment`
 * behind it (convex/adapters/wikidata.ts): Wikidata EntitySearch narrowed to
 * `wdt:P31/wdt:P279* wd:Q623109` (sports league) plus the sport's `wdt:P641`,
 * then one detail query for P1813 (short name), P571/P576 (span) and P17
 * (country).
 *
 * Lives at the convex/ ROOT rather than under convex/adapters/, for the reason
 * spelled out in the header of convex/wikidataEnrichTeam.test.ts: convex-test's
 * `import.meta.glob(...)` module registry breaks when the glob is invoked from
 * inside convex/adapters/, and `enrichLeague` is an `internalAction` that needs
 * the real action harness.
 *
 * ## The QIDs below are REAL, and that is deliberate
 *
 * Q1163715 (MLB) and Q1131829 (Federal League) were resolved live against
 * query.wikidata.org / Special:EntityData on 2026-09-04, and the fixtures
 * reproduce what those entities actually return — including the Federal
 * League's having no P1813 at all. NEO-235's lesson: a fixture that invents an
 * identifier proves the code agrees with itself, which is exactly what let four
 * wrong `hallOfFameQid` constants ship green for months.
 *
 * Fetch is stubbed with this session's `vi.stubGlobal("fetch", …)` convention,
 * routed by substrings of the decoded query string — `Q623109` appears only in
 * the search query, `P1813` only in the detail query.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeLeagueName } from "./leagues";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

type SparqlBindingFixture = { type: string; value: string; "xml:lang"?: string };

function uriBinding(qid: string): SparqlBindingFixture {
  return { type: "uri", value: `http://www.wikidata.org/entity/${qid}` };
}
function literalBinding(value: string): SparqlBindingFixture {
  return { type: "literal", value };
}

/**
 * The search response, shaped as WDQS renders it: `?league` plus the `?num`
 * ordinal the query asks mwapi for. Both are bound on every real row, so the
 * fixture binds both even though only `?league` is read.
 */
function makeSparqlSearchBody(qid: string | null) {
  return {
    results: {
      bindings: qid ? [{ league: uriBinding(qid), num: literalBinding("0") }] : [],
    },
  };
}

function makeSparqlDetailBody(opts: {
  shortName?: string;
  /** Rendered exactly as WDQS does — a full xsd:dateTime, whatever the precision. */
  inception?: string;
  dissolved?: string;
  country?: string;
}) {
  const row: Record<string, SparqlBindingFixture> = {};
  if (opts.shortName !== undefined) {
    row.shortName = { type: "literal", value: opts.shortName, "xml:lang": "en" };
  }
  if (opts.inception !== undefined) row.inception = literalBinding(opts.inception);
  if (opts.dissolved !== undefined) row.dissolved = literalBinding(opts.dissolved);
  if (opts.country !== undefined) row.countryLabel = literalBinding(opts.country);
  return { results: { bindings: Object.keys(row).length ? [row] : [] } };
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Routes the stubbed `fetch`, and COUNTS, so a test can assert that no lookup
 * was attempted at all rather than merely that no row was written.
 *
 *  - decoded query containing `Q623109` → the EntitySearch query
 *  - decoded query containing `P1813`   → the detail query
 */
function makeFetchStub(opts: {
  qid: string | null;
  detail?: Parameters<typeof makeSparqlDetailBody>[0];
}): { fetch: typeof fetch; searchCalls: () => number; detailCalls: () => number } {
  let searchCalls = 0;
  let detailCalls = 0;
  const impl = (async (url: string | URL) => {
    const u = String(url);
    if (!u.includes("query.wikidata.org")) {
      throw new Error(`unexpected fetch url in enrichLeague test: ${u}`);
    }
    const decoded = decodeURIComponent(u);
    if (decoded.includes("P1813")) {
      detailCalls++;
      return jsonResponse(makeSparqlDetailBody(opts.detail ?? {}));
    }
    if (decoded.includes("Q623109")) {
      searchCalls++;
      return jsonResponse(makeSparqlSearchBody(opts.qid));
    }
    throw new Error(`unroutable wikidata query in enrichLeague test: ${decoded}`);
  }) as unknown as typeof fetch;
  return { fetch: impl, searchCalls: () => searchCalls, detailCalls: () => detailCalls };
}

async function seedSport(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      // The real production config: `sportQid` is what narrows the search to
      // baseball leagues, and it is read off the sport ROW, never a name-keyed
      // map (NEO-96).
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q809892" },
      },
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

/**
 * A league shaped as `findOrCreateLeague` inserts one. `abbreviation`/`level`
 * are settable here because the default row is BORN with both — proving they
 * are not enrichment markers is half of what this file is for.
 */
async function insertLeague(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  opts: {
    name: string;
    abbreviation?: string;
    level?: "major" | "minor";
    yearsActive?: { from: number; to?: number };
    wikidataId?: string;
  },
): Promise<Id<"leagues">> {
  return t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name: opts.name,
      nameNormalized: normalizeLeagueName(opts.name),
      sportId,
      ...(opts.abbreviation ? { abbreviation: opts.abbreviation } : {}),
      ...(opts.level ? { level: opts.level } : {}),
      ...(opts.yearsActive ? { yearsActive: opts.yearsActive } : {}),
      ...(opts.wikidataId ? { externalIds: { wikidataId: opts.wikidataId } } : {}),
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

const getLeague = (t: ReturnType<typeof convexTest>, id: Id<"leagues">) =>
  t.run(async (ctx) => ctx.db.get(id));

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================

describe("enrichLeague", () => {
  test("full hit: QID, P1813 abbreviation and an open-ended span are all persisted", async () => {
    // Major League Baseball as Wikidata actually holds it (verified live
    // 2026-09-04): Q1163715, P1813 "MLB", P571 1903 at year precision, no
    // P576 — still going.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, sportId, {
      name: "Major League Baseball",
      level: "major",
    });

    const stub = makeFetchStub({
      qid: "Q1163715",
      detail: {
        shortName: "MLB",
        inception: "1903-01-01T00:00:00Z",
        country: "United States",
      },
    });
    vi.stubGlobal("fetch", stub.fetch);

    await t.action(internal.adapters.wikidata.enrichLeague, { leagueId });

    const league = await getLeague(t, leagueId);
    expect(league!.externalIds?.wikidataId).toBe("Q1163715");
    expect(league!.abbreviation).toBe("MLB");
    expect(league!.yearsActive).toEqual({ from: 1903 });
    // `to` absent means still active — not null, not 0.
    expect(league!.yearsActive?.to).toBeUndefined();
    // Country is looked up but has nowhere to go: `leagues` has no such field,
    // and enrichment must not invent schema.
    expect(Object.keys(league!)).not.toContain("country");
    // The row's own identity is never restamped from a source.
    expect(league!.name).toBe("Major League Baseball");
    expect(league!.level).toBe("major");
    expect(stub.searchCalls()).toBe(1);
    expect(stub.detailCalls()).toBe(1);
  });

  test("a defunct league gets both ends of its span, and no abbreviation when Wikidata has none", async () => {
    // The Federal League, Q1131829 (verified live 2026-09-04): P571 1913,
    // P576 1915, and NO P1813 at all — which is the common shape for the
    // vintage leagues that actually need this field, so "absent" has to mean
    // "left alone" rather than "written as empty".
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, sportId, { name: "Federal League" });

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        qid: "Q1131829",
        detail: {
          inception: "1913-01-01T00:00:00Z",
          dissolved: "1915-01-01T00:00:00Z",
          country: "United States",
        },
      }).fetch,
    );

    await t.action(internal.adapters.wikidata.enrichLeague, { leagueId });

    const league = await getLeague(t, leagueId);
    expect(league!.yearsActive).toEqual({ from: 1913, to: 1915 });
    expect(league!.externalIds?.wikidataId).toBe("Q1131829");
    expect(league!.abbreviation).toBeUndefined();
  });

  test("a full-precision inception date still yields a bare year", async () => {
    // The NHL's P571 is 1917-11-26 at day precision, not a bare year. The same
    // parser the team lookup uses has to cope with either rendering, or a
    // league's founding silently becomes no span at all.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, sportId, { name: "National Hockey League" });

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        qid: "Q1215892",
        detail: { shortName: "NHL", inception: "1917-11-26T00:00:00Z" },
      }).fetch,
    );

    await t.action(internal.adapters.wikidata.enrichLeague, { leagueId });

    expect((await getLeague(t, leagueId))!.yearsActive).toEqual({ from: 1917 });
  });

  test("no search match: nothing is applied, and the detail query is never asked", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, sportId, {
      name: "Some Unresolvable League",
    });
    const before = await getLeague(t, leagueId);

    const stub = makeFetchStub({ qid: null });
    vi.stubGlobal("fetch", stub.fetch);

    // A miss is fall-back, not failure — the action resolves.
    await expect(
      t.action(internal.adapters.wikidata.enrichLeague, { leagueId }),
    ).resolves.toBeNull();

    // Nothing written at all, not even `lastUpdated`.
    expect(await getLeague(t, leagueId)).toEqual(before);
    expect(stub.searchCalls()).toBe(1);
    expect(stub.detailCalls()).toBe(0);
  });

  test("gap-fill: an operator's abbreviation survives, and the empty fields still fill", async () => {
    // `applyEnrichmentInternal` fills gaps only. A corrected abbreviation that
    // lasts until the next lookup is worse than one that was never applied —
    // so Wikidata's "MLB" must lose to the operator's own wording while the
    // span and the id, which the operator never set, still land.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, sportId, {
      name: "Major League Baseball",
      abbreviation: "Majors",
    });

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        qid: "Q1163715",
        detail: { shortName: "MLB", inception: "1903-01-01T00:00:00Z" },
      }).fetch,
    );

    await t.action(internal.adapters.wikidata.enrichLeague, { leagueId });

    const league = await getLeague(t, leagueId);
    expect(league!.abbreviation).toBe("Majors");
    expect(league!.yearsActive).toEqual({ from: 1903 });
    expect(league!.externalIds?.wikidataId).toBe("Q1163715");
  });

  test("force re-runs the lookup on a marked row, and still does not overwrite what is there", async () => {
    // The operator remedy (`leagues.enrichFromWikidata`) is the only caller
    // that sets `force`. It buys a fresh LOOKUP past the creation-only guard;
    // it does not buy an overwrite, because gap-fill is a separate rule living
    // in the mutation. So a wrong stored id stays wrong until a human clears
    // it — which is the honest behaviour: nothing silently restamps a row.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, sportId, {
      name: "Major League Baseball",
      wikidataId: "Q1",
    });

    const stub = makeFetchStub({
      qid: "Q1163715",
      detail: { shortName: "MLB", inception: "1903-01-01T00:00:00Z" },
    });
    vi.stubGlobal("fetch", stub.fetch);

    await t.action(internal.adapters.wikidata.enrichLeague, {
      leagueId,
      force: true,
    });

    // The lookup DID run — that is what force is for.
    expect(stub.searchCalls()).toBe(1);
    expect(stub.detailCalls()).toBe(1);
    const league = await getLeague(t, leagueId);
    expect(league!.externalIds?.wikidataId).toBe("Q1");
    // …and the gap it could fill, it filled.
    expect(league!.yearsActive).toEqual({ from: 1903 });
    expect(league!.abbreviation).toBe("MLB");
  });

  test("without force, the same marked row is skipped before any request is made", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, sportId, {
      name: "Major League Baseball",
      wikidataId: "Q1163715",
    });
    const before = await getLeague(t, leagueId);

    const stub = makeFetchStub({ qid: "Q1163715" });
    vi.stubGlobal("fetch", stub.fetch);

    await t.action(internal.adapters.wikidata.enrichLeague, { leagueId });

    expect(stub.searchCalls()).toBe(0);
    expect(stub.detailCalls()).toBe(0);
    expect(await getLeague(t, leagueId)).toEqual(before);
  });

  test("a league whose row is gone resolves quietly", async () => {
    // A pool item can outlive its row. `enrichLeague` must not throw out of the
    // action for it — there is no onComplete on this lane to catch anything.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, sportId, { name: "Texas League" });
    await t.run(async (ctx) => ctx.db.delete(leagueId));

    vi.stubGlobal("fetch", makeFetchStub({ qid: null }).fetch);

    await expect(
      t.action(internal.adapters.wikidata.enrichLeague, { leagueId }),
    ).resolves.toBeNull();
  });

  test("a SPARQL failure never escapes the action", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, sportId, { name: "Texas League" });
    const before = await getLeague(t, leagueId);

    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );

    await expect(
      t.action(internal.adapters.wikidata.enrichLeague, { leagueId }),
    ).resolves.toBeNull();
    expect(await getLeague(t, leagueId)).toEqual(before);
  });

  test("the search query carries both filters: the sports-league class and the sport", async () => {
    // Pins the two things the lookup depends on being in the query at all. The
    // class QID is Q623109 ("sports league", verified live 2026-09-04) and the
    // sport QID comes off the sport ROW's sportConfig.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, sportId, { name: "Texas League" });

    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        queries.push(decodeURIComponent(String(url)));
        return jsonResponse(makeSparqlSearchBody(null));
      }) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.wikidata.enrichLeague, { leagueId });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("wdt:P31/wdt:P279* wd:Q623109");
    expect(queries[0]).toContain("wdt:P641 wd:Q5369");
    // Relevance order has to be asked for: without it the search returned the
    // defunct 1902 "National Football League" ahead of the real one.
    expect(queries[0]).toContain("wikibase:apiOrdinal");
    expect(queries[0]).toContain("ORDER BY ?num");
  });

  test("a sport with no wikidata config still gets a class-filtered search", async () => {
    // A custom sport degrades rather than refusing: the sports-league class is
    // a tight enough bound on its own, unlike "any human"/"any sports team".
    const t = convexTest(schema, modules);
    const sportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Cricket",
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      }),
    );
    const leagueId = await insertLeague(t, sportId, { name: "Indian Premier League" });

    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        queries.push(decodeURIComponent(String(url)));
        const decoded = decodeURIComponent(String(url));
        return jsonResponse(
          decoded.includes("P1813")
            ? makeSparqlDetailBody({ shortName: "IPL", inception: "2007-09-13T00:00:00Z" })
            : makeSparqlSearchBody("Q6959"),
        );
      }) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.wikidata.enrichLeague, { leagueId });

    expect(queries[0]).toContain("wdt:P31/wdt:P279* wd:Q623109");
    expect(queries[0]).not.toContain("wdt:P641");
    expect((await getLeague(t, leagueId))!.abbreviation).toBe("IPL");
  });
});
