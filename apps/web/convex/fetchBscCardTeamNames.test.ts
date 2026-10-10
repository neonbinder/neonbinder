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
  vi.restoreAllMocks();
});

describe("fetchBscCardTeamNames", () => {
  test("all cards resolve — returns a bscCardId -> { rawTeamName, teamNames } map with only non-empty entries", async () => {
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
      "bsc-1": { rawTeamName: "New York Yankees", teamNames: ["New York Yankees"] },
      "bsc-2": { rawTeamName: "Boston Red Sox", teamNames: ["Boston Red Sox"] },
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

    expect(result).toEqual({
      "bsc-1": { rawTeamName: "New York Yankees", teamNames: ["New York Yankees"] },
    });
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
    ).resolves.toEqual({
      "bsc-1": { rawTeamName: "New York Yankees", teamNames: ["New York Yankees"] },
    });
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

  test("NEO-333: a comma-separated value comes back raw AND split, in BSC's order", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({
        responses: { "bsc-1": "Cleveland Guardians, Washington Nationals" },
        calls: [],
      }),
    );

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1"] },
    );

    expect(result).toEqual({
      "bsc-1": {
        rawTeamName: "Cleveland Guardians, Washington Nationals",
        teamNames: ["Cleveland Guardians", "Washington Nationals"],
      },
    });
  });

  test("NEO-333: a slash is not a team separator on the wire either", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({ responses: { "bsc-1": "Bodø/Glimt" }, calls: [] }),
    );

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1"] },
    );

    expect(result["bsc-1"]).toEqual({ rawTeamName: "Bodø/Glimt", teamNames: ["Bodø/Glimt"] });
  });

  test("NEO-333: more teams than a card carries keeps the raw string and refuses the split", async () => {
    const t = convexTest(schema, modules);
    const raw = Array.from({ length: 9 }, (_, i) => `Team ${i}`).join(", ");
    vi.stubGlobal("fetch", makeCardListingFetch({ responses: { "bsc-1": raw }, calls: [] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1"] },
    );

    expect(result["bsc-1"]).toEqual({ rawTeamName: raw, teamNames: [] });
    // Flagged, with the card id only: never the marketplace text.
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("bsc-1");
    expect(logged).not.toContain("Team 3");
    warn.mockRestore();
  });

  test("NEO-333 (security N1): a raw value over 120 characters is sent as '' while its parts stand", async () => {
    const t = convexTest(schema, modules);
    const a = "A".repeat(70);
    const b = "B".repeat(70);
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({ responses: { "bsc-1": `${a}, ${b}` }, calls: [] }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1"] },
    );

    // Dropped, never truncated.
    expect(result["bsc-1"]).toEqual({ rawTeamName: "", teamNames: [a, b] });
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain(a);
    warn.mockRestore();
  });

  test("NEO-333 (security N1): an over-length value whose parts are ALSO unusable is absent", async () => {
    const t = convexTest(schema, modules);
    const raw = "X".repeat(200);
    vi.stubGlobal("fetch", makeCardListingFetch({ responses: { "bsc-1": raw }, calls: [] }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1"] },
    );

    // One 200-char part is over-length and dropped; raw is dropped: nothing.
    expect(result).toEqual({});
  });
});
