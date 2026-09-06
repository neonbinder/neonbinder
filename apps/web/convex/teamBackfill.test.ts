/**
 * NEO-26 Stage 4: backfill `cardChecklist.team` (legacy free-text) into
 * `cardChecklist.teamOnCardIds[]` (structured entity link).
 *
 * Test matrix:
 *  - Happy path: row with `team` set + no teamOnCardIds → new teams
 *    row created (when no name match exists) → row patched.
 *  - Idempotent: re-run on the same DB processes zero rows.
 *  - Re-uses existing teams row when name+sport already matches.
 *  - Skips ambiguous rows (no sport ancestor) — counts surface up.
 *  - Honors batchSize cap: large queues drain via repeated runs.
 *  - Already-migrated rows (teamOnCardIds set, leftover team string)
 *    get the string cleared without creating a duplicate team.
 *
 * NOTE: every cardChecklist insert below uses `as any` because the
 * schema removed the `team` column in this same PR. The runtime
 * DB layer still tolerates the extra field on a patch (Convex
 * patches are merge-shaped, not replace-shaped), which is exactly
 * the migration we're testing.
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
 * variantType id (cards attach here). Backfill needs the sport
 * ancestor to know which teams.sport to use for the lookup.
 */
async function seedTree(
  t: ReturnType<typeof convexTest>,
  sportValue = "Baseball",
): Promise<{ variantTypeId: Id<"selectorOptions">; sportId: Id<"selectorOptions"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: sportValue,
      platformData: { bsc: { b0: "bsc-baseball" }, sportlots: { s0: "sl-baseball" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: { bsc: { b0: "x" }, sportlots: { s0: "y" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: { b0: "x" }, sportlots: { s0: "y" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    return { variantTypeId, sportId };
  });
}

/**
 * Insert a cardChecklist row with the legacy `team` string set. Returns
 * the new card id. Uses `as any` since the schema-side `team` field
 * was removed in this PR — convex-test's schema validator would
 * otherwise reject the field.
 */
async function insertLegacyCard(
  t: ReturnType<typeof convexTest>,
  variantTypeId: Id<"selectorOptions">,
  team: string,
  cardNumber: string,
  opts?: { teamOnCardIds?: Array<Id<"teams">> },
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) => {
    return ctx.db.insert("cardChecklist", {
      selectorOptionId: variantTypeId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      // Legacy field — only present on pre-NEO-26 rows. `as any`
      // bypasses the schema validator that would otherwise reject it.
      team,
      platformData: {},
      sortOrder: Number(cardNumber),
      lastUpdated: Date.now(),
      ...(opts?.teamOnCardIds ? { teamOnCardIds: opts.teamOnCardIds } : {}),
    } as any);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfillTeamToOnCardIds", () => {
  /**
   * NEO-236 — the migration LINKS; it no longer creates.
   *
   * This test used to be "happy path: creates a teams row". A one-shot
   * migration inserting a globally-shared `teams` row per unrecognised
   * marketplace string is exactly the creation-without-an-operator NEO-236
   * closes: creation takes Location + Name, and a legacy `team` column has
   * neither. An unmatched row keeps BOTH its string and its empty link, so
   * nothing is lost and a rerun picks it up once the team exists.
   */
  test("a legacy string naming a team we do not hold is left completely alone", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const cardId = await insertLegacyCard(t, variantTypeId, "New York Yankees", "1");

    const result = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 10 },
    );

    expect(result.processed).toBe(1);
    expect(result.unmatched).toBe(1);
    expect(result.skippedAmbiguous).toBe(0);

    const patched = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(patched!.teamOnCardIds ?? []).toEqual([]);
    // The string SURVIVES: it is the only record of what the marketplace
    // claimed, and the operator needs it to create the right team.
    expect((patched as any).team).toBe("New York Yankees");

    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(0);
  });

  test("idempotent: re-run on already-migrated rows reports zero processed", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Red Sox",
        location: "Boston",
        nameNormalized: "boston red sox",
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    await insertLegacyCard(t, variantTypeId, "Boston Red Sox", "1");

    // First run drains.
    const first = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 10 },
    );
    expect(first.processed).toBe(1);
    expect(first.unmatched).toBe(0);

    // Second run finds nothing.
    const second = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 10 },
    );
    expect(second.processed).toBe(0);
    expect(second.unmatched).toBe(0);
    expect(second.remaining).toBe(0);
  });

  test("links an existing teams row when name + sport already matches, split or not", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);

    // NEO-236: a SPLIT row. `nameNormalized` matches the token-sorted output
    // of `normalizeTeamName("New York Yankees")` = ["new", "york",
    // "yankees"].sort() → "new yankees york", which is precisely why moving
    // "New York" into `location` cannot make the legacy string stop matching.
    const existingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Yankees",
        location: "New York",
        nameNormalized: "new yankees york",
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    const cardId = await insertLegacyCard(t, variantTypeId, "New York Yankees", "1");

    const result = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 10 },
    );

    expect(result.unmatched).toBe(0);
    expect(result.processed).toBe(1);

    const patched = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(patched!.teamOnCardIds).toEqual([existingTeamId]);
    // Linked, so the legacy string is cleared in the same patch.
    expect((patched as any).team).toBeUndefined();
  });

  test("skips rows with no sport ancestor (ambiguous data)", async () => {
    const t = convexTest(schema, modules);
    // Insert an orphaned selectorOption — no sport ancestor.
    const orphanedOptId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Orphaned set",
        platformData: { bsc: { b0: "x" } },
      platformSlotSeq: { bsc: 1 },
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: orphanedOptId,
        cardNumber: "1",
        cardName: "Orphan",
        team: "Some Team",
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      } as any),
    );

    const result = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 10 },
    );

    expect(result.skippedAmbiguous).toBe(1);
    expect(result.unmatched).toBe(0);
  });

  test("batchSize caps the work per invocation; re-run drains the queue", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, sportId } = await seedTree(t);
    // Insert 5 rows; cap to 2 per batch. NEO-236: every one names a team we
    // ALREADY hold, because only a linked row gets its legacy string cleared
    // and so stops being eligible — an unmatched row deliberately stays put,
    // which is the case the test below covers.
    for (let i = 0; i < 5; i++) {
      await t.run(async (ctx) =>
        ctx.db.insert("teams", {
          name: `Team ${i}`,
          nameNormalized: `${i} team`,
          sportId,
          lastUpdated: Date.now(),
        }),
      );
      await insertLegacyCard(t, variantTypeId, `Team ${i}`, String(i + 1));
    }

    const first = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 2 },
    );
    expect(first.processed).toBe(2);
    expect(first.remaining).toBe(3);

    const second = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 2 },
    );
    expect(second.processed).toBe(2);
    expect(second.remaining).toBe(1);

    const third = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 2 },
    );
    expect(third.processed).toBe(1);
    expect(third.remaining).toBe(0);
  });

  /**
   * NEO-236 — the migration no longer converges to zero, and that is the
   * intended shape rather than a leak.
   *
   * An unmatched row keeps its legacy string, so it stays eligible on every
   * pass. The old exit condition ("rerun until `processed === 0`") would spin
   * forever on it. `unmatched` is what tells the operator to stop: a pass
   * where `processed === unmatched` has migrated everything it can, and the
   * rest needs the teams to be created first.
   */
  test("unmatched rows stay eligible on every pass — the operator's exit signal is processed === unmatched", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    await insertLegacyCard(t, variantTypeId, "Nobody's Team", "1");

    const first = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 10 },
    );
    expect(first).toMatchObject({ processed: 1, unmatched: 1, remaining: 0 });

    const second = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 10 },
    );
    expect(second).toMatchObject({ processed: 1, unmatched: 1 });
  });

  test("already-linked rows just have the leftover string cleared", async () => {
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

    const cardId = await insertLegacyCard(
      t,
      variantTypeId,
      "Some Old String", // Legacy string that conflicts with the link
      "1",
      { teamOnCardIds: [preexistingTeamId] },
    );

    const result = await t.mutation(
      internal.cardChecklist.backfillTeamToOnCardIds,
      { batchSize: 10 },
    );

    expect(result.unmatched).toBe(0);
    // The legacy string was cleared without touching the link.
    const patched = await t.run(async (ctx) => ctx.db.get(cardId));
    expect((patched as any).team).toBeUndefined();
    expect(patched!.teamOnCardIds).toEqual([preexistingTeamId]);
    // The patch counts as one processed row.
    expect(result.processed).toBe(1);
  });
});
