/**
 * NEO-90: tests for the BSC per-card team-enrichment read/write primitives
 * in `convex/cardChecklist.ts` — `getForBscTeamCheck`, `applyBscTeamResolution`,
 * and `enqueueBscTeamBackfill`. These are the Convex-side building blocks
 * for the chained enrichment queue defined in `convex/adapters/buysportscards.ts`
 * (`resolveBscCardTeam` / `processBscTeamEnrichmentQueue`), which mirrors the
 * existing Wikidata chained-queue pattern (`convex/adapters/wikidata.ts`'s
 * `processEnrichmentQueue`).
 *
 * Fixture pattern follows `convex/teamBackfill.test.ts` (raw sport →
 * setName → variantType tree; teams findOrCreate via
 * `by_name_normalized_and_sport`) since these mutations only ever read a
 * single cardChecklist row + its selectorOption ancestor chain — no need
 * for the full `addCustomSelectorOption`/`commitCardChecklist` mutation
 * chain here (that wiring is covered separately in
 * `convex/featurePropagation.test.ts`).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a minimal sport → setName → variantType tree and return the
 * variantType id (cards attach here). `applyBscTeamResolution` needs the
 * sport ancestor to resolve/create the right `teams` row.
 */
async function seedTree(
  t: ReturnType<typeof convexTest>,
  sportValue = "Baseball",
): Promise<{ variantTypeId: Id<"selectorOptions">; sportId: Id<"selectorOptions"> }> {
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
    return { variantTypeId, sportId };
  });
}

type InsertCardOpts = {
  bsc?: string; // platformData.bsc; omit to simulate "no BSC ref"
  teamOnCardIds?: Array<Id<"teams">>;
  teamCheckDoneAt?: number;
  // NEO-102: an operator confirmed this card carries no team.
  teamNoneConfirmedAt?: number;
};

async function insertCard(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  cardNumber: string,
  opts: InsertCardOpts = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      platformData: opts.bsc !== undefined ? { bsc: { ref: opts.bsc, src: "b0" } } : {},
      sortOrder: Number(cardNumber) || 0,
      lastUpdated: Date.now(),
      ...(opts.teamOnCardIds ? { teamOnCardIds: opts.teamOnCardIds } : {}),
      ...(opts.teamCheckDoneAt !== undefined
        ? { teamCheckDoneAt: opts.teamCheckDoneAt }
        : {}),
      ...(opts.teamNoneConfirmedAt !== undefined
        ? { teamNoneConfirmedAt: opts.teamNoneConfirmedAt }
        : {}),
    }),
  );
}

const getCard = (t: ReturnType<typeof convexTest>, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => ctx.db.get(id));

// ===========================================================================
// getForBscTeamCheck
// ===========================================================================

/**
 * NEO-220 — this file must not reach the network, and must not leave work
 * running past the end of a test.
 *
 * `enqueueBscTeamBackfill` schedules `processBscTeamEnrichmentQueue`, which
 * calls BuySportsCards' PRODUCTION API. Nothing here asserts on that action —
 * these tests cover the Convex-side building blocks (`getForBscTeamCheck`,
 * `applyBscTeamResolution`, `enqueueBscTeamBackfill`) and only ever schedule
 * it as a side effect. Until now that scheduled work escaped past teardown and
 * fired real requests to `api-prod.buysportscards.com`, which is exactly the
 * leak NEO-188's guard exists to catch; it went unattributed because the
 * requests landed after the test that started them had already passed.
 *
 * A THROWING stub rather than a canned 200: the adapter swallows request
 * failures, so "network unavailable" is a state it already handles, and it
 * cannot write anything derived from a payload this file invented. Inventing a
 * response shape is how a stub starts asserting things nobody meant to assert.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(
        `NEO-220: this test file must not reach the network: ${String(url)}`,
      );
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getForBscTeamCheck", () => {
  test("returns null when the card has no platformData.bsc", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1"); // no bsc

    const result = await t.query(internal.cardChecklist.getForBscTeamCheck, {
      cardChecklistId: cardId,
    });
    expect(result).toBeNull();
  });

  test("needsCheck is true when neither teamOnCardIds nor teamCheckDoneAt is set", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    const result = await t.query(internal.cardChecklist.getForBscTeamCheck, {
      cardChecklistId: cardId,
    });
    expect(result).toEqual({ bscCardId: "bsc-1", needsCheck: true });
  });

  test("needsCheck is false once teamOnCardIds is set", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Yankees",
        nameNormalized: "yankees",
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    const cardId = await insertCard(t, variantTypeId, "1", {
      bsc: "bsc-1",
      teamOnCardIds: [teamId],
    });

    const result = await t.query(internal.cardChecklist.getForBscTeamCheck, {
      cardChecklistId: cardId,
    });
    expect(result).toEqual({ bscCardId: "bsc-1", needsCheck: false });
  });

  test("needsCheck is false once teamCheckDoneAt is set, even with empty teamOnCardIds", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", {
      bsc: "bsc-1",
      teamCheckDoneAt: Date.now(),
    });

    const result = await t.query(internal.cardChecklist.getForBscTeamCheck, {
      cardChecklistId: cardId,
    });
    expect(result).toEqual({ bscCardId: "bsc-1", needsCheck: false });
  });
});

// ===========================================================================
// applyBscTeamResolution
// ===========================================================================

describe("applyBscTeamResolution", () => {
  /**
   * NEO-236 — the behaviour this test used to assert is now the bug.
   *
   * It was called "team-found case CREATES a teams row": a background queue,
   * given a string BSC returned, minted a globally-shared `teams` row nobody
   * had reviewed. Creation takes Location + Name from an operator now, and
   * this path has neither, so an unmatched name links nothing and leaves the
   * card for the attention walker.
   */
  test("a team BSC names that we do NOT hold creates nothing and links nothing", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "New York Yankees" },
    );
    // NEO-220: creating a team here runs `resolveDefaultLeagueId` →
    // `findOrCreateLeague`, which schedules a Wikidata enrichment (NEO-240).
    // convex-test runs a scheduled function in the background without waiting
    // for it, so a test that returns while it is still running races the
    // worker teardown and fails the JOB with an EnvironmentTeardownError while
    // every test still reports green. Drained right after the scheduling call,
    // never at end of test: `enqueueBscTeamBackfill` below schedules the BSC
    // network queue, and a later drain would pull that outbound call forward.
    await drainScheduled(t);

    expect(result).toEqual({ applied: false, unmatched: true });

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds ?? []).toEqual([]);
    // NEO-236 security review: BSC's answer is KEPT as a hint. Discarding it
    // left the operator with a teamless card and no idea which team it was
    // meant to carry — `MissingTeamFixer` renders this as "Marketplace says:".
    expect(card!.bscTeamName).toBe("New York Yankees");
    // A hint, NOT a team: `pendingTeamNames` is what
    // `features/cardAttention.ts` reads as the card HAVING a team, so writing
    // it there would take the card out of the missing-team lane this branch
    // exists to leave it in.
    expect(card!.pendingTeamNames ?? []).toEqual([]);
    // Stamped anyway: the lookup HAS been and gone, and leaving it unset would
    // re-enqueue a live BSC request for this card on every backfill pass.
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
    // Nothing was inserted.
    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(0);
  });

  test("links an existing teams row via by_name_normalized_and_sport, including one that is SPLIT", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const existingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        // NEO-236: a split row — location out front, nickname in `name`. The
        // dedup key still keys the WHOLE name, which is what lets BSC's "New
        // York Yankees" resolve onto it.
        name: "Yankees",
        location: "New York",
        // normalizeTeamName("New York Yankees") token-sorts to this key.
        nameNormalized: "new yankees york",
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "New York Yankees" },
    );
    // NEO-220: creating a team here runs `resolveDefaultLeagueId` →
    // `findOrCreateLeague`, which schedules a Wikidata enrichment (NEO-240).
    // convex-test runs a scheduled function in the background without waiting
    // for it, so a test that returns while it is still running races the
    // worker teardown and fails the JOB with an EnvironmentTeardownError while
    // every test still reports green. Drained right after the scheduling call,
    // never at end of test: `enqueueBscTeamBackfill` below schedules the BSC
    // network queue, and a later drain would pull that outbound call forward.
    await drainScheduled(t);

    expect(result).toEqual({ applied: true, unmatched: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toEqual([existingTeamId]);
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
    // NEO-236: a matched card carries no hint — the question is answered, and
    // a leftover "Marketplace says: …" beside a real team reads as a
    // disagreement rather than as history.
    expect(card!.bscTeamName).toBeUndefined();
  });

  test("a later match CLEARS a hint left by an earlier miss", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    // First pass: no such team yet, so the string is parked as a hint.
    await t.mutation(internal.cardChecklist.applyBscTeamResolution, {
      cardChecklistId: cardId,
      teamName: "New York Yankees",
    });
    expect((await getCard(t, cardId))!.bscTeamName).toBe("New York Yankees");

    // The operator reads the hint and creates the team as Location + Name.
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Yankees",
        location: "New York",
        nameNormalized: "new yankees york",
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    // A re-run now links it, and the hint goes with the question.
    await t.run(async (ctx) =>
      ctx.db.patch(cardId, { teamCheckDoneAt: undefined }),
    );
    await t.mutation(internal.cardChecklist.applyBscTeamResolution, {
      cardChecklistId: cardId,
      teamName: "New York Yankees",
    });

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toEqual([teamId]);
    expect(card!.bscTeamName).toBeUndefined();
  });

  test("an absurdly long marketplace string is truncated, not stored whole", async () => {
    // A third party's string reaching an admin screen. Truncated rather than
    // refused: unlike a stored team name this is only a hint, and dropping the
    // whole hint because it was long helps nobody.
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    await t.mutation(internal.cardChecklist.applyBscTeamResolution, {
      cardChecklistId: cardId,
      teamName: "Y".repeat(500),
    });

    const card = await getCard(t, cardId);
    expect(card!.bscTeamName).toHaveLength(120);
  });

  test("no-team-found case (empty string) only sets teamCheckDoneAt", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "" },
    );
    // NEO-220: creating a team here runs `resolveDefaultLeagueId` →
    // `findOrCreateLeague`, which schedules a Wikidata enrichment (NEO-240).
    // convex-test runs a scheduled function in the background without waiting
    // for it, so a test that returns while it is still running races the
    // worker teardown and fails the JOB with an EnvironmentTeardownError while
    // every test still reports green. Drained right after the scheduling call,
    // never at end of test: `enqueueBscTeamBackfill` below schedules the BSC
    // network queue, and a later drain would pull that outbound call forward.
    await drainScheduled(t);

    expect(result).toEqual({ applied: false, unmatched: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });

  test("whitespace-only teamName is treated the same as empty", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "   " },
    );
    // NEO-220: creating a team here runs `resolveDefaultLeagueId` →
    // `findOrCreateLeague`, which schedules a Wikidata enrichment (NEO-240).
    // convex-test runs a scheduled function in the background without waiting
    // for it, so a test that returns while it is still running races the
    // worker teardown and fails the JOB with an EnvironmentTeardownError while
    // every test still reports green. Drained right after the scheduling call,
    // never at end of test: `enqueueBscTeamBackfill` below schedules the BSC
    // network queue, and a later drain would pull that outbound call forward.
    await drainScheduled(t);

    expect(result).toEqual({ applied: false, unmatched: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });

  test("already-resolved row is a no-op and backfills teamCheckDoneAt if missing, without touching teamOnCardIds", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const preexistingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Mets",
        nameNormalized: "mets",
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    // teamOnCardIds already set, teamCheckDoneAt NOT yet set (e.g. resolved
    // via a different path, like commitCardChecklist's own team resolution).
    const cardId = await insertCard(t, variantTypeId, "1", {
      bsc: "bsc-1",
      teamOnCardIds: [preexistingTeamId],
    });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "Some Other Team" },
    );
    // NEO-220: creating a team here runs `resolveDefaultLeagueId` →
    // `findOrCreateLeague`, which schedules a Wikidata enrichment (NEO-240).
    // convex-test runs a scheduled function in the background without waiting
    // for it, so a test that returns while it is still running races the
    // worker teardown and fails the JOB with an EnvironmentTeardownError while
    // every test still reports green. Drained right after the scheduling call,
    // never at end of test: `enqueueBscTeamBackfill` below schedules the BSC
    // network queue, and a later drain would pull that outbound call forward.
    await drainScheduled(t);

    expect(result).toEqual({ applied: false, unmatched: false });
    const card = await getCard(t, cardId);
    // teamOnCardIds is never overwritten with the (bogus) resolution input.
    expect(card!.teamOnCardIds).toEqual([preexistingTeamId]);
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });

  test("already-resolved row with teamCheckDoneAt already set leaves the original timestamp untouched", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const preexistingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Mets",
        nameNormalized: "mets",
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    const originalTimestamp = 1_700_000_000_000;
    const cardId = await insertCard(t, variantTypeId, "1", {
      bsc: "bsc-1",
      teamOnCardIds: [preexistingTeamId],
      teamCheckDoneAt: originalTimestamp,
    });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "Some Other Team" },
    );
    // NEO-220: creating a team here runs `resolveDefaultLeagueId` →
    // `findOrCreateLeague`, which schedules a Wikidata enrichment (NEO-240).
    // convex-test runs a scheduled function in the background without waiting
    // for it, so a test that returns while it is still running races the
    // worker teardown and fails the JOB with an EnvironmentTeardownError while
    // every test still reports green. Drained right after the scheduling call,
    // never at end of test: `enqueueBscTeamBackfill` below schedules the BSC
    // network queue, and a later drain would pull that outbound call forward.
    await drainScheduled(t);

    expect(result).toEqual({ applied: false, unmatched: false });
    const card = await getCard(t, cardId);
    expect(card!.teamCheckDoneAt).toBe(originalTimestamp); // not clobbered with Date.now()
  });

  test("missing sport ancestor does NOT set teamCheckDoneAt, so it can be retried later", async () => {
    const t = convexTest(schema, modules);
    // Orphaned selectorOption — no sport ancestor in its parent chain.
    const orphanedOptId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Orphaned set",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const cardId = await insertCard(t, orphanedOptId, "1", { bsc: "bsc-1" });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "Some Team" },
    );
    // NEO-220: creating a team here runs `resolveDefaultLeagueId` →
    // `findOrCreateLeague`, which schedules a Wikidata enrichment (NEO-240).
    // convex-test runs a scheduled function in the background without waiting
    // for it, so a test that returns while it is still running races the
    // worker teardown and fails the JOB with an EnvironmentTeardownError while
    // every test still reports green. Drained right after the scheduling call,
    // never at end of test: `enqueueBscTeamBackfill` below schedules the BSC
    // network queue, and a later drain would pull that outbound call forward.
    await drainScheduled(t);

    expect(result).toEqual({ applied: false, unmatched: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeUndefined(); // retryable later
  });

  test("row that no longer exists is a safe no-op", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });
    await t.run(async (ctx) => ctx.db.delete(cardId));

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "Some Team" },
    );
    // NEO-220: creating a team here runs `resolveDefaultLeagueId` →
    // `findOrCreateLeague`, which schedules a Wikidata enrichment (NEO-240).
    // convex-test runs a scheduled function in the background without waiting
    // for it, so a test that returns while it is still running races the
    // worker teardown and fails the JOB with an EnvironmentTeardownError while
    // every test still reports green. Drained right after the scheduling call,
    // never at end of test: `enqueueBscTeamBackfill` below schedules the BSC
    // network queue, and a later drain would pull that outbound call forward.
    await drainScheduled(t);

    expect(result).toEqual({ applied: false, unmatched: false });
  });
});

// ===========================================================================
// enqueueBscTeamBackfill
// ===========================================================================

describe("enqueueBscTeamBackfill", () => {
  test("only enqueues rows with platformData.bsc, no teamOnCardIds, and no teamCheckDoneAt", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Yankees",
        nameNormalized: "yankees",
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" }); // eligible
    await insertCard(t, variantTypeId, "2", { bsc: "bsc-2", teamOnCardIds: [teamId] }); // excluded: already linked
    await insertCard(t, variantTypeId, "3", { bsc: "bsc-3", teamCheckDoneAt: Date.now() }); // excluded: already checked
    await insertCard(t, variantTypeId, "4"); // excluded: no BSC ref

    const result = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      batchSize: 10,
    });
    // Settle the BSC queue this schedules. Safe to drain now that `fetch` is
    // stubbed to throw (see the beforeEach above): the action fails harmlessly
    // inside the test instead of firing a real request after teardown.
    await drainScheduled(t);

    // Exactly the one genuinely-eligible row is enqueued; the other three
    // (already-linked, already-checked, no-BSC-ref) are correctly excluded.
    expect(result.enqueued).toBe(1);
    expect(result.remaining).toBe(0);
  });

  test("respects batchSize and reports remaining beyond the batch", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    for (let i = 0; i < 5; i++) {
      await insertCard(t, variantTypeId, String(i + 1), { bsc: `bsc-${i + 1}` });
    }

    const result = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      batchSize: 2,
    });
    // Settle the BSC queue this schedules. Safe to drain now that `fetch` is
    // stubbed to throw (see the beforeEach above): the action fails harmlessly
    // inside the test instead of firing a real request after teardown.
    await drainScheduled(t);

    expect(result.enqueued).toBe(2);
    expect(result.remaining).toBe(3);
  });

  test("defaults batchSize to 200 when not provided", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    for (let i = 0; i < 3; i++) {
      await insertCard(t, variantTypeId, String(i + 1), { bsc: `bsc-${i + 1}` });
    }

    const result = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {});
    // Settle the BSC queue this schedules. Safe to drain now that `fetch` is
    // stubbed to throw (see the beforeEach above): the action fails harmlessly
    // inside the test instead of firing a real request after teardown.
    await drainScheduled(t);

    expect(result.enqueued).toBe(3);
    expect(result.remaining).toBe(0);
  });

  test("no eligible rows enqueues nothing", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    await insertCard(t, variantTypeId, "1"); // no bsc ref at all

    const result = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      batchSize: 10,
    });
    // Settle the BSC queue this schedules. Safe to drain now that `fetch` is
    // stubbed to throw (see the beforeEach above): the action fails harmlessly
    // inside the test instead of firing a real request after teardown.
    await drainScheduled(t);

    expect(result.enqueued).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.isDone).toBe(true);
    expect(typeof result.continueCursor).toBe("string");
    expect(result.estimatedDrainMs).toBe(0);
  });

  // Regression test for a real bug found in production use: the original
  // implementation used `.take(1000)` with no cursor, re-scanning the exact
  // same window on every call. Once the table grew past 1000 rows, a page
  // boundary could land in the middle of a single batch insert (many cards
  // committed by one commitCardChecklist call share near-identical
  // `_creationTime`s), permanently stranding whichever rows fell just past
  // the cutoff — no rerun could ever reach them. Cursor-based `.paginate()`
  // fixes this by actually advancing through the whole table.
  test("advances past the first page via cursor instead of re-scanning it forever", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);

    // Seed more than one page's worth of eligible rows (PAGE_SIZE is 1000
    // internally) so a single call can't possibly enqueue them all — the
    // old bug would leave the un-enqueued tail unreachable on every future
    // call too, not just this one.
    const TOTAL_ROWS = 1200;
    for (let i = 0; i < TOTAL_ROWS; i++) {
      await insertCard(t, variantTypeId, String(i + 1), { bsc: `bsc-${i + 1}` });
    }

    const first = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      batchSize: TOTAL_ROWS, // no artificial per-page cap — isolate the cursor behavior
    });
    // Settle the BSC queue this schedules. Safe to drain now that `fetch` is
    // stubbed to throw (see the beforeEach above): the action fails harmlessly
    // inside the test instead of firing a real request after teardown.
    await drainScheduled(t);
    expect(first.isDone).toBe(false);
    expect(first.enqueued).toBeGreaterThan(0);

    const second = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      batchSize: TOTAL_ROWS,
      cursor: first.continueCursor,
    });
    // Settle the BSC queue this schedules. Safe to drain now that `fetch` is
    // stubbed to throw (see the beforeEach above): the action fails harmlessly
    // inside the test instead of firing a real request after teardown.
    await drainScheduled(t);
    // The second call, continuing from the first's cursor, must reach NEW
    // rows the first call's page never scanned — the old bug would return
    // enqueued: 0 here forever (same top-1000 window, already all enqueued).
    expect(second.enqueued).toBeGreaterThan(0);
    expect(second.isDone).toBe(true);

    // Between the two calls, every eligible row was reachable exactly once.
    expect(first.enqueued + second.enqueued).toBe(TOTAL_ROWS);
  });
});

// ===========================================================================
// NEO-102 — the BSC background writer never overturns an operator's
// "this card carries no team"
// ===========================================================================

/**
 * `teamCheckDoneAt` and `teamNoneConfirmedAt` are different facts, and every
 * path that used to read "empty teamOnCardIds" as "not looked up yet" now has
 * to say which one it means. These three are that path's whole surface: the
 * read that decides whether to spend a live BSC request, the write that
 * applies the answer, and the backfill scan that finds legacy rows.
 *
 * The write-time check is the load-bearing one. The queue walks a whole set at
 * one request every 300ms while the operator works the same checklist, so a
 * confirmation can land after a card was enqueued and before its answer comes
 * back. An enqueue-time filter alone would be checked minutes too early.
 */
describe("NEO-102: teamNoneConfirmedAt suppresses BSC team enrichment", () => {
  test("getForBscTeamCheck: needsCheck is false for a none-confirmed card", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", {
      bsc: "bsc-1",
      // Deliberately WITHOUT teamCheckDoneAt: the confirmation alone has to
      // be enough, or a card confirmed before any lookup ran would still
      // burn a request.
      teamNoneConfirmedAt: 1_700_000_000_000,
    });

    const result = await t.query(internal.cardChecklist.getForBscTeamCheck, {
      cardChecklistId: cardId,
    });
    expect(result).toEqual({ bscCardId: "bsc-1", needsCheck: false });
  });

  test("applyBscTeamResolution: a found team is NOT written over a none-confirmed card", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", {
      bsc: "bsc-1",
      teamNoneConfirmedAt: 1_700_000_000_000,
    });

    // The in-flight case: this card was enqueued before the operator
    // confirmed, and BSC has since answered with a real team.
    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "New York Yankees" },
    );
    // NEO-220: creating a team here runs `resolveDefaultLeagueId` →
    // `findOrCreateLeague`, which schedules a Wikidata enrichment (NEO-240).
    // convex-test runs a scheduled function in the background without waiting
    // for it, so a test that returns while it is still running races the
    // worker teardown and fails the JOB with an EnvironmentTeardownError while
    // every test still reports green. Drained right after the scheduling call,
    // never at end of test: `enqueueBscTeamBackfill` below schedules the BSC
    // network queue, and a later drain would pull that outbound call forward.
    await drainScheduled(t);
    expect(result).toEqual({ applied: false, unmatched: false });

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamNoneConfirmedAt).toBe(1_700_000_000_000);
    // Stamped on the way out, mirroring the has-teams early return: the
    // lookup HAS now been and gone, which also takes the row out of the
    // backfill scan.
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");

    // And no team row was minted as a side effect.
    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(0);
  });

  test("applyBscTeamResolution: an already-stamped none-confirmed card is left completely alone", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", {
      bsc: "bsc-1",
      teamCheckDoneAt: 1_600_000_000_000,
      teamNoneConfirmedAt: 1_700_000_000_000,
    });

    await t.mutation(internal.cardChecklist.applyBscTeamResolution, {
      cardChecklistId: cardId,
      teamName: "New York Yankees",
    });

    const card = await getCard(t, cardId);
    // Not re-stamped: in Convex a patch invalidates every query that read the
    // row, so a pointless write re-renders the checklist for nothing.
    expect(card!.teamCheckDoneAt).toBe(1_600_000_000_000);
    expect(card!.teamOnCardIds).toBeUndefined();
  });

  test("enqueueBscTeamBackfill: a none-confirmed card is not eligible", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });
    await insertCard(t, variantTypeId, "2", {
      bsc: "bsc-2",
      teamNoneConfirmedAt: 1_700_000_000_000,
    });

    const result = await t.mutation(
      internal.cardChecklist.enqueueBscTeamBackfill,
      { batchSize: 10 },
    );
    // Settle the BSC queue this schedules. Safe to drain now that `fetch` is
    // stubbed to throw (see the beforeEach above): the action fails harmlessly
    // inside the test instead of firing a real request after teardown.
    await drainScheduled(t);
    // NEO-220: creating a team here runs `resolveDefaultLeagueId` →
    // `findOrCreateLeague`, which schedules a Wikidata enrichment (NEO-240).
    // convex-test runs a scheduled function in the background without waiting
    // for it, so a test that returns while it is still running races the
    // worker teardown and fails the JOB with an EnvironmentTeardownError while
    // every test still reports green. Drained right after the scheduling call,
    // never at end of test: `enqueueBscTeamBackfill` below schedules the BSC
    // network queue, and a later drain would pull that outbound call forward.
    await drainScheduled(t);

    // Only card #1. The confirmed one is settled, so re-deriving its team is
    // work whose best outcome is a no-op and whose worst is a contradiction.
    expect(result.enqueued).toBe(1);
    expect(result.remaining).toBe(0);
  });
});
