/**
 * NEO-71-74: write-once feature snapshots.
 *
 * Every selectorOptions node gets a complete, self-contained `features`
 * snapshot written ONCE at creation: `{ ...parent.features,
 * ...deriveOwnLevelFeatures(level, value) }` (see
 * convex/features/deriveCardFeatures.ts). No ancestor walk is needed at
 * read time — this covers all 3 node-creation call sites:
 * `storeSelectorOptions`, `addCustomSelectorOption` (both in
 * convex/selectorOptions.ts), and `storeReconciledOptions` (in
 * convex/setReconciliation.ts).
 *
 * (`setSelectorOptionFeature`'s single-row-only edit behavior and
 * `commitCardChecklist`/`addCustomCard`'s leaf-only card-creation read are
 * covered in convex/featurePropagation.test.ts and
 * convex/cardFeatureDerivation.test.ts respectively.)
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_wofs_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_wofs_001",
  name: "Admin User",
  role: "admin",
};

/**
 * NEO-334 — a sub-variant can only be created under an insert of an Insert
 * type, so the `parallel` own-level cases need that parent. Both rows are
 * seeded with no `features`, so the parallel's snapshot is its own level's
 * and nothing copied down.
 */
async function seedFeaturelessInsert(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const variantType = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      platformData: {},
      children: [],
      lastUpdated: 0,
    });
    const insert = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Chrome Update",
      platformData: {},
      parentId: variantType,
      children: [],
      lastUpdated: 0,
    });
    await ctx.db.patch(variantType, { children: [insert] });
    return insert;
  });
}

async function getFeatures(
  t: ReturnType<typeof convexTest>,
  id: Id<"selectorOptions">,
): Promise<Record<string, string> | undefined> {
  return t.run(async (ctx) => (await ctx.db.get(id))?.features);
}

// ===========================================================================
// Own-level heuristic — root case, no parent present
// ===========================================================================

describe("own-level heuristic on a root (parentless) node", () => {
  test("sport -> league", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Baseball" },
    );
    expect(await getFeatures(t, id)).toEqual({ league: "MLB" });
  });

  test("year -> era, vintage, season", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "year", value: "1975" },
    );
    expect(await getFeatures(t, id)).toEqual({
      era: "Vintage (1970-79)",
      vintage: "true",
      season: "1975",
    });
  });

  test("manufacturer -> manufacturer", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "manufacturer", value: "Panini" },
    );
    expect(await getFeatures(t, id)).toEqual({ manufacturer: "Panini" });
  });

  test("setName -> isReprint, autographed, cardSize, cardMaterial, cardThickness, language, countryOfOrigin", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "setName", value: "2024 Topps" },
    );
    expect(await getFeatures(t, id)).toEqual({
      isReprint: "false",
      autographed: "None",
      cardSize: "Standard",
      cardMaterial: "Card Stock",
      cardThickness: "20pt",
      language: "English",
      countryOfOrigin: "USA",
    });
  });

  test("variantType / insert / parallel -> cardType", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "variantType", value: "Base" },
    );
    const insertId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "insert", value: "Chrome Update" },
    );
    // NEO-334: a parentless sub-variant is refused, so the parallel case is
    // created under a featureless insert of an Insert type instead.
    const parallelId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "parallel", value: "Gold", parentId: await seedFeaturelessInsert(t) },
    );
    expect(await getFeatures(t, variantTypeId)).toEqual({
      cardType: "Base",
      parallelName: "Base",
    });
    expect(await getFeatures(t, insertId)).toEqual({ cardType: "Insert" });
    expect(await getFeatures(t, parallelId)).toEqual({ cardType: "Parallel" });
  });

  test("variantType -> parallelName defaults to Base (a base card has no special variant)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "variantType", value: "Base" },
    );
    expect(await getFeatures(t, variantTypeId)).toMatchObject({
      parallelName: "Base",
    });
  });

  test("insert / parallel do NOT get a generic parallelName default", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const insertId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "insert", value: "Chrome Update" },
    );
    const parallelId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "parallel", value: "Gold", parentId: await seedFeaturelessInsert(t) },
    );
    expect((await getFeatures(t, insertId))?.parallelName).toBeUndefined();
    expect((await getFeatures(t, parallelId))?.parallelName).toBeUndefined();
  });

  test("unmapped sport seeds nothing, not an error", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Cricket" },
    );
    expect(await getFeatures(t, id)).toBeFalsy();
  });

  // NEO-219 decision 2: `addCustomSelectorOption` no longer ACCEPTS a
  // non-four-digit year, so this behaviour is asserted in two halves — the
  // mutation now refuses the label, and the deriver (which still runs on year
  // rows a marketplace sync created, and on every row written before the
  // guard) still mirrors an unparseable one.
  test("year level refuses a non-four-digit label at the mutation", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomSelectorOption, {
        level: "year",
        value: "TBD",
      }),
    ).rejects.toThrow(/four-digit/);
  });

  test("non-year value seeds nothing for era/vintage, but season still mirrors the raw label", () => {
    // era/vintage need a parseable 4-digit year; season doesn't — it just
    // mirrors whatever label the year node carries, parseable or not.
    expect(deriveOwnLevelFeatures("year", "TBD")).toEqual({ season: "TBD" });
  });
});

// ===========================================================================
// Full copy-down — parent's complete snapshot flows onto the child
// ===========================================================================

describe("full copy-down from parent to child", () => {
  test("addCustomSelectorOption: child inherits an arbitrary parent key with no deriver, plus its own heuristic", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Baseball" },
    );
    // Seed an arbitrary key with no deriver directly onto the parent.
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: sportId,
      key: "subsetLabel",
      value: "Flagship",
    });

    const yearId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "year", value: "2024", parentId: sportId },
    );

    expect(await getFeatures(t, yearId)).toEqual({
      league: "MLB", // copied down, no deriver at year level
      subsetLabel: "Flagship", // arbitrary key, copied down verbatim
      era: "Modern (1980-Now)", // own-level heuristic
      vintage: "false", // own-level heuristic
      season: "2024", // own-level heuristic
    });
  });

  test("storeSelectorOptions: fresh insert copies the parent's snapshot down", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Baseball" },
    );

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "year",
      parentId: sportId,
      options: [{ value: "1975", platformData: {} }],
    });

    const yearRow = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "year").eq("parentId", sportId),
        )
        .collect(),
    );
    expect(yearRow).toHaveLength(1);
    expect(yearRow[0].features).toEqual({
      league: "MLB",
      era: "Vintage (1970-79)",
      vintage: "true",
      season: "1975",
    });
  });

  test("storeSelectorOptions: merge/refresh of an EXISTING row does not re-seed or clobber an override", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "sport",
      options: [{ value: "Baseball", platformData: { bsc: "bsc-1" } }],
    });
    const sportRow = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "sport").eq("parentId", undefined),
        )
        .collect(),
    );
    expect(sportRow).toHaveLength(1);
    const sportId = sportRow[0]._id;

    // Operator override, simulating a real edit.
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: sportId,
      key: "league",
      value: "CUSTOM_LEAGUE",
    });

    // Re-sync the SAME value — hits the merge branch, not fresh-insert.
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "sport",
      options: [{ value: "Baseball", platformData: { bsc: "bsc-1-updated" } }],
    });

    expect(await getFeatures(t, sportId)).toEqual({ league: "CUSTOM_LEAGUE" });
  });

  /**
   * NEO-291 / NEO-334 — `item.metadata` on the wire no longer admits
   * `isInsert` / `isParallel`. The kind comes from `derivedVariantFlags`,
   * read off the row's variant-type PARENT's TITLE, and feeds the own-level
   * features at creation only: no flag is written on the row.
   */
  test("storeReconciledOptions: fresh insert under a variant type titled Inserts gets cardType Insert and no flag", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Baseball" },
    );
    const setNameId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "setName", value: "2024 Topps", parentId: sportId },
    );
    const variantTypeId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "variantType", value: "Inserts", parentId: setNameId },
    );
    // The shape a real variantType sync writes: a `variant`-tagged BSC slot.
    // The slot says nothing about the kind; the title "Inserts" does.
    await t.run(async (ctx) =>
      ctx.db.patch(variantTypeId, {
        platformData: { bsc: { b0: "insert" } },
        platformFacets: { bsc: { b0: "variant" } },
      }),
    );

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId: variantTypeId,
      reconciledItems: [
        {
          value: "Chrome Update",
          platformData: { bsc: "bsc-insert-1" },
        },
      ],
    });

    const insertRow = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "insert").eq("parentId", variantTypeId),
        )
        .collect(),
    );
    expect(insertRow).toHaveLength(1);
    expect(insertRow[0].metadata).toBeUndefined();
    expect(insertRow[0].features).toMatchObject({
      league: "MLB", // copied down from sport
      isReprint: "false", // copied down from setName
      autographed: "None", // copied down from setName
      cardSize: "Standard", // copied down from setName
      cardMaterial: "Card Stock", // copied down from setName
      cardThickness: "20pt", // copied down from setName
      language: "English", // copied down from setName
      countryOfOrigin: "USA", // copied down from setName
      cardType: "Insert", // derived (level="insert", parent titled "Inserts")
    });
  });

  /**
   * NEO-291 / NEO-334 — the "parallel of the base set" shape: an
   * `insert`-level row sitting under a variantType titled "Parallels", not
   * "Inserts". `features.cardType` is read off the parent's title, so the row
   * is born a Parallel; no flag is written.
   */
  test("storeReconciledOptions: fresh insert under a variant type titled Parallels gets cardType Parallel and no flag", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Baseball" },
    );
    const setNameId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "setName", value: "2024 Topps", parentId: sportId },
    );
    const variantTypeId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "variantType", value: "Parallels", parentId: setNameId },
    );
    // The "parallel of the base set" shape: the row's cards live at `insert`
    // level, but the parent's title says Parallels, not Inserts.
    await t.run(async (ctx) =>
      ctx.db.patch(variantTypeId, {
        platformData: { bsc: { b0: "parallel" } },
        platformFacets: { bsc: { b0: "variant" } },
      }),
    );

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId: variantTypeId,
      reconciledItems: [
        {
          value: "Gold Refractor",
          platformData: { bsc: "bsc-parallel-1" },
        },
      ],
    });

    const insertRow = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "insert").eq("parentId", variantTypeId),
        )
        .collect(),
    );
    expect(insertRow).toHaveLength(1);
    expect(insertRow[0].metadata).toBeUndefined();
    expect(insertRow[0].features?.cardType).toBe("Parallel");
  });
});
