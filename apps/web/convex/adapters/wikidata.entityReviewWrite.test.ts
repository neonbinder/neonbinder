/**
 * NEO-294 — `runEntityReviewLookupImpl`: the lookup decides, the WRITE is a
 * separate failure.
 *
 * ## The bug these pin
 *
 * One `try` used to cover both the SPARQL lookup and the `applyLookupResult`
 * that stores its answer. So when the write lost an optimistic-concurrency
 * race — four times, permanently, in one live seed run — the failure landed in
 * the handler written for "Wikidata found nothing", which called
 * `applyLookupResult` a second time with `status: "error"` and no enrichment.
 * A write failure was served to the operator as a data absence: "No Wikidata
 * match found" for a player Wikidata had matched, no `careerTeams`, so no
 * career-team steps staged and nothing for the wizard's recovery pass to read.
 *
 * The invariant every test here defends is one sentence: **a lookup that
 * matched can never end as the no-match shape** (`status: "error"` with no
 * enrichment). What a failed write produces instead is a THROW — the row stays
 * `pending`, the pool's `onComplete` backstop ages it and logs why (see
 * `backstopEntityReviewRowImpl`), and nothing is fabricated about Wikidata.
 *
 * ## Why a stub ctx rather than convex-test
 *
 * The conflict is the point, and convex-test's in-memory db cannot be made to
 * lose an OCC race. So the impl is driven with a two-method ctx whose
 * `runMutation` is scripted to fail — the same reason
 * `backstopEntityReviewRowImpl` is a plain exported function. Dispatch is by
 * `getFunctionName`, never by reference identity: the generated `api` is a
 * proxy and two reads of the same path are not the same object (the house
 * convention, as in app/print/labels/page.test.ts).
 *
 * The convex-test coverage of the happy path, the genuine no-match and the
 * timeout lives next door in convex/wikidataEntityReviewQueue.test.ts and is
 * unchanged by this ticket — these tests are about the seam between deciding
 * and writing.
 */

import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  runEntityReviewLookupImpl,
  type EntityReviewLookupCtx,
} from "./wikidata";
import { OCC_RETRY_ATTEMPTS } from "../../lib/errors/occ-retry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROW_ID = "row_entity_review_1" as unknown as Id<"entityReviewQueue">;
const SPORT_ID = "sport_option_1" as unknown as Id<"selectorOptions">;
const MATCHED_QID = "Q123456";

const SPORT_CTX = {
  label: "Baseball",
  wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
  espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
};

/** A pending player row, the shape `entityReviewQueue.getInternal` returns. */
const ROW = {
  _id: ROW_ID,
  _creationTime: 0,
  selectorOptionId: SPORT_ID,
  batchId: "batch-1",
  createdByUserId: "user_review_001",
  kind: "player" as const,
  name: "Mike Trout",
  sportId: SPORT_ID,
  status: "pending" as const,
};

/**
 * What Convex raises when a mutation loses the optimistic-concurrency race on
 * every internal retry — the exact sentence `isOccConflict` matches, and the
 * one the live seed logs carried.
 */
const occConflictError = () =>
  new Error(
    'Documents read from or written to the "entityReviewQueue" table changed ' +
      "while this mutation was being run and on every subsequent retry. A call to " +
      '"entityReviewQueue.js:applyLookupResult" changed the document with ID "row_entity_review_1"',
  );

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const uriBinding = (qid: string) => ({
  type: "uri",
  value: `http://www.wikidata.org/entity/${qid}`,
});
const literalBinding = (value: string) => ({ type: "literal", value });

/**
 * Routes the two SPARQL calls `lookupPlayerEnrichment` makes, the same way
 * convex/wikidataEntityReviewQueue.test.ts's stub does: the detail query is
 * the one carrying `p:P54`/`wdt:P166`, everything else is the entity search.
 * `qid: null` is the genuine no-match — the search answers with no bindings.
 */
function stubPlayerFetch(qid: string | null): void {
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      const decoded = decodeURIComponent(String(url));
      if (decoded.includes("p:P54") || decoded.includes("wdt:P166")) {
        return jsonResponse({
          results: {
            bindings: [
              {
                team: uriBinding("Q217123"),
                teamLabel: literalBinding("Los Angeles Angels"),
                start: literalBinding("2011-01-01T00:00:00Z"),
              },
            ],
          },
        });
      }
      return jsonResponse({ results: { bindings: qid ? [{ player: uriBinding(qid) }] : [] } });
    }) as unknown as typeof fetch,
  );
}

// ---------------------------------------------------------------------------
// The stub ctx
// ---------------------------------------------------------------------------

type WriteArgs = { id: Id<"entityReviewQueue">; status: string; enrichment?: unknown };

/**
 * A ctx that answers the impl's two queries from the fixtures above and hands
 * each `applyLookupResult` call to `writeOutcomes[n]` — `"ok"`, or an Error to
 * reject with. Running off the end of the script throws: an extra write is
 * exactly the bug (the old code's second, fabricated call), so it must fail
 * the test rather than pass silently.
 */
function stubCtx(writeOutcomes: Array<"ok" | Error>, options: { lookupThrows?: Error } = {}) {
  const writes: WriteArgs[] = [];
  const ctx = {
    runQuery: async (ref: FunctionReference<"query">, _args: unknown) => {
      switch (getFunctionName(ref)) {
        case getFunctionName(internal.entityReviewQueue.getInternal):
          return ROW;
        case getFunctionName(internal.selectorOptions.getSportEnrichmentContext):
          if (options.lookupThrows) throw options.lookupThrows;
          return SPORT_CTX;
        default:
          throw new Error(`unexpected query: ${getFunctionName(ref)}`);
      }
    },
    runMutation: async (ref: FunctionReference<"mutation">, args: WriteArgs) => {
      const name = getFunctionName(ref);
      if (name !== getFunctionName(internal.entityReviewQueue.applyLookupResult)) {
        throw new Error(`unexpected mutation: ${name}`);
      }
      writes.push(args);
      const outcome = writeOutcomes[writes.length - 1];
      if (outcome === undefined) {
        throw new Error(
          `applyLookupResult called ${writes.length} times; script has ${writeOutcomes.length}`,
        );
      }
      if (outcome instanceof Error) throw outcome;
      return null;
    },
  } as unknown as EntityReviewLookupCtx;
  return { ctx, writes };
}

/** No wall clock in the retry backoff; occ-retry exposes this seam for tests. */
const NO_SLEEP = { sleep: async () => {} };

/** The structured lines a console spy received, parsed, for one `msg`. */
function linesFor(
  spy: ReturnType<typeof vi.spyOn>,
  msg: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    const first = call[0];
    if (typeof first !== "string" || !first.startsWith("{")) continue;
    const parsed = JSON.parse(first) as Record<string, unknown>;
    if (parsed.msg === msg) out.push(parsed);
  }
  return out;
}

/** The no-match shape: what the operator reads as "No Wikidata match found". */
const isNoMatchWrite = (w: WriteArgs) => w.status === "error" && w.enrichment === undefined;

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// A matched lookup whose write conflicts
// ===========================================================================

describe("a lookup that MATCHED, whose write loses an OCC race", () => {
  test("the conflict is retried and the enrichment lands — never 'no match'", async () => {
    stubPlayerFetch(MATCHED_QID);
    const { ctx, writes } = stubCtx([occConflictError(), "ok"]);

    await expect(
      runEntityReviewLookupImpl(ctx, { rowId: ROW_ID }, NO_SLEEP),
    ).resolves.toBeNull();

    // Both attempts carried the SAME decided payload. Before NEO-294 the
    // second call was the catch's, and it carried `status: "error"` with no
    // enrichment — the wrong answer this whole file exists to stop.
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write.status).toBe("ready");
      expect(write.enrichment).toMatchObject({ wikidataId: MATCHED_QID });
    }
    expect(writes.some(isNoMatchWrite)).toBe(false);
    // A conflict that the retry absorbed is not a failure: nothing is logged
    // as one, and the no-match line (a lookup that answered nothing) is absent.
    expect(linesFor(errorSpy, "entity_review_lookup_write_failed")).toEqual([]);
    expect(linesFor(logSpy, "entity_review_lookup_no_match")).toEqual([]);
  });

  test("a conflict on every attempt THROWS — it is never written as a no-match", async () => {
    stubPlayerFetch(MATCHED_QID);
    // A spare "ok" sits past the retry budget deliberately: a FOURTH write
    // would succeed if the code made one, so this test fails on what that
    // write SAYS rather than on the stub running out of script.
    const { ctx, writes } = stubCtx([
      ...Array.from({ length: OCC_RETRY_ATTEMPTS }, () => occConflictError()),
      "ok",
    ]);

    // Settled rather than asserted-on inline, so the FIRST assertion below is
    // the one that matters: what got written, not how the call ended.
    const outcome = await runEntityReviewLookupImpl(ctx, { rowId: ROW_ID }, NO_SLEEP).then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    // The regression itself: the old code answered a failed write with a
    // fabricated "Wikidata found nothing" patch.
    expect(writes.some(isNoMatchWrite)).toBe(false);
    expect(writes.every((w) => w.status === "ready")).toBe(true);
    // Exactly the retry budget, and not one write more.
    expect(writes).toHaveLength(OCC_RETRY_ATTEMPTS);
    // Throwing is the point: the row is left `pending` for the pool's
    // onComplete backstop, which ages it to "error" and logs the work item's
    // resultKind — an attributable failure instead of a fabricated answer.
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toMatch(/changed while this mutation was being run/);
  });

  test("the failure is logged as a WRITE failure, with ids and counts only", async () => {
    stubPlayerFetch(MATCHED_QID);
    const { ctx } = stubCtx(
      Array.from({ length: OCC_RETRY_ATTEMPTS }, () => occConflictError()),
    );

    await expect(
      runEntityReviewLookupImpl(ctx, { rowId: ROW_ID }, NO_SLEEP),
    ).rejects.toThrow();

    const failed = linesFor(errorSpy, "entity_review_lookup_write_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      rowId: ROW_ID,
      kind: "player",
      // What the lookup CONCLUDED — the line's whole value in triage. A
      // "ready" here is enrichment the operator did not get.
      attempted: "ready",
      occConflict: true,
      attempts: OCC_RETRY_ATTEMPTS,
    });
    // Distinguishable from a lookup that found nothing, which is the state
    // this bug was indistinguishable from in the logs.
    expect(linesFor(logSpy, "entity_review_lookup_no_match")).toEqual([]);
    // House rule: the lines this path emits carry ids, kinds and counts —
    // never the name on the row. (Scoped to THIS marker deliberately: the
    // lookup functions' own `wikidata_*_no_match` markers next door do carry
    // the searched name, and changing those is not this ticket.)
    expect(JSON.stringify(failed[0])).not.toContain(ROW.name);
  });

  test("a write failure that is NOT a conflict is not retried, and still throws", async () => {
    stubPlayerFetch(MATCHED_QID);
    const { ctx, writes } = stubCtx([new Error("schema validation failed")]);

    await expect(
      runEntityReviewLookupImpl(ctx, { rowId: ROW_ID }, NO_SLEEP),
    ).rejects.toThrow(/schema validation failed/);

    // occ-retry rethrows anything that is not a conflict immediately: a
    // mutation that failed halfway through is not safely repeatable.
    expect(writes).toHaveLength(1);
    expect(linesFor(errorSpy, "entity_review_lookup_write_failed")[0]).toMatchObject({
      occConflict: false,
    });
  });
});

// ===========================================================================
// The two genuine failures — unchanged by NEO-294
// ===========================================================================

describe("a lookup that genuinely found nothing (unchanged)", () => {
  test("writes 'error' with no enrichment, exactly once, and resolves", async () => {
    stubPlayerFetch(null);
    const { ctx, writes } = stubCtx(["ok"]);

    await expect(
      runEntityReviewLookupImpl(ctx, { rowId: ROW_ID }, NO_SLEEP),
    ).resolves.toBeNull();

    expect(writes).toHaveLength(1);
    expect(writes[0].status).toBe("error");
    expect(writes[0].enrichment).toBeUndefined();
    expect(isNoMatchWrite(writes[0])).toBe(true);
  });

  test("logs the no-match marker — the line that tells it from a failed write", async () => {
    stubPlayerFetch(null);
    const { ctx } = stubCtx(["ok"]);

    await runEntityReviewLookupImpl(ctx, { rowId: ROW_ID }, NO_SLEEP);

    const noMatch = linesFor(logSpy, "entity_review_lookup_no_match");
    expect(noMatch).toHaveLength(1);
    expect(noMatch[0]).toMatchObject({ rowId: ROW_ID, kind: "player", sportContext: true });
    expect(linesFor(errorSpy, "entity_review_lookup_write_failed")).toEqual([]);
    // This marker carries ids and kinds only.
    expect(JSON.stringify(noMatch[0])).not.toContain(ROW.name);
  });
});

/**
 * NOTE on what "threw" means here. A dead `fetch` does NOT reach this catch:
 * `runSparql` absorbs a transport failure and answers `null` (NEO-288), so a
 * network outage arrives as a no-match, not as a throw. What does reach it is
 * everything else in the try — the sport-config query, a malformed response a
 * parser chokes on — so these drive it through the query.
 */
describe("a lookup that threw (unchanged)", () => {
  test("is caught, writes 'error' once, resolves, and says so in the log", async () => {
    const { ctx, writes } = stubCtx(["ok"], { lookupThrows: new Error("sport config read failed") });

    await expect(
      runEntityReviewLookupImpl(ctx, { rowId: ROW_ID }, NO_SLEEP),
    ).resolves.toBeNull();

    expect(writes).toHaveLength(1);
    expect(isNoMatchWrite(writes[0])).toBe(true);
    // The long-standing line, kept verbatim: a thrown lookup is still a caught
    // lookup failure. What it no longer covers is the write.
    const prefixed = errorSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[entity-review-lookup]"),
    );
    expect(prefixed).toHaveLength(1);
    expect(linesFor(errorSpy, "entity_review_lookup_write_failed")).toEqual([]);
    // A thrown lookup never ran to an answer, so it is NOT a recorded no-match.
    expect(linesFor(logSpy, "entity_review_lookup_no_match")).toEqual([]);
  });

  test("a thrown lookup whose write then conflicts re-sends the SAME verdict", async () => {
    const { ctx, writes } = stubCtx([occConflictError(), "ok"], {
      lookupThrows: new Error("sport config read failed"),
    });

    await expect(
      runEntityReviewLookupImpl(ctx, { rowId: ROW_ID }, NO_SLEEP),
    ).resolves.toBeNull();

    // The retry re-sends the SAME decided payload — the error the lookup
    // concluded, not a second, different verdict invented by a catch.
    expect(writes).toHaveLength(2);
    expect(writes.every(isNoMatchWrite)).toBe(true);
  });
});
