/**
 * NEO-301 — the `wikidataPool` retry ladder and what happens after its LAST
 * attempt.
 *
 * convex-test cannot mount the workpool component, so the pool's own retry
 * loop is not driven here. What IS pinned, and together covers the contract:
 *
 *   1. the configuration — `retryActionsByDefault` and `WIKIDATA_POOL_RETRY`
 *      exactly — plus the arithmetic that justifies it, checked against every
 *      clock that watches these items (the per-attempt worst case, Convex's
 *      action limit, the workpool's recovery scan, and the review-row stale
 *      cron). A future edit to any number makes the matching invariant fail
 *      with the reason it matters;
 *   2. which errors the pool will retry: a `WikidataUnavailableError` is NOT a
 *      `NonRetryableError`, so the workpool's `complete` retries it until
 *      `maxAttempts`; the review lookup's NEO-294 write failure IS one;
 *   3. every enrichment enqueue carries the completion callback and its
 *      context (spying on the real `Workpool` instance, as
 *      convex/placeholderHeavyPool.test.ts does);
 *   4. the completion callbacks, which the workpool invokes only once retries
 *      are exhausted (`complete.ts`: `onComplete` runs only when it decides
 *      NOT to retry): a row enrichment logs `wikidata_{kind}_unavailable`
 *      with ids only; a review row is aged to "error" by the backstop and the
 *      line says the ladder gave up on Wikidata.
 *
 * Root-level for the convex-test module-registry reason in
 * convex/wikidataEnrichTeam.test.ts's header.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { isNonRetryableError, NonRetryableError, type RunResult } from "@convex-dev/workpool";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  WIKIDATA_MAX_PARALLELISM,
  WIKIDATA_POOL_RETRY,
  wikidataPool,
} from "./wikidataPool";
import { backstopEntityReviewRowImpl, ENTITY_REVIEW_STALE_MS } from "./entityReviewQueue";
import {
  WIKIDATA_FAST_FAILURE_MS,
  WIKIDATA_FETCH_TIMEOUT_MS,
} from "./adapters/wikidata";
import {
  enrichmentCompletionLogLine,
  parseWikidataUnavailable,
  WikidataUnavailableError,
} from "../lib/errors/wikidata-unavailable";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

afterEach(() => {
  vi.restoreAllMocks();
});

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** runSparql's in-call backoff (adapters/wikidata.ts WIKIDATA_RETRY_BACKOFF_MS). */
const IN_CALL_BACKOFF_MS = 1_500;
/** adapters/espn.ts ESPN_FETCH_TIMEOUT_MS — a team lookup's first request. */
const ESPN_FETCH_TIMEOUT_MS = 10_000;
/** Convex's per-run action limit. */
const CONVEX_ACTION_LIMIT_MS = 10 * MINUTE;
/** @convex-dev/workpool loop.ts RECOVERY_THRESHOLD_MS. */
const WORKPOOL_RECOVERY_THRESHOLD_MS = 5 * MINUTE;
/** withJitter: delay * (0.5 + Math.random()), so [0.5, 1.5). */
const MIN_JITTER = 0.5;
const MAX_JITTER = 1.5;

function backoffsMs(): number[] {
  const { maxAttempts, initialBackoffMs, base } = WIKIDATA_POOL_RETRY;
  return Array.from({ length: maxAttempts - 1 }, (_, k) => initialBackoffMs * base ** k);
}

/** One attempt's worst case, per kind (the arithmetic on WIKIDATA_FETCH_TIMEOUT_MS). */
function worstAttemptMs(kind: "player" | "team" | "league"): number {
  const perCall = Math.max(
    WIKIDATA_FETCH_TIMEOUT_MS,
    WIKIDATA_FAST_FAILURE_MS + IN_CALL_BACKOFF_MS + WIKIDATA_FETCH_TIMEOUT_MS,
  );
  const sparql = 2 * perCall; // search + detail
  return kind === "team" ? ESPN_FETCH_TIMEOUT_MS + sparql : sparql;
}

// ===========================================================================
// 1. The configuration and its arithmetic
// ===========================================================================

describe("wikidataPool retry configuration", () => {
  test("pins retryActionsByDefault, maxAttempts 5, initialBackoffMs 30000, base 2 — at 5 wide", () => {
    expect(WIKIDATA_POOL_RETRY).toEqual({ maxAttempts: 5, initialBackoffMs: 30_000, base: 2 });
    expect(wikidataPool.options.defaultRetryBehavior).toEqual(WIKIDATA_POOL_RETRY);
    expect(wikidataPool.options.retryActionsByDefault).toBe(true);
    expect(wikidataPool.options.maxParallelism).toBe(WIKIDATA_MAX_PARALLELISM);
  });

  test("nominal backoffs are 30 s, 60 s, 120 s, 240 s = 450 s", () => {
    expect(backoffsMs()).toEqual([30 * SECOND, 60 * SECOND, 120 * SECOND, 240 * SECOND]);
    expect(backoffsMs().reduce((a, b) => a + b, 0)).toBe(450 * SECOND);
  });

  test("even at the SHORTEST jitter the ladder waits out a multi-minute degradation", () => {
    // The measured failures cluster for minutes. The backoffs alone, at the
    // shortest jitter, must span more than 3 minutes, or a short outage can
    // burn all five attempts inside itself and leave the row bare.
    const minTotal = MIN_JITTER * backoffsMs().reduce((a, b) => a + b, 0);
    expect(minTotal).toBe(225 * SECOND);
    expect(minTotal).toBeGreaterThan(3 * MINUTE);
  });

  test("one attempt stays far inside Convex's action limit and the workpool's recovery scan", () => {
    expect(worstAttemptMs("player")).toBe(73 * SECOND);
    expect(worstAttemptMs("league")).toBe(73 * SECOND);
    expect(worstAttemptMs("team")).toBe(83 * SECOND);
    for (const kind of ["player", "team", "league"] as const) {
      expect(worstAttemptMs(kind)).toBeLessThan(CONVEX_ACTION_LIMIT_MS);
      expect(worstAttemptMs(kind)).toBeLessThan(WORKPOOL_RECOVERY_THRESHOLD_MS);
    }
  });

  test("the whole ladder, worst case, ends inside the review-row stale cron with room for queueing", () => {
    // First start → final failure: five worst attempts plus the longest
    // jitter on every backoff. A review row is aged by the cron 30 min after
    // CREATION, so the ladder must leave real headroom for the row's wait
    // for a slot; 10 min is the floor this pins.
    const maxBackoffs = MAX_JITTER * backoffsMs().reduce((a, b) => a + b, 0);
    const worstTeam = WIKIDATA_POOL_RETRY.maxAttempts * worstAttemptMs("team") + maxBackoffs;
    const worstPlayer = WIKIDATA_POOL_RETRY.maxAttempts * worstAttemptMs("player") + maxBackoffs;
    expect(worstTeam).toBe(1_090 * SECOND);
    expect(worstPlayer).toBe(1_040 * SECOND);
    expect(ENTITY_REVIEW_STALE_MS - worstTeam).toBeGreaterThanOrEqual(10 * MINUTE);
  });
});

// ===========================================================================
// 2. Which throws the pool retries
// ===========================================================================

describe("the retry signal", () => {
  test("an unavailable lookup is RETRYABLE; the NEO-294 write failure is not", () => {
    expect(isNonRetryableError(new WikidataUnavailableError("player", "timeout"))).toBe(false);
    expect(isNonRetryableError(new NonRetryableError("write failed"))).toBe(true);
  });

  test("the message survives being flattened to a string and carries no name", () => {
    const error = new WikidataUnavailableError("team", "http_502");
    expect(error.message).toBe("wikidata_unavailable kind=team reason=http_502");
    // How the workpool may see it: prefixed and with a stack appended.
    expect(
      parseWikidataUnavailable(`Uncaught WikidataUnavailableError: ${error.message}\n    at enrichTeam`),
    ).toEqual({ kind: "team", reason: "http_502" });
    expect(parseWikidataUnavailable("Uncaught Error: something else")).toBeNull();
    expect(parseWikidataUnavailable(undefined)).toBeNull();
  });

  test("a reason can never smuggle text into the message", () => {
    // The reason is always runSparql's own fixed vocabulary; this is the belt
    // that keeps a malformed one to a single token of [A-Za-z0-9_], at most
    // 32 long, so it cannot add a field, a quote or a newline to the line.
    const error = new WikidataUnavailableError("player", 'timeout" name=X\nY');
    expect(error.message).toBe("wikidata_unavailable kind=player reason=timeoutnameXY");
    expect(new WikidataUnavailableError("player", "x".repeat(100)).reason).toHaveLength(32);
    expect(new WikidataUnavailableError("player", "").reason).toBe("unknown");
  });
});

// ===========================================================================
// 3. Every enrichment enqueue carries the completion callback
// ===========================================================================

describe("enqueueEnrichment wires the final-attempt callback", () => {
  test("player, team and league items each carry onEnrichmentLookupComplete with {kind, id}", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      });
      const playerId = await ctx.db.insert("players", {
        name: "P",
        nameNormalized: "p",
        sportId,
        lastUpdated: 1_700_000_000_000,
      });
      const teamId = await ctx.db.insert("teams", {
        name: "T",
        nameNormalized: "t",
        sportId,
        lastUpdated: 1_700_000_000_000,
      });
      const leagueId = await ctx.db.insert("leagues", {
        name: "L",
        nameNormalized: "l",
        sportId,
        lastUpdated: 1_700_000_000_000,
      });
      return { playerId, teamId, leagueId };
    });
    const spy = vi
      .spyOn(wikidataPool, "enqueueAction")
      .mockImplementation(async () => "work-1" as never);

    await t.mutation(internal.wikidataPool.enqueueEnrichment, {
      playerIds: [ids.playerId],
      teamIds: [ids.teamId],
      leagueIds: [ids.leagueId],
    });

    const calls = spy.mock.calls.map(([, fn, args, opts]) => ({
      fn: getFunctionName(fn as never),
      args,
      onComplete: getFunctionName((opts as { onComplete: never }).onComplete),
      context: (opts as { context: unknown }).context,
    }));
    expect(calls).toEqual([
      {
        fn: "adapters/wikidata:enrichPlayer",
        args: { playerId: ids.playerId, force: undefined },
        onComplete: "wikidataPool:onEnrichmentLookupComplete",
        context: { kind: "player", id: ids.playerId },
      },
      {
        fn: "adapters/wikidata:enrichTeam",
        args: { teamId: ids.teamId, force: undefined },
        onComplete: "wikidataPool:onEnrichmentLookupComplete",
        context: { kind: "team", id: ids.teamId },
      },
      {
        fn: "adapters/wikidata:enrichLeague",
        args: { leagueId: ids.leagueId, force: undefined },
        onComplete: "wikidataPool:onEnrichmentLookupComplete",
        context: { kind: "league", id: ids.leagueId },
      },
    ]);
  });
});

// ===========================================================================
// 4. After the final attempt
// ===========================================================================

const UNAVAILABLE = (kind: "player" | "team" | "league", reason = "timeout"): RunResult => ({
  kind: "failed",
  error: `Uncaught WikidataUnavailableError: ${new WikidataUnavailableError(kind, reason).message}`,
});

function jsonLines(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call: unknown[]) => call[0])
    .filter((first: unknown): first is string => typeof first === "string" && first.startsWith("{"))
    .map((first: string) => JSON.parse(first) as Record<string, unknown>);
}

describe("onEnrichmentLookupComplete — the row stays bare, and now someone knows", () => {
  test.each(["player", "team", "league"] as const)(
    "a %s whose ladder never reached Wikidata logs wikidata_%s_unavailable, ids only",
    async (kind) => {
      const t = convexTest(schema, modules);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await t.mutation(internal.wikidataPool.onEnrichmentLookupComplete, {
        workId: "work-1",
        context: { kind, id: "row_123" },
        result: UNAVAILABLE(kind, "http_502"),
      });

      expect(jsonLines(warn)).toEqual([
        {
          msg: `wikidata_${kind}_unavailable`,
          kind,
          id: "row_123",
          reason: "http_502",
          attempts: WIKIDATA_POOL_RETRY.maxAttempts,
        },
      ]);
    },
  );

  test("a success logs nothing; any other failure is told apart and never copies the error text", async () => {
    const t = convexTest(schema, modules);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await t.mutation(internal.wikidataPool.onEnrichmentLookupComplete, {
      workId: "work-1",
      context: { kind: "player", id: "row_1" },
      result: { kind: "success", returnValue: null },
    });
    await t.mutation(internal.wikidataPool.onEnrichmentLookupComplete, {
      workId: "work-2",
      context: { kind: "player", id: "row_2" },
      result: { kind: "failed", error: "Validator error: name 'Harmon Killebrew' too long" },
    });
    await t.mutation(internal.wikidataPool.onEnrichmentLookupComplete, {
      workId: "work-3",
      context: { kind: "team", id: "row_3" },
      result: { kind: "canceled" },
    });

    const lines = jsonLines(warn);
    expect(lines).toEqual([
      { msg: "wikidata_enrichment_failed", kind: "player", id: "row_2", resultKind: "failed" },
      { msg: "wikidata_enrichment_failed", kind: "team", id: "row_3", resultKind: "canceled" },
    ]);
    expect(JSON.stringify(lines)).not.toContain("Killebrew");
  });

  test("the pure line builder agrees with the callback", () => {
    expect(enrichmentCompletionLogLine({ kind: "league", id: "x" }, { kind: "success", returnValue: null }, 5)).toBeNull();
  });
});

describe("a review row whose ladder never reached Wikidata", () => {
  async function seedPendingRow(t: ReturnType<typeof convexTest>): Promise<Id<"entityReviewQueue">> {
    return t.run(async (ctx) => {
      const selectorOptionId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      });
      return ctx.db.insert("entityReviewQueue", {
        selectorOptionId,
        batchId: "batch-1",
        createdByUserId: "user_review_001",
        kind: "player",
        name: "Harmon Killebrew",
        sportId: selectorOptionId,
        status: "pending",
      });
    });
  }

  test("goes to 'error' at the final attempt's completion, and the line says why — without the name", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedPendingRow(t);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Before the final attempt the workpool does not call onComplete at all,
    // and the work item itself never writes on an unavailable attempt (pinned
    // in convex/wikidataEntityReviewQueue.test.ts) — so up to here the row is
    // still pending. This is the one call that settles it.
    expect((await t.run((ctx) => ctx.db.get(rowId)))?.status).toBe("pending");
    await t.mutation(internal.wikidataPool.onEntityReviewLookupComplete, {
      workId: "work-1",
      context: { rowId },
      result: UNAVAILABLE("player"),
    });

    expect((await t.run((ctx) => ctx.db.get(rowId)))?.status).toBe("error");
    const lines = jsonLines(warn).filter((l) => l.msg === "entity_review_row_backstopped");
    expect(lines).toEqual([
      { msg: "entity_review_row_backstopped", rowId, resultKind: "failed", wikidataUnavailable: true },
    ]);
    expect(JSON.stringify(lines)).not.toContain("Killebrew");
  });

  test("a write failure's backstop is told apart from an unavailable one", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedPendingRow(t);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await t.run((ctx) =>
      backstopEntityReviewRowImpl(ctx, rowId, { kind: "failed", error: "Documents read from or written to ..." }),
    );

    expect(jsonLines(warn).find((l) => l.msg === "entity_review_row_backstopped")).toMatchObject({
      wikidataUnavailable: false,
    });
  });

  test("a row the stale cron already aged is left alone by a late backstop (the cron firing mid-ladder is harmless)", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedPendingRow(t);
    await t.run((ctx) => ctx.db.patch(rowId, { status: "error" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await t.run((ctx) => backstopEntityReviewRowImpl(ctx, rowId, UNAVAILABLE("player")));

    expect((await t.run((ctx) => ctx.db.get(rowId)))?.status).toBe("error");
    expect(jsonLines(warn).filter((l) => l.msg === "entity_review_row_backstopped")).toEqual([]);
  });

  test("…and a later attempt that DOES get an answer still lands on a cron-aged row", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedPendingRow(t);
    await t.run((ctx) => ctx.db.patch(rowId, { status: "error" }));

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: rowId,
      status: "ready",
      enrichment: { wikidataId: "Q1585630", careerTeams: [] },
    });

    const row = await t.run((ctx) => ctx.db.get(rowId));
    expect(row?.status).toBe("ready");
    expect(row?.enrichment?.wikidataId).toBe("Q1585630");
  });
});
