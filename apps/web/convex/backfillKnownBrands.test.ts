/**
 * NEO-294 — the one-shot backfill that applies the known-brands list to the
 * sets already under every year's Unknown row.
 *
 * Same shape as `backfillBrandPrefixAndUnknownName.test.ts`: the two
 * independent arms (per-invocation `confirm`, per-deployment
 * `ALLOW_SELECTOR_BACKFILL`), dry-run-writes-nothing, and the steady state on
 * a second run. The NEO-294 additions are the three rows it must LEAVE
 * ALONE — an operator's, a name the target brand already has, and a brand
 * name worn by the flagged row itself — and the read/move bound.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_YEAR_SET_ROWS } from "./setFromMarketplace";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_000_000;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** sport → year, the year carrying a SportLots id so the sentinel is written. */
async function seedYear(t: ReturnType<typeof convexTest>, value = "1995") {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { sportlots: { s0: "BB" } },
      platformSlotSeq: { sportlots: 1 },
      children: [],
      lastUpdated: SENTINEL,
    });
    return ctx.db.insert("selectorOptions", {
      level: "year",
      value,
      platformData: { sportlots: { s0: value } },
      platformSlotSeq: { sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: SENTINEL,
    });
  });
}

async function seedManufacturer(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
  opts: { isBrandUnknown?: boolean; setNamePrefix?: string } = {},
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: {},
      metadata: {
        ...(opts.isBrandUnknown !== undefined
          ? { isBrandUnknown: opts.isBrandUnknown }
          : {}),
        ...(opts.setNamePrefix ? { setNamePrefix: opts.setNamePrefix } : {}),
      },
      parentId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.get(parentId);
    await ctx.db.patch(parentId, { children: [...(year?.children ?? []), id] });
    return id;
  });
}

async function seedSet(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
  opts: { setByOperator?: boolean } = {},
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value,
      platformData: {},
      parentId,
      children: [],
      ...(opts.setByOperator
        ? { metadata: { brandSetByOperator: true } }
        : {}),
      lastUpdated: SENTINEL,
    });
    const parent = await ctx.db.get(parentId);
    await ctx.db.patch(parentId, { children: [...(parent?.children ?? []), id] });
    return id;
  });
}

const dry = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.backfillKnownBrands.run, {});

const armed = (t: ReturnType<typeof convexTest>) => {
  vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
  return t.mutation(internal.backfillKnownBrands.run, { confirm: "BACKFILL" });
};

const armedButNoFlag = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.backfillKnownBrands.run, { confirm: "BACKFILL" });

async function manufacturersOf(
  t: ReturnType<typeof convexTest>,
  yearId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "manufacturer").eq("parentId", yearId),
      )
      .collect(),
  );
}

async function setsUnder(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", parentId),
      )
      .collect(),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The dry run
// ───────────────────────────────────────────────────────────────────────────

describe("backfillKnownBrands — the dry run", () => {
  test("reports what an armed run would do, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    await seedSet(t, unknown, "Choice Biloxi Shuckers");
    await seedSet(t, unknown, "Philadelphia Phillies Team Issue");

    const report = await dry(t);

    expect(report.armed).toBe(false);
    expect(report.message).toContain("Dry run");
    expect(report.counts).toEqual({
      brandsCreated: 0,
      moved: 1,
      clashAtTarget: 0,
      operatorPlaced: 0,
      noMatch: 1,
      brandUnavailable: 0,
    });
    expect(report.rows[0]).toMatchObject({
      value: "Choice Biloxi Shuckers",
      action: "moved",
      brand: "Choice",
    });
    expect(report.truncated).toBe(false);

    // Nothing written: no brand row, both sets still under Unknown.
    expect((await manufacturersOf(t, year)).map((m) => m.value)).toEqual([
      "Unknown",
    ]);
    expect((await setsUnder(t, unknown)).map((r) => r.value).sort()).toEqual([
      "Choice Biloxi Shuckers",
      "Philadelphia Phillies Team Issue",
    ]);
  });

  test("an armed invocation on an UNARMED deployment is refused, not thrown", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    await seedSet(t, unknown, "Choice Biloxi Shuckers");

    const report = await armedButNoFlag(t);

    expect(report.armed).toBe(false);
    expect(report.message).toContain("not armed");
    expect(report.counts.moved).toBe(1);
    expect((await manufacturersOf(t, year)).map((m) => m.value)).toEqual([
      "Unknown",
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The armed run
// ───────────────────────────────────────────────────────────────────────────

describe("backfillKnownBrands — the armed run", () => {
  test("creates the brand and re-homes the set, keeping the row's _id and its subtree", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const setId = await seedSet(t, unknown, "Choice Biloxi Shuckers");
    const baseId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { sportlots: { s0: "901" } },
        platformSlotSeq: { sportlots: 1 },
        parentId: setId,
        children: [],
        metadata: { isBase: true },
        lastUpdated: SENTINEL,
      }),
    );
    await t.run(async (ctx) => ctx.db.patch(setId, { children: [baseId] }));

    const report = await armed(t);

    expect(report.armed).toBe(true);
    expect(report.message).toContain("Applied");
    expect(report.counts.brandsCreated).toBe(1);
    expect(report.counts.moved).toBe(1);

    const mfrs = await manufacturersOf(t, year);
    expect(mfrs.map((m) => m.value).sort()).toEqual(["Choice", "Unknown"]);
    const choice = mfrs.find((m) => m.value === "Choice")!;
    // Born exactly as a hand-created brand: NB's prefix, SportLots' sentinel
    // because the chain can scope SportLots, and never the unknown flag.
    expect(choice.metadata?.setNamePrefix).toBe("Choice");
    expect(choice.metadata?.isBrandUnknown).toBeUndefined();
    expect(choice.platformData.sportlots).toEqual({ s0: "All Brands" });
    expect(choice.children).toEqual([setId]);

    // SAME row, same subtree, same links — a move, not a copy.
    const moved = await t.run(async (ctx) => ctx.db.get(setId));
    expect(moved?.parentId).toBe(choice._id);
    expect(moved?.children).toEqual([baseId]);
    const base = await t.run(async (ctx) => ctx.db.get(baseId));
    expect(base?.platformData.sportlots).toEqual({ s0: "901" });

    // Unknown kept nothing but its own emptiness.
    expect(await setsUnder(t, unknown)).toEqual([]);
    const unknownRow = await t.run(async (ctx) => ctx.db.get(unknown));
    expect(unknownRow?.children).toEqual([]);
    expect(unknownRow?.value).toBe("Unknown");
  });

  test("a second armed run is the steady state: nothing created, nothing moved", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    await seedSet(t, unknown, "Choice Biloxi Shuckers");
    await seedSet(t, unknown, "Star Michael Jordan");

    const first = await armed(t);
    expect(first.counts.brandsCreated).toBe(2);
    expect(first.counts.moved).toBe(2);
    const docsAfterFirst = await t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).length,
    );

    const second = await armed(t);
    expect(second.counts).toEqual({
      brandsCreated: 0,
      moved: 0,
      clashAtTarget: 0,
      operatorPlaced: 0,
      noMatch: 0,
      brandUnavailable: 0,
    });
    const docsAfterSecond = await t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).length,
    );
    expect(docsAfterSecond).toBe(docsAfterFirst);
  });

  test("an EXISTING brand of that name is used, not a second row", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const choice = await seedManufacturer(t, year, "Choice", {
      setNamePrefix: "Choice",
    });
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    await seedSet(t, unknown, "Choice Biloxi Shuckers");

    const report = await armed(t);

    expect(report.counts.brandsCreated).toBe(0);
    expect(report.counts.moved).toBe(1);
    expect((await manufacturersOf(t, year)).map((m) => m.value).sort()).toEqual([
      "Choice",
      "Unknown",
    ]);
    expect((await setsUnder(t, choice)).map((r) => r.value)).toEqual([
      "Choice Biloxi Shuckers",
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The three rows it must leave alone
// ───────────────────────────────────────────────────────────────────────────

describe("backfillKnownBrands — what it refuses to touch", () => {
  test("a row an OPERATOR placed stays under Unknown, counted", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const placed = await seedSet(t, unknown, "Choice Albany Polecats", {
      setByOperator: true,
    });

    const report = await armed(t);

    expect(report.counts).toEqual({
      brandsCreated: 0,
      moved: 0,
      clashAtTarget: 0,
      operatorPlaced: 1,
      noMatch: 0,
      brandUnavailable: 0,
    });
    // No brand was minted for a row that was never going to move.
    expect((await manufacturersOf(t, year)).map((m) => m.value)).toEqual([
      "Unknown",
    ]);
    const row = await t.run(async (ctx) => ctx.db.get(placed));
    expect(row?.parentId).toBe(unknown);
  });

  test("a name the target brand already has is a counted CLASH, and nothing is merged", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const choice = await seedManufacturer(t, year, "Choice", {
      setNamePrefix: "Choice",
    });
    const incumbent = await seedSet(t, choice, "Choice Biloxi Shuckers");
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    // Folds to the same name as the incumbent (NEO-219's rule is the fold).
    const duplicate = await seedSet(t, unknown, "choice biloxi shuckers");

    const report = await armed(t);

    expect(report.counts.clashAtTarget).toBe(1);
    expect(report.counts.moved).toBe(0);
    expect(report.rows[0]).toMatchObject({
      action: "clash_at_target",
      brand: "Choice",
    });
    // Both rows still exist, each under its own parent. Nothing renamed.
    expect((await t.run(async (ctx) => ctx.db.get(incumbent)))?.parentId).toBe(
      choice,
    );
    expect((await t.run(async (ctx) => ctx.db.get(duplicate)))?.parentId).toBe(
      unknown,
    );
  });

  test("a brand name worn by the FLAGGED row itself is reported, never adopted or renamed", async () => {
    // An operator renamed the year's Unknown row to "Choice". There is no
    // brand row to move to, and minting a second "Choice" under one year is
    // the duplicate the fold forbids.
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Choice", {
      isBrandUnknown: true,
    });
    await seedSet(t, unknown, "Choice Biloxi Shuckers");

    const report = await armed(t);

    expect(report.counts.brandUnavailable).toBe(1);
    expect(report.counts.moved).toBe(0);
    expect((await manufacturersOf(t, year)).map((m) => m.value)).toEqual([
      "Choice",
    ]);
    const flagged = await t.run(async (ctx) => ctx.db.get(unknown));
    expect(flagged?.value).toBe("Choice");
    expect(flagged?.metadata?.isBrandUnknown).toBe(true);
    expect(flagged?.metadata?.setNamePrefix).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Bounds and scoping
// ───────────────────────────────────────────────────────────────────────────

describe("backfillKnownBrands — bounds", () => {
  test("reports the set rows it read, and does not truncate on an ordinary year", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    for (let i = 0; i < 5; i++) {
      await seedSet(t, unknown, `Choice Team ${i}`);
    }

    const report = await dry(t);

    expect(report.truncated).toBe(false);
    expect(report.setRowsRead).toBe(5);
    expect(report.scanned).toBe(1);
    expect(report.counts.moved).toBe(5);
    expect(report.message).not.toContain("read or move bound");
  });

  /**
   * NEO-294 audit, condition 4. The dry run is what an operator reads before
   * arming prod, so it may not promise a move it has not checked. Once the
   * read budget is spent, the per-brand "names already taken" read comes back
   * empty whether the brand is empty or the budget is gone — planning every
   * later matching row as `moved` with no clash check behind it. Planning
   * stops instead, and `truncated` says why.
   */
  test("stops planning rather than promising a move it could not clash-check", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const choice = await seedManufacturer(t, year, "Choice", {
      setNamePrefix: "Choice",
    });
    // The target already HAS that name, so the honest plan for the matching
    // row is `clash_at_target` — never `moved`.
    await seedSet(t, choice, "Choice Biloxi Shuckers");
    // The Unknown bucket spends the whole read budget: the matching row is
    // the last one the bounded read keeps, and one more row pushes it past
    // the bound. Inserted directly — the `children` cache plays no part.
    await t.run(async (ctx) => {
      const insert = (value: string) =>
        ctx.db.insert("selectorOptions", {
          level: "setName",
          value,
          platformData: {},
          parentId: unknown,
          children: [],
          lastUpdated: SENTINEL,
        });
      for (let i = 0; i < MAX_YEAR_SET_ROWS - 1; i++) await insert(`Filler ${i}`);
      await insert("Choice Biloxi Shuckers");
      await insert("Filler past the bound");
    });

    const report = await dry(t);

    expect(report.truncated).toBe(true);
    expect(report.setRowsRead).toBe(MAX_YEAR_SET_ROWS);
    // The row the unbounded version planned as `moved` against an empty
    // taken-set, on top of a set of that very name.
    expect(report.counts.moved).toBe(0);
    expect(report.rows.some((r) => r.action === "moved")).toBe(false);
  });

  test("`parentId` narrows the run to one year and leaves the others alone", async () => {
    const t = convexTest(schema, modules);
    const year1995 = await seedYear(t, "1995");
    const year1996 = await seedYear(t, "1996");
    const unknown95 = await seedManufacturer(t, year1995, "Unknown", {
      isBrandUnknown: true,
    });
    const unknown96 = await seedManufacturer(t, year1996, "Unknown", {
      isBrandUnknown: true,
    });
    await seedSet(t, unknown95, "Choice Biloxi Shuckers");
    await seedSet(t, unknown96, "Star Michael Jordan");

    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const report = await t.mutation(internal.backfillKnownBrands.run, {
      confirm: "BACKFILL",
      parentId: year1995,
    });

    expect(report.scanned).toBe(1);
    expect(report.counts.moved).toBe(1);
    expect((await manufacturersOf(t, year1995)).map((m) => m.value).sort()).toEqual(
      ["Choice", "Unknown"],
    );
    // 1996 was never looked at.
    expect((await manufacturersOf(t, year1996)).map((m) => m.value)).toEqual([
      "Unknown",
    ]);
    expect((await setsUnder(t, unknown96)).map((r) => r.value)).toEqual([
      "Star Michael Jordan",
    ]);
  });

  test("a year with no flagged row is no work at all", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const choice = await seedManufacturer(t, year, "Choice", {
      setNamePrefix: "Choice",
    });
    await seedSet(t, choice, "Choice Biloxi Shuckers");

    const report = await armed(t);

    expect(report.counts).toEqual({
      brandsCreated: 0,
      moved: 0,
      clashAtTarget: 0,
      operatorPlaced: 0,
      noMatch: 0,
      brandUnavailable: 0,
    });
    expect(report.setRowsRead).toBe(0);
  });
});
