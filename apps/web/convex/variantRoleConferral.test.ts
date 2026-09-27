/**
 * NEO-306 — the variant type's insert/parallel ROLE is conferred at WRITE
 * time, by the two stores, as `metadata.variantRole`.
 *
 * `variantTypeRole` no longer reads a BSC slot at runtime (variantRole.test.ts
 * pins that). So the only places a synced variant type gets its role are the
 * insert and patch sites of `storeSelectorOptions` and
 * `storeReconciledOptions`, plus the armed backfill for rows no sync
 * reaches. This file pins both stores:
 *
 *   - a fresh variantType row is born with the role its tagged BSC slot says;
 *   - a matched row with no role gets one (adds only);
 *   - a role already there is never flipped, the Base never gets one, and
 *     ambiguous evidence writes nothing;
 *   - the BSC slots are untouched by the conferral: `platformData.bsc` and
 *     `platformFacets.bsc` deep-equal their pre-write snapshot (Jason's
 *     condition on D1 — listing needs them).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_vrc_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_vrc_001",
  name: "Admin User",
  role: "admin",
};

const SENTINEL = 1_000_000;
type T = ReturnType<typeof convexTest>;

async function insertSetName(t: T): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: { bsc: { b0: "2024-topps" } },
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

/** An existing variantType row as an older sync left it: tagged slot, no role. */
async function insertLegacyVariantType(
  t: T,
  parentId: Id<"selectorOptions">,
  value: string,
  bscId: string,
  metadata?: Doc<"selectorOptions">["metadata"],
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value,
      parentId,
      children: [],
      platformData: { bsc: { b0: bscId } },
      platformLabels: { bsc: { b0: value } },
      platformFacets: { bsc: { b0: "variant" } },
      platformSlotSeq: { bsc: 1 },
      primaryPlatformId: { bsc: "b0" },
      ...(metadata ? { metadata } : {}),
      lastUpdated: SENTINEL,
    });
    const parent = await ctx.db.get(parentId);
    await ctx.db.patch(parentId, { children: [...(parent?.children ?? []), id] });
    return id;
  });
}

async function rowsUnder(t: T, parentId: Id<"selectorOptions">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_parent", (q) => q.eq("parentId", parentId))
      .collect(),
  );
}

function bscSnapshot(row: Doc<"selectorOptions"> | null) {
  return {
    platformData: row?.platformData?.bsc,
    platformFacets: row?.platformFacets?.bsc,
  };
}

/** Both stores, driven with one list of `{value, bsc}` at variantType level. */
const STORES = {
  storeSelectorOptions: (t: T, parentId: Id<"selectorOptions">, items: Array<{ value: string; bsc: string }>) =>
    t.withIdentity(ADMIN_IDENTITY).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "variantType",
      parentId,
      options: items.map((i) => ({ value: i.value, platformData: { bsc: i.bsc } })),
    }),
  storeReconciledOptions: (t: T, parentId: Id<"selectorOptions">, items: Array<{ value: string; bsc: string }>) =>
    t.withIdentity(ADMIN_IDENTITY).mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId,
      reconciledItems: items.map((i) => ({ value: i.value, platformData: { bsc: i.bsc } })),
    }),
} as const;

for (const [storeName, store] of Object.entries(STORES)) {
  describe(`${storeName} — variantRole conferral (NEO-306)`, () => {
    test("fresh rows: insert/parallel get the role, the Base gets isBase and no role", async () => {
      const t = convexTest(schema, modules);
      const setId = await insertSetName(t);
      await store(t, setId, [
        { value: "Base", bsc: "base" },
        { value: "Insert", bsc: "insert" },
        { value: "Parallel", bsc: "parallel" },
      ]);
      const rows = await rowsUnder(t, setId);
      const byValue = new Map(rows.map((r) => [r.value, r]));
      expect(byValue.get("Base")?.metadata?.isBase).toBe(true);
      expect(byValue.get("Base")?.metadata?.variantRole).toBeUndefined();
      expect(byValue.get("Insert")?.metadata?.variantRole).toBe("insert");
      expect(byValue.get("Parallel")?.metadata?.variantRole).toBe("parallel");
      // The BSC slot the role was read from is written exactly as before.
      expect(Object.values(byValue.get("Insert")?.platformData.bsc ?? {})).toEqual([
        "insert",
      ]);
      expect(Object.values(byValue.get("Insert")?.platformFacets?.bsc ?? {})).toEqual([
        "variant",
      ]);
    });

    test("fresh row with ambiguous or role-less evidence gets no role", async () => {
      const t = convexTest(schema, modules);
      const setId = await insertSetName(t);
      await store(t, setId, [
        { value: "Base", bsc: "base" },
        { value: "Both", bsc: "insert-parallel" },
        { value: "Promo", bsc: "promo" },
      ]);
      const rows = await rowsUnder(t, setId);
      for (const value of ["Both", "Promo"]) {
        expect(rows.find((r) => r.value === value)?.metadata?.variantRole).toBeUndefined();
      }
    });

    test("a matched legacy row gets its role, and its BSC slots deep-equal the pre-write snapshot", async () => {
      const t = convexTest(schema, modules);
      const setId = await insertSetName(t);
      const baseId = await insertLegacyVariantType(t, setId, "Base", "base", { isBase: true });
      const insertId = await insertLegacyVariantType(t, setId, "Inserts", "insert", {
        cardNumberPrefix: "IN-",
      });
      const parallelId = await insertLegacyVariantType(t, setId, "Parallels", "parallel");
      const before = await t.run(async (ctx) => ({
        base: await ctx.db.get(baseId),
        insert: await ctx.db.get(insertId),
        parallel: await ctx.db.get(parallelId),
      }));

      await store(t, setId, [
        { value: "Base", bsc: "base" },
        { value: "Inserts", bsc: "insert" },
        { value: "Parallels", bsc: "parallel" },
      ]);

      const after = await t.run(async (ctx) => ({
        base: await ctx.db.get(baseId),
        insert: await ctx.db.get(insertId),
        parallel: await ctx.db.get(parallelId),
      }));
      expect(after.insert?.metadata).toEqual({ cardNumberPrefix: "IN-", variantRole: "insert" });
      expect(after.parallel?.metadata).toEqual({ variantRole: "parallel" });
      expect(after.base?.metadata).toEqual({ isBase: true });
      for (const key of ["base", "insert", "parallel"] as const) {
        expect(bscSnapshot(after[key])).toEqual(bscSnapshot(before[key]));
      }
    });

    test("a role already there is never flipped, even when the slot now says otherwise", async () => {
      const t = convexTest(schema, modules);
      const setId = await insertSetName(t);
      await insertLegacyVariantType(t, setId, "Base", "base", { isBase: true });
      const id = await insertLegacyVariantType(t, setId, "Odd", "insert", {
        variantRole: "parallel",
      });
      await store(t, setId, [
        { value: "Base", bsc: "base" },
        { value: "Odd", bsc: "insert" },
      ]);
      const row = await t.run(async (ctx) => ctx.db.get(id));
      expect(row?.metadata?.variantRole).toBe("parallel");
    });

    test("an operator's Base keeps no role even if its slot carries a role token", async () => {
      const t = convexTest(schema, modules);
      const setId = await insertSetName(t);
      const id = await insertLegacyVariantType(t, setId, "Parallels", "parallel", {
        isBase: true,
      });
      await store(t, setId, [{ value: "Parallels", bsc: "parallel" }]);
      const row = await t.run(async (ctx) => ctx.db.get(id));
      expect(row?.metadata).toEqual({ isBase: true });
    });
  });
}
