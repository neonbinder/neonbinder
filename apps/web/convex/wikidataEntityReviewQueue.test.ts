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
 *   - `processEntityReviewQueue` — the chained pop-front/reschedule-tail
 *     queue over `entityReviewQueue` row ids, same `INTER_ENTITY_DELAY_MS`
 *     pacing as the existing `processEnrichmentQueue`.
 *
 * Lives at the convex/ ROOT (not co-located under convex/adapters/) for the
 * same reason as convex/wikidataEnrichTeam.test.ts / convex/bscTeamEnrichmentQueue.test.ts:
 * convex-test's `import.meta.glob(...)` module registry breaks when the glob
 * is invoked from within convex/adapters/ itself — see that file's header
 * comment for the full explanation. `processEntityReviewQueue` is an
 * `internalAction` that needs the real convex-test action/scheduler harness.
 *
 * Fetch mocking follows convex/wikidataEnrichTeam.test.ts's convention:
 * `decodeURIComponent` + check for a predicate unique to each SPARQL call to
 * distinguish the player entity-search query from the player detail query
 * (both hit the same query.wikidata.org host).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
}) {
  const rows: Array<Record<string, SparqlBindingFixture>> = [];
  for (const ct of opts.careerTeams ?? []) {
    const row: Record<string, SparqlBindingFixture> = {
      team: uriBinding(ct.teamQid),
      teamLabel: literalBinding(ct.teamLabel),
    };
    if (ct.fromYear !== undefined) row.start = literalBinding(`${ct.fromYear}-01-01T00:00:00Z`);
    if (ct.toYear !== undefined) row.end = literalBinding(`${ct.toYear}-01-01T00:00:00Z`);
    if (opts.hofAwardQid) row.award = uriBinding(opts.hofAwardQid);
    rows.push(row);
  }
  if (rows.length === 0 && opts.hofAwardQid) {
    rows.push({ award: uriBinding(opts.hofAwardQid) });
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

    const result = await lookupPlayerEnrichment("Mike Trout", "Baseball");

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

    const result = await lookupPlayerEnrichment("Derek Jeter", "Baseball");
    expect(result!.isHallOfFame).toBe(true);
  });

  test("defaults isHallOfFame to false (not undefined) for a HoF-aware sport with no matching award", async () => {
    vi.stubGlobal("fetch", makePlayerFetchStub({ qid: "Q1000", detail: {} }));

    const result = await lookupPlayerEnrichment("Some Journeyman", "Baseball");
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

    const result = await lookupPlayerEnrichment("Totally Unknown Prospect", "Baseball");
    expect(result).toBeNull();
    expect(callCount).toBe(1); // search query only — no detail query attempted
  });

  test("returns null for a sport with no SPORT_QIDS mapping, without calling fetch at all", async () => {
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      (async () => {
        fetchCalled = true;
        throw new Error("fetch must not be called for an unmapped sport");
      }) as unknown as typeof fetch,
    );

    const result = await lookupPlayerEnrichment("Someone", "Cricket");
    expect(result).toBeNull();
    expect(fetchCalled).toBe(false);
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

    const result = await lookupTeamEnrichment("Some Unresolvable Team", "Baseball");
    expect(result).toBeNull();
  });
});

// ===========================================================================
// processEntityReviewQueue — chained pop-front/reschedule-tail draining
// ===========================================================================

describe("processEntityReviewQueue", () => {
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
        kind: opts.kind,
        name: opts.name,
        sport: "Baseball",
        status: "pending",
      }),
    );
  }

  const getRow = (t: ReturnType<typeof convexTest>, id: Id<"entityReviewQueue">) =>
    t.run(async (ctx) => ctx.db.get(id));

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("drains ids one at a time, in order, patching each row's status/enrichment as its lookup completes", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row1 = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Mike Trout" });
    const row2 = await seedReviewRow(t, selectorOptionId, { kind: "team", name: "Los Angeles Angels" });
    const row3 = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Unknown Prospect" });

    // Deterministic call ORDER (no content-sniffing needed): the queue
    // processes row1 (player, resolves) then row2 (team, no match on either
    // source) then row3 (player, no match) — each lookup's own internal call
    // count is fixed and already proven by wikidataEnrichTeam.test.ts /
    // the lookupPlayerEnrichment tests above, so a plain call-index counter
    // is enough here; this test's OWN job is only the queue's drain order.
    //   0: row1 player search      -> matches Q123456
    //   1: row1 player detail      -> empty (no career teams/HoF row)
    //   2: row2 team ESPN lookup   -> no match
    //   3: row2 team wikidata search -> no match -> lookupTeamEnrichment null
    //   4: row3 player search      -> no match
    const responses = [
      () => jsonResponse(makePlayerSearchBody("Q123456")),
      () => jsonResponse(makePlayerDetailBody({})),
      () => jsonResponse({ sports: [] }),
      () => jsonResponse(makePlayerSearchBody(null)),
      () => jsonResponse(makePlayerSearchBody(null)),
    ];
    let callIndex = 0;
    vi.stubGlobal(
      "fetch",
      (async () => {
        const respond = responses[callIndex];
        callIndex++;
        if (!respond) throw new Error(`unexpected extra fetch call #${callIndex}`);
        return respond();
      }) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.wikidata.processEntityReviewQueue, {
      ids: [row1, row2, row3],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const r1 = await getRow(t, row1);
    const r2 = await getRow(t, row2);
    const r3 = await getRow(t, row3);
    // row1: Wikidata match -> ready. row2: team, no ESPN/Wikidata match ->
    // error. row3: no Wikidata match -> error. All three left "pending"
    // status behind — proving the queue actually visited every id.
    expect(r1!.status).toBe("ready");
    expect(r1!.enrichment?.wikidataId).toBe("Q123456");
    expect(r2!.status).toBe("error");
    expect(r3!.status).toBe("error");
  });

  test("an empty id list is a no-op (resolves without scheduling anything)", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.action(internal.adapters.wikidata.processEntityReviewQueue, { ids: [] }),
    ).resolves.toBeNull();
  });

  test("a row that's been deleted mid-queue is skipped without throwing, and the tail still processes", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const deletedRow = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Deleted Player" });
    const survivingRow = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Surviving Player" });
    await t.run(async (ctx) => ctx.db.delete(deletedRow));

    vi.stubGlobal(
      "fetch",
      (async () => jsonResponse(makePlayerSearchBody(null))) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.wikidata.processEntityReviewQueue, {
      ids: [deletedRow, survivingRow],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const surviving = await getRow(t, survivingRow);
    expect(surviving!.status).toBe("error"); // no Wikidata match, but processed
  });

  test("a lookup that throws is caught — the row is marked 'error' and the tail still processes", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row1 = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Throws During Lookup" });
    const row2 = await seedReviewRow(t, selectorOptionId, { kind: "player", name: "Fine Player" });

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        callCount++;
        if (callCount === 1) throw new Error("network down");
        return jsonResponse(makePlayerSearchBody(null));
      }) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.wikidata.processEntityReviewQueue, {
      ids: [row1, row2],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const r1 = await getRow(t, row1);
    const r2 = await getRow(t, row2);
    expect(r1!.status).toBe("error");
    expect(r2!.status).toBe("error"); // reached despite row1's throw
  });
});
