/**
 * NEO-293 — the one-shot backfill for parallels that were promoted from
 * inserts BEFORE `applyParallelGroupings` learned to tag their BSC slots.
 *
 * Selection is level + parent + untagged slot, and nothing else: a `parallel`
 * whose parent is an `insert` got there through the insert→parallel
 * promotion, and the untagged BSC id on it is the one the insert-level
 * variantName fetch wrote. The tests pin what is selected, what is refused
 * (base-set parallels under a variantType, already-tagged slots, rows with no
 * BSC side), and the two-arm write discipline shared with the other
 * `selectorOptions` backfills.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { bscSourceView, resolveBscFacetFilters } from "./bscFacets";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_000_000;

type T = ReturnType<typeof convexTest>;
type Row = Doc<"selectorOptions">;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * One set with BOTH variant-type shapes beneath it: an Insert variant type
 * (where promoted parallels live) and a Parallel variant type (base-set
 * parallels, which sit at insert level or directly under the variant type).
 */
async function seedSet(t: T) {
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: { b0: "baseball" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2026",
      parentId: sport,
      platformData: { bsc: { b0: "2026" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const set = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Bowman",
      parentId: year,
      platformData: { bsc: { b0: "bowman" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const insertVt = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      parentId: set,
      platformData: { bsc: { b0: "insert" } },
      platformFacets: { bsc: { b0: "variant" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const parallelVt = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Parallel",
      parentId: set,
      platformData: { bsc: { b0: "parallel" } },
      platformFacets: { bsc: { b0: "variant" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    await ctx.db.patch(sport, { children: [year] });
    await ctx.db.patch(year, { children: [set] });
    await ctx.db.patch(set, { children: [insertVt, parallelVt] });
    return { sport, year, set, insertVt, parallelVt };
  });
}

async function seedChild(
  t: T,
  parentId: Id<"selectorOptions">,
  level: "insert" | "parallel",
  value: string,
  row: Partial<Pick<Row, "platformData" | "platformFacets">> = {},
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level,
      value,
      parentId,
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
      ...row,
    });
    const parent = (await ctx.db.get(parentId))!;
    await ctx.db.patch(parentId, { children: [...parent.children, id] });
    return id;
  });
}

/** The prod shape: Insert › Anime › Anime Kanji, the parallel's slot untagged. */
async function seedPromotedCase(t: T) {
  const ids = await seedSet(t);
  const anime = await seedChild(t, ids.insertVt, "insert", "Anime", {
    platformData: { bsc: { b0: "anime" } },
  });
  const kanji = await seedChild(t, anime, "parallel", "Anime Kanji", {
    platformData: { bsc: { b0: "anime-kanji" } },
  });
  return { ...ids, anime, kanji };
}

async function getRow(t: T, id: Id<"selectorOptions">): Promise<Row> {
  const row = await t.run(async (ctx) => ctx.db.get(id));
  if (!row) throw new Error(`row ${id} vanished`);
  return row;
}

async function chainTo(t: T, leafId: Id<"selectorOptions">): Promise<Row[]> {
  return t.run(async (ctx) => {
    const chain: Row[] = [];
    let cursor: Id<"selectorOptions"> | undefined = leafId;
    while (cursor) {
      const row: Row | null = await ctx.db.get(cursor);
      if (!row) break;
      chain.unshift(row);
      cursor = row.parentId;
    }
    return chain;
  });
}

const dry = (t: T, variantTypeId?: Id<"selectorOptions">) =>
  t.mutation(internal.backfillPromotedParallelFacet.run, {
    ...(variantTypeId ? { variantTypeId } : {}),
  });

/**
 * BOTH arms: the per-invocation token AND the per-deployment flag. A helper
 * that set only one of them would make every test below a test of the other
 * one by accident.
 */
const armed = (t: T, variantTypeId?: Id<"selectorOptions">) => {
  vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
  return t.mutation(internal.backfillPromotedParallelFacet.run, {
    confirm: "BACKFILL",
    ...(variantTypeId ? { variantTypeId } : {}),
  });
};

/** The token, on a deployment that was never armed. */
const armedButNoFlag = (t: T) =>
  t.mutation(internal.backfillPromotedParallelFacet.run, {
    confirm: "BACKFILL",
  });

describe("backfillPromotedParallelFacet — selection", () => {
  test("selects the promoted case: a parallel under an insert with an untagged BSC slot, and reports its path", async () => {
    const t = convexTest(schema, modules);
    const { kanji } = await seedPromotedCase(t);

    const report = await dry(t);

    expect(report.scanned).toBe(1);
    expect(report.rowsTagged).toBe(1);
    expect(report.slotsTagged).toBe(1);
    expect(report.skippedCounts).toEqual({
      alreadyTagged: 0,
      noBscSlot: 0,
      parentNotInsert: 0,
    });
    expect(report.rows).toEqual([
      {
        id: kanji,
        path: ["Baseball", "2026", "Bowman", "Insert", "Anime", "Anime Kanji"],
        slots: ["b0"],
      },
    ]);
  });

  test("excludes a base-set parallel — a parallel whose parent is the variantType", async () => {
    const t = convexTest(schema, modules);
    const { parallelVt } = await seedSet(t);
    // A parallel filed directly under the Parallel variant type. Its untagged
    // slot sits on a different `variant` axis and must stay inert.
    const gold = await seedChild(t, parallelVt, "parallel", "Gold", {
      platformData: { bsc: { b0: "gold" } },
    });

    const report = await dry(t);

    expect(report.scanned).toBe(1);
    expect(report.rowsTagged).toBe(0);
    expect(report.skippedCounts.parentNotInsert).toBe(1);
    expect(report.rows).toEqual([]);

    // And armed, it still writes nothing to that row.
    await armed(t);
    expect((await getRow(t, gold)).platformFacets).toBeUndefined();
  });

  test("a base-set parallel synced at INSERT level is never even scanned", async () => {
    // The Parallel variant type's sync lands its rows at `insert`, where the
    // level rule already resolves them. Out of scope by index, not by test.
    const t = convexTest(schema, modules);
    const { parallelVt } = await seedSet(t);
    await seedChild(t, parallelVt, "insert", "Gold", {
      platformData: { bsc: { b0: "gold" } },
    });

    const report = await dry(t);
    expect(report.scanned).toBe(0);
    expect(report.rowsTagged).toBe(0);
  });

  test("excludes slots that already carry a tag, and tags only the untagged ones on a mixed row", async () => {
    const t = convexTest(schema, modules);
    const { insertVt } = await seedSet(t);
    const anime = await seedChild(t, insertVt, "insert", "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    const allTagged = await seedChild(t, anime, "parallel", "Anime Kanji", {
      platformData: { bsc: { b0: "anime-kanji" } },
      platformFacets: { bsc: { b0: "variantName" } },
    });
    const mixed = await seedChild(t, anime, "parallel", "Anime Gold", {
      platformData: { bsc: { b0: "anime-gold", b1: "bowman-draft" } },
      platformFacets: { bsc: { b1: "setName" } },
    });

    const report = await dry(t);

    expect(report.scanned).toBe(2);
    expect(report.rowsTagged).toBe(1);
    expect(report.slotsTagged).toBe(1);
    expect(report.skippedCounts.alreadyTagged).toBe(1);
    expect(report.rows).toEqual([
      {
        id: mixed,
        path: ["Baseball", "2026", "Bowman", "Insert", "Anime", "Anime Gold"],
        slots: ["b0"],
      },
    ]);

    await armed(t);
    expect((await getRow(t, mixed)).platformFacets).toEqual({
      bsc: { b0: "variantName", b1: "setName" },
    });
    expect((await getRow(t, allTagged)).platformFacets).toEqual({
      bsc: { b0: "variantName" },
    });
    expect((await getRow(t, allTagged)).lastUpdated).toBe(SENTINEL);
  });

  test("a parallel with no BSC side is counted and left alone; SportLots slots are never tagged", async () => {
    const t = convexTest(schema, modules);
    const { insertVt } = await seedSet(t);
    const anime = await seedChild(t, insertVt, "insert", "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    const slOnly = await seedChild(t, anime, "parallel", "Anime Kanji", {
      platformData: { sportlots: { s0: "884412" } },
    });

    const report = await armed(t);

    expect(report.rowsTagged).toBe(0);
    expect(report.skippedCounts.noBscSlot).toBe(1);
    expect((await getRow(t, slOnly)).platformFacets).toBeUndefined();
  });

  test("`variantTypeId` narrows the scan to that variant type's inserts' parallels", async () => {
    const t = convexTest(schema, modules);
    const first = await seedPromotedCase(t);
    const second = await seedPromotedCase(t);

    const all = await dry(t);
    expect(all.scanned).toBe(2);
    expect(all.rowsTagged).toBe(2);

    const scoped = await dry(t, first.insertVt);
    expect(scoped.scanned).toBe(1);
    expect(scoped.rowsTagged).toBe(1);
    expect(scoped.rows[0]?.id).toBe(first.kanji);

    // Armed and scoped: only the scoped row is written.
    await armed(t, first.insertVt);
    expect((await getRow(t, first.kanji)).platformFacets).toEqual({
      bsc: { b0: "variantName" },
    });
    expect((await getRow(t, second.kanji)).platformFacets).toBeUndefined();
  });
});

describe("backfillPromotedParallelFacet — the dry run", () => {
  test("reports exactly what an armed run would do, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { kanji } = await seedPromotedCase(t);

    const report = await dry(t);

    expect(report.armed).toBe(false);
    expect(report.message).toContain("Dry run");
    expect(report.rowsTagged).toBe(1);

    const row = await getRow(t, kanji);
    expect(row.platformFacets).toBeUndefined();
    expect(row.lastUpdated).toBe(SENTINEL);
  });

  test("the token WITHOUT the deployment flag is refused, and says which flag", async () => {
    const t = convexTest(schema, modules);
    const { kanji } = await seedPromotedCase(t);

    const report = await armedButNoFlag(t);

    expect(report.armed).toBe(false);
    expect(report.message).toContain("ALLOW_SELECTOR_BACKFILL");
    // The plan is still reported in full.
    expect(report.rowsTagged).toBe(1);

    const row = await getRow(t, kanji);
    expect(row.platformFacets).toBeUndefined();
    expect(row.lastUpdated).toBe(SENTINEL);
  });

  test("the flag ALONE writes nothing — the per-invocation token is still required", async () => {
    const t = convexTest(schema, modules);
    const { kanji } = await seedPromotedCase(t);

    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const report = await dry(t);

    expect(report.armed).toBe(false);
    expect(report.rowsTagged).toBe(1);
    expect((await getRow(t, kanji)).platformFacets).toBeUndefined();
  });

  test("a wrong token is a dry run, not an error", async () => {
    const t = convexTest(schema, modules);
    const { kanji } = await seedPromotedCase(t);

    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const report = await t.mutation(internal.backfillPromotedParallelFacet.run, {
      confirm: "yes",
    });

    expect(report.armed).toBe(false);
    expect((await getRow(t, kanji)).platformFacets).toBeUndefined();
  });
});

describe("backfillPromotedParallelFacet — the armed run", () => {
  test("tags the slot variantName, and the chain then resolves the parallel as a BSC source", async () => {
    const t = convexTest(schema, modules);
    const { kanji } = await seedPromotedCase(t);

    // BEFORE: inert. The insert ancestor's variantName leaks through and the
    // panel shows the slot as untagged.
    const beforeChain = await chainTo(t, kanji);
    expect(resolveBscFacetFilters(beforeChain).filters.variantName).toEqual(["anime"]);
    expect(bscSourceView(beforeChain[beforeChain.length - 1], beforeChain).untagged).toHaveLength(1);

    const report = await armed(t);

    expect(report.armed).toBe(true);
    expect(report.message).toContain("Applied");
    expect(report.rowsTagged).toBe(1);
    expect(report.slotsTagged).toBe(1);

    const row = await getRow(t, kanji);
    expect(row.platformFacets).toEqual({ bsc: { b0: "variantName" } });
    expect(row.platformData).toEqual({ bsc: { b0: "anime-kanji" } });
    expect(row.level).toBe("parallel");
    expect(row.lastUpdated).toBeGreaterThan(SENTINEL);

    // AFTER: the parallel's variantName wins, variant stays the insert axis.
    const chain = await chainTo(t, kanji);
    const plan = resolveBscFacetFilters(chain);
    expect(plan.filters).toEqual({
      sport: ["baseball"],
      year: ["2026"],
      setName: ["bowman"],
      variant: ["insert"],
      variantName: ["anime-kanji"],
    });
    expect(plan.sourceFacet).toBe("variantName");
    const view = bscSourceView(chain[chain.length - 1], chain);
    expect(view.untagged).toEqual([]);
    expect(view.sources.map((s) => s.id)).toEqual(["anime-kanji"]);
    expect(view.scope.missing).toEqual([]);
  });

  test("is idempotent: a second run reports the steady state and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { kanji } = await seedPromotedCase(t);

    await armed(t);
    const stamped = (await getRow(t, kanji)).lastUpdated;

    const again = await armed(t);
    expect(again.rowsTagged).toBe(0);
    expect(again.skippedCounts.alreadyTagged).toBe(1);
    expect((await getRow(t, kanji)).lastUpdated).toBe(stamped);
  });

  test("the audit line carries counts only — no row values or marketplace ids", async () => {
    const t = convexTest(schema, modules);
    await seedPromotedCase(t);
    const log = vi.mocked(console.log);

    await armed(t);

    const line = log.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("backfill_promoted_parallel_facet"));
    expect(line).toBeDefined();
    expect(line).not.toContain("anime");
    expect(line).not.toContain("Anime");
    expect(line).not.toContain("Bowman");
    expect(JSON.parse(line!)).toMatchObject({
      armed: true,
      scoped: false,
      rowsTagged: 1,
      slotsTagged: 1,
    });
  });
});
