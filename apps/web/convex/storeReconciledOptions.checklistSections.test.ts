/**
 * NEO-496 (D7) — `storeReconciledOptions` saving a set's checklist sections
 * on the rows a variant sync lands.
 *
 * Per item `checklistSectionKeys`: absent = the row's links untouched;
 * present = REPLACE them ([] clears). Written through the one link writer
 * (`setRowChecklistSections`), counted in `writeOps`, a no-op on a replay.
 *
 * An id-less line carrying sections (a section "made its own set") is found
 * by its sections on a re-sync, so it never duplicates; its name or its
 * sections clashing with a sibling withholds it and says so
 * (`nameTakenBySibling`, `nameSharedInBatch`, `checklistKeyHeldByMany`).
 * Fixture shape: `storeReconciledOptions.nameTwins.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { linksForRow, setRowChecklistSections } from "./lib/publishedChecklistSections";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_neo496_store_sections", role: "admin" };
const SENTINEL = 1_000_000;

type T = ReturnType<typeof convexTest>;
type RowId = Id<"selectorOptions">;
type Row = Doc<"selectorOptions">;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
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

const SECTION_NAMES = [
  "Base",
  "Future Stars",
  "Radiating Rookies",
  "Expose",
  "Chrome Legends Autographs",
];

/** sport → year → brand → set (with a ready checklist) → Insert variant type. */
async function seed(t: T) {
  const sportId = await insertRow(t, { level: "sport", value: "Baseball" });
  const yearId = await insertRow(t, { level: "year", value: "2025", parentId: sportId });
  const brandId = await insertRow(t, { level: "manufacturer", value: "Topps", parentId: yearId });
  const setId = await insertRow(t, {
    level: "setName",
    value: "Topps Chrome",
    parentId: brandId,
    platformData: { bsc: { b0: "topps-chrome" } },
    platformFacets: { bsc: { b0: "setName" } },
    platformSlotSeq: { bsc: 1 },
  });
  const insertTypeId = await insertRow(t, {
    level: "variantType",
    value: "Insert",
    parentId: setId,
    features: { season: "2025" },
  });
  const otherTypeId = await insertRow(t, {
    level: "variantType",
    value: "Parallel",
    parentId: setId,
    features: { season: "2025" },
  });

  const who = t.withIdentity(ADMIN);
  const { checklistId } = await who.mutation(api.publishedChecklists.start, {
    setId,
    fileName: "topps-chrome.csv",
    format: "csv",
  });
  await who.mutation(api.publishedChecklists.addSections, {
    checklistId,
    firstOrdinal: 0,
    sections: SECTION_NAMES.map((name, s) => ({
      name,
      rows: [{ number: `${s + 1}`, players: [`Player ${s + 1}`], teams: ["Team"] }],
    })),
  });
  await who.mutation(api.publishedChecklists.finish, {
    checklistId,
    sectionCount: SECTION_NAMES.length,
    rowCount: SECTION_NAMES.length,
  });
  return { setId, insertTypeId, otherTypeId };
}

type Line = {
  value: string;
  bsc?: string;
  existingId?: RowId;
  identityOnly?: boolean;
  checklistSectionKeys?: string[];
};

function store(t: T, parentId: RowId, items: Line[]) {
  return t.withIdentity(ADMIN).mutation(api.setReconciliation.storeReconciledOptions, {
    level: "insert",
    parentId,
    reconciledItems: items.map((i) => ({
      value: i.value,
      platformData: i.bsc ? { bsc: i.bsc } : {},
      metadata: undefined,
      ...(i.existingId ? { existingId: i.existingId } : {}),
      ...(i.identityOnly ? { identityOnly: true } : {}),
      ...(i.checklistSectionKeys !== undefined
        ? { checklistSectionKeys: i.checklistSectionKeys }
        : {}),
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

async function keysOf(t: T, rowId: RowId): Promise<string[]> {
  return t.run(async (ctx) =>
    (await linksForRow(ctx.db, rowId)).map((l) => l.sectionKey).sort(),
  );
}

async function rowNamed(t: T, parentId: RowId, value: string): Promise<Row> {
  const row = (await insertsUnder(t, parentId)).find((r) => r.value === value);
  if (!row) throw new Error(`no row named ${value}`);
  return row;
}

describe("storeReconciledOptions — checklistSectionKeys (NEO-496 D7)", () => {
  test("a marketplace line with sections: the row it lands on links them, by key or by name", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);

    await store(t, insertTypeId, [
      { value: "Radiating Rookies", bsc: "b-rr", checklistSectionKeys: ["Radiating Rookies"] },
      { value: "Gold Wave", bsc: "b-gw" },
    ]);

    const rr = await rowNamed(t, insertTypeId, "Radiating Rookies");
    expect(await keysOf(t, rr._id)).toEqual(["radiating rookies"]);
    const gw = await rowNamed(t, insertTypeId, "Gold Wave");
    expect(await keysOf(t, gw._id)).toEqual([]);
  });

  test("link writes are counted in writeOps, and a replay writes nothing", async () => {
    const withKeys: Line = {
      value: "Future Stars",
      bsc: "b-fs",
      checklistSectionKeys: ["future stars", "expose"],
    };
    const withoutKeys: Line = { value: "Future Stars", bsc: "b-fs" };

    // The same line into two fresh sets, with and without its sections.
    const a = convexTest(schema, modules);
    const aSeed = await seed(a);
    const b = convexTest(schema, modules);
    const bSeed = await seed(b);
    const firstWith = await store(a, aSeed.insertTypeId, [withKeys]);
    const firstWithout = await store(b, bSeed.insertTypeId, [withoutKeys]);
    expect(firstWith.writeOps - firstWithout.writeOps).toBe(2);

    // A replay of the same list writes no link: the same ops as a plain replay.
    const replayWith = await store(a, aSeed.insertTypeId, [withKeys]);
    const replayWithout = await store(b, bSeed.insertTypeId, [withoutKeys]);
    expect(replayWith.writeOps).toBe(replayWithout.writeOps);
    expect(replayWith.itemsProcessed).toBe(1);
    const fs = await rowNamed(a, aSeed.insertTypeId, "Future Stars");
    expect(await keysOf(a, fs._id)).toEqual(["expose", "future stars"]);
    expect(await insertsUnder(a, aSeed.insertTypeId)).toHaveLength(1);

    // Swapping one section is one delete and one insert.
    const swapped = await store(a, aSeed.insertTypeId, [
      { ...withKeys, checklistSectionKeys: ["future stars", "radiating rookies"] },
    ]);
    expect(swapped.writeOps - replayWithout.writeOps).toBe(2);
  });

  test("present keys replace the row's links; absent keys leave them; [] clears them", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    await store(t, insertTypeId, [
      { value: "Future Stars", bsc: "b-fs", checklistSectionKeys: ["future stars", "expose"] },
    ]);
    const fs = await rowNamed(t, insertTypeId, "Future Stars");

    await store(t, insertTypeId, [
      { value: "Future Stars", bsc: "b-fs", existingId: fs._id, checklistSectionKeys: ["expose", "radiating rookies"] },
    ]);
    expect(await keysOf(t, fs._id)).toEqual(["expose", "radiating rookies"]);

    await store(t, insertTypeId, [{ value: "Future Stars", bsc: "b-fs", existingId: fs._id }]);
    expect(await keysOf(t, fs._id)).toEqual(["expose", "radiating rookies"]);

    await store(t, insertTypeId, [
      { value: "Future Stars", bsc: "b-fs", existingId: fs._id, checklistSectionKeys: [] },
    ]);
    expect(await keysOf(t, fs._id)).toEqual([]);
  });

  test("a key the set's checklist does not hold is refused, and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);

    await expect(
      store(t, insertTypeId, [
        { value: "Future Stars", bsc: "b-fs", checklistSectionKeys: ["not a section"] },
      ]),
    ).rejects.toThrow();
    expect(await insertsUnder(t, insertTypeId)).toEqual([]);
  });

  test("a section made its own set (no marketplace id): inserted once, and a re-sync lands on the same row", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    const line: Line = {
      value: "Chrome Legends Autographs",
      identityOnly: true,
      checklistSectionKeys: ["chrome legends autographs"],
    };

    const first = await store(t, insertTypeId, [line]);
    expect(first.withheldSiblings).toEqual([]);
    const row = await rowNamed(t, insertTypeId, "Chrome Legends Autographs");
    expect(row.platformData).toEqual({});
    expect(await keysOf(t, row._id)).toEqual(["chrome legends autographs"]);

    // Again, with no existingId: found by its section, not by its name.
    const second = await store(t, insertTypeId, [line]);
    expect(second.withheldSiblings).toEqual([]);
    expect(await insertsUnder(t, insertTypeId)).toHaveLength(1);

    // Even after the operator renamed the row.
    await t.run((ctx) => ctx.db.patch(row._id, { value: "Legends Autos" }));
    await store(t, insertTypeId, [line]);
    const rows = await insertsUnder(t, insertTypeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(row._id);
  });

  test("an id-less section line whose name a sibling already has: withheld nameTakenBySibling", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);
    const sibling = await insertRow(t, {
      level: "insert",
      value: "Future Stars",
      parentId: insertTypeId,
    });

    const res = await store(t, insertTypeId, [
      { value: "Future Stars", identityOnly: true, checklistSectionKeys: ["future stars"] },
    ]);

    expect(res.withheldSiblings).toEqual([
      {
        itemIndex: 0,
        label: "Future Stars",
        reason: "nameTakenBySibling",
        rows: [{ id: sibling, value: "Future Stars" }],
      },
    ]);
    expect(await insertsUnder(t, insertTypeId)).toHaveLength(1);
    expect(await keysOf(t, sibling)).toEqual([]);
  });

  test("two id-less section lines with one name in the batch: both withheld nameSharedInBatch", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);

    const res = await store(t, insertTypeId, [
      { value: "Legends", identityOnly: true, checklistSectionKeys: ["chrome legends autographs"] },
      { value: "Legends", identityOnly: true, checklistSectionKeys: ["expose"] },
    ]);

    expect(res.withheldSiblings.map((w) => [w.itemIndex, w.reason])).toEqual([
      [0, "nameSharedInBatch"],
      [1, "nameSharedInBatch"],
    ]);
    expect(await insertsUnder(t, insertTypeId)).toEqual([]);
  });

  test("an id-less line whose sections two siblings link: withheld checklistKeyHeldByMany, naming both", async () => {
    const t = convexTest(schema, modules);
    const { setId, insertTypeId } = await seed(t);
    const a = await insertRow(t, { level: "insert", value: "Expose", parentId: insertTypeId });
    const b = await insertRow(t, { level: "insert", value: "Future Stars", parentId: insertTypeId });
    await t.run(async (ctx) => {
      await setRowChecklistSections(ctx, { rowId: a, setId, keys: ["expose"], userId: ADMIN.subject });
      await setRowChecklistSections(ctx, { rowId: b, setId, keys: ["future stars"], userId: ADMIN.subject });
    });

    const res = await store(t, insertTypeId, [
      {
        value: "Expose and Future Stars",
        identityOnly: true,
        checklistSectionKeys: ["expose", "future stars"],
      },
    ]);

    expect(res.withheldSiblings).toHaveLength(1);
    expect(res.withheldSiblings[0]).toMatchObject({
      itemIndex: 0,
      reason: "checklistKeyHeldByMany",
    });
    expect(res.withheldSiblings[0].rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(await insertsUnder(t, insertTypeId)).toHaveLength(2);
    expect(await keysOf(t, a)).toEqual(["expose"]);
    expect(await keysOf(t, b)).toEqual(["future stars"]);
  });

  test("an id-less line whose section a row under ANOTHER type links is withheld, not moved", async () => {
    const t = convexTest(schema, modules);
    const { setId, insertTypeId, otherTypeId } = await seed(t);
    const elsewhere = await insertRow(t, { level: "insert", value: "Expose", parentId: otherTypeId });
    await t.run((ctx) =>
      setRowChecklistSections(ctx, { rowId: elsewhere, setId, keys: ["expose"], userId: ADMIN.subject }),
    );

    const res = await store(t, insertTypeId, [
      { value: "Expose", identityOnly: true, checklistSectionKeys: ["expose"] },
    ]);

    expect(res.withheldSiblings.map((w) => w.reason)).toEqual(["checklistKeyHeldByMany"]);
    expect(await insertsUnder(t, insertTypeId)).toEqual([]);
    expect(await keysOf(t, elsewhere)).toEqual(["expose"]);
  });

  test("a section attached to an existing row by existingId: its links are the full set sent", async () => {
    const t = convexTest(schema, modules);
    const { setId, insertTypeId } = await seed(t);
    const row = await insertRow(t, {
      level: "insert",
      value: "Future Stars",
      parentId: insertTypeId,
      platformData: { bsc: { b0: "b-fs" } },
      platformSlotSeq: { bsc: 1 },
    });
    await t.run((ctx) =>
      setRowChecklistSections(ctx, { rowId: row, setId, keys: ["future stars"], userId: ADMIN.subject }),
    );

    await store(t, insertTypeId, [
      {
        value: "Future Stars",
        bsc: "b-fs",
        existingId: row,
        checklistSectionKeys: ["future stars", "radiating rookies"],
      },
    ]);
    expect(await keysOf(t, row)).toEqual(["future stars", "radiating rookies"]);
  });
});
