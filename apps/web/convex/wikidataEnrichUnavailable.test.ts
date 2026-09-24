/**
 * NEO-301 — the row-enrichment work items (`enrichPlayer`, `enrichTeam`) tell
 * "Wikidata could not be asked" from "Wikidata has no answer".
 *
 * Enrichment runs ONCE, at creation (NEO-203), so before this a lookup that
 * timed out or got a 5xx left the row bare for good: the adapter answered the
 * same `null` a genuine miss answers, the work item returned normally, and the
 * pool (no retries) recorded a success. These pin the contract that replaced
 * it, at the layer that actually propagates — the ACTION, driven through
 * convex-test with a stubbed `fetch`:
 *
 *   - unavailable (timeout, network, 5xx, 429 on a call's last attempt) →
 *     the action THROWS a retryable `WikidataUnavailableError`, and the row is
 *     byte-identical to before (no partial write that would trip the
 *     creation-only marker guard and make the retry skip);
 *   - a 200 with no binding → resolves, no throw, no write: final;
 *   - a retry after the row was deleted, or after an operator filled it in,
 *     is a no-op that makes no request;
 *   - a retry that reaches Wikidata writes the enrichment as usual;
 *   - a fixture HIT answers without the network and never throws, even with
 *     the network down (NEO-289's recording is unaffected).
 *
 * What the POOL does with the throw (the ladder, and the final-attempt log
 * line) is pinned in convex/wikidataPool.retry.test.ts; convex-test cannot
 * mount the workpool component, so these tests call the action directly, the
 * way the pool's worker does.
 *
 * A "slow" failure moves a faked `Date` by the full timeout rather than
 * waiting: that is what a real timeout looks like to the adapter, and it is
 * not retried in-call, so no test here spends wall clock on backoff.
 *
 * Root-level for the convex-test module-registry reason given in
 * convex/wikidataEnrichTeam.test.ts's header.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import { __resetEspnTeamListCache } from "./adapters/espn";
import { WIKIDATA_FETCH_TIMEOUT_MS } from "./adapters/wikidata";
import {
  __setEnrichmentFixtureForTests,
  fixtureKey,
  type EnrichmentFixtureFile,
} from "./adapters/enrichmentFixtures";
import { isNonRetryableError } from "@convex-dev/workpool";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const SPORT_QID = "Q5369";
/** Harmon Killebrew's real QID, as resolved by the live-proof E2E probe. */
const KILLEBREW_QID = "Q1585630";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const uriBinding = (qid: string) => ({
  type: "uri",
  value: `http://www.wikidata.org/entity/${qid}`,
});

async function seedSport(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: SPORT_QID, hallOfFameQid: "Q1194380" },
      },
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function insertPlayer(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      lastUpdated: 1_700_000_000_000,
      ...extra,
    }),
  );
}

async function insertTeam(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name,
      nameNormalized: normalizeTeamName(name),
      sportId,
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

type Route = (decodedUrl: string) => Response | "timeout" | "network";

/**
 * Routes every request through `route`, counts them, and turns the two
 * transport failures into what the adapter really sees: "timeout" is a
 * TimeoutError AFTER the full ceiling (faked clock), "network" a thrown
 * fetch after the same.
 */
function routedFetch(route: Route): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      calls += 1;
      const decoded = decodeURIComponent(String(url));
      const answer = route(decoded);
      if (answer === "timeout" || answer === "network") {
        vi.setSystemTime(Date.now() + WIKIDATA_FETCH_TIMEOUT_MS);
        if (answer === "timeout") {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        throw new TypeError("fetch failed");
      }
      return answer;
    }) as unknown as typeof fetch,
  );
  return { calls: () => calls };
}

/** Player search vs detail: the detail query is the one carrying `p:P54`. */
const isPlayerDetail = (decoded: string) => decoded.includes("p:P54");

/** Everything the enrichment writes on a player row, for a before/after diff. */
async function getPlayer(t: ReturnType<typeof convexTest>, id: Id<"players">) {
  return t.run(async (ctx) => ctx.db.get(id));
}
async function getTeam(t: ReturnType<typeof convexTest>, id: Id<"teams">) {
  return t.run(async (ctx) => ctx.db.get(id));
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  __resetEspnTeamListCache();
  __setEnrichmentFixtureForTests(undefined);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  __setEnrichmentFixtureForTests(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function unavailableLines(): Array<Record<string, unknown>> {
  return warnSpy.mock.calls
    .map((call: unknown[]) => call[0])
    .filter((first: unknown): first is string => typeof first === "string" && first.startsWith("{"))
    .map((first: string) => JSON.parse(first) as Record<string, unknown>)
    .filter((line: Record<string, unknown>) => line.msg === "wikidata_lookup_unavailable");
}

// ===========================================================================
// enrichPlayer
// ===========================================================================

describe("enrichPlayer — unavailable throws retryable, no-match is final", () => {
  test.each([
    ["the search times out", (d: string) => (isPlayerDetail(d) ? jsonResponse({}) : "timeout"), "timeout"],
    ["the search gets a 502", (_d: string) => new Response("bad gateway", { status: 502 }), "http_502"],
    [
      "the search matches but the detail query's network fails",
      (d: string) =>
        isPlayerDetail(d)
          ? "network"
          : jsonResponse({ results: { bindings: [{ player: uriBinding(KILLEBREW_QID) }] } }),
      "network",
    ],
  ] as Array<[string, Route, string]>)("%s → throws, row untouched", async (_label, route, reason) => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, sportId, "Harmon Killebrew");
    const before = await getPlayer(t, playerId);
    // A fast 502 IS retried in-call once; give it its two answers.
    routedFetch(route);

    const outcome = await settle(t.action(internal.adapters.wikidata.enrichPlayer, { playerId }));

    // What got written first: nothing — no QID, no HoF flag, no teamYears.
    expect(await getPlayer(t, playerId)).toEqual(before);
    expect(String(outcome)).toContain(`wikidata_unavailable kind=player reason=${reason}`);
    expect(isNonRetryableError(outcome)).toBe(false);
    expect(unavailableLines()).toEqual([
      { msg: "wikidata_lookup_unavailable", kind: "player", id: playerId, reason },
    ]);
    // Ids, kinds and the reason — never the name.
    expect(JSON.stringify(unavailableLines())).not.toContain("Killebrew");
  });

  test("a 200 with no binding resolves, writes nothing, and makes exactly one request", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, sportId, "Nobody Wikidata Knows");
    const before = await getPlayer(t, playerId);
    const stub = routedFetch(() => jsonResponse({ results: { bindings: [] } }));

    await expect(
      t.action(internal.adapters.wikidata.enrichPlayer, { playerId }),
    ).resolves.toBeNull();

    expect(stub.calls()).toBe(1);
    expect(await getPlayer(t, playerId)).toEqual(before);
    expect(unavailableLines()).toEqual([]);
  });

  test("the retry that reaches Wikidata writes the enrichment — the failed attempt left nothing to skip on", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, sportId, "Harmon Killebrew");

    // Attempt 1: the endpoint is down.
    routedFetch(() => "timeout");
    await expect(
      t.action(internal.adapters.wikidata.enrichPlayer, { playerId }),
    ).rejects.toThrow(/wikidata_unavailable/);

    // Attempt 2 (what the pool re-runs, same args): the endpoint is back.
    routedFetch((d) =>
      isPlayerDetail(d)
        ? jsonResponse({ results: { bindings: [] } })
        : jsonResponse({ results: { bindings: [{ player: uriBinding(KILLEBREW_QID) }] } }),
    );
    await expect(
      t.action(internal.adapters.wikidata.enrichPlayer, { playerId }),
    ).resolves.toBeNull();

    expect((await getPlayer(t, playerId))?.externalIds?.wikidataId).toBe(KILLEBREW_QID);
  });

  test("a retry after the row was deleted (merged away) is a no-op with no request", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, sportId, "Harmon Killebrew");
    await t.run(async (ctx) => ctx.db.delete(playerId));
    const stub = routedFetch(() => "timeout");

    await expect(
      t.action(internal.adapters.wikidata.enrichPlayer, { playerId }),
    ).resolves.toBeNull();
    expect(stub.calls()).toBe(0);
  });

  test("a retry after an operator filled the row in is skipped by the marker guard, with no request", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, sportId, "Harmon Killebrew", {
      externalIds: { wikidataId: KILLEBREW_QID },
    });
    const before = await getPlayer(t, playerId);
    const stub = routedFetch(() => "timeout");

    await expect(
      t.action(internal.adapters.wikidata.enrichPlayer, { playerId }),
    ).resolves.toBeNull();
    expect(stub.calls()).toBe(0);
    expect(await getPlayer(t, playerId)).toEqual(before);
  });

  test("a fixture HIT answers with the network down and never throws", async () => {
    vi.stubEnv("NEONBINDER_ENRICHMENT_FIXTURES", "1");
    vi.stubEnv("TESTING_RESET_SECRET", "s");
    const fixture: EnrichmentFixtureFile = {
      version: 1,
      capturedAt: "2026-09-20T00:00:00.000Z",
      sportQid: SPORT_QID,
      entries: {
        [fixtureKey("player", SPORT_QID, "Harmon Killebrew")]: {
          kind: "player",
          name: "Harmon Killebrew",
          result: { wikidataId: KILLEBREW_QID, careerTeams: [], isHallOfFame: true },
        },
      },
    };
    __setEnrichmentFixtureForTests(fixture);

    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, sportId, "Harmon Killebrew");
    const stub = routedFetch(() => "network");

    await expect(
      t.action(internal.adapters.wikidata.enrichPlayer, { playerId }),
    ).resolves.toBeNull();

    expect(stub.calls()).toBe(0);
    const after = await getPlayer(t, playerId);
    expect(after?.externalIds?.wikidataId).toBe(KILLEBREW_QID);
    expect(after?.isHallOfFame).toBe(true);
  });

  test("a recorded no-match (fixture null) is final, with the network down — no throw", async () => {
    vi.stubEnv("NEONBINDER_ENRICHMENT_FIXTURES", "1");
    vi.stubEnv("TESTING_RESET_SECRET", "s");
    __setEnrichmentFixtureForTests({
      version: 1,
      capturedAt: "2026-09-20T00:00:00.000Z",
      sportQid: SPORT_QID,
      entries: {
        [fixtureKey("player", SPORT_QID, "Nobody Here")]: {
          kind: "player",
          name: "Nobody Here",
          result: null,
        },
      },
    });

    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, sportId, "Nobody Here");
    const before = await getPlayer(t, playerId);
    const stub = routedFetch(() => "network");

    await expect(
      t.action(internal.adapters.wikidata.enrichPlayer, { playerId }),
    ).resolves.toBeNull();
    expect(stub.calls()).toBe(0);
    expect(await getPlayer(t, playerId)).toEqual(before);
  });
});

// ===========================================================================
// enrichTeam — the partial-answer trap
// ===========================================================================

describe("enrichTeam — an ESPN answer does not get written ahead of an unavailable Wikidata", () => {
  test("ESPN knows the team, Wikidata times out → throws, and neither half is written", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await insertTeam(t, sportId, "San Diego Padres");
    const before = await getTeam(t, teamId);

    const stub = routedFetch((d) => {
      if (d.includes("site.web.api.espn.com")) {
        return jsonResponse({
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
        });
      }
      if (d.includes("query.wikidata.org")) return "timeout";
      // teamcolorcodes.com must NOT be reached: the colour leg runs only on an
      // attempt that got its Wikidata answer.
      throw new Error(`unexpected fetch in unavailable-team test: ${d}`);
    });

    const outcome = await settle(t.action(internal.adapters.wikidata.enrichTeam, { teamId }));

    // `espnId`, `colors` and `wikidataId` are all creation-only MARKERS; any
    // one of them written here would make the pool's retry skip the row.
    expect(await getTeam(t, teamId)).toEqual(before);
    expect(String(outcome)).toContain("wikidata_unavailable kind=team reason=timeout");
    expect(isNonRetryableError(outcome)).toBe(false);
    // ESPN list + one Wikidata search; no colour sitemap read.
    expect(stub.calls()).toBe(2);
  });
});
