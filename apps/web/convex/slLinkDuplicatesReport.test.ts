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
import {
  REPORT_BYTES_RESERVE,
  REPORT_CARD_COUNT_CAP,
  REPORT_CARD_ROWS_PER_CALL,
  REPORT_DOCS_PER_CALL,
} from "./slLinkDuplicatesReport";

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

  test("maxBrands and the time budget stop a run; continueCursor resumes at exactly the next brand", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
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
    expect(first).toMatchObject({ truncated: true, brandsScanned: 1, timedOut: false });
    expect(first.continueCursor).toBeDefined();

    // A zero time budget: every run walks exactly one brand (it always
    // advances), stops on time, and hands back the cursor.
    let cursor = first.continueCursor;
    let scanned = first.brandsScanned;
    let groups = first.groupsTotal;
    let runs = 0;
    while (cursor !== undefined) {
      const res = await t.action(internal.slLinkDuplicatesReport.run, { cursor, timeBudgetMs: 0 });
      expect(res.brandsScanned).toBe(1);
      scanned += res.brandsScanned;
      groups += res.groupsTotal;
      cursor = res.continueCursor;
      if (cursor !== undefined) expect(res.timedOut).toBe(true);
      expect(++runs).toBeLessThan(10);
    }
    // Five brands, each read once; the three duplicate groups, each once.
    expect(scanned).toBe(5);
    expect(groups).toBe(3);
  });

  test("cards are counted a few rows per call, capped per row", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < REPORT_CARD_COUNT_CAP + 50; i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: ids.recreated,
          cardNumber: String(100 + i),
          cardName: `Bulk ${i}`,
          platformData: {},
          sortOrder: 100 + i,
          lastUpdated: SENTINEL,
        });
      }
    });
    const rowIds = [ids.recreated, ids.moved, ids.autos, ids.bscDupe, ids.skyBase, ids.skyRow, ids.base];
    const counted = await t.query(internal.slLinkDuplicatesReport.cardCounts, { rowIds });
    expect(counted).toHaveLength(REPORT_CARD_ROWS_PER_CALL);
    expect(counted[0]).toEqual({ id: ids.recreated, cards: REPORT_CARD_COUNT_CAP, capped: true });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await t.action(internal.slLinkDuplicatesReport.run, {});
    const holder = res.groups
      .flatMap((g) => g.holders)
      .find((h) => h.rowId === ids.recreated)!;
    expect(holder).toMatchObject({ cards: REPORT_CARD_COUNT_CAP, cardCountCapped: true });
    expect(res.cardCountsComplete).toBe(true);
  });

  test("childrenPage reads at most REPORT_DOCS_PER_CALL documents per call; a parent that does not fit is asked again", async () => {
    const t = convexTest(schema, modules);
    const { a, b, c } = await t.run(async (ctx) => {
      const mk = (value: string) =>
        ctx.db.insert("selectorOptions", {
          level: "variantType",
          value,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      const a = await mk("A");
      const b = await mk("B");
      const c = await mk("C");
      const fill = async (parentId: RowId, n: number) => {
        for (let i = 0; i < n; i++) {
          await ctx.db.insert("selectorOptions", {
            level: "insert",
            value: `${i}`,
            parentId,
            platformData: {},
            children: [],
            lastUpdated: SENTINEL,
          });
        }
      };
      await fill(a, REPORT_DOCS_PER_CALL - 500);
      await fill(b, 1000);
      await fill(c, REPORT_DOCS_PER_CALL + 1);
      return { a, b, c };
    });

    const ab = await t.query(internal.slLinkDuplicatesReport.childrenPage, { parentIds: [a, b] });
    expect({ rows: ab.rows.length, parentsDone: ab.parentsDone, overflow: ab.overflow }).toEqual({
      rows: REPORT_DOCS_PER_CALL - 500,
      parentsDone: 1,
      overflow: false,
    });
    const bOnly = await t.query(internal.slLinkDuplicatesReport.childrenPage, { parentIds: [b] });
    expect(bOnly.rows).toHaveLength(1000);
    const cOnly = await t.query(internal.slLinkDuplicatesReport.childrenPage, { parentIds: [c] });
    expect({ rows: cOnly.rows.length, overflow: cOnly.overflow }).toEqual({
      rows: REPORT_DOCS_PER_CALL,
      overflow: true,
    });
  });

  test("the report queries stop on the read-byte budget instead of failing (audit S1/S2)", async () => {
    // convex-test enforces this limit: a query that read past it would throw.
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { bytesRead: REPORT_BYTES_RESERVE + 100 * 1024 },
    });
    const heavy = "x".repeat(40 * 1024);
    const { a, b } = await t.run(async (ctx) => {
      const mk = (value: string) =>
        ctx.db.insert("selectorOptions", {
          level: "variantType",
          value,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      const a = await mk("A");
      const b = await mk("B");
      for (const parentId of [a, b]) {
        for (let i = 0; i < 3; i++) {
          const child = await ctx.db.insert("selectorOptions", {
            level: "insert",
            value: heavy,
            parentId,
            platformData: {},
            children: [],
            lastUpdated: SENTINEL,
          });
          await ctx.db.insert("cardChecklist", {
            selectorOptionId: parentId,
            cardNumber: String(i),
            cardName: heavy,
            platformData: {},
            sortOrder: i,
            lastUpdated: SENTINEL,
          });
          void child;
        }
      }
      return { a, b };
    });

    const page = await t.query(internal.slLinkDuplicatesReport.childrenPage, { parentIds: [a, b] });
    expect(page.parentsDone).toBe(1);
    expect(page.rows).toHaveLength(3);
    const cards = await t.query(internal.slLinkDuplicatesReport.cardCounts, { rowIds: [a, b] });
    expect(cards).toEqual([{ id: a, cards: 3, capped: false }]);
  });
});
