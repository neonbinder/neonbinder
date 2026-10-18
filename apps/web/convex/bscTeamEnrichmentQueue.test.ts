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
// NEO-236: fixtures derive their identity fields the same way production does,
// so a seeded row is one the lookup could really have found.
import { teamRowFields } from "./lib/teamRow";
import { teamFullName } from "../lib/teams/team-name";
// NEO-330 — the bound the queue retries a failed lookup within, and the
// reader a given-up card must reach: the attention badge. (Set-wide Fill
// teams, its other reader on NEO-330, was retired by NEO-335.)
import {
  BSC_TEAM_CHECK_MAX_PASSES,
  BSC_TEAM_CHECK_RETRY_DELAYS_MS,
} from "./adapters/buysportscards";
import { deriveCardAttention } from "./features/cardAttention";

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

/**
 * NEO-236: a `teams` row for the BSC resolution to LINK to.
 *
 * The queue no longer creates teams — a background job has no operator and
 * therefore no Location + Name — so a card only acquires a team if we already
 * hold one whose composed full name matches the string BSC returns. Walks up
 * from the variantType to the sport because `seedTree` hands back only the
 * leaf, and every other caller depends on that shape.
 */
async function seedTeam(
  t: ReturnType<typeof convexTest>,
  variantTypeId: Id<"selectorOptions">,
  parts: { name: string; location?: string },
): Promise<Id<"teams">> {
  return t.run(async (ctx) => {
    const variant = await ctx.db.get(variantTypeId);
    const setName = await ctx.db.get(variant!.parentId!);
    return ctx.db.insert("teams", {
      ...teamRowFields(parts),
      sportId: setName!.parentId!,
      lastUpdated: Date.now(),
    });
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
      platformData: { bsc: { ref: bscCardId, src: "b0" } },
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
  test("200 response with a real teamName LINKS the card to the team we already hold", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    // NEO-236: seeded SPLIT, and BSC returns the whole name — the composed
    // name is what the lookup keys on, so a split row still matches.
    const yankeesId = await seedTeam(t, variantTypeId, {
      location: "New York",
      name: "Yankees",
    });
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");

    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({ responses: { "bsc-1": "New York Yankees" }, calls }),
    );

    await expect(
      t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
        cardChecklistId: cardId,
      }),
    ).resolves.toBe("answered");

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toEqual([yankeesId]);
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
    const teamId: Id<"teams"> = card!.teamOnCardIds![0];
    const teamRow = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(teamFullName(teamRow!)).toBe("New York Yankees");
    // Linked, never minted: the queue has no operator and so no Location +
    // Name to build a row from. The miss case is covered at the mutation
    // boundary in cardChecklist.bscTeamEnrichment.test.ts, and end to end in
    // featurePropagation.test.ts.
    const allTeams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(allTeams).toHaveLength(1);

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

  test("non-2xx response reports a failure and leaves the row untouched, no exception thrown", async () => {
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
    ).resolves.toBe("failed");

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeUndefined(); // left untouched for a future retry
  });

  test("a thrown fetch error (network failure) is caught — reported as a failure, no exception", async () => {
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
    ).resolves.toBe("failed");

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
      rawTeamName: "",
      teamNames: [],
    });

    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      (async () => {
        fetchCalled = true;
        throw new Error("fetch must not be called");
      }) as unknown as typeof fetch,
    );

    await expect(
      t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
        cardChecklistId: cardId,
      }),
    ).resolves.toBe("notNeeded");
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

    await expect(
      t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
        cardChecklistId: cardId,
      }),
    ).resolves.toBe("notNeeded");
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
    // NEO-236: the drain LINKS, so the two teams BSC will name must exist.
    // Location-less on purpose — these are the exact strings the stub returns,
    // and a team with no location is an ordinary team.
    const yankeesId = await seedTeam(t, variantTypeId, { name: "Yankees" });
    const metsId = await seedTeam(t, variantTypeId, { name: "Mets" });
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
    expect(c1!.teamOnCardIds).toEqual([yankeesId]);
    expect(c2!.teamOnCardIds).toEqual([metsId]);
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

// ===========================================================================
// NEO-330 — a lookup that never returns ends with the operator, not in limbo
// ===========================================================================

/**
 * Jason, 2026-10-11: "If a team lookup never returns then the user must
 * select a team." A failed lookup used to leave `teamCheckDoneAt` unset with
 * nothing scheduled to ask again — and an unset `teamCheckDoneAt` on a
 * BSC-linked card is what the attention badge reads as "still waiting", so
 * the card was never shown to anyone.
 */
describe("processBscTeamEnrichmentQueue — bounded retry, then the operator (NEO-330)", () => {
  // The queue reports retries and give-ups on console.warn/error. Captured so
  // nothing crosses the vitest worker RPC at teardown (see the tolerance file).
  const warnLines: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    warnLines.length = 0;
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnLines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("the bound is three passes, a minute then five minutes apart", () => {
    expect(BSC_TEAM_CHECK_MAX_PASSES).toBe(3);
    expect([...BSC_TEAM_CHECK_RETRY_DELAYS_MS]).toEqual([60_000, 300_000]);
    // One delay before every pass after the first.
    expect(BSC_TEAM_CHECK_RETRY_DELAYS_MS).toHaveLength(
      BSC_TEAM_CHECK_MAX_PASSES - 1,
    );
  });

  test("a card that fails every pass is asked exactly MAX_PASSES times, then flagged with no team written", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    await seedTeam(t, variantTypeId, { name: "Yankees" });
    const failing = await insertCard(t, variantTypeId, "1", "bsc-1");
    const fine = await insertCard(t, variantTypeId, "2", "bsc-2");
    // A hint an earlier answer left — the give-up must not erase it.
    await t.run(async (ctx) =>
      ctx.db.patch(failing, { bscTeamName: "New York Yankees" }),
    );

    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({
        responses: { "bsc-1": 503, "bsc-2": "Yankees" },
        calls,
      }),
    );

    await t.action(internal.adapters.buysportscards.processBscTeamEnrichmentQueue, {
      cardChecklistIds: [failing, fine],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const asked = calls.filter((c) => c.url.includes("/card/bsc-1/"));
    expect(asked).toHaveLength(BSC_TEAM_CHECK_MAX_PASSES);
    // The answered card is never asked again.
    expect(calls.filter((c) => c.url.includes("/card/bsc-2/"))).toHaveLength(1);

    const card = (await getCard(t, failing))!;
    // Never a guess: nothing came back, so nothing is linked…
    expect(card.teamOnCardIds).toBeUndefined();
    expect(card.pendingTeamNames).toBeUndefined();
    // …but the wait is over, the hint stays, and the operator is told.
    expect(card.teamCheckDoneAt).toBeTypeOf("number");
    // NEO-345: and WHY — so a later re-ask can find it.
    expect(card.teamCheckOutcome).toBe("gaveUp");
    expect(card.bscTeamName).toBe("New York Yankees");
    expect(deriveCardAttention(card)).toContainEqual({ kind: "missingTeam" });

    expect(warnLines.filter((l) => l.includes("bsc_team_check_retry_scheduled"))).toHaveLength(
      BSC_TEAM_CHECK_MAX_PASSES - 1,
    );
    const gaveUp = warnLines.find((l) => l.includes("bsc_team_check_gave_up"));
    expect(gaveUp).toBeDefined();
    expect(JSON.parse(gaveUp!)).toMatchObject({
      platform: "bsc",
      failed: 1,
      flagged: 1,
      passes: BSC_TEAM_CHECK_MAX_PASSES,
    });
    // Counts only on the log line — never the marketplace's team string.
    expect(gaveUp).not.toContain("Yankees");
  });

  test("before the give-up, a failed card is not badged (the wait is real)", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({ responses: { "bsc-1": 503 }, calls: [] }),
    );

    // One pass only: the retry is scheduled, not yet run.
    await t.action(internal.adapters.buysportscards.processBscTeamEnrichmentQueue, {
      cardChecklistIds: [cardId],
    });

    const card = (await getCard(t, cardId))!;
    expect(card.teamCheckDoneAt).toBeUndefined();
    expect(deriveCardAttention(card)).not.toContainEqual({ kind: "missingTeam" });
  });

  test("a transient failure that succeeds on a later pass links BSC's team and is never given up", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const yankeesId = await seedTeam(t, variantTypeId, { name: "Yankees" });
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");

    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      (async () => {
        attempt++;
        if (attempt === 1) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ teamName: "Yankees" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    );

    await t.action(internal.adapters.buysportscards.processBscTeamEnrichmentQueue, {
      cardChecklistIds: [cardId],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(attempt).toBe(2);
    const card = (await getCard(t, cardId))!;
    expect(card.teamOnCardIds).toEqual([yankeesId]);
    expect(warnLines.some((l) => l.includes("bsc_team_check_gave_up"))).toBe(false);
  });

  test("a card the operator answers between passes is not asked again and not stamped over", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      "fetch",
      makeCardListingFetch({ responses: { "bsc-1": 503 }, calls }),
    );

    await t.action(internal.adapters.buysportscards.processBscTeamEnrichmentQueue, {
      cardChecklistIds: [cardId],
    });
    // The operator settles it as teamless while the retry waits.
    const confirmedAt = 1_700_000_000_000;
    await t.run(async (ctx) =>
      ctx.db.patch(cardId, { teamNoneConfirmedAt: confirmedAt }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(calls).toHaveLength(1);
    const card = (await getCard(t, cardId))!;
    expect(card.teamNoneConfirmedAt).toBe(confirmedAt);
    expect(card.teamOnCardIds).toBeUndefined();
    expect(warnLines.some((l) => l.includes("bsc_team_check_gave_up"))).toBe(false);
  });
});

describe("bscTeamCheck.markBscTeamCheckGivenUp (NEO-330)", () => {
  test("stamps teamCheckDoneAt with outcome gaveUp (NEO-345) and writes nothing else", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");
    const before = (await getCard(t, cardId))!;

    await expect(
      t.mutation(internal.bscTeamCheck.markBscTeamCheckGivenUp, {
        cardChecklistId: cardId,
      }),
    ).resolves.toBe(true);

    const after = (await getCard(t, cardId))!;
    expect(after.teamCheckDoneAt).toBeTypeOf("number");
    expect(after.teamCheckOutcome).toBe("gaveUp");
    const {
      teamCheckDoneAt: _stamp,
      teamCheckOutcome: _outcome,
      ...rest
    } = after;
    expect(rest).toEqual(before);
  });

  test("leaves an already-answered card alone", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");
    await t.run(async (ctx) => ctx.db.patch(cardId, { teamCheckDoneAt: 42 }));

    await expect(
      t.mutation(internal.bscTeamCheck.markBscTeamCheckGivenUp, {
        cardChecklistId: cardId,
      }),
    ).resolves.toBe(false);
    expect((await getCard(t, cardId))!.teamCheckDoneAt).toBe(42);
  });

  test("ignores a card with no BSC link", async () => {
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

    await expect(
      t.mutation(internal.bscTeamCheck.markBscTeamCheckGivenUp, {
        cardChecklistId: cardId,
      }),
    ).resolves.toBe(false);
    expect((await getCard(t, cardId))!.teamCheckDoneAt).toBeUndefined();
  });
});

// ===========================================================================
// NEO-345 — one BSC answer fills the team check's outcome AND the card's
// attributes
// ===========================================================================

/** A card-listing stub that answers with whole JSON bodies. */
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

describe("resolveBscCardTeam — attributes and outcome (NEO-345)", () => {
  test("the attribute label in the team slot: no team, a stale hint cleared, attributes and print run filled", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");
    await t.run(async (ctx) => ctx.db.patch(cardId, { bscTeamName: "AU  SN1" }));
    vi.stubGlobal(
      "fetch",
      makePayloadFetch({ "bsc-1": { teamName: "AU  SN1", playerAttribute: "" } }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
        cardChecklistId: cardId,
      }),
    ).resolves.toBe("answered");

    const card = (await getCard(t, cardId))!;
    expect(card.teamOnCardIds).toBeUndefined();
    expect(card.bscTeamName).toBeUndefined();
    expect(card.teamCheckDoneAt).toBeTypeOf("number");
    expect(card.teamCheckOutcome).toBe("answered");
    expect(card.attributes).toEqual(["AU", "NUM"]);
    expect(card.printRun).toBe(1);
    // No leaf format: AU alone never formats the card.
    expect(card.features?.autographed).toBeUndefined();
    vi.restoreAllMocks();
  });

  test("an AU card under a leaf with an autograph format is formatted and Signed By is seeded", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");
    await t.run(async (ctx) => {
      const leaf = (await ctx.db.get(variantTypeId))!;
      const variant = leaf;
      const setName = (await ctx.db.get(variant.parentId!))!;
      const playerId = await ctx.db.insert("players", {
        name: "Barry Bonds",
        nameNormalized: "barry bonds",
        sportId: setName.parentId!,
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(variantTypeId, {
        features: { autographFormat: "Sticker/Label" },
      });
      await ctx.db.patch(cardId, {
        playerIds: [playerId],
        features: { autographed: "None", shortPrint: "None" },
      });
    });
    vi.stubGlobal(
      "fetch",
      makePayloadFetch({
        "bsc-1": { teamName: "", playerAttribute: "AU, SN25, RC, SP" },
      }),
    );

    await t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
      cardChecklistId: cardId,
    });

    const card = (await getCard(t, cardId))!;
    expect(card.teamCheckOutcome).toBe("answered");
    expect(card.printRun).toBe(25);
    expect(card.isRookie).toBe(true);
    expect(card.attributes).toEqual(["AU", "RC", "SP", "NUM"]);
    expect(card.features).toMatchObject({
      autographed: "Sticker/Label",
      signedBy: "Barry Bonds",
      shortPrint: "SP",
      isRookie: "true",
    });
  });

  test("a card that already has a team still gains its print run, and keeps its team", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const teamId = await seedTeam(t, variantTypeId, {
      location: "Seattle",
      name: "Mariners",
    });
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");
    await t.run(async (ctx) => ctx.db.patch(cardId, { teamOnCardIds: [teamId] }));
    // getForBscTeamCheck says nothing is owed for a card with a team, so the
    // mutation is called directly, as a late queue answer would reach it.
    await t.mutation(internal.cardChecklist.applyBscTeamResolution, {
      cardChecklistId: cardId,
      rawTeamName: "Seattle Mariners",
      teamNames: ["Seattle Mariners"],
      attributeTokens: ["AU", "SN50"],
      printRun: 50,
    });

    const card = (await getCard(t, cardId))!;
    expect(card.teamOnCardIds).toEqual([teamId]);
    expect(card.teamCheckOutcome).toBe("answered");
    expect(card.printRun).toBe(50);
    expect(card.attributes).toEqual(["AU", "NUM"]);
  });

  test("a call without tokens (scheduled before NEO-345) fills nothing", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", "bsc-1");
    const before = (await getCard(t, cardId))!;

    await t.mutation(internal.cardChecklist.applyBscTeamResolution, {
      cardChecklistId: cardId,
      rawTeamName: "",
      teamNames: [],
    });

    const card = (await getCard(t, cardId))!;
    expect(card.attributes).toBeUndefined();
    expect(card.printRun).toBeUndefined();
    expect(card.lastUpdated).toBe(before.lastUpdated);
    expect(card.teamCheckOutcome).toBe("answered");
  });
});
