/**
 * NEO-90: tests for `fetchBscCardTeamNames` (the bounded-fan-out batch
 * lookup in `convex/adapters/buysportscards.ts`) — the new synchronous
 * per-card team resolution called from `fetchCardChecklist` so team names
 * land in the same "Confirm New Players & Teams" dialog as new players,
 * instead of trickling in via the background `processBscTeamEnrichmentQueue`
 * after save.
 *
 * Lives at the convex/ ROOT (not co-located under convex/adapters/) for the
 * same reason documented in `convex/bscTeamEnrichmentQueue.test.ts`:
 * convex-test's `import.meta.glob(...)` module registry breaks when the
 * glob is invoked from within convex/adapters/ itself.
 *
 * Fetch mocking follows the same `vi.stubGlobal("fetch", ...)` convention
 * used in `convex/bscTeamEnrichmentQueue.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type RecordedCall = { url: string };

/**
 * Fetch stub for BSC's per-card `card-listing` endpoint, keyed by the
 * bscCardId embedded in the URL. `responses` maps bscCardId -> either a
 * teamName string (200 OK JSON body) or an HTTP status number (non-2xx).
 * A bscCardId mapped to the literal string "THROW" simulates a network
 * failure (rejected fetch) instead of a bad response.
 */
function makeCardListingFetch(opts: {
  responses: Record<string, string | number>;
  calls: RecordedCall[];
}): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    opts.calls.push({ url: u });
    const match = u.match(/\/marketplace\/card\/([^/]+)\/card-listing/);
    const bscCardId = match?.[1] ?? "";
    const response = opts.responses[bscCardId];
    if (response === undefined) {
      throw new Error(`unexpected fetch for bscCardId=${bscCardId}`);
    }
    if (response === "THROW") {
      throw new Error("network down");
    }
    if (typeof response === "number") {
      return new Response("error", { status: response });
    }
    return new Response(JSON.stringify({ teamName: response }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBscCardTeamNames", () => {
  test("all cards resolve — returns a bscCardId -> teamName map with only non-empty entries", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({
        responses: { "bsc-1": "New York Yankees", "bsc-2": "Boston Red Sox" },
        calls: [],
      }),
    );

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1", "bsc-2"] },
    );

    expect(result).toEqual({
      "bsc-1": "New York Yankees",
      "bsc-2": "Boston Red Sox",
    });
  });

  test("cards with a genuinely-empty teamName are simply absent from the result map", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({
        responses: { "bsc-1": "New York Yankees", "bsc-2": "" },
        calls: [],
      }),
    );

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1", "bsc-2"] },
    );

    expect(result).toEqual({ "bsc-1": "New York Yankees" });
    expect(result["bsc-2"]).toBeUndefined();
  });

  test("cards whose fetch fails (non-2xx or thrown error) are absent from the result map — no exception propagates", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({
        responses: {
          "bsc-1": "New York Yankees",
          "bsc-2": 500, // non-2xx
          "bsc-3": "THROW", // thrown network error
        },
        calls: [],
      }),
    );

    await expect(
      t.action(internal.adapters.buysportscards.fetchBscCardTeamNames, {
        bscCardIds: ["bsc-1", "bsc-2", "bsc-3"],
      }),
    ).resolves.toEqual({ "bsc-1": "New York Yankees" });
  });

  test("empty input array — returns an empty map and makes no fetch calls", async () => {
    const t = convexTest(schema, modules);
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      (async () => {
        fetchCalled = true;
        throw new Error("fetch must not be called");
      }) as unknown as typeof fetch,
    );

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: [] },
    );

    expect(result).toEqual({});
    expect(fetchCalled).toBe(false);
  });

  test("concurrency bound: never exceeds BSC_TEAM_LOOKUP_CONCURRENCY (10) in-flight calls, across 25 ids", async () => {
    const t = convexTest(schema, modules);
    let inFlight = 0;
    let maxInFlight = 0;
    const ids = Array.from({ length: 25 }, (_, i) => `bsc-${i + 1}`);

    vi.stubGlobal(
      "fetch",
      (async (url: string | URL | Request) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Artificial delay so overlapping in-flight calls are observable —
        // without this, calls could complete synchronously-ish and never
        // truly overlap in the tracked counter.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        const match = String(url).match(/\/marketplace\/card\/([^/]+)\/card-listing/);
        const id = match?.[1] ?? "";
        return new Response(JSON.stringify({ teamName: `Team-${id}` }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    );

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ids },
    );

    // First chunk of 10 ids launches fully concurrently (Promise.all over
    // the chunk) before the chunk's artificial delay resolves — an
    // off-by-one in the chunking loop (e.g. slicing 11 instead of 10)
    // would push this past 10.
    expect(maxInFlight).toBe(10);
    expect(Object.keys(result)).toHaveLength(25);
  });
});
