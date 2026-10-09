/**
 * NEO-325 (security re-audit) — one link, one row, for EVERY id an inserted
 * line carries. The planner sees only the FIRST id per side; each further id
 * is asked of the sibling snapshot and the holder walk before the new row
 * takes it, and a blocked one is left off the row and reported in
 * `withheldElsewhere`. Fixture shape: `storeReconciledOptions.nameTwins.test.ts`.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { slotIds } from "./platformSlots";
import { MAX_SUBTREE_WALK_INSERTS } from "./selectorSyncStore";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_neo325_store_extras", role: "admin" };
const SENTINEL = 1_000_000;

type T = ReturnType<typeof convexTest>;
type RowId = Id<"selectorOptions">;
type Row = Doc<"selectorOptions">;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

async function insertRow(
  t: T,
  fields: Partial<Row> & { level: Row["level"]; value: string },
): Promise<RowId> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
      ...fields,
    } as Omit<Row, "_id" | "_creationTime">);
    if (fields.parentId) {
      const parent = await ctx.db.get(fields.parentId);
      await ctx.db.patch(fields.parentId, {
        children: [...(parent?.children ?? []), id],
      });
    }
    return id;
  });
}

/** sport → year → brand → set → Insert variant type (the parent of `insert` rows). */
async function seed(t: T) {
  const sportId = await insertRow(t, { level: "sport", value: "Baseball" });
  const yearId = await insertRow(t, { level: "year", value: "2026", parentId: sportId });
  const brandId = await insertRow(t, {
    level: "manufacturer",
    value: "Bowman",
    parentId: yearId,
    metadata: { setNamePrefix: "Bowman" },
  });
  const setId = await insertRow(t, {
    level: "setName",
    value: "Bowman",
    parentId: brandId,
    platformData: { bsc: { b0: "bowman" } },
    platformFacets: { bsc: { b0: "setName" } },
    platformSlotSeq: { bsc: 1 },
  });
  const insertTypeId = await insertRow(t, {
    level: "variantType",
    value: "Insert",
    parentId: setId,
    platformData: { bsc: { b0: "insert" } },
    platformFacets: { bsc: { b0: "variant" } },
    platformSlotSeq: { bsc: 1 },
    metadata: { variantRole: "insert" },
    features: { season: "2026" },
  });
  // A second variant type under the SAME set, and a second set under the
  // same brand, for holders that are not siblings.
  const otherTypeId = await insertRow(t, {
    level: "variantType",
    value: "Other Cards",
    parentId: setId,
    metadata: { variantRole: "insert" },
    features: { season: "2026" },
  });
  const otherSetId = await insertRow(t, {
    level: "setName",
    value: "Bowman Chrome",
    parentId: brandId,
  });
  const otherSetTypeId = await insertRow(t, {
    level: "variantType",
    value: "Insert",
    parentId: otherSetId,
    metadata: { variantRole: "insert" },
    features: { season: "2026" },
  });
  return { insertTypeId, otherTypeId, otherSetTypeId };
}

function insertRowWith(
  t: T,
  parentId: RowId,
  value: string,
  ids: { bsc?: string; sportlots?: string },
) {
  return insertRow(t, {
    level: "insert",
    value,
    parentId,
    platformData: {
      ...(ids.bsc ? { bsc: { b0: ids.bsc } } : {}),
      ...(ids.sportlots ? { sportlots: { s0: ids.sportlots } } : {}),
    },
    platformSlotSeq: {
      ...(ids.bsc ? { bsc: 1 } : {}),
      ...(ids.sportlots ? { sportlots: 1 } : {}),
    },
    metadata: { isInsert: true },
    features: { season: "2026", cardType: "Insert" },
  });
}

type Line = {
  value: string;
  bsc?: string | string[];
  sportlots?: string | string[];
  existingId?: RowId;
  identityOnly?: boolean;
};

function store(
  t: T,
  parentId: RowId,
  items: Line[],
  opts: {
    coveredSides?: Array<"bsc" | "sportlots">;
    returnedIds?: { bsc?: string[]; sportlots?: string[] };
  } = {},
) {
  return t.withIdentity(ADMIN).mutation(api.setReconciliation.storeReconciledOptions, {
    level: "insert",
    parentId,
    ...opts,
    reconciledItems: items.map((i) => ({
      value: i.value,
      platformData: {
        ...(i.bsc !== undefined ? { bsc: i.bsc } : {}),
        ...(i.sportlots !== undefined ? { sportlots: i.sportlots } : {}),
      },
      metadata: undefined,
      ...(i.existingId ? { existingId: i.existingId } : {}),
      ...(i.identityOnly ? { identityOnly: true } : {}),
    })),
  });
}

async function insertsUnder(t: T, parentId: RowId) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "insert").eq("parentId", parentId),
      )
      .collect(),
  );
}


async function holderCount(t: T, side: "bsc" | "sportlots", id: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("selectorOptions").collect();
    return rows.filter((r) => slotIds(r, side).includes(id)).length;
  });
}

describe("storeReconciledOptions — extra ids on an inserted line (NEO-325)", () => {
  test("identityOnly with [A, B], B held by a sibling: the new row holds only A, and one entry names the sibling", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    const sibling = await insertRowWith(t, insertTypeId, "Gold", { sportlots: "B" });

    const res = await store(
      t,
      insertTypeId,
      [{ value: "Anime", sportlots: ["A", "B"], identityOnly: true }],
      { coveredSides: ["sportlots"], returnedIds: { sportlots: ["A", "B"] } },
    );

    const created = (await insertsUnder(t, insertTypeId)).find((r) => r.value === "Anime")!;
    expect(slotIds(created, "sportlots")).toEqual(["A"]);
    expect(res.withheldElsewhere).toHaveLength(1);
    expect(res.withheldElsewhere[0]).toMatchObject({
      label: "Anime",
      reason: "linkHeldElsewhere",
    });
    expect(res.withheldElsewhere[0].holders.map((h) => String(h.id))).toEqual([
      String(sibling),
    ]);
    expect(await holderCount(t, "sportlots", "B")).toBe(1);
  });

  test("B held by an insert under ANOTHER variant type (not identityOnly): the row is created without B, and the holder keeps it", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId, otherTypeId } = await seed(t);
    const holder = await insertRowWith(t, otherTypeId, "Elsewhere", { sportlots: "B" });

    const res = await store(t, insertTypeId, [{ value: "Anime", sportlots: ["A", "B"] }]);

    const created = (await insertsUnder(t, insertTypeId)).find((r) => r.value === "Anime")!;
    expect(slotIds(created, "sportlots")).toEqual(["A"]);
    expect(res.withheldElsewhere).toHaveLength(1);
    expect(res.withheldElsewhere[0].reason).toBe("linkHeldElsewhere");
    expect(res.withheldElsewhere[0].holders.map((h) => String(h.id))).toEqual([
      String(holder),
    ]);
    expect(await holderCount(t, "sportlots", "B")).toBe(1);
  });

  test("extras nobody holds are all allocated, and nothing is reported", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);

    const res = await store(t, insertTypeId, [
      { value: "Anime", sportlots: ["A", "B", "C"], bsc: ["x1", "x2"] },
    ]);

    const created = (await insertsUnder(t, insertTypeId)).find((r) => r.value === "Anime")!;
    expect(slotIds(created, "sportlots")).toEqual(["A", "B", "C"]);
    expect(slotIds(created, "bsc")).toEqual(["x1", "x2"]);
    expect(res.withheldElsewhere).toEqual([]);
    expect(res.withheldElsewhereTotal).toBe(0);
  });

  test("an extra-only reach past the siblings still drives the walk: a link on another set of the brand is not taken", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId, otherSetTypeId } = await seed(t);
    // No sibling holds anything; the ONLY holder is in another set of the
    // brand, found by the brand walk (SportLots only).
    const holder = await insertRowWith(t, otherSetTypeId, "Elsewhere", { sportlots: "B" });

    // The first SportLots id is empty: the planner's item has no id at all,
    // so only the extra can send the store looking past the siblings.
    const res = await store(t, insertTypeId, [{ value: "Anime", sportlots: ["", "B"] }]);

    const created = (await insertsUnder(t, insertTypeId)).find((r) => r.value === "Anime")!;
    expect(slotIds(created, "sportlots")).toEqual([]);
    expect(res.withheldElsewhere).toHaveLength(1);
    expect(res.withheldElsewhere[0].holders.map((h) => String(h.id))).toEqual([
      String(holder),
    ]);
    expect(await holderCount(t, "sportlots", "B")).toBe(1);
  });

  test("a walk that cannot finish makes the extra notChecked: the row is created without it, nothing is named", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i <= MAX_SUBTREE_WALK_INSERTS; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "insert",
          value: `Bulk ${i}`,
          parentId: insertTypeId,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });

    const res = await store(t, insertTypeId, [{ value: "Anime", sportlots: ["", "B"] }]);

    expect(res.subtreeWalkSkipped).toBe(true);
    const created = (await insertsUnder(t, insertTypeId)).find((r) => r.value === "Anime")!;
    expect(slotIds(created, "sportlots")).toEqual([]);
    expect(res.withheldElsewhere).toEqual([
      { label: "Anime", reason: "notChecked", holders: [] },
    ]);
  });

  test("BSC extras are held to the same rule: b2 on a sibling stays there, b1 and b3 are taken", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    const sibling = await insertRowWith(t, insertTypeId, "Gold", { bsc: "b2" });

    const res = await store(t, insertTypeId, [{ value: "Anime", bsc: ["b1", "b2", "b3"] }]);

    const created = (await insertsUnder(t, insertTypeId)).find((r) => r.value === "Anime")!;
    expect(slotIds(created, "bsc")).toEqual(["b1", "b3"]);
    expect(res.withheldElsewhere).toHaveLength(1);
    expect(res.withheldElsewhere[0].holders.map((h) => String(h.id))).toEqual([
      String(sibling),
    ]);
    expect(await holderCount(t, "bsc", "b2")).toBe(1);
  });

  test("wire [A, A]: the row holds A once and nothing is reported against the repeat", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);

    const res = await store(t, insertTypeId, [{ value: "Anime", sportlots: ["A", "A"] }]);

    const created = (await insertsUnder(t, insertTypeId)).find((r) => r.value === "Anime")!;
    expect(slotIds(created, "sportlots")).toEqual(["A"]);
    expect(res.withheldElsewhere).toEqual([]);
  });

  test("wire [\"\", B]: the empty first id is not an id, and B is checked like any extra", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    await insertRowWith(t, insertTypeId, "Gold", { sportlots: "B" });
    const res = await store(t, insertTypeId, [
      { value: "Anime", sportlots: ["", "B"] },
      { value: "Fresh", sportlots: ["", "C"] },
    ]);

    const rows = await insertsUnder(t, insertTypeId);
    // B is held by a sibling: left off. C is free: taken.
    expect(slotIds(rows.find((r) => r.value === "Anime")!, "sportlots")).toEqual([]);
    expect(slotIds(rows.find((r) => r.value === "Fresh")!, "sportlots")).toEqual(["C"]);
    expect(res.withheldElsewhere.map((e) => e.label)).toEqual(["Anime"]);
    expect(await holderCount(t, "sportlots", "B")).toBe(1);
  });
});
