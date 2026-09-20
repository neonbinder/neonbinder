/**
 * NEO-288: `runSparql`'s one-retry contract (convex/adapters/wikidata.ts).
 *
 * query.wikidata.org flaps: the same trivial query answers in 0.15 s, then
 * 12–30 s, then 0.15 s again. Before this, ONE transient failure — a 5xx, a
 * 429, a timeout abort, a thrown fetch — turned a real player into "No
 * Wikidata match found", a permanent answer to a transient question. These
 * tests pin the shape of the fix rather than the fact of it:
 *
 *  - a transport failure on the first attempt is retried exactly ONCE, after
 *    the fixed 1 500 ms backoff, and a recovered retry is a plain success —
 *    the `LookupTrace` marker (which the fixture capture reads as "do not
 *    record this") is NOT tripped;
 *  - two failures → `null`, trace tripped, exactly two fetches, never a third;
 *  - a 4xx other than 429 is a bad query, not a bad day: ONE fetch, no retry;
 *  - a 200 is never retried, including one whose body will not parse;
 *  - the retry log line is structured and carries a reason, never the query.
 *
 * Pure function, no Convex runtime: a stubbed global `fetch` (this session's
 * `vi.stubGlobal("fetch", …)` convention, as in espn.test.ts beside it) and
 * fake timers so the backoff is asserted, not waited for. It lives in
 * convex/adapters/ for the same reason espn.test.ts does — no convex-test,
 * so the `import.meta.glob` constraint that keeps the action-harness tests
 * at convex/ root does not apply.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  lookupLeagueEnrichmentLive,
  lookupPlayerEnrichmentLive,
  newLookupTrace,
  runSparql,
  type SportEnrichmentContext,
} from "./wikidata";

/** Mirrors `WIKIDATA_RETRY_BACKOFF_MS` in the adapter — the value under test. */
const BACKOFF_MS = 1_500;

const EMPTY_BODY = { results: { bindings: [] } };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** What undici rejects a `fetch` with when its `AbortSignal.timeout` fires. */
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

/**
 * A `fetch` that answers from a script of outcomes, one per call, and counts.
 * An outcome is a `Response` to resolve with or an `Error` to reject with.
 * Running off the end of the script fails the test loudly: a third attempt
 * is exactly the bug the "never more than two" cases exist to catch.
 */
function scriptedFetch(script: Array<Response | Error>) {
  let calls = 0;
  const urls: string[] = [];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    urls.push(String(input));
    const next = script[calls++];
    if (next === undefined) throw new Error(`fetch called ${calls} times; script has ${script.length}`);
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch);
  return { calls: () => calls, urls };
}

/** Drives `runSparql` through its backoff under fake timers. */
async function runWithBackoff(query: string, trace?: ReturnType<typeof newLookupTrace>) {
  const pending = runSparql(query, trace);
  await vi.advanceTimersByTimeAsync(BACKOFF_MS);
  return pending;
}

/** The structured retry lines `console.warn` received, parsed. */
function retryLines(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of warn.mock.calls) {
    const first = call[0];
    if (typeof first !== "string" || !first.startsWith("{")) continue;
    const parsed = JSON.parse(first) as Record<string, unknown>;
    if (parsed.msg === "wikidata_sparql_retry") out.push(parsed);
  }
  return out;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const QUERY = "SELECT ?x WHERE { ?x wdt:P31 wd:Q5 } LIMIT 1";
const HIT = { results: { bindings: [{ x: { type: "uri", value: "http://www.wikidata.org/entity/Q1" } }] } };

describe("runSparql — one retry on a transport failure", () => {
  test("a 200 on the first attempt is one fetch, no retry, trace untouched", async () => {
    const stub = scriptedFetch([jsonResponse(HIT)]);
    const trace = newLookupTrace();

    const result = await runWithBackoff(QUERY, trace);

    expect(result).toEqual(HIT);
    expect(stub.calls()).toBe(1);
    expect(trace.transportFailed).toBe(false);
    expect(retryLines(warn)).toEqual([]);
  });

  test("5xx then 200 → the result, one retry line, trace NOT tripped", async () => {
    const stub = scriptedFetch([jsonResponse({}, 503), jsonResponse(HIT)]);
    const trace = newLookupTrace();

    const result = await runWithBackoff(QUERY, trace);

    expect(result).toEqual(HIT);
    expect(stub.calls()).toBe(2);
    // A recovered retry is a success: the fixture capture must record it.
    expect(trace.transportFailed).toBe(false);
    expect(retryLines(warn)).toEqual([{ msg: "wikidata_sparql_retry", reason: "http_503" }]);
  });

  test("timeout then 200 → the result, retry reason 'timeout', trace NOT tripped", async () => {
    const stub = scriptedFetch([timeoutError(), jsonResponse(HIT)]);
    const trace = newLookupTrace();

    const result = await runWithBackoff(QUERY, trace);

    expect(result).toEqual(HIT);
    expect(stub.calls()).toBe(2);
    expect(trace.transportFailed).toBe(false);
    expect(retryLines(warn)).toEqual([{ msg: "wikidata_sparql_retry", reason: "timeout" }]);
  });

  test("a thrown fetch (network) then 200 → the result, retry reason 'network'", async () => {
    const stub = scriptedFetch([new TypeError("fetch failed"), jsonResponse(HIT)]);
    const trace = newLookupTrace();

    const result = await runWithBackoff(QUERY, trace);

    expect(result).toEqual(HIT);
    expect(stub.calls()).toBe(2);
    expect(trace.transportFailed).toBe(false);
    expect(retryLines(warn)).toEqual([{ msg: "wikidata_sparql_retry", reason: "network" }]);
  });

  test("429 then 200 → the result, retry reason 'http_429', trace NOT tripped", async () => {
    const stub = scriptedFetch([jsonResponse({}, 429), jsonResponse(HIT)]);
    const trace = newLookupTrace();

    const result = await runWithBackoff(QUERY, trace);

    expect(result).toEqual(HIT);
    expect(stub.calls()).toBe(2);
    expect(trace.transportFailed).toBe(false);
    expect(retryLines(warn)).toEqual([{ msg: "wikidata_sparql_retry", reason: "http_429" }]);
  });

  test("two transport failures → null, trace tripped, EXACTLY two fetches", async () => {
    // The script has exactly two entries: a third attempt throws from the
    // stub itself, so "never more than two" is asserted by construction as
    // well as by the count.
    const stub = scriptedFetch([jsonResponse({}, 502), timeoutError()]);
    const trace = newLookupTrace();

    const pending = runSparql(QUERY, trace);
    // Generous: were a second backoff scheduled, this would fire it too and
    // the stub would throw on the third call.
    await vi.advanceTimersByTimeAsync(BACKOFF_MS * 3);
    const result = await pending;

    expect(result).toBeNull();
    expect(stub.calls()).toBe(2);
    expect(trace.transportFailed).toBe(true);
    expect(retryLines(warn)).toEqual([{ msg: "wikidata_sparql_retry", reason: "http_502" }]);
  });

  test("the second attempt waits the full backoff, not less", async () => {
    const stub = scriptedFetch([jsonResponse({}, 500), jsonResponse(HIT)]);

    const pending = runSparql(QUERY);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS - 1);
    expect(stub.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.calls()).toBe(2);
    await expect(pending).resolves.toEqual(HIT);
  });

  test("404 → null with NO retry (one fetch), trace tripped", async () => {
    const stub = scriptedFetch([jsonResponse({}, 404)]);
    const trace = newLookupTrace();

    const pending = runSparql(QUERY, trace);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS * 3);
    const result = await pending;

    expect(result).toBeNull();
    expect(stub.calls()).toBe(1);
    // Still a round trip that did not complete: a capture must not write it
    // down as a no-match.
    expect(trace.transportFailed).toBe(true);
    expect(retryLines(warn)).toEqual([]);
  });

  test("400 (a bad query) → null with NO retry — asking again is the same bad query", async () => {
    const stub = scriptedFetch([jsonResponse({}, 400)]);

    const pending = runSparql(QUERY);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS * 3);

    await expect(pending).resolves.toBeNull();
    expect(stub.calls()).toBe(1);
    expect(retryLines(warn)).toEqual([]);
  });

  test("a 200 whose body will not parse → null, no retry, trace tripped", async () => {
    const stub = scriptedFetch([new Response("<html>not json</html>", { status: 200 })]);
    const trace = newLookupTrace();

    const pending = runSparql(QUERY, trace);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS * 3);

    await expect(pending).resolves.toBeNull();
    expect(stub.calls()).toBe(1);
    expect(trace.transportFailed).toBe(true);
    expect(retryLines(warn)).toEqual([]);
  });

  test("the retry line never carries the query", async () => {
    const marker = "ZZ_QUERY_MARKER_ZZ";
    scriptedFetch([jsonResponse({}, 503), jsonResponse(EMPTY_BODY)]);

    await runWithBackoff(`SELECT ?x WHERE { ?x rdfs:label "${marker}" }`);

    for (const call of warn.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "string") expect(arg).not.toContain(marker);
      }
    }
  });

  test("both attempts hit the same URL — the retry is the same call, not a new one", async () => {
    const stub = scriptedFetch([jsonResponse({}, 503), jsonResponse(HIT)]);

    await runWithBackoff(QUERY);

    expect(stub.urls).toHaveLength(2);
    expect(stub.urls[0]).toBe(stub.urls[1]);
    expect(stub.urls[0]).toContain("query.wikidata.org/sparql");
  });
});

// ---------------------------------------------------------------------------
// Through the real lookups — the retry is what the callers see
// ---------------------------------------------------------------------------

const SPORT: SportEnrichmentContext = {
  label: "Baseball",
  espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
  wikidata: { sportQid: "Q5369", hallOfFameQid: "Q809892" },
};

describe("runSparql retry as seen by the lookup callers", () => {
  test("league detail: 503 then 200 → the enrichment lands (a blip is not a no-match)", async () => {
    const detail = {
      results: {
        bindings: [{ shortName: { type: "literal", value: "MLB", "xml:lang": "en" } }],
      },
    };
    const stub = scriptedFetch([jsonResponse({}, 503), jsonResponse(detail)]);
    const trace = newLookupTrace();

    // A known QID skips the search: one logical call, two fetches.
    const pending = lookupLeagueEnrichmentLive("Major League Baseball", "Q5369", "Q1901", trace);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    const result = await pending;

    expect(result).toEqual({ wikidataId: "Q1901", abbreviation: "MLB", yearsActive: undefined, country: undefined });
    expect(stub.calls()).toBe(2);
    expect(trace.transportFailed).toBe(false);
  });

  test("player search: two failures → null, trace tripped, the detail query is never sent", async () => {
    const stub = scriptedFetch([timeoutError(), jsonResponse({}, 500)]);
    const trace = newLookupTrace();

    const pending = lookupPlayerEnrichmentLive("Harmon Killebrew", SPORT, trace);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS * 3);
    const result = await pending;

    expect(result).toBeNull();
    expect(stub.calls()).toBe(2);
    expect(trace.transportFailed).toBe(true);
    expect(retryLines(warn)).toEqual([{ msg: "wikidata_sparql_retry", reason: "timeout" }]);
  });

  test("player: search 429 then hit, detail 200 → three fetches and a match", async () => {
    const search = { results: { bindings: [{ player: { type: "uri", value: "http://www.wikidata.org/entity/Q1585630" } }] } };
    const stub = scriptedFetch([jsonResponse({}, 429), jsonResponse(search), jsonResponse(EMPTY_BODY)]);
    const trace = newLookupTrace();

    const pending = lookupPlayerEnrichmentLive("Harmon Killebrew", SPORT, trace);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    const result = await pending;

    expect(result?.wikidataId).toBe("Q1585630");
    expect(stub.calls()).toBe(3);
    expect(trace.transportFailed).toBe(false);
  });
});
