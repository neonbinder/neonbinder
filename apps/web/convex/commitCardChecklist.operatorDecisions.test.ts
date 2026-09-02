/**
 * NEO-203 — the operator-decision surface of a re-sync: `applyFields` +
 * `baseVersion` content gating, `operatorDeleteIds` guards, cross-side ref
 * conflicts, and ref collisions.
 *
 * See the note on `commitCardChecklistChunk` and `resolveExistingIds` in
 * convex/selectorOptions.ts for the rules this file pins. Fixture
 * conventions mirror `commitCardChecklist.duplicateNumbers.test.ts` and
 * `commitCardChecklist.resync.test.ts` — admin identity, schema, modules
 * glob.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { MAX_OPERATOR_DELETE_IDS } from "./selectorOptions";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_opdec_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_opdec_001",
  name: "Admin User",
  role: "admin",
};

async function seedTree(
  t: ReturnType<typeof convexTest>,
): Promise<{ sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Test Set",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

/** One reconciled card as the commit wire carries it. */
function card(opts: {
  cardNumber: string;
  cardName: string;
  bscRef?: string;
  slRef?: string;
  applyFields?: string[];
  baseVersion?: number;
  printRun?: number;
  attributes?: string[];
  isVariation?: boolean;
  cardVariation?: string;
}) {
  const platformData: {
    bsc?: { ref: string };
    sportlots?: { ref: string };
  } = {};
  if (opts.bscRef !== undefined) platformData.bsc = { ref: opts.bscRef };
  if (opts.slRef !== undefined) platformData.sportlots = { ref: opts.slRef };
  return {
    cardNumber: opts.cardNumber,
    cardName: opts.cardName,
    team: undefined,
    teams: [],
    players: [],
    // No `?? []` fallback: an unset `attributes` must stay undefined on
    // insert so the applyFields re-diff test can pin the un-set baseline.
    attributes: opts.attributes,
    isRookie: undefined,
    isRelic: undefined,
    printRun: opts.printRun,
    autographType: undefined,
    cardVariation: opts.cardVariation,
    isVariation: opts.isVariation,
    platformData,
    applyFields: opts.applyFields,
    baseVersion: opts.baseVersion,
  };
}

async function storedRows(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", selectorOptionId),
      )
      .collect(),
  );
}

// ---------------------------------------------------------------------------
// Case 6 — applyFields server-side re-diff.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — applyFields server-side re-diff", () => {
  test("only named-and-different fields are patched; named-but-equal and differing-but-unnamed fields are left alone", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", cardName: "Original", bscRef: "R1", printRun: 99 })],
    });
    const before = (await storedRows(t, leafId))[0];
    // No attributes were ever written — `[]` and `undefined` are the same
    // statement per `sameContentValue`, so this pins the un-set baseline.
    expect(before.attributes).toBeUndefined();

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({
          cardNumber: "1",
          cardName: "Corrected", // named AND differs -> applied
          bscRef: "R1",
          printRun: 25, // differs but NOT named -> untouched
          attributes: [], // named but semantically EQUAL to undefined -> untouched
          applyFields: ["cardName", "attributes"],
          baseVersion: before.lastUpdated,
        }),
      ],
    });

    const after = (await storedRows(t, leafId))[0];
    expect(after.cardName).toBe("Corrected");
    expect(after.printRun).toBe(99);
    // If the server had trusted `applyFields` without re-diffing, this would
    // now be `[]` instead of staying undefined.
    expect(after.attributes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Case 7 — a stale baseVersion applies NO content and is counted.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — stale baseVersion", () => {
  test("a decision made against a row that has since moved applies no content and is counted in staleDecisions", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", cardName: "Original", bscRef: "R1" })],
    });
    const v1 = (await storedRows(t, leafId))[0];

    // Simulate the row moving between the operator seeing the diff and this
    // commit running — a concurrent edit, or just time passing.
    await t.run(async (ctx) => {
      await ctx.db.patch(v1._id, { lastUpdated: v1.lastUpdated + 1000 });
    });

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({
          cardNumber: "1",
          cardName: "Late Correction",
          bscRef: "R1",
          applyFields: ["cardName"],
          baseVersion: v1.lastUpdated, // now stale
        }),
      ],
    });

    expect(result.staleDecisions).toBe(1);
    const after = (await storedRows(t, leafId))[0];
    expect(after.cardName).toBe("Original");
  });
});

// ---------------------------------------------------------------------------
// Case 9 — operatorDeleteIds guards.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — operatorDeleteIds guards", () => {
  test("9a: an id from a DIFFERENT selectorOption is skipped, not deleted", async () => {
    const t = convexTest(schema, modules);
    const treeA = await seedTree(t);
    const treeB = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: treeB.leafId,
      sportId: treeB.sportId,
      cards: [card({ cardNumber: "1", cardName: "Foreign Card", bscRef: "F1" })],
    });
    const foreignId = (await storedRows(t, treeB.leafId))[0]._id;

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: treeA.leafId,
      sportId: treeA.sportId,
      cards: [card({ cardNumber: "1", cardName: "Home Card", bscRef: "H1" })],
      operatorDeleteIds: [foreignId],
    });

    expect(result.operatorDeleted).toBe(0);
    expect(await storedRows(t, treeB.leafId)).toHaveLength(1);
  });

  test("9b: an id that came back in THIS sync is refused, not deleted", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", cardName: "Still Here", bscRef: "R1" })],
    });
    const rowId = (await storedRows(t, leafId))[0]._id;

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", cardName: "Still Here", bscRef: "R1" })],
      operatorDeleteIds: [rowId],
    });

    expect(result.operatorDeleted).toBe(0);
    const rows = await storedRows(t, leafId);
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(rowId);
  });

  test("9c: an isCustom row is refused, not deleted", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const customId = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: leafId,
        cardNumber: "9001",
        cardName: "Custom Card",
        isCustom: true,
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", cardName: "Marketplace Card", bscRef: "R1" })],
      operatorDeleteIds: [customId],
    });

    expect(result.operatorDeleted).toBe(0);
    const rows = await storedRows(t, leafId);
    expect(rows.some((r) => r._id === customId)).toBe(true);
  });

  test("9d: a legitimate delete cascades cross-listings and orphans variation children", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", cardName: "Parent", bscRef: "P1" }),
        card({
          cardNumber: "1b",
          cardName: "Parent",
          bscRef: "C1",
          isVariation: true,
          cardVariation: "Action",
        }),
      ],
    });
    const rows = await storedRows(t, leafId);
    const parent = rows.find((r) => r.platformData?.bsc?.ref === "P1")!;
    const child = rows.find((r) => r.platformData?.bsc?.ref === "C1")!;
    expect(child.variationOfCardId).toBe(parent._id);

    const otherTree = await seedTree(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("cardCrossListings", {
        cardChecklistId: parent._id,
        selectorOptionId: otherTree.leafId,
        lastUpdated: Date.now(),
      });
    });

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      // Neither the parent nor the child is resent — only the delete request
      // targets the parent.
      cards: [card({ cardNumber: "99", cardName: "Unrelated", bscRef: "U1" })],
      operatorDeleteIds: [parent._id],
    });

    expect(result.operatorDeleted).toBe(1);
    const after = await storedRows(t, leafId);
    expect(after.some((r) => r._id === parent._id)).toBe(false);
    const survivingChild = after.find((r) => r._id === child._id);
    expect(survivingChild).toBeDefined();
    expect(survivingChild!.variationOfCardId).toBeUndefined();

    const crossListings = await t.run(async (ctx) =>
      ctx.db
        .query("cardCrossListings")
        .withIndex("by_card", (q) => q.eq("cardChecklistId", parent._id))
        .collect(),
    );
    expect(crossListings).toHaveLength(0);
  });

  test("9e: more than MAX_OPERATOR_DELETE_IDS ids is rejected before anything writes", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", cardName: "Existing", bscRef: "R1" })],
    });
    const existingId = (await storedRows(t, leafId))[0]._id;
    const tooMany = Array.from({ length: MAX_OPERATOR_DELETE_IDS + 1 }, () => existingId);

    await expect(
      t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ cardNumber: "2", cardName: "Should Not Be Written", bscRef: "R2" })],
        operatorDeleteIds: tooMany,
      }),
    ).rejects.toThrow(/exceeds the \d+ limit/);

    const rows = await storedRows(t, leafId);
    expect(rows).toHaveLength(1); // unchanged — nothing from the rejected call landed
  });
});

// ---------------------------------------------------------------------------
// Case 10 — cross-side ref conflicts.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — cross-side ref conflicts", () => {
  test("a card whose two refs point at different rows is excluded, reported, and neither row is touched", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "10", cardName: "Row A (bsc only)", bscRef: "bscA" }),
        card({ cardNumber: "20", cardName: "Row B (sl only)", slRef: "slB" }),
      ],
    });
    const before = await storedRows(t, leafId);
    const rowA = before.find((r) => r.platformData?.bsc?.ref === "bscA")!;
    const rowB = before.find((r) => r.platformData?.sportlots?.ref === "slB")!;

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        // Contradicts itself: bsc says row A, sportlots says row B.
        card({ cardNumber: "99", cardName: "Contradiction", bscRef: "bscA", slRef: "slB" }),
        card({ cardNumber: "30", cardName: "Unrelated New Card", bscRef: "bscC" }),
      ],
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      cardNumber: "99",
      bscRowId: rowA._id,
      slRowId: rowB._id,
    });
    expect(result.count).toBe(1); // only the unrelated card actually committed

    const after = await storedRows(t, leafId);
    expect(after).toHaveLength(3); // A, B, plus the unrelated new card
    const rowAAfter = after.find((r) => r._id === rowA._id)!;
    const rowBAfter = after.find((r) => r._id === rowB._id)!;
    expect(rowAAfter.cardName).toBe("Row A (bsc only)");
    expect(rowAAfter.lastUpdated).toBe(rowA.lastUpdated);
    expect(rowBAfter.cardName).toBe("Row B (sl only)");
    expect(rowBAfter.lastUpdated).toBe(rowB.lastUpdated);
  });
});

// ---------------------------------------------------------------------------
// Case 11 — ref collisions: first wins, second becomes a marked insert.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — ref collisions", () => {
  test("two incoming cards resolving to one row: first patches, second is inserted with a ref-collision marker", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "3", cardName: "Original", bscRef: "ref-A" })],
    });
    const originalId = (await storedRows(t, leafId))[0]._id;

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "3", cardName: "First", bscRef: "ref-A" }),
        card({ cardNumber: "3", cardName: "Second", bscRef: "ref-A" }),
      ],
    });

    expect(result.collisionInserts).toBe(1);
    const rows = await storedRows(t, leafId);
    expect(rows).toHaveLength(2);
    const matched = rows.find((r) => r._id === originalId)!;
    const inserted = rows.find((r) => r._id !== originalId)!;
    expect(matched.cardName).toBe("Original"); // no applyFields — content untouched
    expect(inserted.cardName).toBe("Second");
    expect(inserted.platformData?.bsc?.ref).toBe("ref-A");
    expect(inserted.attributes).toContain("ref-collision");
  });
});
