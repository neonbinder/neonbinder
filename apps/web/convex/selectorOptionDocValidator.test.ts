/**
 * NEO-137 phase 0/6 — regression guard for `returns`-validator drift on
 * `selectorOptions`.
 *
 * Convex validates `returns` STRICTLY. Four queries return whole
 * `selectorOptions` rows, and each used to enumerate the table's fields by
 * hand. Any field added to the table but missed in one of those lists makes
 * that query throw at runtime — but ONLY for rows that actually carry the
 * field, so it survives every test using bare fixtures and breaks in prod on
 * real reconciled data.
 *
 * That has now happened twice:
 *   - `sportConfig` (NEO-96)
 *   - `platformLabels` + `primaryPlatformId` + `sportConfig` on
 *     `getInsertTreeByVariantType`, which threw
 *     `Object contains extra field 'primaryPlatformId'` and broke Group
 *     Parallels in prod for every reconciled row.
 *
 * The fix is structural: all four validators are built from
 * `selectorOptionFields` in convex/schema.ts. These tests exist so that if
 * anyone re-inlines a field list and it drifts, `convex-test` fails loudly
 * here instead of in prod. Every row seeded below is deliberately FULLY
 * POPULATED — a bare fixture would pass against the broken code.
 */

import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_137",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_137",
  name: "Admin User",
  role: "admin",
};

/**
 * Every optional field the table can carry, populated. If a `returns`
 * validator omits any one of them, the query throws when it hits this row.
 */
const FULLY_POPULATED = {
  platformData: {
    bsc: { b0: "dcap-ap-s1", b1: "dcap-ap-s1-extra" },
    sportlots: { s0: "884412" },
  },
  platformLabels: {
    bsc: { b1: "Series 1 alternate" },
    sportlots: { s0: "Dugout Collection Artists Proofs" },
  },
  primaryPlatformId: { bsc: "b0", sportlots: "s0" },
  platformSlotSeq: { bsc: 2, sportlots: 1 },
  isCustom: false,
  createdByUserId: "clerk|admin_user_137",
  // NEO-239 — `isBase` added. Leaving it out is precisely how this fixture
  // stopped catching the drift it exists for: `getAncestorChain`'s hand-typed
  // metadata validator missed the new field, and no seeded row carried it, so
  // every test passed while the query threw in the preview for any chain
  // containing a Base row. A fixture that is not FULLY POPULATED is not a
  // drift guard.
  metadata: {
    cardNumberPrefix: "DK-",
    isInsert: true,
    isParallel: false,
    isBase: true,
  },
  sportConfig: {
    skuCode: "BB",
    league: "MLB",
    espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
    wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194963" },
  },
  features: { league: "MLB", era: "Modern" },
};

/**
 * Seeds sport → setName → variantType → insert → parallel, every row fully
 * populated. Returns the ids the queries under test need.
 */
async function seedFullTree(t: ReturnType<typeof convexTest>): Promise<{
  sportId: Id<"selectorOptions">;
  variantTypeId: Id<"selectorOptions">;
  insertId: Id<"selectorOptions">;
}> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      children: [],
      lastUpdated: Date.now(),
      ...FULLY_POPULATED,
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Score",
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
      ...FULLY_POPULATED,
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
      ...FULLY_POPULATED,
    });
    const insertId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Dugout Collection Artist's Proofs Series 1",
      parentId: variantTypeId,
      children: [],
      lastUpdated: Date.now(),
      ...FULLY_POPULATED,
    });
    await ctx.db.insert("selectorOptions", {
      level: "parallel",
      value: "Gold",
      parentId: insertId,
      children: [],
      lastUpdated: Date.now(),
      ...FULLY_POPULATED,
    });
    return { sportId, variantTypeId, insertId };
  });
}

describe("selectorOptions returns-validator drift", () => {
  // This is the query that broke prod. It omitted platformLabels,
  // primaryPlatformId and sportConfig.
  test("getInsertTreeByVariantType returns fully-populated inserts and parallels", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedFullTree(t);

    const tree = await asAdmin.query(
      api.selectorOptions.getInsertTreeByVariantType,
      { variantTypeId },
    );

    expect(tree).toHaveLength(1);
    // The three fields whose omission caused the outage.
    expect(tree[0].insert.primaryPlatformId).toEqual({
      bsc: "b0",
      sportlots: "s0",
    });
    expect(tree[0].insert.platformLabels?.sportlots).toEqual({
      s0: "Dugout Collection Artists Proofs",
    });
    expect(tree[0].insert.sportConfig?.skuCode).toBe("BB");
    // Parallels go through the same validator and broke identically.
    expect(tree[0].parallels).toHaveLength(1);
    expect(tree[0].parallels[0].primaryPlatformId).toEqual({
      bsc: "b0",
      sportlots: "s0",
    });
    expect(tree[0].parallels[0].sportConfig?.league).toBe("MLB");
  });

  test("getSelectorOptions returns fully-populated rows", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedFullTree(t);

    const rows = await asAdmin.query(api.selectorOptions.getSelectorOptions, {
      level: "insert",
      parentId: variantTypeId,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].primaryPlatformId).toBeDefined();
    expect(rows[0].platformLabels).toBeDefined();
    expect(rows[0].sportConfig).toBeDefined();
    expect(rows[0].metadata?.cardNumberPrefix).toBe("DK-");
    expect(rows[0].features).toEqual({ league: "MLB", era: "Modern" });
  });

  test("getSelectorOptionById returns a fully-populated row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { insertId } = await seedFullTree(t);

    const row = await asAdmin.query(api.selectorOptions.getSelectorOptionById, {
      id: insertId,
    });

    expect(row).not.toBeNull();
    expect(row?.primaryPlatformId).toBeDefined();
    expect(row?.platformLabels).toBeDefined();
    expect(row?.sportConfig).toBeDefined();
    expect(row?.platformSlotSeq).toEqual({ bsc: 2, sportlots: 1 });
    expect(row?.platformData.sportlots).toEqual({ s0: "884412" });
  });

  test("findByLevelAndValue returns a fully-populated row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedFullTree(t);

    const row = await asAdmin.query(api.selectorOptions.findByLevelAndValue, {
      level: "insert",
      value: "Dugout Collection Artist's Proofs Series 1",
      parentId: variantTypeId,
    });

    expect(row).not.toBeNull();
    expect(row?.primaryPlatformId).toBeDefined();
    expect(row?.platformLabels).toBeDefined();
    expect(row?.sportConfig).toBeDefined();
    expect(row?.createdByUserId).toBe("clerk|admin_user_137");
  });

  /**
   * NEO-239 — the FIFTH validator, and the one that actually shipped broken.
   *
   * `getAncestorChain` does not return whole rows, so it was never in this
   * file's original four — it hand-builds a projection with its own `returns`,
   * including a hand-typed copy of the table's `metadata` object. When
   * `metadata.isBase` was added, that copy did not follow, and Convex
   * validated the query's OUTPUT and threw
   * `Object contains extra field 'isBase' … Path: [4].metadata` server-side.
   *
   * The failure mode is the reason this file exists, one step nastier: the
   * write that set the flag was correct, the row was correct, and the page
   * error-boundaried on the next query that walked a chain containing it. Only
   * a fixture carrying the field can see it — which is why `FULLY_POPULATED`
   * gained `isBase` above rather than this test being written around it.
   */
  test("getAncestorChain returns a chain whose metadata carries isBase", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { insertId } = await seedFullTree(t);

    const chain = await asAdmin.query(api.selectorOptions.getAncestorChain, {
      id: insertId,
    });

    // sport → setName → variantType → insert, every one of them populated.
    expect(chain).toHaveLength(4);
    expect(chain.every((node) => node.metadata?.isBase === true)).toBe(true);
    // The projection's other derived fields, so a future re-inlining of THOSE
    // is caught here too rather than in a preview.
    expect(chain[0].platformFacets).toBeUndefined();
    expect(chain[3].features).toEqual({ league: "MLB", era: "Modern" });
    expect(chain[3].platformLabels?.sportlots).toEqual({
      s0: "Dugout Collection Artists Proofs",
    });
  });
});
