/**
 * NEO-90: tests for the two `"use node"` actions in
 * `convex/adapters/buysportscards.ts` that make up the chained BSC
 * per-card team-enrichment queue — `resolveBscCardTeam` (one HTTP round
 * trip + apply) and `processBscTeamEnrichmentQueue` (the self-rescheduling
 * drain, same shape as `convex/adapters/wikidata.ts`'s
 * `processEnrichmentQueue`).
 *
 * Lives at the convex/ ROOT (not co-located under convex/adapters/)
 * because `convex-test`'s module registry derives every function's path
 * from the `import.meta.glob(...)` call site: when the glob is invoked
 * from within convex/adapters/, files in that same directory resolve to
 * keys like "./buysportscards" instead of "adapters/buysportscards",
 * which breaks convex-test's internal path-prefix matching (confirmed by
 * probing `Object.keys(modules)` directly — see PR notes). Every other
 * convexTest-based test file in this codebase lives at convex/ root for
 * the same reason; convex/adapters/buysportscards.test.ts itself only
 * unit-tests the pure `parsePlayersField` helper and never calls
 * `convexTest`.
 *
 * Fetch mocking follows convex/testing.test.ts's seedMyTestCredentials
 * convention (`vi.stubGlobal("fetch", ...)` + call the action directly
 * through convex-test). Chained-queue draining follows
 * convex/backfillCardFeatures.test.ts's fake-timer +
 * `finishAllScheduledFunctions(vi.runAllTimers)` pattern.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedTree(
  t: ReturnType<typeof convexTest>,
  sportValue = "Baseball",
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: sportValue,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    return variantTypeId;
  });
}

async function insertCard(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  cardNumber: string,
  bscCardId: string,
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      platformData: { bsc: bscCardId },
      sortOrder: Number(cardNumber) || 0,
      lastUpdated: Date.now(),
    }),
  );
}

const getCard = (t: ReturnType<typeof convexTest>, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => ctx.db.get(id));

type RecordedCall = { url: string; init?: RequestInit };

/**
 * Fetch stub for BSC's per-card `card-listing` endpoint, keyed by the
 * bscCardId embedded in the URL. `responses` maps bscCardId -> either a
 * teamName string (200 OK JSON body) or an HTTP status number (non-2xx).
 * Every call is recorded in `calls` so tests can assert on headers/order.
 */
function makeCardListingFetch(opts: {
  responses: Record<string, string | number>;
  calls: RecordedCall[];
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    opts.calls.push({ url: u, init });
    const match = u.match(/\/marketplace\/card\/([^/]+)\/card-listing/);
    const bscCardId = match?.[1] ?? "";
    const response = opts.responses[bscCardId];
    if (response === undefined) {
      throw new Error(`unexpected fetch for bscCardId=${bscCardId}`);
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

// ===========================================================================
// resolveBscCardTeam
// ===========================================================================

describe("resolveBscCardTeam", () => {
  test("200 response with a real teamName resolves the card and creates a team", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");

    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({ responses: { "bsc-1": "New York Yankees" }, calls }),
    );

    await t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
      cardChecklistId: cardId,
    });

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toHaveLength(1);
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
    const teamRow = await t.run(async (ctx) => ctx.db.get(card!.teamOnCardIds![0]));
    expect(teamRow!.name).toBe("New York Yankees");

    // Confirmed-unauthenticated endpoint: no Authorization header sent.
    expect(calls).toHaveLength(1);
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  test("200 response with an empty teamName just marks the card checked", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");

    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({ responses: { "bsc-1": "" }, calls: [] }),
    );

    await t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
      cardChecklistId: cardId,
    });

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });

  test("non-2xx response is a no-op: row untouched, no exception thrown", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");

    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({ responses: { "bsc-1": 500 }, calls: [] }),
    );

    await expect(
      t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
        cardChecklistId: cardId,
      }),
    ).resolves.toBeNull();

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeUndefined(); // left untouched for a future retry
  });

  test("a thrown fetch error (network failure) is caught — no-op, no exception", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");

    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );

    await expect(
      t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
        cardChecklistId: cardId,
      }),
    ).resolves.toBeNull();

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeUndefined();
  });

  test("no-op when the card doesn't need a check (fetch never called)", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");
    // Pre-mark as already checked.
    await t.mutation(internal.cardChecklist.applyBscTeamResolution, {
      cardChecklistId: cardId,
      teamName: "",
    });

    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      (async () => {
        fetchCalled = true;
        throw new Error("fetch must not be called");
      }) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
      cardChecklistId: cardId,
    });
    expect(fetchCalled).toBe(false);
  });

  test("no-op when the card has no platformData.bsc (fetch never called)", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: "1",
        cardName: "Card 1",
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );

    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      (async () => {
        fetchCalled = true;
        throw new Error("fetch must not be called");
      }) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
      cardChecklistId: cardId,
    });
    expect(fetchCalled).toBe(false);
  });
});

// ===========================================================================
// processBscTeamEnrichmentQueue
// ===========================================================================

describe("processBscTeamEnrichmentQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("drains ids one at a time, resolving each card", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const card1 = await insertCard(t, variantTypeId, "1", "bsc-1");
    const card2 = await insertCard(t, variantTypeId, "2", "bsc-2");
    const card3 = await insertCard(t, variantTypeId, "3", "bsc-3");

    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({
        responses: { "bsc-1": "Yankees", "bsc-2": "Mets", "bsc-3": "" },
        calls,
      }),
    );

    await t.action(internal.adapters.buysportscards.processBscTeamEnrichmentQueue, {
      cardChecklistIds: [card1, card2, card3],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Every card in the tail eventually got processed via the chained
    // reschedule (BSC_TEAM_ENRICH_DELAY_MS between each), in order.
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining("/marketplace/card/bsc-1/card-listing"),
      expect.stringContaining("/marketplace/card/bsc-2/card-listing"),
      expect.stringContaining("/marketplace/card/bsc-3/card-listing"),
    ]);

    const c1 = await getCard(t, card1);
    const c2 = await getCard(t, card2);
    const c3 = await getCard(t, card3);
    expect(c1!.teamOnCardIds).toHaveLength(1);
    expect(c2!.teamOnCardIds).toHaveLength(1);
    expect(c3!.teamOnCardIds).toBeUndefined();
    expect(c3!.teamCheckDoneAt).toBeTypeOf("number"); // checked, just no team on file
  });

  test("an empty id list drains immediately without error", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.action(internal.adapters.buysportscards.processBscTeamEnrichmentQueue, {
        cardChecklistIds: [],
      }),
    ).resolves.toBeNull();
  });

  // NOTE: "tolerates one card's resolveBscCardTeam throwing without
  // dropping the rest of the tail" lives in the sibling file
  // convex/bscTeamEnrichmentQueue.tolerance.test.ts. It needs a file-scoped
  // vi.mock of resolveBscCardTeam to force a genuine throw — resolveBscCardTeam's
  // real implementation swallows every externally-triggerable error itself
  // (bad response, network failure), so there's no way to reach this
  // queue's own try/catch through realistic fetch-stub inputs alone, and a
  // malformed id fails Convex's OWN argument validation before the handler
  // even runs (confirmed empirically), so it can't be used as a stand-in
  // either. Isolating the vi.mock in its own file avoids breaking every
  // other (real-fetch-based) test here, since vi.mock is hoisted and
  // file-scoped in Vitest.
});
