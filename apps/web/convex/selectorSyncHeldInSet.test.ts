/**
 * NEO-312 — one marketplace link lives on one NB row: the sync stores look
 * for an incoming id's holder across the whole SET (every variant type, the
 * Base's own slots, inserts and parallels) and, for a SportLots id, across the
 * brand's other sets — not only among their siblings and the one variant type
 * NEO-300 covered.
 *
 * The bug: "Make insert of…" (NEO-306) moves a SportLots link out of the
 * Parallel type onto a row under the Insert type and deletes the source; the
 * next Sync Parallels (or a reconcile dialog opened before the move) saw no
 * row holding that id among its siblings, matched nothing, and created the row
 * again — two NB rows, one SportLots link. Same shape after "Make parallel
 * of…" for Sync Inserts, and after "Promote to set" across the brand.
 *
 * What is pinned, for both stores where the shape allows:
 *  - after each move, the next sync writes NO row, exactly one row holds the
 *    id, and `heldElsewhere` names the holder with its NB path;
 *  - a stale `existingId` (the deleted source) and a BSC+SportLots pair are
 *    held the same way, and the BSC half is attached nowhere;
 *  - the sync's own parent insert is a holder (a NEW parallel cannot take its
 *    id), while a parallel already carrying it still matches (sibling wins);
 *  - a re-sync of rows the sync already owns is unchanged (no writes);
 *  - a bound that stops a walk FAILS CLOSED: the item is withheld and
 *    reported (`notChecked`), never stored on the sibling-only rule.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { slotIds } from "./platformSlots";
import {
  MAX_BRAND_WALK_DOCUMENTS,
  MAX_SUBTREE_WALK_INSERTS,
  WALK_BYTES_RESERVE,
  loadSyncHoldersElsewhere,
} from "./selectorSyncStore";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_neo312_held", role: "admin" };
const SENTINEL = 1_000_000;

type T = ReturnType<typeof convexTest>;
type RowId = Id<"selectorOptions">;
type Row = Doc<"selectorOptions">;

beforeEach(() => {
  // The stores log withholds and walk skips; intentional in prod, noise here.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// ───────────────────────────────────────────────────────────────────────────
// Fixture — 2026 Bowman as NEO-306's tests build it
// ───────────────────────────────────────────────────────────────────────────

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

function roleType(role: "base" | "insert" | "parallel") {
  return {
    platformData: { bsc: { b0: role } },
    platformFacets: { bsc: { b0: "variant" as const } },
    platformSlotSeq: { bsc: 1 },
    metadata: role === "base" ? { isBase: true } : { variantRole: role },
  };
}

function slLinks(links: Array<{ id: string; label: string }>) {
  return {
    platformData: {
      sportlots: Object.fromEntries(links.map((l, i) => [`s${i}`, l.id])),
    },
    platformLabels: {
      sportlots: Object.fromEntries(links.map((l, i) => [`s${i}`, l.label])),
    },
    platformSlotSeq: { sportlots: links.length },
  };
}

async function seed(t: T) {
  const sportId = await insertRow(t, { level: "sport", value: "Baseball" });
  const yearId = await insertRow(t, { level: "year", value: "2026", parentId: sportId });
  const brandId = await insertRow(t, {
    level: "manufacturer",
    value: "Bowman",
    parentId: yearId,
    metadata: { setNamePrefix: "Bowman" },
  });
  const bowmanId = await insertRow(t, {
    level: "setName",
    value: "Bowman",
    parentId: brandId,
    platformData: { bsc: { b0: "bowman" } },
    platformFacets: { bsc: { b0: "setName" } },
    platformSlotSeq: { bsc: 1 },
  });
  const baseId = await insertRow(t, {
    level: "variantType",
    value: "Base",
    parentId: bowmanId,
    ...roleType("base"),
    // The Base carries its SportLots links on itself; the second is not the
    // primary label, so the forms' base-anchor filter does not drop it.
    platformData: { bsc: { b0: "base" }, sportlots: { s0: "SL-BOWMAN", s1: "SL-BOWMAN-2" } },
    platformLabels: { sportlots: { s0: "2026 Bowman", s1: "2026 Bowman Part 2" } },
    platformSlotSeq: { bsc: 1, sportlots: 2 },
  });
  const parallelTypeId = await insertRow(t, {
    level: "variantType",
    value: "Parallel",
    parentId: bowmanId,
    ...roleType("parallel"),
  });
  const insertTypeId = await insertRow(t, {
    level: "variantType",
    value: "Insert",
    parentId: bowmanId,
    features: { season: "2026" },
    ...roleType("insert"),
  });
  const autosId = await insertRow(t, {
    level: "insert",
    value: "All-America Game Autos",
    parentId: insertTypeId,
    platformData: { bsc: { b0: "aa-autos" } },
    platformFacets: { bsc: { b0: "variantName" } },
    platformLabels: { bsc: { b0: "All-America Game Autos" } },
    platformSlotSeq: { bsc: 1 },
    metadata: { isInsert: true },
    features: { season: "2026", cardType: "Insert" },
  });
  const goldId = await insertRow(t, {
    level: "parallel",
    value: "Gold",
    parentId: autosId,
    platformData: { bsc: { b0: "aa-autos-gold" } },
    platformFacets: { bsc: { b0: "variantName" } },
    platformSlotSeq: { bsc: 1 },
    metadata: { isParallel: true },
  });
  return { yearId, brandId, bowmanId, baseId, parallelTypeId, insertTypeId, autosId, goldId };
}

/** An insert-level row the Parallels reconcile filed under Bowman › Parallel (S2). */
function slRow(
  t: T,
  parentId: RowId,
  value: string,
  links: Array<{ id: string; label: string }>,
) {
  return insertRow(t, {
    level: "insert",
    value,
    parentId,
    ...slLinks(links),
    metadata: { isParallel: true },
    features: { cardType: "Parallel", season: "2026" },
  });
}

/** A SportLots-only set that is nothing but a Base (the shape Sync Sets mints). */
async function slSet(
  t: T,
  brandId: RowId,
  name: string,
  links: Array<{ id: string; label: string }>,
) {
  const setId = await insertRow(t, { level: "setName", value: name, parentId: brandId });
  const baseId = await insertRow(t, {
    level: "variantType",
    value: "Base",
    parentId: setId,
    metadata: { isBase: true },
    features: { cardType: "Base", parallelName: "Base" },
    ...slLinks(links),
  });
  return { setId, baseId };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const as = (t: T) => t.withIdentity(ADMIN);

/** Every row holding `id` on `side`, anywhere. */
async function holdersOf(t: T, side: "bsc" | "sportlots", id: string): Promise<Row[]> {
  return t.run(async (ctx) =>
    (await ctx.db.query("selectorOptions").collect()).filter((r) =>
      slotIds(r, side).includes(id),
    ),
  );
}

async function childrenAt(t: T, level: Row["level"], parentId: RowId) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) => q.eq("level", level).eq("parentId", parentId))
      .collect(),
  );
}

async function rowCount(t: T) {
  return t.run(async (ctx) => (await ctx.db.query("selectorOptions").collect()).length);
}

/** Sync Parallels / Sync Inserts: the reconcile store at `insert` under a variant type. */
function reconcile(
  t: T,
  parentId: RowId,
  items: Array<{
    value: string;
    bsc?: string;
    sportlots?: string;
    existingId?: RowId;
  }>,
  level: "insert" | "parallel" | "setName" = "insert",
  opts: {
    coveredSides?: Array<"bsc" | "sportlots">;
    returnedIds?: { bsc?: string[]; sportlots?: string[] };
  } = {},
) {
  return as(t).mutation(api.setReconciliation.storeReconciledOptions, {
    level,
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
    })),
  });
}

/** The single-platform path's store. */
function storeSelector(
  t: T,
  parentId: RowId,
  options: Array<{ value: string; bsc?: string; sportlots?: string }>,
  level: "insert" | "setName" = "insert",
) {
  return as(t).mutation(api.selectorOptions.storeSelectorOptions, {
    level,
    parentId,
    options: options.map((o) => ({
      value: o.value,
      platformData: {
        ...(o.bsc ? { bsc: o.bsc } : {}),
        ...(o.sportlots ? { sportlots: o.sportlots } : {}),
      },
    })),
  });
}

function convertToInsert(
  t: T,
  rowId: RowId,
  targetInsertTypeId: RowId,
  landing:
    | { kind: "joinInsert"; insertId: RowId }
    | { kind: "newParallel"; insertId: RowId }
    | { kind: "newInsertNamed"; name: string },
) {
  return as(t).mutation(api.setInsertConversion.convertToInsert, {
    rowId,
    targetInsertTypeId,
    landing,
  });
}

function heldSummary(entries: Array<{ id: RowId; level: string; path?: string[] }>) {
  return entries.map((e) => ({ id: String(e.id), level: e.level, path: e.path }));
}

const RED_INK = { id: "SL-RED-INK", label: "Bowman All-America Game Autos Red Ink" };

// ───────────────────────────────────────────────────────────────────────────
// Make insert of… → Sync Parallels
// ───────────────────────────────────────────────────────────────────────────

describe("after Make insert of…, the next Sync Parallels does not re-create the row (NEO-312)", () => {
  const landings = [
    {
      name: "newParallel",
      landing: (ids: Awaited<ReturnType<typeof seed>>) =>
        ({ kind: "newParallel", insertId: ids.autosId }) as const,
      holderLevel: "parallel",
      path: ["Bowman", "Insert", "All-America Game Autos"],
    },
    {
      name: "joinInsert",
      landing: (ids: Awaited<ReturnType<typeof seed>>) =>
        ({ kind: "joinInsert", insertId: ids.autosId }) as const,
      holderLevel: "insert",
      path: ["Bowman", "Insert"],
    },
    {
      name: "newInsertNamed",
      landing: () => ({ kind: "newInsertNamed", name: "Red Ink Autos" }) as const,
      holderLevel: "parallel",
      path: ["Bowman", "Insert", "Red Ink Autos"],
    },
  ];

  for (const { name, landing, holderLevel, path } of landings) {
    test(`${name}: no row written, one row holds the link, heldElsewhere names it`, async () => {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      const source = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [RED_INK]);
      await convertToInsert(t, source, ids.insertTypeId, landing(ids));
      const [holder] = await holdersOf(t, "sportlots", RED_INK.id);
      expect(holder.level).toBe(holderLevel);
      const before = await rowCount(t);

      const res = await reconcile(t, ids.parallelTypeId, [
        { value: "All-America Game Autos Red Ink", sportlots: RED_INK.id },
      ]);

      expect(await rowCount(t)).toBe(before);
      expect(await childrenAt(t, "insert", ids.parallelTypeId)).toEqual([]);
      const after = await holdersOf(t, "sportlots", RED_INK.id);
      expect(after.map((r) => r._id)).toEqual([holder._id]);
      expect(after[0].lastUpdated).toBe(holder.lastUpdated);
      expect(res.heldElsewhereTotal).toBe(1);
      expect(heldSummary(res.heldElsewhere)).toEqual([
        { id: String(holder._id), level: holderLevel, path },
      ]);
      expect(res.withheldElsewhereTotal).toBe(0);
      expect(res.optionsCount).toBe(0);
    });
  }

  test("a stale dialog's existingId (the deleted source) is held, not re-created", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const source = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [RED_INK]);
    // The dialog opened here: it restored the source as a Ready set.
    await convertToInsert(t, source, ids.insertTypeId, { kind: "newParallel", insertId: ids.autosId });
    const before = await rowCount(t);

    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "All-America Game Autos Red Ink", sportlots: RED_INK.id, existingId: source },
    ]);

    expect(await rowCount(t)).toBe(before);
    expect(await holdersOf(t, "sportlots", RED_INK.id)).toHaveLength(1);
    expect(res.heldElsewhereTotal).toBe(1);
  });

  test("a BSC + SportLots pair is held whole: no row, and the BSC half attached nowhere", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const source = await slRow(t, ids.parallelTypeId, "Red Ink", [RED_INK]);
    await convertToInsert(t, source, ids.insertTypeId, { kind: "newParallel", insertId: ids.autosId });
    const before = await rowCount(t);

    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "Red Ink", bsc: "bsc-red-ink", sportlots: RED_INK.id },
    ]);

    expect(await rowCount(t)).toBe(before);
    expect(await holdersOf(t, "sportlots", RED_INK.id)).toHaveLength(1);
    expect(await holdersOf(t, "bsc", "bsc-red-ink")).toEqual([]);
    expect(res.heldElsewhereTotal).toBe(1);
  });

  test("the single-platform store holds it the same way", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const source = await slRow(t, ids.parallelTypeId, "Red Ink", [RED_INK]);
    await convertToInsert(t, source, ids.insertTypeId, { kind: "joinInsert", insertId: ids.autosId });
    const before = await rowCount(t);

    const res = await storeSelector(t, ids.parallelTypeId, [
      { value: "Red Ink", sportlots: RED_INK.id },
      // A genuinely new set in the same sync is still stored.
      { value: "Sky Blue", sportlots: "SL-SKY-BLUE" },
    ]);

    expect(await rowCount(t)).toBe(before + 1);
    expect(await holdersOf(t, "sportlots", RED_INK.id)).toHaveLength(1);
    expect((await childrenAt(t, "insert", ids.parallelTypeId)).map((r) => r.value)).toEqual([
      "Sky Blue",
    ]);
    expect(res.heldElsewhereTotal).toBe(1);
    expect(heldSummary(res.heldElsewhere)[0]).toMatchObject({ level: "insert" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Make parallel of… → Sync Inserts; Promote to set → stale Sync Parallels
// ───────────────────────────────────────────────────────────────────────────

describe("the other moves stick too (NEO-312)", () => {
  test("Make parallel of… then Sync Inserts: the link on a Parallel-type row is held", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sky = { id: "SL-SKY", label: "Bowman Sky Blue" };
    const { setId } = await slSet(t, ids.brandId, "Bowman Sky Blue", [sky]);
    const moved = await as(t).mutation(api.setParallelConversion.convertSetToParallel, {
      setId,
      targetParallelTypeId: ids.parallelTypeId,
    });
    const before = await rowCount(t);

    const res = await reconcile(t, ids.insertTypeId, [
      { value: "Sky Blue", sportlots: sky.id },
    ]);

    expect(await rowCount(t)).toBe(before);
    const holders = await holdersOf(t, "sportlots", sky.id);
    expect(holders.map((r) => r._id)).toEqual([moved.parallelId]);
    expect(heldSummary(res.heldElsewhere)).toEqual([
      { id: String(moved.parallelId), level: "insert", path: ["Bowman", "Parallel"] },
    ]);
  });

  test("Promote to set, then a Sync Parallels dialog opened before it: held across the brand", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sky = { id: "SL-SKY", label: "Bowman Sky Blue" };
    const row = await slRow(t, ids.parallelTypeId, "Sky Blue", [sky]);
    const promoted = await as(t).mutation(api.setParallelConversion.promoteParallelToSet, {
      parallelId: row,
      slSlotKey: "s0",
    });
    expect(promoted.parallelKept).toBe(false);
    const before = await rowCount(t);

    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "Sky Blue", sportlots: sky.id, existingId: row },
    ]);

    expect(await rowCount(t)).toBe(before);
    const holders = await holdersOf(t, "sportlots", sky.id);
    expect(holders.map((r) => r._id)).toEqual([promoted.baseId]);
    expect(heldSummary(res.heldElsewhere)).toEqual([
      { id: String(promoted.baseId), level: "variantType", path: [promoted.setValue] },
    ]);
  });

  test("a SportLots id on the set's own Base (not its primary) is held", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "Part 2", sportlots: "SL-BOWMAN-2" },
    ]);
    expect(await childrenAt(t, "insert", ids.parallelTypeId)).toEqual([]);
    expect(heldSummary(res.heldElsewhere)).toEqual([
      { id: String(ids.baseId), level: "variantType", path: ["Bowman"] },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Siblings win; the parent insert is a holder
// ───────────────────────────────────────────────────────────────────────────

describe("what rows already hold does not change (NEO-312)", () => {
  test("a re-sync of the sync's own rows is unchanged: matched by id, links as they were, nothing held", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const blue = await slRow(t, ids.parallelTypeId, "Blue", [{ id: "SL-BLUE", label: "Bowman Blue" }]);
    // And a link elsewhere in the set, so the walk does run for the new item.
    await insertRow(t, {
      level: "parallel",
      value: "Red Ink",
      parentId: ids.autosId,
      ...slLinks([RED_INK]),
    });
    const blueBefore = await t.run(async (ctx) => ctx.db.get(blue));

    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "Blue", sportlots: "SL-BLUE" },
      { value: "Green", sportlots: "SL-GREEN" },
    ]);

    // Matched by its own id: same row, same parent, same links. (The refresh
    // may stamp its primary-slot pointer; that is the store's own
    // bookkeeping, not a link.)
    const blueAfter = await t.run(async (ctx) => ctx.db.get(blue));
    expect(blueAfter?.platformData).toEqual(blueBefore?.platformData);
    expect(blueAfter?.parentId).toBe(blueBefore?.parentId);
    expect((await childrenAt(t, "insert", ids.parallelTypeId)).map((r) => r.value).sort()).toEqual([
      "Blue",
      "Green",
    ]);
    expect(res.heldElsewhereTotal).toBe(0);
    expect(res.withheldElsewhereTotal).toBe(0);
  });

  test("Sync Sub-Variants: a NEW parallel cannot take its parent insert's id; one already carrying it keeps matching", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // The parent insert and its existing parallel both carry SL-AA (data from
    // before this rule); the parallel is a sibling of the sync and wins.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.autosId, {
        platformData: { bsc: { b0: "aa-autos" }, sportlots: { s0: "SL-AA" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
      await ctx.db.patch(ids.goldId, {
        platformData: { bsc: { b0: "aa-autos-gold" }, sportlots: { s0: "SL-AA" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    const goldBefore = await t.run(async (ctx) => ctx.db.get(ids.goldId));

    const res = await reconcile(
      t,
      ids.autosId,
      [
        { value: "Gold", bsc: "aa-autos-gold", sportlots: "SL-AA" },
        // BSC lists the insert's own id as a sub-variant: held by the parent.
        { value: "Autos", bsc: "aa-autos" },
      ],
      "parallel",
    );

    const goldAfter = await t.run(async (ctx) => ctx.db.get(ids.goldId));
    expect(goldAfter?.platformData).toEqual(goldBefore?.platformData);
    expect(goldAfter?.parentId).toBe(ids.autosId);
    expect((await childrenAt(t, "parallel", ids.autosId)).map((r) => r._id)).toEqual([ids.goldId]);
    expect(heldSummary(res.heldElsewhere)).toEqual([
      { id: String(ids.autosId), level: "insert", path: ["Bowman", "Insert"] },
    ]);
  });
});

describe("a matched row does not take a link another row holds (NEO-312)", () => {
  async function blueAndMovedRedInk(t: T) {
    const ids = await seed(t);
    // Blue: one of Sync Parallels' own rows, linked on BSC only.
    const blue = await insertRow(t, {
      level: "insert",
      value: "Blue",
      parentId: ids.parallelTypeId,
      platformData: { bsc: { b0: "blue-v" } },
      platformSlotSeq: { bsc: 1 },
      primaryPlatformId: { bsc: "b0" },
    });
    // The SportLots set "Make insert of…" moved under the Insert type.
    const source = await slRow(t, ids.parallelTypeId, "Red Ink", [RED_INK]);
    await convertToInsert(t, source, ids.insertTypeId, { kind: "newParallel", insertId: ids.autosId });
    const [holder] = await holdersOf(t, "sportlots", RED_INK.id);
    return { ids, blue, holder, source };
  }

  test("matched by BSC id: the held SportLots id is not attached, the holder is named, Blue's links stand", async () => {
    const t = convexTest(schema, modules);
    const { ids, blue, holder } = await blueAndMovedRedInk(t);
    const blueBefore = await t.run(async (ctx) => ctx.db.get(blue));
    const before = await rowCount(t);

    // BSC "Blue" auto-matched with the SportLots set another row holds.
    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "Blue", bsc: "blue-v", sportlots: RED_INK.id },
    ]);

    expect(await rowCount(t)).toBe(before);
    const blueAfter = await t.run(async (ctx) => ctx.db.get(blue));
    expect(blueAfter?.platformData).toEqual(blueBefore?.platformData);
    expect(blueAfter?.platformLabels).toEqual(blueBefore?.platformLabels);
    expect((await holdersOf(t, "sportlots", RED_INK.id)).map((r) => r._id)).toEqual([holder._id]);
    expect(res.withheldElsewhereTotal).toBe(1);
    expect(res.withheldElsewhere[0]).toMatchObject({ label: "Blue", reason: "linkHeldElsewhere" });
    expect(heldSummary(res.withheldElsewhere[0].holders)).toEqual([
      { id: String(holder._id), level: "parallel", path: ["Bowman", "Insert", "All-America Game Autos"] },
    ]);
    // Blue still counts as linked: it matched.
    expect(res.optionsCount).toBe(1);
  });

  test("matched by the modal's existingId: same, and the single-platform store does the same", async () => {
    const t = convexTest(schema, modules);
    const { ids, blue, holder } = await blueAndMovedRedInk(t);

    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "Blue", sportlots: RED_INK.id, existingId: blue },
    ]);
    expect(res.withheldElsewhere[0]).toMatchObject({ label: "Blue", reason: "linkHeldElsewhere" });
    expect((await holdersOf(t, "sportlots", RED_INK.id)).map((r) => r._id)).toEqual([holder._id]);

    const res2 = await storeSelector(t, ids.parallelTypeId, [
      { value: "Blue", bsc: "blue-v", sportlots: RED_INK.id },
    ]);
    expect(res2.withheldElsewhere[0]).toMatchObject({ label: "Blue", reason: "linkHeldElsewhere" });
    expect((await holdersOf(t, "sportlots", RED_INK.id)).map((r) => r._id)).toEqual([holder._id]);
    const blueAfter = await t.run(async (ctx) => ctx.db.get(blue));
    expect(blueAfter?.platformData).toEqual({ bsc: { b0: "blue-v" } });
  });

  test("an id the matched row already holds is never blocked, even when another row holds it too", async () => {
    const t = convexTest(schema, modules);
    const { ids, blue } = await blueAndMovedRedInk(t);
    // Legacy duplicate: Blue also carries the moved id (data from before
    // this rule). Re-syncing it changes nothing and withholds nothing.
    await t.run(async (ctx) => {
      await ctx.db.patch(blue, {
        platformData: { bsc: { b0: "blue-v" }, sportlots: { s0: RED_INK.id } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
        primaryPlatformId: { bsc: "b0", sportlots: "s0" },
      });
    });
    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "Blue", bsc: "blue-v", sportlots: RED_INK.id },
    ]);
    expect(res.withheldElsewhereTotal).toBe(0);
    const blueAfter = await t.run(async (ctx) => ctx.db.get(blue));
    expect(blueAfter?.platformData).toEqual({
      bsc: { b0: "blue-v" },
      sportlots: { s0: RED_INK.id },
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Bounds — fail closed, and the brand walk only when needed
// ───────────────────────────────────────────────────────────────────────────

describe("the holder walk's bounds (NEO-312)", () => {
  test("past the brand walk's bound it is BEST EFFORT: a holder found is still held, the rest is let through, and the truncation is logged (counts only)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await insertRow(t, {
      level: "parallel",
      value: "Red Ink",
      parentId: ids.autosId,
      ...slLinks([RED_INK]),
    });
    // A set the walk reaches BEFORE the bound trips (sets are read first)…
    await slSet(t, ids.brandId, "Bowman Sky Blue", [{ id: "SL-SKY", label: "Bowman Sky Blue" }]);
    // …and another set of the brand bigger than the brand walk may read — one
    // t.run of direct inserts (the children cache is not what is walked).
    await t.run(async (ctx) => {
      const other = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Bowman Draft",
        parentId: ids.brandId,
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      });
      const type = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Parallel",
        parentId: other,
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      });
      for (let i = 0; i < MAX_BRAND_WALK_DOCUMENTS; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "insert",
          value: `Bulk ${i}`,
          parentId: type,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    const before = await rowCount(t);

    const res = await reconcile(t, ids.parallelTypeId, [
      // First-time SportLots set: held by no one, so it sends the store to
      // the brand. Let through — failing closed here broke big brands.
      { value: "New SL Set", sportlots: "SL-NEW" },
      // Held in the set: still held.
      { value: "Red Ink", sportlots: RED_INK.id },
      // Held by a row the brand walk reached before its bound: still held.
      { value: "Sky Blue", sportlots: "SL-SKY" },
      { value: "BSC Only", bsc: "bsc-only" },
    ]);

    expect(res.subtreeWalkSkipped).toBe(false);
    expect(res.withheldElsewhereTotal).toBe(0);
    expect(res.heldElsewhereTotal).toBe(2);
    expect(await rowCount(t)).toBe(before + 2);
    expect(
      (await childrenAt(t, "insert", ids.parallelTypeId)).map((r) => r.value).sort(),
    ).toEqual(["BSC Only", "New SL Set"]);
    expect(await holdersOf(t, "sportlots", "SL-SKY")).toHaveLength(1);

    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("selector_sync_brand_walk_truncated"))!;
    expect(JSON.parse(line)).toMatchObject({ brandWalkTruncated: true, holdersFound: 1 });
    for (const text of ["SL-NEW", "SL-SKY", "Sky Blue", "Bowman"]) {
      expect(line).not.toContain(text);
    }
  });

  test("past the SET walk's bound it still FAILS CLOSED: a new id is withheld, and a matched row does not take a new link", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const blue = await insertRow(t, {
      level: "insert",
      value: "Blue",
      parentId: ids.parallelTypeId,
      platformData: { bsc: { b0: "blue-v" } },
    });
    // A set carrying more insert-level rows than the set walk may read.
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_SUBTREE_WALK_INSERTS; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "insert",
          value: `Bulk ${i}`,
          parentId: ids.insertTypeId,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
    const before = await rowCount(t);

    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "New SL Set", sportlots: "SL-NEW" },
      // Matches Blue by its BSC id; the SportLots id cannot be checked.
      { value: "Blue", bsc: "blue-v", sportlots: "SL-BLUE" },
    ]);

    expect(res.subtreeWalkSkipped).toBe(true);
    expect(res.withheldElsewhere).toEqual([
      { label: "New SL Set", reason: "notChecked", holders: [] },
      { label: "Blue", reason: "notChecked", holders: [] },
    ]);
    expect(await rowCount(t)).toBe(before);
    const blueAfter = await t.run(async (ctx) => ctx.db.get(blue));
    expect(blueAfter?.platformData).toEqual({ bsc: { b0: "blue-v" } });
    expect(await holdersOf(t, "sportlots", "SL-NEW")).toEqual([]);
  });

  test("the brand is read only for a SportLots id the set does not account for", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await slSet(t, ids.brandId, "Bowman Sky Blue", [{ id: "SL-SKY", label: "Bowman Sky Blue" }]);
    const walk = (items: Array<{ value: string; ids: { sportlots?: string; bsc?: string } }>) =>
      t.run(async (ctx) => {
        const parent = await ctx.db.get(ids.parallelTypeId);
        const siblings = await ctx.db
          .query("selectorOptions")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", "insert").eq("parentId", ids.parallelTypeId),
          )
          .collect();
        const r = await loadSyncHoldersElsewhere(ctx, { level: "insert", parent, siblings, items });
        return r && { reads: r.reads, skipped: r.skipped, values: r.rows.map((x) => x.value).sort() };
      });

    // Held in the set (the Base): set walk only — the set get, the variant
    // types, Base/Insert inserts, and the one insert's parallels.
    const inSet = await walk([{ value: "Part 2", ids: { sportlots: "SL-BOWMAN-2" } }]);
    expect(inSet).toEqual({
      reads: 5,
      skipped: false,
      values: ["All-America Game Autos", "Base", "Gold"],
    });
    // Unaccounted for: the brand walk adds the brand get, the sets read, and
    // one children read per non-parallel row of the OTHER set (set, Base).
    const outside = await walk([{ value: "Sky", ids: { sportlots: "SL-SKY" } }]);
    expect(outside).toEqual({
      reads: 9,
      skipped: false,
      values: ["All-America Game Autos", "Base", "Base", "Gold"],
    });
    // BSC never reaches past the set.
    expect(await walk([{ value: "B", ids: { bsc: "nowhere" } }])).toEqual(inSet);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Security audit S3 — the walks are bounded by the transaction's read BYTES
// ───────────────────────────────────────────────────────────────────────────

/** A string of `kb` kilobytes, to give a row real weight in the read budget. */
const heavy = (kb: number) => "x".repeat(kb * 1024);

/**
 * convex-test enforces these limits and answers `getTransactionMetrics()`
 * against them, so a walk that read past the budget would THROW here exactly
 * as it would on Convex; one that respects it completes.
 */
function tightReads(extraBytes: number) {
  return convexTest({
    schema,
    modules,
    transactionLimits: { bytesRead: WALK_BYTES_RESERVE + extraBytes },
  });
}

describe("the holder walks stop on the read-byte budget (NEO-312, audit S3)", () => {
  test("the SET walk fails closed when the remaining read bytes drop below the reserve", async () => {
    const t = tightReads(200 * 1024);
    const ids = await seed(t);
    // Heavy insert-level rows under the Insert type: one read of them spends
    // most of the 200 KB the reserve leaves the walk.
    await t.run(async (ctx) => {
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "insert",
          value: `Heavy ${i}`,
          parentId: ids.insertTypeId,
          platformData: {},
          platformLabels: { bsc: { b0: heavy(30) } },
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();

    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "New SL Set", sportlots: "SL-NEW" },
    ]);

    expect(res.subtreeWalkSkipped).toBe(true);
    expect(res.withheldElsewhere).toEqual([
      { label: "New SL Set", reason: "notChecked", holders: [] },
    ]);
    expect(await childrenAt(t, "insert", ids.parallelTypeId)).toEqual([]);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("selector_sync_subtree_walk_skipped"))!;
    expect(JSON.parse(line)).toMatchObject({ scope: "set", bound: "bytes" });
  });

  test("the BRAND walk truncates on the read-byte budget: a holder found is held, the rest goes through", async () => {
    const t = tightReads(200 * 1024);
    const ids = await seed(t);
    await slSet(t, ids.brandId, "Bowman Sky Blue", [{ id: "SL-SKY", label: "Bowman Sky Blue" }]);
    await t.run(async (ctx) => {
      const other = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Bowman Draft",
        parentId: ids.brandId,
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      });
      const type = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Insert",
        parentId: other,
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      });
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "insert",
          value: `Heavy ${i}`,
          parentId: type,
          platformData: {},
          platformLabels: { bsc: { b0: heavy(30) } },
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();

    const res = await reconcile(t, ids.parallelTypeId, [
      { value: "Sky Blue", sportlots: "SL-SKY" },
      { value: "New SL Set", sportlots: "SL-NEW" },
    ]);

    expect(res.subtreeWalkSkipped).toBe(false);
    expect(res.heldElsewhereTotal).toBe(1);
    expect(res.withheldElsewhereTotal).toBe(0);
    expect((await childrenAt(t, "insert", ids.parallelTypeId)).map((r) => r.value)).toEqual([
      "New SL Set",
    ]);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("selector_sync_brand_walk_truncated"))!;
    expect(JSON.parse(line)).toMatchObject({ brandWalkTruncated: true, bound: "bytes", holdersFound: 1 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit N1 — a blocked incoming id beside an unlinked old one: both reported
// ───────────────────────────────────────────────────────────────────────────

describe("a row's old id is unlinked while its new id is blocked: both notices say so (NEO-312, audit N1)", () => {
  /**
   * Red Ink (Sync Parallels' own row) holds old SportLots id SL-OLD. The fetch
   * now lists Red Ink under SL-RED-INK — an id another row holds — and no
   * longer returns SL-OLD, with SportLots covered. Invariant 5 allows the
   * unlink (fetched, not returned, operator told); NEO-312 refuses the new
   * link. Pinned, not changed: the operator must hear about both.
   */
  async function fixture(t: T) {
    const ids = await seed(t);
    // The store only counts SportLots as covered when the chain can scope it.
    await t.run(async (ctx) => {
      const year = await ctx.db.get(ids.yearId);
      await ctx.db.patch(ids.yearId, { platformData: { sportlots: { s0: "SL-YEAR" } } });
      await ctx.db.patch(year!.parentId!, { platformData: { sportlots: { s0: "SL-SPORT" } } });
    });
    const redInk = await insertRow(t, {
      level: "insert",
      value: "Red Ink",
      parentId: ids.parallelTypeId,
      platformData: { sportlots: { s0: "SL-OLD" } },
      platformSlotSeq: { sportlots: 1 },
      primaryPlatformId: { sportlots: "s0" },
    });
    const holder = await insertRow(t, {
      level: "parallel",
      value: "Red Ink",
      parentId: ids.autosId,
      ...slLinks([RED_INK]),
    });
    return { ids, redInk, holder };
  }
  const covered = {
    coveredSides: ["sportlots" as const],
    returnedIds: { sportlots: [RED_INK.id] },
  };

  test("held by name only: SL-OLD unlinked (notice), SL-RED-INK held (notice naming the holder)", async () => {
    const t = convexTest(schema, modules);
    const { ids, redInk, holder } = await fixture(t);

    const res = await reconcile(
      t,
      ids.parallelTypeId,
      [{ value: "Red Ink", sportlots: RED_INK.id }],
      "insert",
      covered,
    );

    expect(res.unlinked).toEqual([{ id: redInk, value: "Red Ink", side: "sportlots", hasCards: false }]);
    expect(heldSummary(res.heldElsewhere)).toEqual([
      { id: String(holder), level: "parallel", path: ["Bowman", "Insert", "All-America Game Autos"] },
    ]);
    const after = await t.run(async (ctx) => ctx.db.get(redInk));
    expect(slotIds(after!, "sportlots")).toEqual([]);
    expect((await holdersOf(t, "sportlots", RED_INK.id)).map((r) => r._id)).toEqual([holder]);
  });

  test("matched by existingId: SL-OLD unlinked (notice), SL-RED-INK not attached (linkHeldElsewhere notice)", async () => {
    const t = convexTest(schema, modules);
    const { ids, redInk, holder } = await fixture(t);

    const res = await reconcile(
      t,
      ids.parallelTypeId,
      [{ value: "Red Ink", sportlots: RED_INK.id, existingId: redInk }],
      "insert",
      covered,
    );

    expect(res.unlinked.map((u) => [String(u.id), u.side])).toEqual([[String(redInk), "sportlots"]]);
    expect(res.withheldElsewhere).toHaveLength(1);
    expect(res.withheldElsewhere[0]).toMatchObject({ label: "Red Ink", reason: "linkHeldElsewhere" });
    expect(res.withheldElsewhere[0].holders.map((h) => String(h.id))).toEqual([String(holder)]);
    expect((await holdersOf(t, "sportlots", RED_INK.id)).map((r) => r._id)).toEqual([holder]);
  });

  test("set walk past its bound: SL-OLD unlinked (notice), SL-RED-INK withheld as notChecked (notice)", async () => {
    const t = convexTest(schema, modules);
    const { ids, redInk } = await fixture(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_SUBTREE_WALK_INSERTS; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "insert",
          value: `Bulk ${i}`,
          parentId: ids.insertTypeId,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });

    const res = await reconcile(
      t,
      ids.parallelTypeId,
      [{ value: "Red Ink", sportlots: RED_INK.id }],
      "insert",
      covered,
    );

    expect(res.subtreeWalkSkipped).toBe(true);
    expect(res.unlinked.map((u) => [String(u.id), u.side])).toEqual([[String(redInk), "sportlots"]]);
    expect(res.withheldElsewhere).toEqual([
      { label: "Red Ink", reason: "notChecked", holders: [] },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit N4 — a Sync Sets save does not re-create a set whose link moved down
// ───────────────────────────────────────────────────────────────────────────

describe("Sync Sets: a SportLots id held under any set of the brand is not filed as a set again (NEO-312, audit N4)", () => {
  async function movedDown(t: T) {
    const ids = await seed(t);
    const sky = { id: "SL-SKY", label: "Bowman Sky Blue" };
    const { setId } = await slSet(t, ids.brandId, "Bowman Sky Blue", [sky]);
    const moved = await as(t).mutation(api.setParallelConversion.convertSetToParallel, {
      setId,
      targetParallelTypeId: ids.parallelTypeId,
    });
    return { ids, sky, moved };
  }

  test("both stores, at setName level: the moved link is held, its holder named; a new set and a BSC set still land", async () => {
    const t = convexTest(schema, modules);
    const { ids, sky, moved } = await movedDown(t);
    const setsBefore = (await childrenAt(t, "setName", ids.brandId)).map((r) => r.value).sort();
    expect(setsBefore).toEqual(["Bowman"]);

    // A Sync Sets dialog opened before the move (reconcile store).
    const res = await reconcile(
      t,
      ids.brandId,
      [{ value: "Bowman Sky Blue", sportlots: sky.id }],
      "setName",
    );
    expect(heldSummary(res.heldElsewhere)).toEqual([
      { id: String(moved.parallelId), level: "insert", path: ["Bowman", "Parallel"] },
    ]);
    expect((await childrenAt(t, "setName", ids.brandId)).map((r) => r.value)).toEqual(["Bowman"]);

    // The aggregator's store, with a genuinely new SportLots set and a BSC set.
    const res2 = await storeSelector(
      t,
      ids.brandId,
      [
        { value: "Bowman Sky Blue", sportlots: sky.id },
        { value: "Bowman Gold", sportlots: "SL-GOLD" },
        { value: "Bowman Chrome", bsc: "bowman-chrome" },
      ],
      "setName",
    );
    expect(res2.heldElsewhereTotal).toBe(1);
    expect((await childrenAt(t, "setName", ids.brandId)).map((r) => r.value).sort()).toEqual([
      "Bowman",
      "Bowman Chrome",
      "Bowman Gold",
    ]);
    expect((await holdersOf(t, "sportlots", sky.id)).map((r) => r._id)).toEqual([moved.parallelId]);
  });

  test("past the brand walk's bound the setName save lets the item through (the client's list is the protection) and logs it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_BRAND_WALK_DOCUMENTS; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Bulk ${i}`,
          parentId: ids.bowmanId,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();

    const res = await storeSelector(t, ids.brandId, [{ value: "Bowman Gold", sportlots: "SL-GOLD" }], "setName");

    expect(res.withheldElsewhereTotal).toBe(0);
    expect((await childrenAt(t, "setName", ids.brandId)).map((r) => r.value).sort()).toEqual([
      "Bowman",
      "Bowman Gold",
    ]);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("selector_sync_brand_walk_truncated")),
    ).toBe(true);
  });
});
