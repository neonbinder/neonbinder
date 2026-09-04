/**
 * NEO-92: unit tests for the review-wizard side of `convex/adapters/wikidata.ts`:
 *   - `lookupPlayerEnrichment`/`lookupTeamEnrichment` — the pure(-ish) lookup
 *     functions extracted from `enrichPlayer`/`enrichTeam` so the wizard can
 *     preview Wikidata data BEFORE a player/team row is created. Unlike
 *     `enrichPlayer`, `lookupPlayerEnrichment` must NOT resolve `careerTeams`
 *     to real team ids (no `teams.findOrCreateInternal` call) — that's the
 *     specific bug the deferred-materialization design in entityReviewQueue.ts
 *     fixes (a mere preview lookup could otherwise orphan a team row for a
 *     player the user ends up linking to someone else, or never creates).
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
};

function makePlayerDetailBody(opts: {
  careerTeams?: CareerTeamFixture[];
  hofAwardQid?: string;
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
  for (const ct of opts.careerTeams ?? []) {
    const base: Record<string, SparqlBindingFixture> = {
      team: uriBinding(ct.teamQid),
      teamLabel: literalBinding(ct.teamLabel),
    };
    if (ct.fromYear !== undefined) base.start = literalBinding(`${ct.fromYear}-01-01T00:00:00Z`);
    if (ct.toYear !== undefined) base.end = literalBinding(`${ct.toYear}-01-01T00:00:00Z`);
    if (awards.length === 0) {
      rows.push(decorate({ ...base }));
    } else {
      for (const award of awards) {
        rows.push(decorate({ ...base, award: uriBinding(award) }));
      }
    }
  }
  if (rows.length === 0) {
    if (awards.length > 0) {
      for (const award of awards) rows.push(decorate({ award: uriBinding(award) }));
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
    // teams.findOrCreateInternal-equivalent side effect).
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
