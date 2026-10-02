/**
 * NEO-312 — the read-only duplicate-link report (`slLinkDuplicatesReport.ts`).
 *
 * Pinned: a SportLots id on two rows of one set, and on rows of two sets of
 * one brand, are both reported with each holder's NB path, level and card
 * count; a BSC id on two insert-level rows of one set is reported; the same
 * SportLots id under two BRANDS, a brand row's own SportLots id, and a BSC
 * facet id shared by variant types are not; the run writes nothing; the log
 * line carries counts only; and `maxBrands` pages the run with a cursor that
 * resumes without re-reading a brand.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { REPORT_BRAND_PAGE } from "./slLinkDuplicatesReport";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;
type RowId = Id<"selectorOptions">;
type Row = Doc<"selectorOptions">;
const SENTINEL = 1_000_000;

afterEach(() => vi.restoreAllMocks());

async function insertRow(
  t: T,
  fields: Partial<Row> & { level: Row["level"]; value: string },
): Promise<RowId> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
      ...fields,
    } as Omit<Row, "_id" | "_creationTime">),
  );
}

const sl = (...ids: string[]) => ({
  platformData: { sportlots: Object.fromEntries(ids.map((id, i) => [`s${i}`, id])) },
});

async function seed(t: T) {
  const sport = await insertRow(t, { level: "sport", value: "Baseball" });
  const year = await insertRow(t, { level: "year", value: "2026", parentId: sport });
  const bowman = await insertRow(t, {
    level: "manufacturer",
    value: "Bowman",
    parentId: year,
    // A brand's own SportLots id is a brand id: never compared.
    ...sl("SL-BRAND"),
  });
  const set = await insertRow(t, { level: "setName", value: "Bowman", parentId: bowman, ...sl("SL-BRAND") });
  const base = await insertRow(t, {
    level: "variantType",
    value: "Base",
    parentId: set,
    platformData: { bsc: { b0: "base" }, sportlots: { s0: "SL-BOWMAN" } },
  });
  const parallelType = await insertRow(t, {
    level: "variantType",
    value: "Parallel",
    parentId: set,
    platformData: { bsc: { b0: "parallel" } },
  });
  const insertType = await insertRow(t, {
    level: "variantType",
    value: "Insert",
    parentId: set,
    platformData: { bsc: { b0: "parallel" } }, // a shared facet id: not compared
  });
  // The NEO-312 bug's output: the re-created Parallel-type row and the
  // Insert-type parallel "Make insert of…" moved the link to.
  const recreated = await insertRow(t, {
    level: "insert",
    value: "Red Ink",
    parentId: parallelType,
    ...sl("SL-RED-INK"),
  });
  const autos = await insertRow(t, {
    level: "insert",
    value: "All-America Game Autos",
    parentId: insertType,
    platformData: { bsc: { b0: "aa-autos" } },
  });
  const moved = await insertRow(t, {
    level: "parallel",
    value: "Red Ink",
    parentId: autos,
    ...sl("SL-RED-INK"),
  });
  // A BSC id on two insert-level rows of one set.
  const bscDupe = await insertRow(t, {
    level: "insert",
    value: "Autos (again)",
    parentId: parallelType,
    platformData: { bsc: { b0: "aa-autos" } },
  });
  // Another set of the brand whose Base holds a link a row of Bowman holds.
  const sky = await insertRow(t, { level: "setName", value: "Bowman Sky Blue", parentId: bowman });
  const skyBase = await insertRow(t, {
    level: "variantType",
    value: "Base",
    parentId: sky,
    ...sl("SL-SKY"),
  });
  const skyRow = await insertRow(t, {
    level: "insert",
    value: "Sky Blue",
    parentId: parallelType,
    ...sl("SL-SKY", "SL-UNIQUE"),
  });
  // Another brand holding a Bowman SportLots id: brands are not compared.
  const topps = await insertRow(t, { level: "manufacturer", value: "Topps", parentId: year });
  const toppsSet = await insertRow(t, { level: "setName", value: "Topps", parentId: topps });
  await insertRow(t, { level: "variantType", value: "Base", parentId: toppsSet, ...sl("SL-RED-INK") });

  // Cards on two holders.
  await t.run(async (ctx) => {
    for (const [rowId, n] of [[recreated, 2], [moved, 3]] as const) {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: rowId,
          cardNumber: String(i + 1),
          cardName: `Player ${i}`,
          platformData: {},
          sortOrder: i,
          lastUpdated: SENTINEL,
        });
      }
    }
  });
  return { bowman, topps, recreated, moved, autos, bscDupe, skyBase, skyRow, base };
}

async function snapshot(t: T) {
  return t.run(async (ctx) => ({
    rows: await ctx.db.query("selectorOptions").collect(),
    cards: await ctx.db.query("cardChecklist").collect(),
  }));
}

describe("slLinkDuplicatesReport.run (NEO-312)", () => {
  test("reports SportLots duplicates in a set and across a brand, BSC duplicates in a set; writes nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const before = await snapshot(t);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await t.action(internal.slLinkDuplicatesReport.run, {});

    expect(await snapshot(t)).toEqual(before);
    expect(res.truncated).toBe(false);
    expect(res.brandsScanned).toBe(2);
    expect(res.groupsTotal).toBe(3);

    const byKey = new Map(res.groups.map((g) => [`${g.side}:${g.marketplaceId}`, g]));
    expect([...byKey.keys()].sort()).toEqual(["bsc:aa-autos", "sportlots:SL-RED-INK", "sportlots:SL-SKY"]);

    const redInk = byKey.get("sportlots:SL-RED-INK")!;
    expect(redInk).toMatchObject({ scope: "set", sport: "Baseball", year: "2026", holderCount: 2 });
    expect(
      redInk.holders
        .map((h) => ({ id: String(h.rowId), level: h.level, path: h.path, cards: h.cards }))
        .sort((a, b) => a.path.length - b.path.length),
    ).toEqual([
      { id: String(ids.recreated), level: "insert", path: ["Bowman", "Bowman", "Parallel", "Red Ink"], cards: 2 },
      {
        id: String(ids.moved),
        level: "parallel",
        path: ["Bowman", "Bowman", "Insert", "All-America Game Autos", "Red Ink"],
        cards: 3,
      },
    ]);

    const skyGroup = byKey.get("sportlots:SL-SKY")!;
    expect(skyGroup.scope).toBe("brand");
    expect(skyGroup.holders.map((h) => String(h.rowId)).sort()).toEqual(
      [String(ids.skyBase), String(ids.skyRow)].sort(),
    );
    expect(skyGroup.holders.find((h) => h.rowId === ids.skyBase)!.path).toEqual([
      "Bowman",
      "Bowman Sky Blue",
      "Base",
    ]);

    const bsc = byKey.get("bsc:aa-autos")!;
    expect(bsc.scope).toBe("set");
    expect(bsc.holders.map((h) => String(h.rowId)).sort()).toEqual(
      [String(ids.autos), String(ids.bscDupe)].sort(),
    );

    // Counts only in the log: no marketplace id, no NB name.
    const line = log.mock.calls.map((c) => String(c[0])).find((s) => s.includes("report_marketplace_link_duplicates"))!;
    expect(JSON.parse(line)).toMatchObject({ groupsTotal: 3, sportlotsGroups: 2, bscGroups: 1 });
    for (const secret of ["SL-RED-INK", "SL-SKY", "aa-autos", "Red Ink", "Bowman"]) {
      expect(line).not.toContain(secret);
    }
  });

  test("maxBrands pages the run; the cursor resumes without re-reading a brand", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // More brands than one page, so the cursor has somewhere to go.
    await t.run(async (ctx) => {
      for (let i = 0; i < REPORT_BRAND_PAGE; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "manufacturer",
          value: `Brand ${i}`,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const first = await t.action(internal.slLinkDuplicatesReport.run, { maxBrands: 1 });
    expect(first.truncated).toBe(true);
    expect(first.brandsScanned).toBe(REPORT_BRAND_PAGE);
    expect(first.continueCursor).toBeDefined();

    const second = await t.action(internal.slLinkDuplicatesReport.run, {
      cursor: first.continueCursor,
    });
    expect(second.truncated).toBe(false);
    expect(first.brandsScanned + second.brandsScanned).toBe(REPORT_BRAND_PAGE + 2);
    expect(first.groupsTotal + second.groupsTotal).toBe(3);
  });
});
