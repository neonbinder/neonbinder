/**
 * NEO-301 (Jason's decision) — a team REVIEW row shows ESPN's answer now and
 * keeps retrying for the Wikidata half.
 *
 * When a team's Wikidata lookup is unavailable (timeout, network, 5xx, 429)
 * but ESPN answered, `runEntityReviewLookupImpl` writes that partial as
 * "ready" through `applyLookupResult` and THEN throws the retryable
 * `WikidataUnavailableError`, so `wikidataPool` retries. Pinned here:
 *
 *   - the partial is written "ready" (league, location, colours, espnId) and
 *     the item still throws retryable;
 *   - a later attempt that reaches Wikidata MERGES — it adds wikidataId,
 *     yearsActive and leagueWikidataId, and does not erase ESPN's colours or
 *     location even when that attempt's own ESPN fetch failed;
 *   - a later attempt that finds nothing does not downgrade the row;
 *   - after the ladder's final failure the backstop leaves the row "ready"
 *     and logs `wikidata_review_unavailable`;
 *   - player rows are unaffected (a partial is still discarded — pinned in
 *     convex/adapters/wikidata.entityReviewWrite.test.ts).
 *
 * Row ENRICHMENT (`enrichTeam` on a `teams` row) deliberately keeps the
 * discard-and-retry behaviour — pinned in convex/wikidataEnrichUnavailable
 * .test.ts — because there a written `espnId` is a creation-only marker that
 * would make the retry skip the row.
 *
 * Root-level for the convex-test module-registry reason given in
 * convex/wikidataEnrichTeam.test.ts's header.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { __resetEspnTeamListCache } from "./adapters/espn";
import { WIKIDATA_FETCH_TIMEOUT_MS } from "./adapters/wikidata";
import { backstopEntityReviewRowImpl, overlayTeamEnrichment } from "./entityReviewQueue";
import { WikidataUnavailableError } from "../lib/errors/wikidata-unavailable";
import { isNonRetryableError } from "@convex-dev/workpool";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/** The Nationals' real Wikidata QID and ESPN id. */
const NATIONALS_QID = "Q1421";
const MLB_QID = "Q1163715";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const ESPN_NATIONALS = {
  sports: [
    {
      leagues: [
        {
          teams: [
            {
              team: {
                id: "20",
                displayName: "Washington Nationals",
                location: "Washington",
                color: "ab0003",
                alternateColor: "14225a",
              },
            },
          ],
        },
      ],
    },
  ],
};

type Answer = Response | "timeout";

/**
 * Routes ESPN / Wikidata search / Wikidata detail. "timeout" is what the
 * adapter really sees: a TimeoutError after the full ceiling (the faked clock
 * is moved, not waited on), which it does not retry in-call.
 */
function stubFetch(routes: { espn: Answer; search: Answer; detail?: Answer }): void {
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      const u = String(url);
      const decoded = decodeURIComponent(u);
      let answer: Answer | undefined;
      if (u.includes("site.web.api.espn.com")) answer = routes.espn;
      else if (u.includes("query.wikidata.org")) {
        const isDetail = decoded.includes("wdt:P118") || decoded.includes("wdt:P571");
        answer = isDetail ? routes.detail : routes.search;
      }
      if (answer === undefined) throw new Error(`unexpected fetch: ${u}`);
      if (answer === "timeout") {
        vi.setSystemTime(Date.now() + WIKIDATA_FETCH_TIMEOUT_MS);
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return answer;
    }) as unknown as typeof fetch,
  );
}

const WIKIDATA_SEARCH_HIT = () =>
  jsonResponse({
    results: {
      bindings: [{ team: { type: "uri", value: `http://www.wikidata.org/entity/${NATIONALS_QID}` } }],
    },
  });
const WIKIDATA_DETAIL = () =>
  jsonResponse({
    results: {
      bindings: [
        {
          league: { type: "uri", value: `http://www.wikidata.org/entity/${MLB_QID}` },
          leagueLabel: { type: "literal", value: "Major League Baseball" },
          inception: { type: "literal", value: "1969-01-01T00:00:00Z" },
        },
      ],
    },
  });
const NO_BINDINGS = () => jsonResponse({ results: { bindings: [] } });
const ESPN_DOWN = () => new Response("unavailable", { status: 503 });

async function seedTeamRow(t: ReturnType<typeof convexTest>): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) => {
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
    return ctx.db.insert("entityReviewQueue", {
      selectorOptionId: sportId,
      batchId: "batch-1",
      createdByUserId: "user_review_001",
      kind: "team",
      name: "Washington Nationals",
      nameNormalized: normalizeTeamName("Washington Nationals"),
      sportId,
      status: "pending",
    });
  });
}

const getRow = (t: ReturnType<typeof convexTest>, id: Id<"entityReviewQueue">) =>
  t.run(async (ctx) => ctx.db.get(id));

/** One pool attempt: the action, settled rather than asserted inline. */
async function attempt(t: ReturnType<typeof convexTest>, rowId: Id<"entityReviewQueue">): Promise<unknown> {
  __resetEspnTeamListCache();
  return t.action(internal.adapters.wikidata.runEntityReviewLookup, { rowId }).then(
    () => "resolved",
    (error: unknown) => error,
  );
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  __resetEspnTeamListCache();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function jsonLines(spy: { mock: { calls: unknown[][] } }, msg: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call) => call[0])
    .filter((first): first is string => typeof first === "string" && first.startsWith("{"))
    .map((first) => JSON.parse(first) as Record<string, unknown>)
    .filter((line) => line.msg === msg);
}

describe("a team review row with an ESPN answer and an unavailable Wikidata", () => {
  test("the ESPN partial is written 'ready' FIRST, and the item still throws retryable", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTeamRow(t);
    stubFetch({ espn: jsonResponse(ESPN_NATIONALS), search: "timeout" });

    const outcome = await attempt(t, rowId);

    const row = await getRow(t, rowId);
    expect(row!.status).toBe("ready");
    expect(row!.enrichment).toMatchObject({
      league: "Major League Baseball",
      location: "Washington",
      espnId: "20",
    });
    expect(row!.enrichment?.colors?.primary).toBeTruthy();
    // No Wikidata half yet.
    expect(row!.enrichment?.wikidataId).toBeUndefined();
    expect(row!.enrichment?.yearsActive).toBeUndefined();

    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toContain("wikidata_unavailable kind=team reason=timeout");
    expect(isNonRetryableError(outcome)).toBe(false);
  });

  test("a later attempt that reaches Wikidata MERGES — adds QID and years, keeps ESPN's colours even when its own ESPN fetch failed", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTeamRow(t);

    stubFetch({ espn: jsonResponse(ESPN_NATIONALS), search: "timeout" });
    await attempt(t, rowId);
    const partial = (await getRow(t, rowId))!.enrichment!;

    // The retry: ESPN is down this time (ESPN is no-throw, so it reads as "no
    // ESPN data"), Wikidata answers.
    stubFetch({ espn: ESPN_DOWN(), search: WIKIDATA_SEARCH_HIT(), detail: WIKIDATA_DETAIL() });
    const outcome = await attempt(t, rowId);

    expect(outcome).toBe("resolved");
    const row = await getRow(t, rowId);
    expect(row!.status).toBe("ready");
    expect(row!.enrichment).toMatchObject({
      // ESPN's half, untouched by an attempt that had no ESPN data:
      location: "Washington",
      espnId: "20",
      colors: partial.colors,
      // Wikidata's half, added:
      wikidataId: NATIONALS_QID,
      leagueWikidataId: MLB_QID,
      yearsActive: { from: 1969 },
      league: "Major League Baseball",
    });
  });

  test("a later attempt that finds NOTHING does not downgrade the row", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTeamRow(t);

    stubFetch({ espn: jsonResponse(ESPN_NATIONALS), search: "timeout" });
    await attempt(t, rowId);
    const before = await getRow(t, rowId);

    stubFetch({ espn: ESPN_DOWN(), search: NO_BINDINGS() });
    expect(await attempt(t, rowId)).toBe("resolved");

    const row = await getRow(t, rowId);
    expect(row!.status).toBe("ready");
    expect(row!.enrichment).toEqual(before!.enrichment);
  });

  test("after the final failed attempt the backstop leaves it 'ready' and logs the unavailable line", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTeamRow(t);

    stubFetch({ espn: jsonResponse(ESPN_NATIONALS), search: "timeout" });
    const lastError = await attempt(t, rowId);
    const before = await getRow(t, rowId);

    // What the pool's onComplete receives once the ladder is spent.
    await t.mutation(internal.wikidataPool.onEntityReviewLookupComplete, {
      workId: "work-1",
      context: { rowId },
      result: { kind: "failed", error: `Uncaught ${String(lastError)}` },
    });

    const row = await getRow(t, rowId);
    expect(row!.status).toBe("ready");
    expect(row!.enrichment).toEqual(before!.enrichment);
    expect(jsonLines(warnSpy, "wikidata_review_unavailable")).toEqual([
      { msg: "wikidata_review_unavailable", rowId, kind: "team", reason: "timeout", rowStatus: "ready" },
    ]);
    // Not "backstopped": nothing was aged.
    expect(jsonLines(warnSpy, "entity_review_row_backstopped")).toEqual([]);
    // Never the name.
    expect(JSON.stringify(jsonLines(warnSpy, "wikidata_review_unavailable"))).not.toContain("Nationals");
  });

  test("with NO ESPN answer either, a team row still stays 'pending' and throws — there is nothing to show", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTeamRow(t);
    stubFetch({ espn: ESPN_DOWN(), search: "timeout" });

    const outcome = await attempt(t, rowId);

    expect((await getRow(t, rowId))!.status).toBe("pending");
    expect(outcome).toBeInstanceOf(WikidataUnavailableError);

    // …and the final backstop then ages it, saying why.
    await t.run((ctx) =>
      backstopEntityReviewRowImpl(ctx, rowId, { kind: "failed", error: String(outcome) }),
    );
    expect((await getRow(t, rowId))!.status).toBe("error");
  });
});

describe("overlayTeamEnrichment", () => {
  test("keeps what the new result leaves undefined, per field and per colour swatch", () => {
    expect(
      overlayTeamEnrichment(
        { league: "MLB", location: "Washington", colors: { primary: "#ab0003", secondary: "#14225a" }, espnId: "20" },
        { wikidataId: NATIONALS_QID, location: undefined, colors: { primary: undefined, secondary: "#000000" } },
      ),
    ).toEqual({
      league: "MLB",
      location: "Washington",
      colors: { primary: "#ab0003", secondary: "#000000" },
      espnId: "20",
      wikidataId: NATIONALS_QID,
    });
  });

  test("either side missing returns the other", () => {
    expect(overlayTeamEnrichment(undefined, { espnId: "1" })).toEqual({ espnId: "1" });
    expect(overlayTeamEnrichment({ espnId: "1" }, undefined)).toEqual({ espnId: "1" });
  });
});
