/**
 * NEO-325 — what `storeReconciledOptions` TELLS the operator.
 *
 * Until NEO-325 a sibling-level withhold and a refused title edit were
 * log-only, so a twin saved after its namesake vanished silently. The store
 * now returns `withheldSiblings` (itemIndex into the items sent, reason, the
 * sibling rows the decision is about) and `renameRefused` (with `clashWith`,
 * the row in the way; the row's LINKS are still applied), both capped at
 * `UNLINK_NOTICE_LIMIT` with the true count in the matching `*Total`. An
 * `identityOnly` line is inserted as its own row instead of being folded into
 * its namesake. Fixture shape: `selectorSyncHeldInSet.test.ts`.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { slotIds } from "./platformSlots";
import { UNLINK_NOTICE_LIMIT } from "./selectorSyncStore";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_neo325_store_twins", role: "admin" };
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
  return { insertTypeId };
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
  bsc?: string;
  sportlots?: string;
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
        ...(i.bsc ? { bsc: i.bsc } : {}),
        ...(i.sportlots ? { sportlots: i.sportlots } : {}),
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

describe("storeReconciledOptions — withheldSiblings (NEO-325)", () => {
  test("two lines sharing a name no row has: both reported nameSharedInBatch with their itemIndex, and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);

    const res = await store(t, insertTypeId, [
      { value: "Anime", sportlots: "s1" },
      { value: "Gold", sportlots: "s9" },
      { value: "Anime", sportlots: "s2" },
    ]);

    expect(res.withheldSiblings).toEqual([
      { itemIndex: 0, label: "Anime", reason: "nameSharedInBatch", rows: [] },
      { itemIndex: 2, label: "Anime", reason: "nameSharedInBatch", rows: [] },
    ]);
    expect(res.withheldSiblingsTotal).toBe(2);
    expect((await insertsUnder(t, insertTypeId)).map((r) => r.value)).toEqual(["Gold"]);
  });

  test("a namesake linked to a different live set: reported with the row's id and NB name", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    const rowId = await insertRowWith(t, insertTypeId, "Anime", { sportlots: "old" });

    const res = await store(
      t,
      insertTypeId,
      [{ value: "Anime", sportlots: "new" }, { value: "Other", sportlots: "old" }],
      { coveredSides: ["sportlots"], returnedIds: { sportlots: ["old", "new"] } },
    );

    const w = res.withheldSiblings.find((e) => e.itemIndex === 0);
    expect(w).toEqual({
      itemIndex: 0,
      label: "Anime",
      reason: "nameLinkedToOtherSet",
      rows: [{ id: rowId, value: "Anime" }],
    });
  });

  test("a withheld line with no marketplace id is not reported: it has no link to lose", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    await insertRowWith(t, insertTypeId, "Anime", { sportlots: "s1" });

    const res = await store(t, insertTypeId, [{ value: "Anime" }]);

    expect(res.withheldSiblings).toEqual([]);
    expect(res.withheldSiblingsTotal).toBe(0);
  });

  test("a clean store reports empty lists and zero totals", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);

    const res = await store(t, insertTypeId, [{ value: "Anime", sportlots: "s1" }]);

    expect(res.withheldSiblings).toEqual([]);
    expect(res.withheldSiblingsTotal).toBe(0);
    expect(res.renameRefused).toEqual([]);
    expect(res.renameRefusedTotal).toBe(0);
  });

  test("the list is capped at UNLINK_NOTICE_LIMIT while the total keeps the true count", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    const pairs = Math.ceil((UNLINK_NOTICE_LIMIT + 10) / 2);
    const items: Line[] = [];
    for (let i = 0; i < pairs; i++) {
      items.push({ value: `Name ${i}`, sportlots: `a${i}` });
      items.push({ value: `Name ${i}`, sportlots: `b${i}` });
    }

    const res = await store(t, insertTypeId, items);

    expect(res.withheldSiblingsTotal).toBe(pairs * 2);
    expect(res.withheldSiblings).toHaveLength(UNLINK_NOTICE_LIMIT);
    expect(res.withheldSiblings[0].itemIndex).toBe(0);
  });
});

describe("storeReconciledOptions — identityOnly (NEO-325)", () => {
  test("a promoted line is inserted as its own row beside a same-named row holding another id", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    const first = await insertRowWith(t, insertTypeId, "Anime", { sportlots: "s1" });

    const res = await store(
      t,
      insertTypeId,
      [{ value: "Anime", sportlots: "s2", identityOnly: true }],
      { coveredSides: ["sportlots"], returnedIds: { sportlots: ["s1", "s2"] } },
    );

    expect(res.withheldSiblings).toEqual([]);
    const rows = await insertsUnder(t, insertTypeId);
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r._id === first)!;
    expect(slotIds(original, "sportlots")).toEqual(["s1"]);
    const created = rows.find((r) => r._id !== first)!;
    expect(created.value).toBe("Anime");
    expect(slotIds(created, "sportlots")).toEqual(["s2"]);
  });

  test("without identityOnly the same line is withheld, not inserted", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    await insertRowWith(t, insertTypeId, "Anime", { sportlots: "s1" });

    const res = await store(
      t,
      insertTypeId,
      [{ value: "Anime", sportlots: "s2" }, { value: "Keep", sportlots: "s1" }],
      { coveredSides: ["sportlots"], returnedIds: { sportlots: ["s1", "s2"] } },
    );

    expect(res.withheldSiblings.map((e) => e.reason)).toEqual(["nameLinkedToOtherSet"]);
    expect(await insertsUnder(t, insertTypeId)).toHaveLength(1);
  });
});

describe("storeReconciledOptions — renameRefused (NEO-325)", () => {
  test("a title that clashes with another row is refused with clashWith, and the row's links are still applied", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    const a = await insertRowWith(t, insertTypeId, "Alpha", { bsc: "b1" });
    const b = await insertRowWith(t, insertTypeId, "Beta", { bsc: "b2" });

    const res = await store(t, insertTypeId, [
      { value: "Beta", bsc: "b1", sportlots: "s9", existingId: a },
    ]);

    expect(res.renameRefused).toEqual([
      {
        itemIndex: 0,
        rowId: a,
        value: "Alpha",
        requested: "Beta",
        reason: "clash",
        clashWith: { id: b, value: "Beta" },
      },
    ]);
    expect(res.renameRefusedTotal).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(a));
    expect(row?.value).toBe("Alpha");
    expect(slotIds(row!, "sportlots")).toEqual(["s9"]);
  });

  test("a title that is not usable is refused as invalid, with no clashWith", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    const a = await insertRowWith(t, insertTypeId, "Alpha", { bsc: "b1" });

    const res = await store(t, insertTypeId, [
      { value: "x".repeat(400), bsc: "b1", existingId: a },
    ]);

    expect(res.renameRefused).toHaveLength(1);
    expect(res.renameRefused[0]).toMatchObject({ itemIndex: 0, rowId: a, reason: "invalid" });
    expect(res.renameRefused[0].clashWith).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(a)))?.value).toBe("Alpha");
  });

  test("a successful rename is not reported", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    const a = await insertRowWith(t, insertTypeId, "Alpha", { bsc: "b1" });

    const res = await store(t, insertTypeId, [
      { value: "Alpha Renamed", bsc: "b1", existingId: a },
    ]);

    expect(res.renameRefused).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(a)))?.value).toBe("Alpha Renamed");
  });
});
