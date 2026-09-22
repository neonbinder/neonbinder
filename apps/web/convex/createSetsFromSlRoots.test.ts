/**
 * NEO-237 (D13) — `createSetsFromSlRoots`: the write behind the Sync Sets
 * SportLots phase, one call per brand scope after a SUCCESSFUL fetch of that
 * brand's list. Every root `routeSlSets` classified as NEW becomes an NB set
 * (a `setName` row with no marketplace ids) with a "Base" `variantType` child
 * carrying the SportLots id — the way the BSC phase already stores BSC's
 * sets. Jason, 2026-09-21: "If a set exists in a marketplace it should be
 * saved whether it is in SL or BSC or both."
 *
 * Companion to `selectorBrandRouting.test.ts` (the pure `routeSlSets`
 * classifier that produces the roots this mutation is handed) and to
 * `platformLevelSupport.test.ts` (the whole action against stubbed
 * marketplaces). This file drives the DB-writing half: the name rule per
 * scope, the two counted refusals, idempotency across syncs, and the cap.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_SL_SETS_PER_SYNC, routeSlSets } from "./selectorSyncMatch";
import { SL_ALL_BRANDS_BRAND_ID } from "./slBrandAxis";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_000_000;
const ADMIN_USER = "admin_user_neo237_d13";

type T = ReturnType<typeof convexTest>;

async function seedYear(t: T) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      platformData: { sportlots: { s0: "HK" } },
      platformSlotSeq: { sportlots: 1 },
      children: [],
      lastUpdated: SENTINEL,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1997",
      platformData: { sportlots: { s0: "1997" } },
      platformSlotSeq: { sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: SENTINEL,
    });
    return { sportId, yearId };
  });
}

async function insertManufacturer(
  t: T,
  yearId: Id<"selectorOptions">,
  value: string,
  opts: { slId?: string; prefix?: string; isBrandUnknown?: boolean } = {},
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: opts.slId ? { sportlots: { s0: opts.slId } } : {},
      ...(opts.slId ? { platformSlotSeq: { sportlots: 1 } } : {}),
      parentId: yearId,
      children: [],
      metadata: {
        ...(opts.prefix !== undefined ? { setNamePrefix: opts.prefix } : {}),
        ...(opts.isBrandUnknown ? { isBrandUnknown: true } : {}),
      },
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.get(yearId);
    await ctx.db.patch(yearId, { children: [...(year?.children ?? []), id] });
    return id;
  });
}

async function insertSet(
  t: T,
  brandId: Id<"selectorOptions">,
  value: string,
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value,
      platformData: {},
      parentId: brandId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const brand = await ctx.db.get(brandId);
    await ctx.db.patch(brandId, { children: [...(brand?.children ?? []), id] });
    return id;
  });
}

async function setsUnder(t: T, parentId: Id<"selectorOptions">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", parentId),
      )
      .collect(),
  );
}

async function variantsUnder(t: T, setId: Id<"selectorOptions">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "variantType").eq("parentId", setId),
      )
      .collect(),
  );
}

async function rowCount(t: T) {
  return t.run(async (ctx) => (await ctx.db.query("selectorOptions").collect()).length);
}

const create = (
  t: T,
  manufacturerId: Id<"selectorOptions">,
  roots: Array<{ id: string; label: string }>,
  /** `null` = no caller identity (a default `undefined` would re-arm ADMIN_USER). */
  createdByUserId: string | null = ADMIN_USER,
) =>
  t.mutation(internal.selectorOptions.createSetsFromSlRoots, {
    manufacturerId,
    roots,
    ...(createdByUserId ? { createdByUserId } : {}),
  });

describe("createSetsFromSlRoots — the set and its Base", () => {
  test("a real brand: the set is named <prefix> <label>, has no marketplace ids, and its Base carries the SportLots id", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });

    // The adapter strips a real brand's own list: "Heritage", not "Topps
    // Heritage".
    const result = await create(t, topps, [{ id: "502", label: "Heritage" }]);
    expect(result).toEqual({
      created: 1,
      clashedAtTarget: 0,
      existsElsewhere: 0,
      invalid: 0,
    });

    const sets = await setsUnder(t, topps);
    expect(sets).toHaveLength(1);
    const [set] = sets;
    expect(set.value).toBe("Topps Heritage");
    expect(set.platformData).toEqual({});
    expect(set.createdByUserId).toBe(ADMIN_USER);

    const variants = await variantsUnder(t, set._id);
    expect(variants).toHaveLength(1);
    const [base] = variants;
    expect(base.value).toBe("Base");
    expect(base.metadata?.isBase).toBe(true);
    expect(base.platformData).toEqual({ sportlots: { s0: "502" } });
    expect(base.platformLabels?.sportlots).toEqual({ s0: "Heritage" });
    expect(base.platformData.bsc).toBeUndefined();
    expect(base.createdByUserId).toBe(ADMIN_USER);

    // Both children caches point the right way.
    expect(set.children).toEqual([base._id]);
    const brand = await t.run((ctx) => ctx.db.get(topps));
    expect(brand?.children).toEqual([set._id]);
  });

  test("a brand linked through All Brands: same name rule, prefix + the narrowed, stripped label", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const bandai = await insertManufacturer(t, yearId, "Bandai", {
      slId: SL_ALL_BRANDS_BRAND_ID,
      prefix: "Bandai",
    });

    const result = await create(t, bandai, [{ id: "801", label: "Carddass" }]);
    expect(result.created).toBe(1);

    const [set] = await setsUnder(t, bandai);
    expect(set.value).toBe("Bandai Carddass");
    const [base] = await variantsUnder(t, set._id);
    expect(base.platformData.sportlots).toEqual({ s0: "801" });
  });

  test("the Unknown scope has no prefix: the label IS the set name", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const unknown = await insertManufacturer(t, yearId, "Unknown", {
      slId: SL_ALL_BRANDS_BRAND_ID,
      isBrandUnknown: true,
    });

    const result = await create(t, unknown, [
      { id: "803", label: "Roanoke Express ECHL" },
    ]);
    expect(result.created).toBe(1);

    const [set] = await setsUnder(t, unknown);
    expect(set.value).toBe("Roanoke Express ECHL");
    const [base] = await variantsUnder(t, set._id);
    expect(base.platformData.sportlots).toEqual({ s0: "803" });
  });

  test("a label that already leads with the prefix is not prefixed twice", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });

    await create(t, topps, [{ id: "502", label: "Topps Heritage" }]);
    const [set] = await setsUnder(t, topps);
    expect(set.value).toBe("Topps Heritage");
  });

  test("several roots in one call each become a set; the brand's children gain every one", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const score = await insertManufacturer(t, yearId, "Score", {
      slId: "7",
      prefix: "Score",
    });

    const result = await create(t, score, [
      { id: "701", label: "Board" },
      { id: "702", label: "Select" },
      { id: "703", label: "Summit" },
    ]);
    expect(result.created).toBe(3);

    const sets = await setsUnder(t, score);
    expect(sets.map((r) => r.value).sort()).toEqual([
      "Score Board",
      "Score Select",
      "Score Summit",
    ]);
    const brand = await t.run((ctx) => ctx.db.get(score));
    expect(new Set(brand?.children)).toEqual(new Set(sets.map((r) => r._id)));
  });

  test("without a caller identity the rows carry no createdByUserId", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });

    await create(t, topps, [{ id: "502", label: "Heritage" }], null);
    const [set] = await setsUnder(t, topps);
    expect(set.createdByUserId).toBeUndefined();
  });
});

describe("createSetsFromSlRoots — refusals are counted, never written, never thrown", () => {
  test("a sibling that folds to the name is a clash: that set exists, its Base mapping is the operator's", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });
    // A BSC-synced or hand-built set with no SportLots id, in a different
    // case: the fold is `selectorValueKey`'s, the one every matcher uses.
    const existing = await insertSet(t, topps, "TOPPS HERITAGE");
    const before = await rowCount(t);

    const result = await create(t, topps, [
      { id: "502", label: "Heritage" },
      { id: "504", label: "Finest" },
    ]);
    expect(result).toEqual({
      created: 1,
      clashedAtTarget: 1,
      existsElsewhere: 0,
      invalid: 0,
    });

    // The existing set is untouched — no Base, no SportLots id written on it.
    const kept = await t.run((ctx) => ctx.db.get(existing));
    expect(kept?.value).toBe("TOPPS HERITAGE");
    expect(kept?.platformData).toEqual({});
    expect(await variantsUnder(t, existing)).toEqual([]);
    // Only Finest was written: one set + one Base.
    expect(await rowCount(t)).toBe(before + 2);
    expect((await setsUnder(t, topps)).map((r) => r.value).sort()).toEqual([
      "TOPPS HERITAGE",
      "Topps Finest",
    ]);
  });

  test("a set by that name under ANOTHER brand of the year is skipped: a re-home question, not a copy", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const unknown = await insertManufacturer(t, yearId, "Unknown", {
      slId: SL_ALL_BRANDS_BRAND_ID,
      isBrandUnknown: true,
    });
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });
    // Filed under Unknown by an earlier BSC sync before Topps existed.
    await insertSet(t, unknown, "Topps Heritage");
    const before = await rowCount(t);

    const result = await create(t, topps, [{ id: "502", label: "Heritage" }]);
    expect(result).toEqual({
      created: 0,
      clashedAtTarget: 0,
      existsElsewhere: 1,
      invalid: 0,
    });
    expect(await rowCount(t)).toBe(before);
    expect(await setsUnder(t, topps)).toEqual([]);
  });

  test("a clash in the middle of the batch does not roll back the sets around it", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });
    await insertSet(t, topps, "Topps Gallery");

    const result = await create(t, topps, [
      { id: "501", label: "Finest" },
      { id: "502", label: "Gallery" },
      { id: "503", label: "Heritage" },
    ]);
    expect(result.created).toBe(2);
    expect(result.clashedAtTarget).toBe(1);
    expect((await setsUnder(t, topps)).map((r) => r.value).sort()).toEqual([
      "Topps Finest",
      "Topps Gallery",
      "Topps Heritage",
    ]);
  });

  test("duplicate root ids in one call are written once", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });

    const result = await create(t, topps, [
      { id: "502", label: "Heritage" },
      { id: "502", label: "Heritage (dup)" },
    ]);
    expect(result.created).toBe(1);
    expect((await setsUnder(t, topps)).map((r) => r.value)).toEqual([
      "Topps Heritage",
    ]);
  });

  test("refuses a manufacturerId that is not a manufacturer row", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);

    await expect(
      create(t, yearId, [{ id: "502", label: "Heritage" }]),
    ).rejects.toThrow(/not a manufacturer row/i);
  });
});

describe("createSetsFromSlRoots — idempotent across syncs", () => {
  test("the next sync reads the SportLots id off the new Base and classifies the entry as covered, so nothing is created twice", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });
    const entries = [
      { id: "502", label: "Heritage" },
      { id: "503", label: "Heritage Minors" },
    ];

    // Sync 1: the classifier sees nothing covered; the root is written.
    const first = routeSlSets({
      entries,
      coveredSlIds: new Set(
        (
          await t.query(internal.selectorOptions.listBrandSubtreeSlIds, {
            manufacturerId: topps,
          })
        ).ids,
      ),
      knownSetNameKeys: new Set(),
      scopePrefix: "Topps",
    });
    expect(first.roots.map((r) => r.id)).toEqual(["502"]);
    await create(t, topps, first.roots.map(({ id, label }) => ({ id, label })));
    const afterFirst = await rowCount(t);

    // Sync 2: the same list. The brand subtree now holds "502" on the Base;
    // "503" is the new set's variant (prefix of a known name). Zero roots.
    const covered = await t.query(internal.selectorOptions.listBrandSubtreeSlIds, {
      manufacturerId: topps,
    });
    expect(covered.ids).toContain("502");
    const second = routeSlSets({
      entries,
      coveredSlIds: new Set(covered.ids),
      knownSetNameKeys: new Set(["topps heritage"]),
      scopePrefix: "Topps",
    });
    expect(second.covered).toBe(1);
    expect(second.variants).toBe(1);
    expect(second.roots).toEqual([]);
    expect(await rowCount(t)).toBe(afterFirst);
  });

  test("a retry that hands the same root back is a counted clash, not a second copy", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });
    await create(t, topps, [{ id: "502", label: "Heritage" }]);
    const before = await rowCount(t);

    const again = await create(t, topps, [{ id: "502", label: "Heritage" }]);
    expect(again).toEqual({
      created: 0,
      clashedAtTarget: 1,
      existsElsewhere: 0,
      invalid: 0,
    });
    expect(await rowCount(t)).toBe(before);
  });
});

describe("createSetsFromSlRoots — the cap", () => {
  test(`exactly MAX_SL_SETS_PER_SYNC roots are written; one more is refused before any write`, async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });
    const roots = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `sl-${i}`,
        label: `Set ${String(i).padStart(4, "0")}`,
      }));
    const before = await rowCount(t);

    await expect(create(t, topps, roots(MAX_SL_SETS_PER_SYNC + 1))).rejects.toThrow(
      /exceeds/i,
    );
    expect(await rowCount(t)).toBe(before);

    const result = await create(t, topps, roots(MAX_SL_SETS_PER_SYNC));
    expect(result.created).toBe(MAX_SL_SETS_PER_SYNC);
    expect(await setsUnder(t, topps)).toHaveLength(MAX_SL_SETS_PER_SYNC);
  });

  test("the roots the classifier hands over are in a deterministic order, so the sets are created in it", async () => {
    // `routeSlSets` sorts by folded label before the cap; this pins that the
    // mutation writes them in the order given (creation time ascends with
    // the root order), so two syncs over one list file the same window.
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });
    const plan = routeSlSets({
      entries: [
        { id: "3", label: "Gallery" },
        { id: "1", label: "Finest" },
        { id: "2", label: "Heritage" },
      ],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
      scopePrefix: "Topps",
    });
    expect(plan.roots.map((r) => r.label)).toEqual(["Finest", "Gallery", "Heritage"]);
    await create(t, topps, plan.roots.map(({ id, label }) => ({ id, label })));

    const sets = await setsUnder(t, topps);
    const byCreation = [...sets].sort((a, b) => a._creationTime - b._creationTime);
    expect(byCreation.map((r) => r.value)).toEqual([
      "Topps Finest",
      "Topps Gallery",
      "Topps Heritage",
    ]);
  });
});
