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

  test("setName -> isReprint, autographed, cardSize, cardMaterial, language", async () => {
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
      language: "English",
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
    const parallelId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "parallel", value: "Gold" },
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
      { level: "parallel", value: "Gold" },
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

  test("non-year value seeds nothing for era/vintage, but season still mirrors the raw label", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "year", value: "TBD" },
    );
    // era/vintage need a parseable 4-digit year; season doesn't — it just
    // mirrors whatever label the year node carries, parseable or not.
    expect(await getFeatures(t, id)).toEqual({ season: "TBD" });
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

  test("storeReconciledOptions: fresh insert copies the parent's snapshot down and applies item.metadata for cardType", async () => {
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

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId: setNameId,
      reconciledItems: [
        {
          value: "Chrome Update",
          platformData: { bsc: "bsc-insert-1" },
          metadata: { isInsert: true },
        },
      ],
    });

    const insertRow = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "insert").eq("parentId", setNameId),
        )
        .collect(),
    );
    expect(insertRow).toHaveLength(1);
    expect(insertRow[0].features).toEqual({
      league: "MLB", // copied down from sport
      isReprint: "false", // copied down from setName
      autographed: "None", // copied down from setName
      cardSize: "Standard", // copied down from setName
      cardMaterial: "Card Stock", // copied down from setName
      language: "English", // copied down from setName
      cardType: "Insert", // own-level heuristic (level="insert")
    });
  });
});
