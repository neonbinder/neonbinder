/**
 * NEO-334 — the two stores write NO role flag.
 *
 * NEO-306 had `storeSelectorOptions` / `storeReconciledOptions` confer
 * `metadata.variantRole` / `isBase` from a tagged BSC slot. A variant type's
 * title is its kind now (convex/variantRole.ts), so neither store writes a
 * flag on a fresh row or a matched one, and a stray flag already on a row is
 * left exactly as found (the armed `stripRoleFlags` removes it). The BSC
 * slots are untouched either way (listing needs them).
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
  describe(`${storeName} — writes no role flag (NEO-334)`, () => {
    test("fresh Base/Insert/Parallel rows carry no flag; their BSC slots are written as before", async () => {
      const t = convexTest(schema, modules);
      const setId = await insertSetName(t);
      await store(t, setId, [
        { value: "Base", bsc: "base" },
        { value: "Insert", bsc: "insert" },
        { value: "Parallel", bsc: "parallel" },
      ]);
      const rows = await rowsUnder(t, setId);
      expect(rows.map((r) => r.value).sort()).toEqual(["Base", "Insert", "Parallel"]);
      for (const row of rows) {
        expect(row.metadata?.isBase).toBeUndefined();
        expect(row.metadata?.variantRole).toBeUndefined();
      }
      const insert = rows.find((r) => r.value === "Insert");
      expect(Object.values(insert?.platformData.bsc ?? {})).toEqual(["insert"]);
      expect(Object.values(insert?.platformFacets?.bsc ?? {})).toEqual(["variant"]);
    });

    test("a fresh row whose BSC id says insert but whose title is plain gets no flag", async () => {
      const t = convexTest(schema, modules);
      const setId = await insertSetName(t);
      await store(t, setId, [
        { value: "Base", bsc: "base" },
        { value: "Gold Stuff", bsc: "insert" },
      ]);
      const rows = await rowsUnder(t, setId);
      expect(rows.find((r) => r.value === "Gold Stuff")?.metadata?.variantRole).toBeUndefined();
    });

    test("a matched legacy row gains no flag, keeps its other metadata, and its BSC slots deep-equal the pre-write snapshot", async () => {
      const t = convexTest(schema, modules);
      const setId = await insertSetName(t);
      const baseId = await insertLegacyVariantType(t, setId, "Base", "base");
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
      expect(after.insert?.metadata).toEqual({ cardNumberPrefix: "IN-" });
      expect(after.parallel?.metadata).toBeUndefined();
      expect(after.base?.metadata).toBeUndefined();
      for (const key of ["base", "insert", "parallel"] as const) {
        expect(bscSnapshot(after[key])).toEqual(bscSnapshot(before[key]));
      }
    });

    test("a stray flag already on a row is left as found, never acted on", async () => {
      const t = convexTest(schema, modules);
      const setId = await insertSetName(t);
      await insertLegacyVariantType(t, setId, "Base", "base");
      const id = await insertLegacyVariantType(t, setId, "Odd", "insert", {
        variantRole: "parallel",
      });
      await store(t, setId, [
        { value: "Base", bsc: "base" },
        { value: "Odd", bsc: "insert" },
      ]);
      const row = await t.run(async (ctx) => ctx.db.get(id));
      expect(row?.metadata).toEqual({ variantRole: "parallel" });
    });
  });
}
