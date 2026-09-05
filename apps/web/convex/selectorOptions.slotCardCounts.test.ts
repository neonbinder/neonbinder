/**
 * NEO-219 A/B — the two optimistic-concurrency hardenings on the mapping
 * mutations, and the query that feeds them.
 *
 * Covers:
 *  - getSlotCardCounts tallies cards across two slots on both sides
 *  - getSlotCardCounts.total is the ROW's card count, not the sum of the maps
 *  - getSlotCardCounts ignores cards carrying no `src`
 *  - getSlotCardCounts is admin-gated
 *  - detachPlatformId returns orphanedCards for the retired slot
 *  - detachPlatformId accepts a matching acknowledgedCards
 *  - detachPlatformId refuses a stale acknowledgedCards, writing nothing
 *  - detachPlatformId called the OLD way (no acknowledgedCards) still works
 *  - setVariantTypePlatformData refuses a stale baseVersion, writing nothing
 *  - setVariantTypePlatformData accepts a current baseVersion
 *  - setVariantTypePlatformData called the OLD way (no baseVersion) still works
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_neo219_counts",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_neo219_counts",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "normal_user_neo219_counts",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|normal_user_neo219_counts",
  name: "Normal User",
  role: "user",
};

/**
 * A fixed `lastUpdated` so a `baseVersion` assertion reads as a deliberate
 * sentinel rather than a race with the clock.
 */
const SENTINEL_LAST_UPDATED = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedSet(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps Chrome",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL_LAST_UPDATED,
    }),
  );
}

/** A Base variantType holding two BSC slots and two SportLots slots. */
async function seedBaseRow(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      // NEO-239 — the base ROLE. `setVariantTypePlatformData` gates on
      // `metadata.isBase`, not on the row being called "Base", and that
      // structural check runs BEFORE the freshness one.
      metadata: { isBase: true },
      platformData: {
        bsc: { b0: "topps-chrome-series-1", b1: "topps-chrome-series-2" },
        sportlots: { s0: "sl-primary", s1: "sl-extra" },
      },
      platformSlotSeq: { bsc: 2, sportlots: 2 },
      primaryPlatformId: { bsc: "b0", sportlots: "s0" },
      platformLabels: {
        bsc: { b0: "Series 1", b1: "Series 2" },
        sportlots: { s0: "Base Set", s1: "Base Set (2)" },
      },
      parentId,
      children: [],
      lastUpdated: SENTINEL_LAST_UPDATED,
    });
    await ctx.db.patch(parentId, { children: [id] });
    return id;
  });
}

async function seedCard(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  cardNumber: string,
  platformData: {
    bsc?: { ref: string; src?: string };
    sportlots?: { ref: string; src?: string };
  },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      platformData,
      sortOrder: Number(cardNumber),
      lastUpdated: SENTINEL_LAST_UPDATED,
    });
  });
}

// ===========================================================================
// getSlotCardCounts
// ===========================================================================

describe("getSlotCardCounts", () => {
  test("tallies cards per slot on both sides and reports the row total", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);

    // Two cards sourced from b0/s0, one from b1/s1.
    await seedCard(t, rowId, "1", {
      bsc: { ref: "bsc-1", src: "b0" },
      sportlots: { ref: "sl-1", src: "s0" },
    });
    await seedCard(t, rowId, "2", {
      bsc: { ref: "bsc-2", src: "b0" },
      sportlots: { ref: "sl-2", src: "s0" },
    });
    await seedCard(t, rowId, "3", {
      bsc: { ref: "bsc-3", src: "b1" },
      sportlots: { ref: "sl-3", src: "s1" },
    });

    const counts = await asAdmin.query(api.selectorOptions.getSlotCardCounts, {
      selectorOptionId: rowId,
    });

    expect(counts.bsc).toEqual({ b0: 2, b1: 1 });
    expect(counts.sportlots).toEqual({ s0: 2, s1: 1 });
    // NOT 6 — `total` is the row's cards, so the re-map notice can say
    // "3 cards are linked through the current mapping" without double-counting
    // a card that carries a src on both sides.
    expect(counts.total).toBe(3);
  });

  test("counts a card with no src in total but in no slot", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);

    await seedCard(t, rowId, "1", { bsc: { ref: "bsc-1", src: "b0" } });
    // Unattributed ref (pre-NEO-137, or a set nobody attached).
    await seedCard(t, rowId, "2", { bsc: { ref: "bsc-2" } });
    // No platform identity at all (a hand-entered custom card).
    await seedCard(t, rowId, "3", {});

    const counts = await asAdmin.query(api.selectorOptions.getSlotCardCounts, {
      selectorOptionId: rowId,
    });

    expect(counts.bsc).toEqual({ b0: 1 });
    expect(counts.sportlots).toEqual({});
    expect(counts.total).toBe(3);
  });

  test("returns zeros for a row with no cards", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);

    const counts = await asAdmin.query(api.selectorOptions.getSlotCardCounts, {
      selectorOptionId: rowId,
    });

    expect(counts).toEqual({ bsc: {}, sportlots: {}, total: 0 });
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .query(api.selectorOptions.getSlotCardCounts, {
          selectorOptionId: rowId,
        }),
    ).rejects.toThrow(/Admin access required/);
  });
});

// ===========================================================================
// detachPlatformId — orphanedCards + acknowledgedCards
// ===========================================================================

describe("detachPlatformId card accounting", () => {
  test("reports the cards orphaned by retiring the slot", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);
    await seedCard(t, rowId, "1", { bsc: { ref: "bsc-1", src: "b1" } });
    await seedCard(t, rowId, "2", { bsc: { ref: "bsc-2", src: "b1" } });
    await seedCard(t, rowId, "3", { bsc: { ref: "bsc-3", src: "b0" } });

    const result = await asAdmin.mutation(
      api.selectorOptions.detachPlatformId,
      { selectorOptionId: rowId, side: "bsc", slot: "b1" },
    );

    expect(result.success).toBe(true);
    expect(result.orphanedCards).toBe(2);
  });

  test("reports 0 when the slot was never attached", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);

    const result = await asAdmin.mutation(
      api.selectorOptions.detachPlatformId,
      { selectorOptionId: rowId, side: "bsc", slot: "b7" },
    );

    expect(result.success).toBe(true);
    expect(result.orphanedCards).toBe(0);
  });

  test("accepts an acknowledgedCards that still matches", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);
    await seedCard(t, rowId, "1", { sportlots: { ref: "sl-1", src: "s1" } });

    const result = await asAdmin.mutation(
      api.selectorOptions.detachPlatformId,
      {
        selectorOptionId: rowId,
        side: "sportlots",
        slot: "s1",
        acknowledgedCards: 1,
      },
    );

    expect(result.success).toBe(true);
    expect(result.orphanedCards).toBe(1);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.platformData.sportlots).toEqual({ s0: "sl-primary" });
  });

  test("refuses a stale acknowledgedCards with DETACH_COUNT_CHANGED and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);
    // The dialog was opened when the slot held ONE card; two more landed.
    await seedCard(t, rowId, "1", { bsc: { ref: "bsc-1", src: "b1" } });
    await seedCard(t, rowId, "2", { bsc: { ref: "bsc-2", src: "b1" } });
    await seedCard(t, rowId, "3", { bsc: { ref: "bsc-3", src: "b1" } });

    let thrown: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.detachPlatformId, {
        selectorOptionId: rowId,
        side: "bsc",
        slot: "b1",
        acknowledgedCards: 1,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConvexError);
    expect((thrown as ConvexError<{ code: string; cards: number }>).data).toEqual(
      { code: "DETACH_COUNT_CHANGED", cards: 3 },
    );

    // Nothing written: the slot, its label and the row's lastUpdated all stand.
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.platformData.bsc).toEqual({
      b0: "topps-chrome-series-1",
      b1: "topps-chrome-series-2",
    });
    expect(row!.platformLabels?.bsc?.b1).toBe("Series 2");
    expect(row!.lastUpdated).toBe(SENTINEL_LAST_UPDATED);
  });

  test("still detaches when the caller omits acknowledgedCards entirely (old bundle)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);
    await seedCard(t, rowId, "1", { bsc: { ref: "bsc-1", src: "b1" } });

    const result = await asAdmin.mutation(
      api.selectorOptions.detachPlatformId,
      { selectorOptionId: rowId, side: "bsc", slot: "b1" },
    );

    expect(result.success).toBe(true);
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.platformData.bsc).toEqual({ b0: "topps-chrome-series-1" });
  });

  test("primary guard still fires before the count check", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);
    await seedCard(t, rowId, "1", { bsc: { ref: "bsc-1", src: "b0" } });

    await expect(
      asAdmin.mutation(api.selectorOptions.detachPlatformId, {
        selectorOptionId: rowId,
        side: "bsc",
        slot: "b0",
        // Deliberately wrong; the primary refusal must win so the operator
        // hears the structural reason, not "the count moved".
        acknowledgedCards: 99,
      }),
    ).rejects.toThrow(/reconciliation primary/);
  });

  // ===========================================================================
  // Adversarial pass (NEO-219 readiness)
  // ===========================================================================

  test("acknowledgedCards=0 is accepted when the slot genuinely holds no cards", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);
    // b1 is attached but sources no cards.

    const result = await asAdmin.mutation(
      api.selectorOptions.detachPlatformId,
      {
        selectorOptionId: rowId,
        side: "bsc",
        slot: "b1",
        // Falsy but explicit — must be compared, not treated as "no check".
        acknowledgedCards: 0,
      },
    );

    expect(result.success).toBe(true);
    expect(result.orphanedCards).toBe(0);
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.platformData.bsc).toEqual({ b0: "topps-chrome-series-1" });
  });

  test("detaches the primary WITH a matching acknowledgedCards in one call", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);
    await seedCard(t, rowId, "1", { bsc: { ref: "bsc-1", src: "b0" } });
    await seedCard(t, rowId, "2", { bsc: { ref: "bsc-2", src: "b0" } });

    const result = await asAdmin.mutation(
      api.selectorOptions.detachPlatformId,
      {
        selectorOptionId: rowId,
        side: "bsc",
        slot: "b0",
        confirmPrimary: true,
        acknowledgedCards: 2,
      },
    );

    expect(result.success).toBe(true);
    expect(result.orphanedCards).toBe(2);
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    // b0 (primary) is gone; b1 (extra) survives.
    expect(row!.platformData.bsc).toEqual({ b1: "topps-chrome-series-2" });
    // primaryPlatformId.bsc cleared so the `?? current[0]` fallback recomputes.
    expect(row!.primaryPlatformId?.bsc).toBeUndefined();
    expect(row!.primaryPlatformId?.sportlots).toBe("s0");
  });

  test("detaching the primary with a STALE acknowledgedCards still refuses, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);
    await seedCard(t, rowId, "1", { bsc: { ref: "bsc-1", src: "b0" } });
    await seedCard(t, rowId, "2", { bsc: { ref: "bsc-2", src: "b0" } });
    await seedCard(t, rowId, "3", { bsc: { ref: "bsc-3", src: "b0" } });

    let thrown: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.detachPlatformId, {
        selectorOptionId: rowId,
        side: "bsc",
        slot: "b0",
        confirmPrimary: true,
        acknowledgedCards: 2,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConvexError);
    expect((thrown as ConvexError<{ code: string; cards: number }>).data).toEqual(
      { code: "DETACH_COUNT_CHANGED", cards: 3 },
    );
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.platformData.bsc?.b0).toBe("topps-chrome-series-1");
    expect(row!.primaryPlatformId?.bsc).toBe("b0");
  });
});

// ===========================================================================
// setVariantTypePlatformData — baseVersion
// ===========================================================================

describe("setVariantTypePlatformData baseVersion", () => {
  test("refuses a stale baseVersion with BASE_MAPPING_STALE and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);

    let thrown: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: rowId,
        platformData: { bsc: "someone-elses-set" },
        baseVersion: SENTINEL_LAST_UPDATED - 1,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConvexError);
    expect((thrown as ConvexError<{ code: string }>).data).toEqual({
      code: "BASE_MAPPING_STALE",
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    // The primary slot key is REUSED by setPrimarySlotId, so a blind write
    // would have re-pointed every card on b0. It did not run.
    expect(row!.platformData.bsc?.b0).toBe("topps-chrome-series-1");
    expect(row!.lastUpdated).toBe(SENTINEL_LAST_UPDATED);
  });

  test("accepts a baseVersion that matches the row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);

    const result = await asAdmin.mutation(
      api.selectorOptions.setVariantTypePlatformData,
      {
        variantTypeId: rowId,
        platformData: { bsc: "topps-chrome-remapped" },
        baseVersion: SENTINEL_LAST_UPDATED,
      },
    );

    expect(result.success).toBe(true);
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    // Slot REUSE is the documented behaviour — b0 now names the new set.
    expect(row!.platformData.bsc?.b0).toBe("topps-chrome-remapped");
  });

  test("still writes when the caller omits baseVersion entirely (old bundle)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId);

    const result = await asAdmin.mutation(
      api.selectorOptions.setVariantTypePlatformData,
      {
        variantTypeId: rowId,
        platformData: { sportlots: "884412", sportlotsDisplay: "Base Set" },
      },
    );

    expect(result.success).toBe(true);
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.platformData.sportlots?.s0).toBe("884412");
  });

  test("reports the wrong-level refusal before the freshness one", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);

    await expect(
      asAdmin.mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: setId,
        platformData: { bsc: "x" },
        baseVersion: 1,
      }),
    ).rejects.toThrow(/only operates on variantType rows/);
  });

  // ===========================================================================
  // Adversarial pass (NEO-219 readiness) — falsy-value edge cases in the
  // `!== undefined` equality check, which a truthy-style check would get wrong.
  // ===========================================================================

  test("baseVersion=0 accepted against a row whose lastUpdated is genuinely 0", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        metadata: { isBase: true }, // NEO-239 — the role, not the name.
        platformData: {},
        parentId: setId,
        children: [],
        // A falsy-but-defined lastUpdated — the epoch. `!== undefined` must
        // treat this as a real value to compare against, not as "missing".
        lastUpdated: 0,
      }),
    );

    const result = await asAdmin.mutation(
      api.selectorOptions.setVariantTypePlatformData,
      {
        variantTypeId: rowId,
        platformData: { bsc: "some-set" },
        baseVersion: 0,
      },
    );

    expect(result.success).toBe(true);
  });

  test("baseVersion=0 refused as stale against a row with a real (non-zero) lastUpdated", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await seedSet(t);
    const rowId = await seedBaseRow(t, setId); // lastUpdated = SENTINEL_LAST_UPDATED

    let thrown: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: rowId,
        platformData: { bsc: "some-set" },
        // A falsy baseVersion must not be treated as "no check" — only
        // `undefined` means that.
        baseVersion: 0,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConvexError);
    expect((thrown as ConvexError<{ code: string }>).data).toEqual({
      code: "BASE_MAPPING_STALE",
    });
  });
});
