/**
 * NEO-92: unit tests for the review-wizard side of `convex/adapters/wikidata.ts`:
 *   - `lookupPlayerEnrichment`/`lookupTeamEnrichment` — the pure(-ish) lookup
 *     functions extracted from `enrichPlayer`/`enrichTeam` so the wizard can
 *     preview Wikidata data BEFORE a player/team row is created. Unlike
 *     `enrichPlayer`, `lookupPlayerEnrichment` must NOT resolve `careerTeams`
 *     to real team ids (no team lookup at all) — that's the specific bug the
 *     deferred-materialization design in entityReviewQueue.ts fixes (a mere
 *     preview lookup could otherwise orphan a team row for a player the user
 *     ends up linking to someone else, or never creates). NEO-236 narrowed
 *     `enrichPlayer`'s own resolution to a LOOKUP too, so neither path can
 *     create a team any more — but the preview must still not even look.
 *   - `runEntityReviewLookup` (NEO-99) — the single-row `wikidataPool` work item
 *     that replaced the old chained `processEntityReviewQueue`. One call looks up
 *     one row and patches it "ready"/"error"; the pool (not this action) handles
 *     concurrency. Includes the NEO-99 fetch-timeout coverage: a stalled/aborted
 *     request must resolve the row to "error", never hang it on "pending".
 *
 * Lives at the convex/ ROOT (not co-located under convex/adapters/) for the
 * same reason as convex/wikidataEnrichTeam.test.ts / convex/bscTeamEnrichmentQueue.test.ts:
 * convex-test's `import.meta.glob(...)` module registry breaks when the glob
 * is invoked from within convex/adapters/ itself — see that file's header
 * comment for the full explanation. `runEntityReviewLookup` is an
 * `internalAction` that needs the real convex-test action harness.
 *
 * Fetch mocking follows convex/wikidataEnrichTeam.test.ts's convention:
 * `decodeURIComponent` + check for a predicate unique to each SPARQL call to
 * distinguish the player entity-search query from the player detail query
 * (both hit the same query.wikidata.org host).
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { normalizeTeamName } from "./teams";
import { Id } from "./_generated/dataModel";
import {
  lookupPlayerEnrichment,
  lookupTeamEnrichment,
} from "./adapters/wikidata";

// ---------------------------------------------------------------------------
// Fixture builders — mirrors convex/wikidataEnrichTeam.test.ts's binding
// helpers, extended with a player detail-query shape (team/teamLabel/
// start/end/award bindings for the P54/P166 SPARQL query).
// ---------------------------------------------------------------------------

type SparqlBindingFixture = { type: string; value: string };

function uriBinding(qid: string): SparqlBindingFixture {
  return { type: "uri", value: `http://www.wikidata.org/entity/${qid}` };
}
function literalBinding(value: string): SparqlBindingFixture {
  return { type: "literal", value };
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function makePlayerSearchBody(qid: string | null) {
  return { results: { bindings: qid ? [{ player: uriBinding(qid) }] : [] } };
}

type CareerTeamFixture = {
  teamQid: string;
  teamLabel: string;
  fromYear?: number;
  toYear?: number;
  // NEO-235: the RAW binding values, for shapes a bare year cannot express —
  // a full-precision P580 ("1982-07-19T00:00:00Z"). Wins over fromYear/toYear.
  startRaw?: string;
  endRaw?: string;
};

function makePlayerDetailBody(opts: {
  careerTeams?: CareerTeamFixture[];
  hofAwardQid?: string;
  // NEO-235: the P463 "member of" shape — how the National Baseball Hall of
  // Fame records the majority of its inductees (Gwynn, Ruth, Griffey), and the
  // shape that was invisible to the P166-only detection this ticket replaces.
  // Binds the `?memberOf` column the memberOf strategy's OPTIONAL block emits.
  hofMemberOfQid?: string;
  // NEO-212: the SPARQL response is the cross-product of memberships ×
  // awards, and these three are entity-level — so they repeat identically on
  // every row, which is exactly how the real endpoint returns them.
  descr?: string;
  dob?: string;
  title?: string;
  // NEO-212: emit each membership once per award, reproducing the real
  // cross-product rather than one tidy row per team. Without this the
  // stint-dedup could not be told apart from no dedup at all.
  awardQids?: string[];
}) {
  const rows: Array<Record<string, SparqlBindingFixture>> = [];
  const decorate = (row: Record<string, SparqlBindingFixture>) => {
    if (opts.descr !== undefined) row.descr = literalBinding(opts.descr);
    if (opts.dob !== undefined) row.dob = literalBinding(opts.dob);
    if (opts.title !== undefined) row.title = literalBinding(opts.title);
    return row;
  };
  // `hofAwardQid` is the single-award shorthand the pre-NEO-212 tests use;
  // `awardQids` is the explicit list, for exercising the cross-product.
  const awards = opts.awardQids ?? (opts.hofAwardQid ? [opts.hofAwardQid] : []);
  // NEO-235: `?memberOf` is entity-level and binds at most once (its OPTIONAL
  // block matches a FIXED object), so unlike `?award` it repeats identically
  // on every row rather than multiplying them.
  const withMemberOf = (row: Record<string, SparqlBindingFixture>) => {
    if (opts.hofMemberOfQid !== undefined) row.memberOf = uriBinding(opts.hofMemberOfQid);
    return row;
  };
  for (const ct of opts.careerTeams ?? []) {
    const base: Record<string, SparqlBindingFixture> = {
      team: uriBinding(ct.teamQid),
      teamLabel: literalBinding(ct.teamLabel),
    };
    // NEO-235: a membership with NEITHER is the undated shape — Gwynn's third
    // P54 statement, which carries no qualifiers at all.
    if (ct.startRaw !== undefined) base.start = literalBinding(ct.startRaw);
    else if (ct.fromYear !== undefined) base.start = literalBinding(`${ct.fromYear}-01-01T00:00:00Z`);
    if (ct.endRaw !== undefined) base.end = literalBinding(ct.endRaw);
    else if (ct.toYear !== undefined) base.end = literalBinding(`${ct.toYear}-01-01T00:00:00Z`);
    if (awards.length === 0) {
      rows.push(decorate(withMemberOf({ ...base })));
    } else {
      for (const award of awards) {
        rows.push(decorate(withMemberOf({ ...base, award: uriBinding(award) })));
      }
    }
  }
  if (rows.length === 0) {
    if (awards.length > 0) {
      for (const award of awards) rows.push(decorate(withMemberOf({ award: uriBinding(award) })));
    } else if (opts.hofMemberOfQid !== undefined) {
      rows.push(decorate(withMemberOf({})));
    } else if (opts.descr !== undefined || opts.dob !== undefined || opts.title !== undefined) {
      // A player with no teams and no awards still has entity-level fields,
      // and they arrive on a single otherwise-empty row.
      rows.push(decorate({}));
    }
  }
  return { results: { bindings: rows } };
}

/**
 * Routes a stubbed global `fetch` for `lookupPlayerEnrichment` calls:
 *  - any `query.wikidata.org` call WITHOUT `p:P54`/`wdt:P166` in the decoded
 *    query is the entity-SEARCH query (findPlayerQid's EntitySearch lookup)
 *  - a call WITH those predicates is the player DETAIL query
 * Fails loudly (throws) on any unexpected URL — e.g. a stray team-resolution
 * call, which must never happen from this pure lookup.
 */
function makePlayerFetchStub(opts: {
  qid: string | null;
  detail?: Parameters<typeof makePlayerDetailBody>[0];
}): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (!u.includes("query.wikidata.org")) {
      throw new Error(`unexpected fetch url in lookupPlayerEnrichment test: ${u}`);
    }
    const decoded = decodeURIComponent(u);
    const isDetailQuery = decoded.includes("p:P54") || decoded.includes("wdt:P166");
    if (isDetailQuery) {
      return jsonResponse(makePlayerDetailBody(opts.detail ?? {}));
    }
    return jsonResponse(makePlayerSearchBody(opts.qid));
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// lookupPlayerEnrichment — pure, no db writes, no team-resolution fetch
// ===========================================================================

describe("lookupPlayerEnrichment", () => {
  test("returns careerTeams as bare NAMES (not resolved ids) — exactly 2 fetch calls, no extra team-resolution round trip", async () => {
    const calls: string[] = [];
    const stub = makePlayerFetchStub({
      qid: "Q123456",
      detail: {
        careerTeams: [
          { teamQid: "Q217123", teamLabel: "Los Angeles Angels", fromYear: 2011 },
        ],
      },
    });
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        calls.push(String(url));
        return stub(url);
      }) as unknown as typeof fetch,
    );

    const result = await lookupPlayerEnrichment("Mike Trout", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });

    expect(result).not.toBeNull();
    expect(result!.wikidataId).toBe("Q123456");
    // A bare string name, not a teams._id — the whole point of deferring
    // team-row materialization to commit time.
    expect(result!.careerTeams).toEqual([
      { name: "Los Angeles Angels", fromYear: 2011, toYear: undefined },
    ]);
    expect(typeof result!.careerTeams[0].name).toBe("string");
    // Exactly the search + detail SPARQL calls — no third call resolving
    // "Los Angeles Angels" to a team id (that would prove a leaked
    // team-resolution side effect in what is meant to be a pure preview).
    expect(calls).toHaveLength(2);
  });

  test("returns isHallOfFame from the HoF-award P166 binding", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1000",
        detail: { hofAwardQid: "Q1194380" }, // National Baseball Hall of Fame
      }),
    );

    const result = await lookupPlayerEnrichment("Derek Jeter", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });
    expect(result!.isHallOfFame).toBe(true);
  });

  test("defaults isHallOfFame to false (not undefined) for a HoF-aware sport with no matching award", async () => {
    vi.stubGlobal("fetch", makePlayerFetchStub({ qid: "Q1000", detail: {} }));

    const result = await lookupPlayerEnrichment("Some Journeyman", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });
    expect(result!.isHallOfFame).toBe(false);
  });

  test("returns null (no fetch beyond the search call) when no Wikidata QID is found", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        callCount++;
        return makePlayerFetchStub({ qid: null })(url);
      }) as unknown as typeof fetch,
    );

    const result = await lookupPlayerEnrichment("Totally Unknown Prospect", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });
    expect(result).toBeNull();
    expect(callCount).toBe(1); // search query only — no detail query attempted
  });

  test("returns null for a sport with no sportConfig.wikidata mapping, without calling fetch at all", async () => {
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      (async () => {
        fetchCalled = true;
        throw new Error("fetch must not be called for an unmapped sport");
      }) as unknown as typeof fetch,
    );

    const result = await lookupPlayerEnrichment("Someone", { label: "Cricket" });
    expect(result).toBeNull();
    expect(fetchCalled).toBe(false);
  });
});


// ===========================================================================
// NEO-212 — multi-stint careers, and the player disambiguation fields.
//
// The old `seenTeams` set was keyed on the bare team QID. That collapsed the
// membership × award cross-product (its actual job) but ALSO threw away a
// player's second stint at a team they returned to, which is the single most
// interesting thing a career timeline can record. The key is now the whole
// stint — team + start + end — so both survive.
// ===========================================================================

describe("lookupPlayerEnrichment: multi-stint careers", () => {
  test("keeps BOTH stints when one team appears twice with different years, sorted earliest first", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1000",
        detail: {
          careerTeams: [
            // Deliberately returned LATEST-first, the way the endpoint may
            // well order them — the sort, not the response, decides.
            { teamQid: "Q217123", teamLabel: "Los Angeles Angels", fromYear: 2016, toYear: 2019 },
            { teamQid: "Q217123", teamLabel: "Los Angeles Angels", fromYear: 2011, toYear: 2013 },
          ],
        },
      }),
    );

    const result = await lookupPlayerEnrichment("Returning Player", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });

    expect(result!.careerTeams).toEqual([
      { name: "Los Angeles Angels", fromYear: 2011, toYear: 2013 },
      { name: "Los Angeles Angels", fromYear: 2016, toYear: 2019 },
    ]);
  });

  test("still collapses the membership x award cross-product to one entry per stint", async () => {
    // Two teams and three awards is six SPARQL rows for two real stints. If
    // the dedup key ever stops collapsing, this reads back as six careerTeams.
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1000",
        detail: {
          careerTeams: [
            { teamQid: "Q217123", teamLabel: "Los Angeles Angels", fromYear: 2011, toYear: 2013 },
            { teamQid: "Q217124", teamLabel: "Seattle Mariners", fromYear: 2014 },
          ],
          awardQids: ["Q1194380", "Q999001", "Q999002"],
        },
      }),
    );

    const result = await lookupPlayerEnrichment("Decorated Player", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });

    expect(result!.careerTeams).toEqual([
      { name: "Los Angeles Angels", fromYear: 2011, toYear: 2013 },
      { name: "Seattle Mariners", fromYear: 2014, toYear: undefined },
    ]);
    // The HoF award is in that list, so the collapse did not cost the award
    // scan anything either.
    expect(result!.isHallOfFame).toBe(true);
  });

  test("sorts stints across DIFFERENT teams into one chronological timeline", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1000",
        detail: {
          careerTeams: [
            { teamQid: "Q3", teamLabel: "Third Team", fromYear: 2020 },
            { teamQid: "Q1", teamLabel: "First Team", fromYear: 2005, toYear: 2010 },
            { teamQid: "Q2", teamLabel: "Second Team", fromYear: 2010, toYear: 2020 },
          ],
        },
      }),
    );

    const result = await lookupPlayerEnrichment("Journeyman", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });
    expect(result!.careerTeams.map((ct) => ct.name)).toEqual([
      "First Team",
      "Second Team",
      "Third Team",
    ]);
  });
});

describe("lookupPlayerEnrichment: disambiguation fields (description / birthYear / enwikiTitle)", () => {
  test("parses all three when Wikidata has them", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1000",
        detail: {
          careerTeams: [
            { teamQid: "Q217123", teamLabel: "Los Angeles Angels", fromYear: 2011 },
          ],
          descr: "American football running back",
          dob: "1991-08-07T00:00:00Z",
          title: "Chris Johnson (running back)",
        },
      }),
    );

    const result = await lookupPlayerEnrichment("Chris Johnson", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });
    expect(result!.description).toBe("American football running back");
    expect(result!.birthYear).toBe(1991);
    expect(result!.enwikiTitle).toBe("Chris Johnson (running back)");
  });

  test("leaves each field ABSENT (not null, not empty string) when Wikidata has none of them", async () => {
    // A real but thinly-documented player. The wizard renders on presence, so
    // an empty string here would show a blank line claiming to be a
    // description rather than nothing at all.
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1000",
        detail: {
          careerTeams: [
            { teamQid: "Q217123", teamLabel: "Los Angeles Angels", fromYear: 2011 },
          ],
        },
      }),
    );

    const result = await lookupPlayerEnrichment("Obscure Prospect", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });
    expect(result).not.toBeNull();
    expect("description" in result!).toBe(false);
    expect("birthYear" in result!).toBe(false);
    expect("enwikiTitle" in result!).toBe(false);
  });

  test("reads them off a player with no career teams and no awards at all", async () => {
    // The OPTIONAL blocks are independent, so a player whose only bindings are
    // the entity-level three still yields them — one row, no team, no award.
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1000",
        detail: {
          descr: "British racing cyclist",
          dob: "1985-03-02T00:00:00Z",
          title: "Chris Johnson (cyclist)",
        },
      }),
    );

    const result = await lookupPlayerEnrichment("Chris Johnson", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });
    expect(result!.careerTeams).toEqual([]);
    expect(result!.description).toBe("British racing cyclist");
    expect(result!.birthYear).toBe(1985);
    expect(result!.enwikiTitle).toBe("Chris Johnson (cyclist)");
  });

  test("the SPARQL detail query asks for the description, P569 and the enwiki sitelink", async () => {
    // Cheap structural guard: the parsing tests above would all still pass
    // against a query that never requested these, since the fixture supplies
    // the bindings unconditionally.
    let detailQuery = "";
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        const decoded = decodeURIComponent(String(url));
        if (decoded.includes("p:P54") || decoded.includes("wdt:P166")) {
          detailQuery = decoded;
        }
        return makePlayerFetchStub({ qid: "Q1000", detail: {} })(url);
      }) as unknown as typeof fetch,
    );

    await lookupPlayerEnrichment("Someone", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });
    expect(detailQuery).toContain("schema:description");
    expect(detailQuery).toContain("wdt:P569");
    expect(detailQuery).toContain("schema:isPartOf <https://en.wikipedia.org/>");
  });
});

// ===========================================================================
// NEO-235 — Hall of Fame is not one property, and a career team is not always
// dated.
//
// Found on production with Tony Gwynn (Q1145222), who came back
// `isHallOfFame: false`. His induction is recorded as P463 "member of" →
// Q809892 (National Baseball Hall of Fame and Museum) with a P580 of 2007;
// he has no P166 statement for the Hall at all, and P166 was the only shape we
// looked for. Verified live on 2026-09-04 — endpoint-wide, Q809892 is reached
// by P463 for 66 people and by P166 for 41, so the property we handled was the
// MINORITY shape for the sport with the most cards.
//
// The fixtures below are Gwynn-shaped on purpose: the same three P54
// statements (one full-precision, one year-precision, one with no qualifiers
// at all) and the same P463-only induction.
// ===========================================================================

/**
 * The real National Baseball Hall of Fame and Museum. The fixtures elsewhere
 * in this file use the placeholder the sport row used to carry; these use the
 * live value, because these tests are about matching what Wikidata actually
 * returns.
 */
const HOF_QID = "Q809892";

const BASEBALL_SPORT = {
  label: "Baseball",
  wikidata: { sportQid: "Q5369", hallOfFameQid: HOF_QID },
  espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
};

/** Gwynn's three P54 statements, exactly as WDQS renders them. */
const GWYNN_MEMBERSHIPS: CareerTeamFixture[] = [
  {
    teamQid: "Q721134",
    teamLabel: "San Diego Padres",
    // Precision 11 (day) — the case a year-only parser would drop entirely.
    startRaw: "1982-07-19T00:00:00Z",
    endRaw: "2001-01-01T00:00:00Z",
  },
  {
    teamQid: "Q7413724",
    teamLabel: "San Diego State Aztecs men's basketball",
    fromYear: 1977,
    toYear: 1981,
  },
  // No qualifiers at all. Cannot become a stint; must not vanish silently.
  { teamQid: "Q16969667", teamLabel: "San Diego State Aztecs baseball" },
];

describe("lookupPlayerEnrichment: Hall-of-Fame detection strategies (NEO-235)", () => {
  test("P463 'member of' alone flips isHallOfFame true — the Tony Gwynn shape", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({ qid: "Q1145222", detail: { hofMemberOfQid: HOF_QID } }),
    );

    const result = await lookupPlayerEnrichment("Tony Gwynn", BASEBALL_SPORT);
    expect(result!.isHallOfFame).toBe(true);
  });

  test("P166 'award received' alone still flips it true — the shape we already handled", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({ qid: "Q505423", detail: { hofAwardQid: HOF_QID } }),
    );

    const result = await lookupPlayerEnrichment("Jerry Rice", BASEBALL_SPORT);
    expect(result!.isHallOfFame).toBe(true);
  });

  test("a link on ONE property is enough even when the other names a different entity", async () => {
    // The failure this guards: an `else`/precedence slip that let a
    // non-matching P166 mask a matching P463.
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1145222",
        detail: { awardQids: ["Q120649", "Q1366948"], hofMemberOfQid: HOF_QID },
      }),
    );

    const result = await lookupPlayerEnrichment("Tony Gwynn", BASEBALL_SPORT);
    expect(result!.isHallOfFame).toBe(true);
  });

  test("neither property matching is a definitive false when the sport's Hall is known", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({ qid: "Q1000", detail: { awardQids: ["Q120649"] } }),
    );

    const result = await lookupPlayerEnrichment("Some Journeyman", BASEBALL_SPORT);
    expect(result!.isHallOfFame).toBe(false);
  });

  test("no hallOfFameQid on the sport leaves isHallOfFame UNDEFINED, never false", async () => {
    // Soccer ships without one deliberately (no single canonical Hall), and a
    // false there would be a claim we cannot support.
    vi.stubGlobal("fetch", makePlayerFetchStub({ qid: "Q1000", detail: {} }));

    const result = await lookupPlayerEnrichment("Some Footballer", {
      label: "Soccer",
      wikidata: { sportQid: "Q2736" },
    });
    expect(result!.isHallOfFame).toBeUndefined();
  });

  test("a hallOfFameQid that is not a QID is refused, not interpolated — undefined, not false", async () => {
    // The sport row is the source of truth for this value and nothing stops a
    // legacy or hand-edited row holding something else. It reaches SPARQL as
    // `wd:${hofQid}` now, so it is validated first.
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        queries.push(decodeURIComponent(String(url)));
        return makePlayerFetchStub({ qid: "Q1000", detail: {} })(url);
      }) as unknown as typeof fetch,
    );

    const result = await lookupPlayerEnrichment("Some Player", {
      label: "Baseball",
      wikidata: { sportQid: "Q5369", hallOfFameQid: "} } INJECTED { #" },
    });

    expect(result!.isHallOfFame).toBeUndefined();
    for (const q of queries) expect(q).not.toContain("INJECTED");
  });

  test("both HoF strategies emit a fixed-object block — the query does not bind every award", async () => {
    // The row-count reason, not a style preference: an unfiltered `?award`
    // column multiplied the membership rows by the player's whole award list
    // (Michael Jordan: ~350 rows for 7 teams).
    let detailQuery = "";
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        const decoded = decodeURIComponent(String(url));
        if (decoded.includes("p:P54")) detailQuery = decoded;
        return makePlayerFetchStub({ qid: "Q1000", detail: {} })(url);
      }) as unknown as typeof fetch,
    );

    await lookupPlayerEnrichment("Some Player", BASEBALL_SPORT);

    expect(detailQuery).toContain(`wdt:P166 wd:${HOF_QID}`);
    expect(detailQuery).toContain(`wdt:P463 wd:${HOF_QID}`);
    expect(detailQuery).not.toContain("wdt:P166 ?award");
  });
});

describe("lookupPlayerEnrichment: career-team strategies (NEO-235)", () => {
  test("a full-precision P580 yields the YEAR — 1982-07-19 is a 1982 stint", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1145222",
        detail: {
          careerTeams: [
            {
              teamQid: "Q721134",
              teamLabel: "San Diego Padres",
              startRaw: "1982-07-19T00:00:00Z",
              endRaw: "2001-01-01T00:00:00Z",
            },
          ],
        },
      }),
    );

    const result = await lookupPlayerEnrichment("Tony Gwynn", BASEBALL_SPORT);
    expect(result!.careerTeams).toEqual([
      { name: "San Diego Padres", fromYear: 1982, toYear: 2001 },
    ]);
  });

  test("an undated P54 is surfaced in undatedCareerTeams and kept OUT of careerTeams", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1145222",
        detail: { careerTeams: GWYNN_MEMBERSHIPS, hofMemberOfQid: HOF_QID },
      }),
    );

    const result = await lookupPlayerEnrichment("Tony Gwynn", BASEBALL_SPORT);

    expect(result!.careerTeams).toEqual([
      { name: "San Diego State Aztecs men's basketball", fromYear: 1977, toYear: 1981 },
      { name: "San Diego Padres", fromYear: 1982, toYear: 2001 },
    ]);
    expect(result!.undatedCareerTeams).toEqual(["San Diego State Aztecs baseball"]);
    expect(result!.isHallOfFame).toBe(true);
  });

  test("undatedCareerTeams is ABSENT (not an empty array) when every membership is dated", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1000",
        detail: {
          careerTeams: [{ teamQid: "Q721134", teamLabel: "San Diego Padres", fromYear: 1982 }],
        },
      }),
    );

    const result = await lookupPlayerEnrichment("Someone", BASEBALL_SPORT);
    expect(result!.undatedCareerTeams).toBeUndefined();
    expect("undatedCareerTeams" in result!).toBe(false);
  });

  test("an undated membership with no English label is dropped, not surfaced as a bare QID", async () => {
    // Same reason the dated path drops it: the operator would be shown
    // "Q127635", which is not a team name.
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1000",
        detail: { careerTeams: [{ teamQid: "Q127635", teamLabel: "Q127635" }] },
      }),
    );

    const result = await lookupPlayerEnrichment("Someone", BASEBALL_SPORT);
    expect(result!.undatedCareerTeams).toBeUndefined();
    expect(result!.careerTeams).toEqual([]);
  });

  test("the same undated team repeated across cross-product rows is named ONCE", async () => {
    vi.stubGlobal(
      "fetch",
      makePlayerFetchStub({
        qid: "Q1000",
        detail: {
          careerTeams: [{ teamQid: "Q16969667", teamLabel: "San Diego State Aztecs baseball" }],
          // Three awards ⇒ the membership arrives on three rows.
          awardQids: ["Q120649", "Q1366948", "Q3405246"],
        },
      }),
    );

    const result = await lookupPlayerEnrichment("Someone", BASEBALL_SPORT);
    expect(result!.undatedCareerTeams).toEqual(["San Diego State Aztecs baseball"]);
  });
});

// ===========================================================================
// NEO-235 — the two consumers of PlayerLookupResult must agree.
//
// `enrichPlayer` (post-creation, writes `players`) and `runEntityReviewLookup`
// (pre-creation preview, writes `entityReviewQueue.enrichment`) both go through
// `lookupPlayerEnrichment`, so a strategy added for one is a strategy the other
// has too. These drive ONE Gwynn-shaped fixture through BOTH and assert they
// reach the same conclusion — the pin against a future "fix it in enrichPlayer
// only" divergence.
// ===========================================================================

describe("both enrichment paths agree on a Gwynn-shaped fixture (NEO-235)", () => {
  const modules = (import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }).glob("./**/*.*s");

  const seedGwynnSport = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport" as const,
        value: "Baseball",
        platformData: {},
        children: [],
        sportConfig: {
          skuCode: "BB",
          league: "MLB",
          espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
          wikidata: { sportQid: "Q5369", hallOfFameQid: HOF_QID },
        },
        lastUpdated: Date.now(),
      }),
    );

  const gwynnStub = () =>
    makePlayerFetchStub({
      qid: "Q1145222",
      detail: { careerTeams: GWYNN_MEMBERSHIPS, hofMemberOfQid: HOF_QID },
    });

  test("enrichPlayer writes isHallOfFame true and both DATED stints, ignoring the undated one", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedGwynnSport(t);
    // NEO-236: career teams are LINKED, never created — `enrichPlayer` calls
    // `teams.findByFullNameInternal` now, so a stint only lands if we already
    // hold the team. One of these is stored SPLIT and the other whole, which
    // is the state the rollout actually produces, and both must resolve from
    // Wikidata's full-string label.
    const aztecsId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "San Diego State Aztecs men's basketball",
        nameNormalized: normalizeTeamName("San Diego State Aztecs men's basketball"),
        sportId,
        lastUpdated: 1_700_000_000_000,
      }),
    );
    const padresId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: normalizeTeamName("San Diego Padres"),
        sportId,
        lastUpdated: 1_700_000_000_000,
      }),
    );
    const playerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: "tony gwynn",
        sportId,
        createdByUserId: "user_test",
        lastUpdated: 1_700_000_000_000,
      }),
    );

    vi.stubGlobal("fetch", gwynnStub());
    await t.action(internal.adapters.wikidata.enrichPlayer, { playerId });

    const player = await t.run(async (ctx) => ctx.db.get(playerId));
    expect(player!.isHallOfFame).toBe(true);
    expect(player!.externalIds?.wikidataId).toBe("Q1145222");
    // Two stints, earliest first — the undated Aztecs baseball membership has
    // no `fromYear` and `players.teamYears` has nowhere to put it.
    expect(player!.teamYears).toHaveLength(2);
    expect(player!.teamYears!.map((ty) => ty.fromYear)).toEqual([1977, 1982]);
    expect(player!.teamYears!.map((ty) => ty.teamId)).toEqual([aztecsId, padresId]);
    // No team was minted along the way.
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(2);
  });

  /**
   * NEO-236 — a career team we do not hold is SKIPPED, not created.
   *
   * Before this, enriching one player inserted a globally-shared `teams` row
   * per unseen P54 label — rows no operator chose, named however Wikidata
   * happened to spell it, which every picker and spine label then offered.
   * Creation takes Location + Name from a person; this path has neither.
   *
   * The stint is genuinely lost rather than parked: `players.teamYears`
   * requires a `teamId` and the row has nowhere to hold a bare name (the same
   * constraint that produced `undatedCareerTeams` in NEO-235). The miss is
   * logged so the aggregate is visible, and the review wizard is where an
   * operator turns one of these into a real team.
   */
  test("a career team we do not hold is skipped and logged, and no team row is created", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedGwynnSport(t);
    // Only ONE of Gwynn's two dated teams exists.
    const padresId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: normalizeTeamName("San Diego Padres"),
        sportId,
        lastUpdated: 1_700_000_000_000,
      }),
    );
    const playerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: "tony gwynn",
        sportId,
        createdByUserId: "user_test",
        lastUpdated: 1_700_000_000_000,
      }),
    );

    const logged: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        logged.push(String(args[0]));
      });
    try {
      vi.stubGlobal("fetch", gwynnStub());
      await t.action(internal.adapters.wikidata.enrichPlayer, { playerId });
    } finally {
      logSpy.mockRestore();
    }

    const player = await t.run(async (ctx) => ctx.db.get(playerId));
    expect(player!.teamYears).toEqual([
      { teamId: padresId, fromYear: 1982, toYear: 2001 },
    ]);
    // Nothing inserted — still just the one team we seeded.
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);

    const unmatched = logged
      .map((line) => {
        try {
          return JSON.parse(line) as { msg?: string; player?: string; team?: string };
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.msg === "career_team_unmatched");
    expect(unmatched).toEqual([
      {
        msg: "career_team_unmatched",
        player: "Tony Gwynn",
        team: "San Diego State Aztecs men's basketball",
      },
    ]);
  });

  test("runEntityReviewLookup stores the same verdict, plus the undated team by name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedGwynnSport(t);
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: sportId,
        batchId: "batch-neo235",
        createdByUserId: "user_review_001",
        kind: "player" as const,
        name: "Tony Gwynn",
        sportId,
        status: "pending" as const,
      }),
    );

    vi.stubGlobal("fetch", gwynnStub());
    await t.action(internal.adapters.wikidata.runEntityReviewLookup, { rowId });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.status).toBe("ready");
    expect(row!.enrichment?.isHallOfFame).toBe(true);
    expect(row!.enrichment?.careerTeams).toEqual([
      { name: "San Diego State Aztecs men's basketball", fromYear: 1977, toYear: 1981 },
      { name: "San Diego Padres", fromYear: 1982, toYear: 2001 },
    ]);
    // The whole point of surfacing it: the preview row carries it, so the
    // wizard CAN show it. Proves the enrichment validator accepts the field —
    // an unvalidated extra key would have thrown on the patch.
    expect(row!.enrichment?.undatedCareerTeams).toEqual([
      "San Diego State Aztecs baseball",
    ]);
  });
});

// ===========================================================================
// lookupTeamEnrichment — already side-effect-free; smoke-test it's still
// reachable/exported correctly from the same module. Full multi-source merge
// coverage already exists in convex/wikidataEnrichTeam.test.ts (via
// enrichTeam, which is a thin wrapper over this same function).
// ===========================================================================

describe("lookupTeamEnrichment", () => {
  test("returns null (no writes possible — it's a pure function) when neither ESPN nor Wikidata match", async () => {
    vi.stubGlobal(
      "fetch",
      (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
    );

    const result = await lookupTeamEnrichment("Some Unresolvable Team", { label: "Baseball", wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" }, espn: { path: "baseball/mlb", leagueName: "Major League Baseball" } });
    expect(result).toBeNull();
  });
});

// ===========================================================================
// runEntityReviewLookup — one row's lookup + patch (the wikidataPool work item)
// ===========================================================================

describe("runEntityReviewLookup", () => {
  const modules = (import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }).glob("./**/*.*s");

  async function seedSelectorOption(
    t: ReturnType<typeof convexTest>,
  ): Promise<Id<"selectorOptions">> {
    return t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        // NEO-96: enrichment reads the QIDs off the sport row now.
        sportConfig: {
          skuCode: "BB",
          league: "MLB",
          espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
          wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
        },
        lastUpdated: Date.now(),
      }),
    );
  }

  async function seedReviewRow(
    t: ReturnType<typeof convexTest>,
    selectorOptionId: Id<"selectorOptions">,
    opts: { kind: "player" | "team"; name: string },
  ): Promise<Id<"entityReviewQueue">> {
    return t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId,
        batchId: "batch-1",
        createdByUserId: "user_review_001",
        kind: opts.kind,
        name: opts.name,
        // NEO-96: these tests seed the sport row and the review row's
        // selectorOption as the SAME row, which is fine — the lookup only needs
        // a valid reference to resolve config from.
        sportId: selectorOptionId,
        status: "pending",
      }),
    );
  }

  const getRow = (t: ReturnType<typeof convexTest>, id: Id<"entityReviewQueue">) =>
    t.run(async (ctx) => ctx.db.get(id));

  test("patches a matched player row to 'ready' with the resolved enrichment", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Mike Trout" });

    vi.stubGlobal("fetch", makePlayerFetchStub({ qid: "Q123456", detail: {} }));

    await t.action(internal.adapters.wikidata.runEntityReviewLookup, { rowId: row });

    const r = await getRow(t, row);
    expect(r!.status).toBe("ready");
    expect(r!.enrichment?.wikidataId).toBe("Q123456");
  });

  test("patches a no-match row to 'error' (never leaves it 'pending')", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Unknown Prospect" });

    vi.stubGlobal(
      "fetch",
      (async () => jsonResponse(makePlayerSearchBody(null))) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.wikidata.runEntityReviewLookup, { rowId: row });

    const r = await getRow(t, row);
    expect(r!.status).toBe("error");
  });

  test("a deleted row is a no-op — resolves null, patches nothing", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Deleted Player" });
    await t.run(async (ctx) => ctx.db.delete(row));

    // fetch must never be reached for a row that no longer exists.
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      (async () => {
        fetchCalled = true;
        throw new Error("fetch must not be called for a deleted row");
      }) as unknown as typeof fetch,
    );

    await expect(
      t.action(internal.adapters.wikidata.runEntityReviewLookup, { rowId: row }),
    ).resolves.toBeNull();
    expect(fetchCalled).toBe(false);
  });

  test("a lookup that throws is caught — the row is marked 'error'", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Throws During Lookup" });

    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.wikidata.runEntityReviewLookup, { rowId: row });

    const r = await getRow(t, row);
    expect(r!.status).toBe("error");
  });

  // ── NEO-99 fetch timeout ────────────────────────────────────────────────
  // The second half of the "Looking up…" hang: without a fetch timeout a
  // throttled Wikidata request could stall forever, so its `await` never
  // returned and the row was never patched out of "pending". `runSparql` now
  // passes `AbortSignal.timeout(...)`, and any rejection (a fired timeout
  // included) maps to null → the row resolves to "error" instead of hanging.

  test("every SPARQL fetch is given an AbortSignal (the timeout is wired)", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Signal Check" });

    let sawSignal = false;
    vi.stubGlobal(
      "fetch",
      (async (_url: string | URL, init?: { signal?: unknown }) => {
        // An AbortSignal is what lets a stalled request be aborted; assert one
        // is passed on the request that could otherwise hang.
        if (init?.signal instanceof AbortSignal) sawSignal = true;
        return jsonResponse(makePlayerSearchBody(null));
      }) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.wikidata.runEntityReviewLookup, { rowId: row });
    expect(sawSignal).toBe(true);
  });

  test("an aborted/timed-out request resolves the row to 'error' rather than hanging it", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Times Out" });

    // Simulate what AbortSignal.timeout does when it fires: fetch rejects with a
    // TimeoutError. runSparql maps it to null exactly like any other failure.
    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.wikidata.runEntityReviewLookup, { rowId: row });

    const r = await getRow(t, row);
    // The bug was: this stayed "pending" forever. Now it resolves.
    expect(r!.status).toBe("error");
  });
});
