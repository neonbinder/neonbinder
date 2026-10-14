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
  test("all cards resolve — one answered entry per id, in request order, raw and split", async () => {
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

    expect(result).toEqual([
      {
        bscCardId: "bsc-1",
        rawTeamName: "New York Yankees",
        teamNames: ["New York Yankees"],
        success: true,
        attributeTokens: [],
      },
      {
        bscCardId: "bsc-2",
        rawTeamName: "Boston Red Sox",
        teamNames: ["Boston Red Sox"],
        success: true,
        attributeTokens: [],
      },
    ]);
  });

  test("NEO-335: a genuinely-empty teamName is an ANSWER — success true, empty name", async () => {
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

    expect(result).toEqual([
      {
        bscCardId: "bsc-1",
        rawTeamName: "New York Yankees",
        teamNames: ["New York Yankees"],
        success: true,
        attributeTokens: [],
      },
      { bscCardId: "bsc-2", rawTeamName: "", teamNames: [], success: true, attributeTokens: [] },
    ]);
  });

  test("NEO-335: a fetch that fails (non-2xx or thrown error) is reported success false — distinct from an empty answer, and no exception propagates", async () => {
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
    ).resolves.toEqual([
      {
        bscCardId: "bsc-1",
        rawTeamName: "New York Yankees",
        teamNames: ["New York Yankees"],
        success: true,
        attributeTokens: [],
      },
      { bscCardId: "bsc-2", rawTeamName: "", teamNames: [], success: false, attributeTokens: [] },
      { bscCardId: "bsc-3", rawTeamName: "", teamNames: [], success: false, attributeTokens: [] },
    ]);
  });

  test("empty input array — returns an empty list and makes no fetch calls", async () => {
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

    expect(result).toEqual([]);
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
    expect(result).toHaveLength(25);
    expect(result.map((r) => r.bscCardId)).toEqual(ids);
    expect(result.every((r) => r.success)).toBe(true);
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

    expect(result).toEqual([
      {
        bscCardId: "bsc-1",
        rawTeamName: "Cleveland Guardians, Washington Nationals",
        teamNames: ["Cleveland Guardians", "Washington Nationals"],
        success: true,
        attributeTokens: [],
      },
    ]);
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

    expect(result).toEqual([
      {
        bscCardId: "bsc-1",
        rawTeamName: "Bodø/Glimt",
        teamNames: ["Bodø/Glimt"],
        success: true,
        attributeTokens: [],
      },
    ]);
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

    expect(result).toEqual([
      { bscCardId: "bsc-1", rawTeamName: raw, teamNames: [], success: true, attributeTokens: [] },
    ]);
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
    expect(result).toEqual([
      { bscCardId: "bsc-1", rawTeamName: "", teamNames: [a, b], success: true, attributeTokens: [] },
    ]);
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain(a);
    warn.mockRestore();
  });

  test("NEO-333 (security N1): an over-length value whose parts are ALSO unusable is an answer with neither form", async () => {
    const t = convexTest(schema, modules);
    const raw = "X".repeat(200);
    vi.stubGlobal("fetch", makeCardListingFetch({ responses: { "bsc-1": raw }, calls: [] }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1"] },
    );

    // One 200-char part is over-length and dropped; raw is dropped: nothing
    // to carry. BSC still ANSWERED (NEO-335), so the entry is not a failure.
    expect(result).toEqual([
      { bscCardId: "bsc-1", rawTeamName: "", teamNames: [], success: true, attributeTokens: [] },
    ]);
  });
});

/**
 * NEO-345 — the card-listing response also carries the card's attribute
 * tokens (`playerAttribute`, a comma string), and on some cards BSC puts the
 * attribute LABEL where the team belongs. Payload shapes below are the ones
 * seen when the public endpoint was probed for autograph cards.
 */
function makePayloadFetch(
  responses: Record<string, Record<string, unknown>>,
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const match = String(url).match(/\/marketplace\/card\/([^/]+)\/card-listing/);
    const body = responses[match?.[1] ?? ""];
    if (!body) throw new Error("unexpected fetch");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("fetchBscCardTeamNames — attribute tokens (NEO-345)", () => {
  test("carries the raw tokens and the print run beside the team", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      makePayloadFetch({
        "bsc-1": { teamName: "Seattle Mariners", playerAttribute: "AU ,  SN50" },
        "bsc-2": { teamName: "Detroit Tigers", playerAttribute: "FY, AU, RC" },
        "bsc-3": { teamName: "Boston Red Sox" },
      }),
    );

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1", "bsc-2", "bsc-3"] },
    );

    expect(result).toEqual([
      {
        bscCardId: "bsc-1",
        rawTeamName: "Seattle Mariners",
        teamNames: ["Seattle Mariners"],
        success: true,
        attributeTokens: ["AU", "SN50"],
        printRun: 50,
      },
      {
        bscCardId: "bsc-2",
        rawTeamName: "Detroit Tigers",
        teamNames: ["Detroit Tigers"],
        success: true,
        attributeTokens: ["FY", "AU", "RC"],
      },
      {
        bscCardId: "bsc-3",
        rawTeamName: "Boston Red Sox",
        teamNames: ["Boston Red Sox"],
        success: true,
        attributeTokens: [],
      },
    ]);
  });

  test("a team value that is the attribute label ('AU  SN1') is no team, and its tokens are the card's", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      makePayloadFetch({ "bsc-1": { teamName: "AU  SN1", playerAttribute: "" } }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1"] },
    );

    // Answered, with no team on file — never a team called "AU  SN1".
    expect(result).toEqual([
      {
        bscCardId: "bsc-1",
        rawTeamName: "",
        teamNames: [],
        success: true,
        attributeTokens: ["AU", "SN1"],
        printRun: 1,
      },
    ]);
    // A flag and the card id only, never the marketplace text.
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("bsc-1");
    expect(logged).not.toContain("AU  SN1");
  });

  test("the label beside a populated playerAttribute takes the payload's tokens", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      makePayloadFetch({
        "bsc-1": { teamName: "AU SN25", playerAttribute: "AU, SN25" },
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const [entry] = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1"] },
    );

    expect(entry.rawTeamName).toBe("");
    expect(entry.teamNames).toEqual([]);
    expect(entry.attributeTokens).toEqual(["AU", "SN25"]);
    expect(entry.printRun).toBe(25);
  });

  test("a non-string playerAttribute is ignored, not trusted", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      makePayloadFetch({
        "bsc-1": { teamName: "Boston Red Sox", playerAttribute: { evil: true } },
      }),
    );

    const [entry] = await t.action(
      internal.adapters.buysportscards.fetchBscCardTeamNames,
      { bscCardIds: ["bsc-1"] },
    );

    expect(entry.attributeTokens).toEqual([]);
    expect(entry.printRun).toBeUndefined();
    expect(entry.rawTeamName).toBe("Boston Red Sox");
  });
});
