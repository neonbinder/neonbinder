/**
 * NEO-312 — `buildCardRowForInsert` / `insertCardRow`, extracted from the
 * commit's insert branch so a parallel-build copy is born exactly like a
 * synced card (see the module doc in `cardRowCreate.ts`).
 *
 * `buildCardRowForInsert` is pure, so most of this is a plain unit test over
 * its output shape. `insertCardRow` is exercised with `convex-test` for the
 * insert-then-patch write, matching the pattern in `selectorOptions.test.ts`.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import {
  buildCardRowForInsert,
  insertCardRow,
  copyFeaturesForParallel,
  type NewCardRow,
  type CardRowSetContext,
} from "./cardRowCreate";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

/** A placeholder selectorOptionId for the pure-function tests, which never
 * touch a database. */
const SELECTOR_ID = "selector-1" as unknown as Id<"selectorOptions">;

function baseCard(overrides: Partial<NewCardRow> = {}): NewCardRow {
  return {
    selectorOptionId: SELECTOR_ID,
    cardNumber: "10",
    cardName: "Ken Griffey Jr.",
    playerIds: [],
    playerLinks: [],
    teamOnCardIds: [],
    attributes: [],
    platformData: {},
    pendingPlayerNames: [],
    pendingTeamNames: [],
    sortOrder: 0,
    playerNames: ["Ken Griffey Jr."],
    ...overrides,
  };
}

function baseSet(overrides: Partial<CardRowSetContext> = {}): CardRowSetContext {
  return {
    sportValue: "Baseball",
    setNameValue: "Topps",
    ...overrides,
  };
}

describe("buildCardRowForInsert — imageUrls is never written", () => {
  test("the built row carries no imageUrls key at all", () => {
    const built = buildCardRowForInsert(baseCard(), baseSet(), 1_700_000_000_000);
    expect(built.row).not.toHaveProperty("imageUrls");
  });
});

describe("buildCardRowForInsert — carried fields (M3)", () => {
  test("a plain commit (no `carried`) writes none of the carried keys", () => {
    const built = buildCardRowForInsert(baseCard(), baseSet(), 1_700_000_000_000);
    for (const key of [
      "teamCheckDoneAt",
      "bscTeamName",
      "teamNoneConfirmedAt",
      "teamNoneConfirmedByUserId",
      "variationOfCardId",
      "variationParentManual",
    ]) {
      expect(built.row).not.toHaveProperty(key);
    }
  });

  test("a copy's variationOfCardId is carried through verbatim", () => {
    const parentId = "parent-card-1" as unknown as Id<"cardChecklist">;
    const built = buildCardRowForInsert(
      baseCard({ carried: { variationOfCardId: parentId, variationParentManual: true } }),
      baseSet(),
      1_700_000_000_000,
    );
    expect(built.row.variationOfCardId).toBe(parentId);
    expect(built.row.variationParentManual).toBe(true);
  });

  test("a carried team ruling (teamCheckDoneAt, bscTeamName) is copied, not recomputed", () => {
    const built = buildCardRowForInsert(
      baseCard({
        carried: {
          teamCheckDoneAt: 1_690_000_000_000,
          bscTeamName: "New York Yankees",
        },
      }),
      baseSet(),
      1_700_000_000_000,
    );
    expect(built.row.teamCheckDoneAt).toBe(1_690_000_000_000);
    expect(built.row.bscTeamName).toBe("New York Yankees");
  });

  test("a carried field explicitly undefined is omitted, not written as undefined", () => {
    // `teamNoneConfirmedByUserId` present in the `carried` object but the
    // caller passed no value: the row must not carry the key at all, the same
    // as if `carried` had never mentioned it.
    const built = buildCardRowForInsert(
      baseCard({ carried: { teamNoneConfirmedByUserId: undefined } }),
      baseSet(),
      1_700_000_000_000,
    );
    expect(built.row).not.toHaveProperty("teamNoneConfirmedByUserId");
  });
});

describe("buildCardRowForInsert — never stores autographType", () => {
  test("autographType is observed (folds into features.autographed) but not stored on the row", () => {
    const built = buildCardRowForInsert(
      baseCard({ autographType: "On-Card Auto" }),
      baseSet(),
      1_700_000_000_000,
    );
    expect(built.row).not.toHaveProperty("autographType");
    expect(built.row.features?.autographed).toBeTruthy();
  });

  test("Signed By defaults from the roster when autographed newly becomes set", () => {
    const built = buildCardRowForInsert(
      baseCard({ autographType: "On-Card Auto", playerNames: ["Ken Griffey Jr."] }),
      baseSet(),
      1_700_000_000_000,
    );
    expect(built.row.features?.signedBy).toBe("Ken Griffey Jr.");
  });

  test("an already-autographed inherited feature does not overwrite an existing signedBy", () => {
    const built = buildCardRowForInsert(
      baseCard({ playerNames: ["Ken Griffey Jr."] }),
      baseSet({ inheritedFeatures: { autographed: "Yes", signedBy: "Someone Else" } }),
      1_700_000_000_000,
    );
    expect(built.row.features?.signedBy).toBe("Someone Else");
  });
});

describe("buildCardRowForInsert — features precedence (NEO-71-74)", () => {
  test("a card-observed fact beats the inherited set-level feature", () => {
    const built = buildCardRowForInsert(
      baseCard({ isRookie: true }),
      baseSet({ inheritedFeatures: { isRookie: "false" } }),
      1_700_000_000_000,
    );
    expect(built.row.features?.isRookie).toBe("true");
  });

  test("with no observed fact, the inherited feature survives unchanged", () => {
    const built = buildCardRowForInsert(
      baseCard(),
      baseSet({ inheritedFeatures: { parallelName: "Gold Foil" } }),
      1_700_000_000_000,
    );
    expect(built.row.features?.parallelName).toBe("Gold Foil");
  });
});

describe("buildCardRowForInsert — listing text and sortOrder", () => {
  test("listingTitle and listingDescription are generated, not left blank", () => {
    const built = buildCardRowForInsert(baseCard(), baseSet(), 1_700_000_000_000);
    expect(built.row.listingTitle).toBeTruthy();
    expect(built.row.listingDescription).toBeTruthy();
  });

  test("sortOrder and lastUpdated come from the caller and the clock, respectively", () => {
    const built = buildCardRowForInsert(baseCard({ sortOrder: 42 }), baseSet(), 1_700_000_000_000);
    expect(built.row.sortOrder).toBe(42);
    expect(built.row.lastUpdated).toBe(1_700_000_000_000);
  });

  test("pendingPlayerNames/pendingTeamNames are omitted from the row when empty", () => {
    const built = buildCardRowForInsert(baseCard(), baseSet(), 1_700_000_000_000);
    expect(built.row).not.toHaveProperty("pendingPlayerNames");
    expect(built.row).not.toHaveProperty("pendingTeamNames");
  });

  test("a non-empty pendingPlayerNames is written through", () => {
    const built = buildCardRowForInsert(
      baseCard({ pendingPlayerNames: ["Unreviewed Name"] }),
      baseSet(),
      1_700_000_000_000,
    );
    expect(built.row.pendingPlayerNames).toEqual(["Unreviewed Name"]);
  });
});

describe("insertCardRow — keepSku (NEO-312 R2)", () => {
  test("a keepSku is written verbatim instead of generating a fresh SKU", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const cardId = await t.run(async (ctx) =>
      insertCardRow(
        ctx,
        baseCard({ selectorOptionId, keepSku: "NB-BB-OLD-SKU" }),
        baseSet({ sportSkuCode: "BB" }),
      ),
    );
    const row = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(row?.sku).toBe("NB-BB-OLD-SKU");
  });

  test("with no keepSku, a fresh SKU is generated for each insert", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const id1 = await t.run(async (ctx) =>
      insertCardRow(ctx, baseCard({ selectorOptionId, cardNumber: "1" }), baseSet({ sportSkuCode: "BB" })),
    );
    const id2 = await t.run(async (ctx) =>
      insertCardRow(ctx, baseCard({ selectorOptionId, cardNumber: "2" }), baseSet({ sportSkuCode: "BB" })),
    );
    const [row1, row2] = await t.run(async (ctx) => [
      await ctx.db.get(id1),
      await ctx.db.get(id2),
    ]);
    expect(row1?.sku).not.toBe(row2?.sku);
  });
});

describe("copyFeaturesForParallel", () => {
  test("the parallel's own snapshot is the base", () => {
    const out = copyFeaturesForParallel({
      insertSnapshot: { cardType: "Insert" },
      parallelSnapshot: { cardType: "Parallel", parallelName: "Gold Foil" },
      insertCardFeatures: undefined,
    });
    expect(out).toEqual({ cardType: "Parallel", parallelName: "Gold Foil" });
  });

  test("a card-level fact (differs from the insert's own snapshot) is carried onto the copy", () => {
    const out = copyFeaturesForParallel({
      insertSnapshot: { cardType: "Insert", autographed: "None" },
      parallelSnapshot: { cardType: "Parallel", parallelName: "Gold Foil" },
      insertCardFeatures: { cardType: "Insert", autographed: "Yes", signedBy: "Ken Griffey Jr." },
    });
    expect(out.autographed).toBe("Yes");
    expect(out.signedBy).toBe("Ken Griffey Jr.");
  });

  test("a fact merely inherited on the insert card (equal to its snapshot) is not carried", () => {
    const out = copyFeaturesForParallel({
      insertSnapshot: { cardType: "Insert", isRookie: "false" },
      parallelSnapshot: { cardType: "Parallel" },
      insertCardFeatures: { cardType: "Insert", isRookie: "false" },
    });
    expect(out.isRookie).toBeUndefined();
  });

  test("the parallel's snapshot wins on PARALLEL_FACT_KEYS even if the insert card disagrees", () => {
    const out = copyFeaturesForParallel({
      insertSnapshot: { cardType: "Insert" },
      parallelSnapshot: { cardType: "Parallel", parallelName: "Gold Foil" },
      insertCardFeatures: { cardType: "SomethingElse", parallelName: "Wrong Name" },
    });
    expect(out.cardType).toBe("Parallel");
    expect(out.parallelName).toBe("Gold Foil");
  });

  test("a non-parallel-fact key the parallel's own snapshot already set (an operator edit) wins over the insert card", () => {
    const out = copyFeaturesForParallel({
      insertSnapshot: { shortPrint: "false" },
      parallelSnapshot: { shortPrint: "true" },
      insertCardFeatures: { shortPrint: "not-true-not-false" },
    });
    expect(out.shortPrint).toBe("true");
  });
});

async function seedSelectorOption(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Refractor",
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

describe("insertCardRow — insert-then-patch, no imageUrls, no enrichment scheduled", () => {
  test("inserts a row with no imageUrls and then patches in a SKU", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const cardId = await t.run(async (ctx) =>
      insertCardRow(
        ctx,
        baseCard({ selectorOptionId }),
        baseSet({ sportSkuCode: "BB" }),
      ),
    );
    const row = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty("imageUrls");
    expect(row?.sku).toBeTruthy();
    expect(row?.sku).toMatch(/^NB-BB-/);
  });

  test("queues no scheduled function (no team enrichment) for a plain insert", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    await t.run(async (ctx) =>
      insertCardRow(ctx, baseCard({ selectorOptionId }), baseSet()),
    );
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });
});

describe("buildCardRowForInsert — a parallel copy's parallelName (NEO-321)", () => {
  const NOW = 1_700_000_000_000;

  test("the parallel's NB name wins over the snapshot's inherited 'Base' and lands in the title", () => {
    const built = buildCardRowForInsert(
      baseCard({
        baseFeatures: { cardType: "Parallel", parallelName: "Base" },
        parallelName: "Gold Wave Refractors",
      }),
      baseSet(),
      NOW,
    );
    expect(built.row.features?.parallelName).toBe("Gold Wave Refractors");
    expect(built.row.listingTitle).toContain("Gold Wave Refractors");
  });

  test("it also wins over a copied variation's cardVariation, which keeps its own title token", () => {
    const built = buildCardRowForInsert(
      baseCard({
        cardVariation: "Image Variation",
        baseFeatures: { cardType: "Parallel", parallelName: "Base" },
        parallelName: "Gold Wave",
      }),
      baseSet(),
      NOW,
    );
    expect(built.row.features?.parallelName).toBe("Gold Wave");
    expect(built.row.cardVariation).toBe("Image Variation");
    expect(built.row.listingTitle).toContain("Gold Wave");
    expect(built.row.listingTitle).toContain("Image Variation");
  });

  test("without it (the commit path) nothing changes: 'Base' stays and no parallel token is titled", () => {
    const withNothing = buildCardRowForInsert(
      baseCard({ baseFeatures: { cardType: "Base", parallelName: "Base" } }),
      baseSet(),
      NOW,
    );
    expect(withNothing.row.features?.parallelName).toBe("Base");
    const blank = buildCardRowForInsert(
      baseCard({ baseFeatures: { cardType: "Base", parallelName: "Base" }, parallelName: "   " }),
      baseSet(),
      NOW,
    );
    expect(blank.row.features?.parallelName).toBe("Base");
    expect(blank.row.listingTitle).toBe(withNothing.row.listingTitle);
  });
});
