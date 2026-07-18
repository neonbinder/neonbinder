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
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
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

type InsertCardOpts = {
  bsc?: string; // platformData.bsc; omit to simulate "no BSC ref"
  teamOnCardIds?: Array<Id<"teams">>;
  teamCheckDoneAt?: number;
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
      platformData: opts.bsc !== undefined ? { bsc: opts.bsc } : {},
      sortOrder: Number(cardNumber) || 0,
      lastUpdated: Date.now(),
      ...(opts.teamOnCardIds ? { teamOnCardIds: opts.teamOnCardIds } : {}),
      ...(opts.teamCheckDoneAt !== undefined
        ? { teamCheckDoneAt: opts.teamCheckDoneAt }
        : {}),
    }),
  );
}

const getCard = (t: ReturnType<typeof convexTest>, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => ctx.db.get(id));

// ===========================================================================
// getForBscTeamCheck
// ===========================================================================

describe("getForBscTeamCheck", () => {
  test("returns null when the card has no platformData.bsc", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1"); // no bsc

    const result = await t.query(internal.cardChecklist.getForBscTeamCheck, {
      cardChecklistId: cardId,
    });
    expect(result).toBeNull();
  });

  test("needsCheck is true when neither teamOnCardIds nor teamCheckDoneAt is set", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    const result = await t.query(internal.cardChecklist.getForBscTeamCheck, {
      cardChecklistId: cardId,
    });
    expect(result).toEqual({ bscCardId: "bsc-1", needsCheck: true });
  });

  test("needsCheck is false once teamOnCardIds is set", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Yankees",
        nameNormalized: "yankees",
        sport: "Baseball",
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
    const variantTypeId = await seedTree(t);
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
  test("team-found case creates a teams row and sets teamOnCardIds + teamCheckDoneAt", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "New York Yankees" },
    );

    expect(result).toEqual({ applied: true, teamCreated: true });

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toHaveLength(1);
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");

    const teamRow = await t.run(async (ctx) => ctx.db.get(card!.teamOnCardIds![0]));
    expect(teamRow!.name).toBe("New York Yankees");
    expect(teamRow!.sport).toBe("Baseball");
  });

  test("reuses an existing teams row via by_name_normalized_and_sport instead of creating a duplicate", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const existingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Yankees",
        // normalizeTeamName("New York Yankees") token-sorts to this key.
        nameNormalized: "new yankees york",
        sport: "Baseball",
        lastUpdated: Date.now(),
      }),
    );
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "New York Yankees" },
    );

    expect(result).toEqual({ applied: true, teamCreated: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toEqual([existingTeamId]);
  });

  test("no-team-found case (empty string) only sets teamCheckDoneAt", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "" },
    );

    expect(result).toEqual({ applied: false, teamCreated: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });

  test("whitespace-only teamName is treated the same as empty", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "   " },
    );

    expect(result).toEqual({ applied: false, teamCreated: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });

  test("already-resolved row is a no-op and backfills teamCheckDoneAt if missing, without touching teamOnCardIds", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const preexistingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Mets",
        nameNormalized: "mets",
        sport: "Baseball",
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

    expect(result).toEqual({ applied: false, teamCreated: false });
    const card = await getCard(t, cardId);
    // teamOnCardIds is never overwritten with the (bogus) resolution input.
    expect(card!.teamOnCardIds).toEqual([preexistingTeamId]);
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });

  test("already-resolved row with teamCheckDoneAt already set leaves the original timestamp untouched", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const preexistingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Mets",
        nameNormalized: "mets",
        sport: "Baseball",
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

    expect(result).toEqual({ applied: false, teamCreated: false });
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

    expect(result).toEqual({ applied: false, teamCreated: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeUndefined(); // retryable later
  });

  test("row that no longer exists is a safe no-op", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const cardId = await insertCard(t, variantTypeId, "1", { bsc: "bsc-1" });
    await t.run(async (ctx) => ctx.db.delete(cardId));

    const result = await t.mutation(
      internal.cardChecklist.applyBscTeamResolution,
      { cardChecklistId: cardId, teamName: "Some Team" },
    );

    expect(result).toEqual({ applied: false, teamCreated: false });
  });
});

// ===========================================================================
// enqueueBscTeamBackfill
// ===========================================================================

describe("enqueueBscTeamBackfill", () => {
  test("only enqueues rows with platformData.bsc, no teamOnCardIds, and no teamCheckDoneAt", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Yankees",
        nameNormalized: "yankees",
        sport: "Baseball",
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

    // Exactly the one genuinely-eligible row is enqueued; the other three
    // (already-linked, already-checked, no-BSC-ref) are correctly excluded.
    expect(result.enqueued).toBe(1);
    expect(result.remaining).toBe(0);
  });

  test("respects batchSize and reports remaining beyond the batch", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    for (let i = 0; i < 5; i++) {
      await insertCard(t, variantTypeId, String(i + 1), { bsc: `bsc-${i + 1}` });
    }

    const result = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      batchSize: 2,
    });

    expect(result.enqueued).toBe(2);
    expect(result.remaining).toBe(3);
  });

  test("defaults batchSize to 200 when not provided", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    for (let i = 0; i < 3; i++) {
      await insertCard(t, variantTypeId, String(i + 1), { bsc: `bsc-${i + 1}` });
    }

    const result = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {});

    expect(result.enqueued).toBe(3);
    expect(result.remaining).toBe(0);
  });

  test("no eligible rows enqueues nothing", async () => {
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t);
    await insertCard(t, variantTypeId, "1"); // no bsc ref at all

    const result = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      batchSize: 10,
    });

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
    const variantTypeId = await seedTree(t);

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
    expect(first.isDone).toBe(false);
    expect(first.enqueued).toBeGreaterThan(0);

    const second = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      batchSize: TOTAL_ROWS,
      cursor: first.continueCursor,
    });
    // The second call, continuing from the first's cursor, must reach NEW
    // rows the first call's page never scanned — the old bug would return
    // enqueued: 0 here forever (same top-1000 window, already all enqueued).
    expect(second.enqueued).toBeGreaterThan(0);
    expect(second.isDone).toBe(true);

    // Between the two calls, every eligible row was reachable exactly once.
    expect(first.enqueued + second.enqueued).toBe(TOTAL_ROWS);
  });
});
