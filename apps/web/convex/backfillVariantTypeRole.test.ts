/**
 * NEO-306 — `backfillVariantTypeRole`: the armed one-shot that gives every
 * existing variantType row the `metadata.variantRole` NB flag its
 * `variant`-tagged BSC slot says it has, now that `variantTypeRole` no longer
 * reads the slot at runtime.
 *
 * Pinned: the dry run is the default and writes nothing; `confirm` without
 * the deployment arm is refused and writes nothing; an armed run flags
 * exactly the single-evidence rows, never the Base, never over a role, never
 * on ambiguous or absent evidence; the BSC slots deep-equal their pre-run
 * snapshot (Jason's condition: listing needs them); a second run is the
 * steady state; the action walks every page.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import {
  PAGE_SIZE,
  REPORT_PAGE_SIZE,
  REPORT_SAMPLE_LIMIT,
} from "./backfillVariantTypeRole";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_700_000_000_000;
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function insertType(
  t: T,
  value: string,
  bsc: Record<string, string>,
  facets: Record<string, "variant" | "setName"> | undefined,
  metadata?: Doc<"selectorOptions">["metadata"],
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value,
      platformData: Object.keys(bsc).length > 0 ? { bsc } : {},
      ...(facets ? { platformFacets: { bsc: facets } } : {}),
      ...(metadata ? { metadata } : {}),
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

/** One row per bucket, plus an insert-level row the scan must never see. */
async function seedBuckets(t: T) {
  const insertId = await insertType(t, "Inserts", { b0: "insert" }, { b0: "variant" }, {
    cardNumberPrefix: "IN-",
  });
  const parallelId = await insertType(t, "Parallels", { b0: "parallel" }, { b0: "variant" });
  const flaggedId = await insertType(
    t,
    "Odd",
    { b0: "insert" },
    { b0: "variant" },
    { variantRole: "parallel" },
  );
  const baseId = await insertType(t, "Base", { b0: "parallel" }, { b0: "variant" }, {
    isBase: true,
  });
  const ambiguousId = await insertType(t, "Both", { b0: "insert-parallel" }, { b0: "variant" });
  const untaggedId = await insertType(t, "Legacy", { b0: "insert" }, undefined);
  const promoId = await insertType(t, "Promo", { b0: "promo" }, { b0: "variant" });
  const handMadeId = await insertType(t, "Hand made", {}, undefined);
  const notATypeId = await t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Not a type",
      platformData: { bsc: { b0: "insert" } },
      platformFacets: { bsc: { b0: "variant" } },
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
  return {
    insertId,
    parallelId,
    flaggedId,
    baseId,
    ambiguousId,
    untaggedId,
    promoId,
    handMadeId,
    notATypeId,
  };
}

async function allRows(t: T) {
  return t.run(async (ctx) => ctx.db.query("selectorOptions").collect());
}

const run = (t: T, confirm?: string) =>
  t.action(internal.backfillVariantTypeRole.run, confirm ? { confirm } : {});

const EXPECTED_COUNTS = {
  scanned: 8,
  flagged: 2,
  alreadyFlagged: 1,
  base: 1,
  ambiguous: 1,
  noEvidence: 3,
};

describe("backfillVariantTypeRole", () => {
  test("the dry run is the default: it reports the five buckets and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedBuckets(t);
    const before = await allRows(t);

    const result = await run(t);

    expect(result.armed).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.counts).toEqual(EXPECTED_COUNTS);
    expect(result.message).toMatch(/^Dry run/);
    expect(await allRows(t)).toEqual(before);
  });

  test("confirm without the deployment arm is refused, reported, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedBuckets(t);
    const before = await allRows(t);

    const result = await run(t, "BACKFILL");

    expect(result.armed).toBe(false);
    expect(result.message).toMatch(/ALLOW_SELECTOR_BACKFILL/);
    expect(result.counts).toEqual(EXPECTED_COUNTS);
    expect(await allRows(t)).toEqual(before);
  });

  test("armed: single-evidence rows get the role; the Base, a role already there, ambiguous and absent evidence are left exactly as they were", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const ids = await seedBuckets(t);
    const before = new Map((await allRows(t)).map((r) => [r._id, r]));

    const result = await run(t, "BACKFILL");

    expect(result.armed).toBe(true);
    expect(result.counts).toEqual(EXPECTED_COUNTS);
    const after = new Map((await allRows(t)).map((r) => [r._id, r]));

    expect(after.get(ids.insertId)?.metadata).toEqual({
      cardNumberPrefix: "IN-",
      variantRole: "insert",
    });
    expect(after.get(ids.parallelId)?.metadata).toEqual({ variantRole: "parallel" });
    for (const untouched of [
      ids.flaggedId,
      ids.baseId,
      ids.ambiguousId,
      ids.untaggedId,
      ids.promoId,
      ids.handMadeId,
      ids.notATypeId,
    ]) {
      expect(after.get(untouched)).toEqual(before.get(untouched));
    }
    // Metadata only: every row's BSC slots and tags deep-equal the pre-run
    // snapshot, and `lastUpdated` (the dialogs' optimistic version) is not
    // bumped.
    for (const [id, row] of after) {
      const was = before.get(id)!;
      expect(row.platformData).toEqual(was.platformData);
      expect(row.platformFacets).toEqual(was.platformFacets);
      expect(row.platformLabels).toEqual(was.platformLabels);
      expect(row.lastUpdated).toBe(was.lastUpdated);
    }
  });

  test("a second armed run is the steady state: everything it flagged reads as already flagged", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "true");
    const t = convexTest(schema, modules);
    await seedBuckets(t);
    await run(t, "BACKFILL");
    const between = await allRows(t);

    const again = await run(t, "BACKFILL");

    expect(again.counts).toEqual({
      ...EXPECTED_COUNTS,
      flagged: 0,
      alreadyFlagged: 3,
    });
    expect(await allRows(t)).toEqual(between);
  });

  test("the action walks every page: more than one page of rows is all flagged", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const n = PAGE_SIZE + 7;
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Inserts ${i}`,
          platformData: { bsc: { b0: "insert" } },
          platformFacets: { bsc: { b0: "variant" } },
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });

    const result = await run(t, "BACKFILL");

    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.counts.flagged).toBe(n);
    const rows = await allRows(t);
    expect(rows.every((r) => r.metadata?.variantRole === "insert")).toBe(true);
  });

  test("a run that stops at its page cap returns continueCursor, and a run given it carries on from there", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const n = PAGE_SIZE + 7;
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Parallels ${i}`,
          platformData: { bsc: { b0: "parallel" } },
          platformFacets: { bsc: { b0: "variant" } },
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });

    const first = await t.action(internal.backfillVariantTypeRole.run, {
      confirm: "BACKFILL",
      maxPages: 1,
    });
    expect(first.truncated).toBe(true);
    expect(first.counts.flagged).toBe(PAGE_SIZE);
    expect(first.message).toMatch(/continueCursor/);
    expect(first.continueCursor).toEqual(expect.any(String));

    const second = await t.action(internal.backfillVariantTypeRole.run, {
      confirm: "BACKFILL",
      cursor: first.continueCursor,
    });
    // Only the rows past the first page: the cursor, not a restart.
    expect(second.counts.scanned).toBe(7);
    expect(second.counts.flagged).toBe(7);
    expect(second.truncated).toBe(false);
    expect(second.continueCursor).toBeUndefined();
    const rows = await allRows(t);
    expect(rows.every((r) => r.metadata?.variantRole === "parallel")).toBe(true);
  });

  test("both functions are internal: no client can reach the backfill", () => {
    const src = readFileSync(join(__dirname, "backfillVariantTypeRole.ts"), "utf8");
    expect(src).toContain("export const runPage = internalMutation({");
    expect(src).toContain("export const run = internalAction({");
    expect(src).not.toMatch(/export const \w+ = (query|mutation|action)\(/);
  });
});

/**
 * NEO-306 — `reportBaseAnomalies`: the base role and the Base row are one
 * thing now, and data written before that rule can break it. The report
 * COUNTS the two shapes, per set, and never writes.
 */
describe("reportBaseAnomalies", () => {
  async function seedSet(
    t: T,
    value: string,
    types: Array<{ value: string; isBase?: boolean; cards?: number }>,
  ): Promise<{ setId: Id<"selectorOptions">; typeIds: Array<Id<"selectorOptions">> }> {
    return t.run(async (ctx) => {
      const setId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value,
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      });
      const typeIds: Array<Id<"selectorOptions">> = [];
      for (const type of types) {
        const typeId = await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: type.value,
          platformData: {},
          ...(type.isBase !== undefined ? { metadata: { isBase: type.isBase } } : {}),
          parentId: setId,
          children: [],
          lastUpdated: SENTINEL,
        });
        typeIds.push(typeId);
        for (let i = 0; i < (type.cards ?? 0); i++) {
          await ctx.db.insert("cardChecklist", {
            selectorOptionId: typeId,
            cardNumber: String(i + 1),
            cardName: `Card ${i + 1}`,
            platformData: {},
            sortOrder: i,
            lastUpdated: SENTINEL,
          });
        }
      }
      return { setId, typeIds };
    });
  }

  test("counts each anomaly once per set, names the sets, and ignores the healthy shapes", async () => {
    const t = convexTest(schema, modules);
    // Healthy: exactly one base (with cards), or no base and no cards anywhere
    // (a hand-built set not yet told which is its base).
    await seedSet(t, "Healthy", [
      { value: "Base", isBase: true, cards: 2 },
      { value: "Inserts" },
    ]);
    await seedSet(t, "Unbuilt", [{ value: "Base" }, { value: "Inserts" }]);
    // Two base rows.
    const twoBases = await seedSet(t, "Two bases", [
      { value: "Base", isBase: true },
      { value: "Base Set", isBase: true, cards: 1 },
    ]);
    // No base, but a type holding cards straight off it — the shape a Base
    // that lost its flag leaves. Two such types still count the SET once.
    const lostFlag = await seedSet(t, "Lost flag", [
      { value: "Base", cards: 3 },
      { value: "Other", isBase: false, cards: 1 },
    ]);
    const before = await allRows(t);

    const res = await t.action(internal.backfillVariantTypeRole.reportBaseAnomalies, {});

    expect(res.counts).toEqual({
      setsScanned: 4,
      multipleBase: 1,
      noBaseWithCards: 1,
    });
    expect(res.multipleBaseSetIds).toEqual([twoBases.setId]);
    expect(res.noBaseWithCardsSetIds).toEqual([lostFlag.setId]);
    expect(res.truncated).toBe(false);
    expect(res.message).toMatch(/^Report only — nothing written\./);
    // NEVER auto-fixed: every row is byte-identical afterwards.
    expect(await allRows(t)).toEqual(before);
  });

  test("walks every page and caps the sample ids", async () => {
    const t = convexTest(schema, modules);
    const total = REPORT_PAGE_SIZE + REPORT_SAMPLE_LIMIT;
    for (let i = 0; i < total; i++) {
      await seedSet(t, `Set ${i}`, [
        { value: "A", isBase: true },
        { value: "B", isBase: true },
      ]);
    }

    const res = await t.action(internal.backfillVariantTypeRole.reportBaseAnomalies, {});

    expect(res.pages).toBeGreaterThan(1);
    expect(res.counts.setsScanned).toBe(total);
    expect(res.counts.multipleBase).toBe(total);
    expect(res.multipleBaseSetIds).toHaveLength(REPORT_SAMPLE_LIMIT);
  });

  test("a truncated report says so and resumes from its cursor", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < REPORT_PAGE_SIZE + 3; i++) {
      await seedSet(t, `Set ${i}`, [{ value: "Base", cards: 1 }]);
    }

    const first = await t.action(internal.backfillVariantTypeRole.reportBaseAnomalies, {
      maxPages: 1,
    });
    expect(first.truncated).toBe(true);
    expect(first.continueCursor).toBeDefined();
    expect(first.counts.setsScanned).toBe(REPORT_PAGE_SIZE);

    const second = await t.action(internal.backfillVariantTypeRole.reportBaseAnomalies, {
      cursor: first.continueCursor,
    });
    expect(second.truncated).toBe(false);
    expect(second.counts.setsScanned).toBe(3);
    expect(second.counts.noBaseWithCards).toBe(3);
  });

  test("the report is internal, and a query: it cannot write", () => {
    const src = readFileSync(join(__dirname, "backfillVariantTypeRole.ts"), "utf8");
    expect(src).toContain("export const reportBaseAnomaliesPage = internalQuery({");
    expect(src).toContain("export const reportBaseAnomalies = internalAction({");
  });
});
