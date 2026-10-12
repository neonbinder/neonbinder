/**
 * NEO-334 — `backfillVariantTypeRole`: the retirement of the role flags.
 *
 *   - `stripRoleFlags` (ARMED) removes `isBase` / `variantRole` / `isInsert` /
 *     `isParallel` from stored rows. Dry run is the default; `confirm` without
 *     the deployment arm is refused; an armed run writes metadata only, drops
 *     a metadata left empty, never bumps `lastUpdated`, keeps every other key;
 *     a second run is the steady state; paging resumes from level + cursor.
 *   - `reportTitleKind` (READ-ONLY) buckets variant types by whether reading
 *     the title changes the kind the flags gave.
 *   - `reportBaseAnomalies` (READ-ONLY) reads the TITLE: two Bases, no Base
 *     with cards off a type, and same-word siblings.
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
  SAMPLE_LIMIT,
  strippedMetadata,
} from "./backfillVariantTypeRole";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_700_000_000_000;
type T = ReturnType<typeof convexTest>;
type Level = Doc<"selectorOptions">["level"];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function insertRow(
  t: T,
  level: Level,
  value: string,
  metadata?: Doc<"selectorOptions">["metadata"],
  parentId?: Id<"selectorOptions">,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level,
      value,
      platformData: { bsc: { b0: value.toLowerCase() } },
      platformFacets: { bsc: { b0: "variant" } },
      ...(metadata ? { metadata } : {}),
      ...(parentId ? { parentId } : {}),
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function allRows(t: T) {
  return t.run(async (ctx) => ctx.db.query("selectorOptions").collect());
}

// ===========================================================================
// strippedMetadata — the pure part
// ===========================================================================

describe("strippedMetadata", () => {
  test("a row with no metadata, or none of the retired keys, has nothing to strip", () => {
    expect(strippedMetadata(undefined)).toBeNull();
    expect(strippedMetadata({})).toBeNull();
    expect(strippedMetadata({ cardNumberPrefix: "IN-" })).toBeNull();
  });

  test("removes all four retired keys and keeps the rest", () => {
    expect(
      strippedMetadata({
        isBase: true,
        variantRole: "insert",
        isInsert: true,
        isParallel: true,
        cardNumberPrefix: "IN-",
      }),
    ).toEqual({ cardNumberPrefix: "IN-" });
  });

  test("a metadata left empty becomes undefined, not {}", () => {
    expect(strippedMetadata({ isBase: true })).toBeUndefined();
    expect(strippedMetadata({ isInsert: false })).toBeUndefined();
  });
});

// ===========================================================================
// stripRoleFlags
// ===========================================================================

const strip = (t: T, args: Record<string, unknown> = {}) =>
  t.action(internal.backfillVariantTypeRole.stripRoleFlags, args);

/** Flagged rows at all three levels, a clean one, and a row of another level. */
async function seedFlagged(t: T) {
  const base = await insertRow(t, "variantType", "Base", { isBase: true });
  const insertType = await insertRow(t, "variantType", "Inserts", {
    variantRole: "insert",
    cardNumberPrefix: "IN-",
  });
  const clean = await insertRow(t, "variantType", "Promo", { cardNumberPrefix: "P-" });
  const noMeta = await insertRow(t, "variantType", "Plain");
  const insert = await insertRow(t, "insert", "Gold Foil", { isInsert: true });
  const parallel = await insertRow(t, "parallel", "Refractor", { isParallel: true });
  const setRow = await insertRow(t, "setName", "2024 Topps", { isBase: true });
  return { base, insertType, clean, noMeta, insert, parallel, setRow };
}

const FLAGGED_COUNTS = { scanned: 6, stripped: 4, clean: 2 };

describe("stripRoleFlags", () => {
  test("the dry run is the default: it counts what an armed run would strip and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedFlagged(t);
    const before = await allRows(t);

    const result = await strip(t);

    expect(result.armed).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.counts).toEqual(FLAGGED_COUNTS);
    expect(result.message).toMatch(/^Dry run/);
    expect(await allRows(t)).toEqual(before);
  });

  test("a wrong confirm token is still a dry run", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    await seedFlagged(t);
    const before = await allRows(t);

    const result = await strip(t, { confirm: "yes" });

    expect(result.armed).toBe(false);
    expect(result.message).toMatch(/^Dry run/);
    expect(await allRows(t)).toEqual(before);
  });

  test("confirm without the deployment arm is refused, reported, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedFlagged(t);
    const before = await allRows(t);

    const result = await strip(t, { confirm: "BACKFILL" });

    expect(result.armed).toBe(false);
    expect(result.message).toMatch(/ALLOW_SELECTOR_BACKFILL/);
    expect(result.counts).toEqual(FLAGGED_COUNTS);
    expect(await allRows(t)).toEqual(before);
  });

  test("armed: the flags go, other metadata stays, an emptied metadata is removed, lastUpdated and slots are untouched", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const ids = await seedFlagged(t);
    const before = new Map((await allRows(t)).map((r) => [r._id, r]));

    const result = await strip(t, { confirm: "BACKFILL" });

    expect(result.armed).toBe(true);
    expect(result.message).toMatch(/^Applied/);
    expect(result.counts).toEqual(FLAGGED_COUNTS);
    const after = new Map((await allRows(t)).map((r) => [r._id, r]));

    expect(after.get(ids.base)?.metadata).toBeUndefined();
    expect("metadata" in (after.get(ids.base) ?? {})).toBe(false);
    expect(after.get(ids.insertType)?.metadata).toEqual({ cardNumberPrefix: "IN-" });
    expect(after.get(ids.insert)?.metadata).toBeUndefined();
    expect(after.get(ids.parallel)?.metadata).toBeUndefined();
    // Clean rows, and rows at levels the strip does not walk, are untouched.
    for (const untouched of [ids.clean, ids.noMeta, ids.setRow]) {
      expect(after.get(untouched)).toEqual(before.get(untouched));
    }
    for (const [id, row] of after) {
      const was = before.get(id)!;
      expect(row.value).toBe(was.value);
      expect(row.platformData).toEqual(was.platformData);
      expect(row.platformFacets).toEqual(was.platformFacets);
      expect(row.lastUpdated).toBe(was.lastUpdated);
    }
  });

  test("a second armed run is the steady state: nothing left to strip, nothing written", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "true");
    const t = convexTest(schema, modules);
    await seedFlagged(t);
    await strip(t, { confirm: "BACKFILL" });
    const between = await allRows(t);

    const again = await strip(t, { confirm: "BACKFILL" });

    expect(again.counts).toEqual({ scanned: 6, stripped: 0, clean: 6 });
    expect(await allRows(t)).toEqual(between);
  });

  test("the action walks every page of a level", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const n = PAGE_SIZE + 7;
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Inserts ${i}`,
          platformData: {},
          metadata: { variantRole: "insert" },
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });

    const result = await strip(t, { confirm: "BACKFILL" });

    expect(result.truncated).toBe(false);
    expect(result.counts.stripped).toBe(n);
    expect((await allRows(t)).every((r) => r.metadata === undefined)).toBe(true);
  });

  test("a run that stops at its page cap names the level and cursor, and a run given them carries on", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const n = PAGE_SIZE + 7;
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Parallels ${i}`,
          platformData: {},
          metadata: { variantRole: "parallel" },
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });

    const first = await strip(t, { confirm: "BACKFILL", maxPages: 1 });
    expect(first.truncated).toBe(true);
    expect(first.counts.stripped).toBe(PAGE_SIZE);
    expect(first.continueLevel).toBe("variantType");
    expect(first.continueCursor).toEqual(expect.any(String));
    expect(first.message).toMatch(/continue values/);

    const second = await strip(t, {
      confirm: "BACKFILL",
      level: first.continueLevel,
      cursor: first.continueCursor,
    });
    // Only the rows past the first page: the cursor, not a restart.
    expect(second.counts.scanned).toBe(7);
    expect(second.counts.stripped).toBe(7);
    expect(second.truncated).toBe(false);
    expect(second.continueCursor).toBeUndefined();
    expect((await allRows(t)).every((r) => r.metadata === undefined)).toBe(true);
  });

  test("a run resumed at a later level skips the earlier ones", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const ids = await seedFlagged(t);

    const result = await strip(t, { confirm: "BACKFILL", level: "insert" });

    expect(result.counts.scanned).toBe(2);
    const after = new Map((await allRows(t)).map((r) => [r._id, r]));
    expect(after.get(ids.insert)?.metadata).toBeUndefined();
    expect(after.get(ids.base)?.metadata).toEqual({ isBase: true });
  });

  test("the internal page mutation re-asserts the arm itself: an unarmed armed-call writes nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedFlagged(t);

    const page = await t.mutation(internal.backfillVariantTypeRole.stripRoleFlagsPage, {
      confirm: "BACKFILL",
      level: "variantType",
      cursor: null,
    });

    expect(page.armed).toBe(false);
    expect(page.refusedForFlag).toBe(true);
    const base = await t.run(async (ctx) => ctx.db.get(ids.base));
    expect(base?.metadata).toEqual({ isBase: true });
  });

  test("every function is internal: no client can reach the strip or the reports", () => {
    const src = readFileSync(join(__dirname, "backfillVariantTypeRole.ts"), "utf8");
    expect(src).toContain("export const stripRoleFlagsPage = internalMutation({");
    expect(src).toContain("export const stripRoleFlags = internalAction({");
    expect(src).toContain("export const reportTitleKind = internalAction({");
    expect(src).not.toMatch(/export const \w+ = (query|mutation|action)\(/);
  });
});

// ===========================================================================
// reportTitleKind
// ===========================================================================

describe("reportTitleKind", () => {
  const report = (t: T, args: Record<string, unknown> = {}) =>
    t.action(internal.backfillVariantTypeRole.reportTitleKind, args);

  test("buckets each variant type by title against the flags, ids only, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const agreeBase = await insertRow(t, "variantType", "Base", { isBase: true });
    const agreeInsert = await insertRow(t, "variantType", "Inserts", { variantRole: "insert" });
    const agreeNone = await insertRow(t, "variantType", "Promo");
    const gained = await insertRow(t, "variantType", "Parallels");
    const lost = await insertRow(t, "variantType", "Gold", { variantRole: "insert" });
    const lostBase = await insertRow(t, "variantType", "Base Set", { isBase: true });
    const switched = await insertRow(t, "variantType", "Insert", { variantRole: "parallel" });
    const notAType = await insertRow(t, "insert", "Gold Foil", { isInsert: true });
    const before = await allRows(t);

    const res = await report(t);

    expect(res.counts).toEqual({ scanned: 7, agree: 3, gained: 1, lost: 2, switched: 1 });
    expect(res.samples.gained).toEqual([gained]);
    expect(res.samples.lost.sort()).toEqual([lost, lostBase].sort());
    expect(res.samples.switched).toEqual([switched]);
    for (const id of [agreeBase, agreeInsert, agreeNone, notAType]) {
      expect(JSON.stringify(res.samples)).not.toContain(id);
    }
    expect(res.truncated).toBe(false);
    expect(res.message).toMatch(/^Report only — nothing written\./);
    expect(await allRows(t)).toEqual(before);
  });

  test("an isBase flag outranks a variantRole flag, as it always did", async () => {
    const t = convexTest(schema, modules);
    await insertRow(t, "variantType", "Base", { isBase: true, variantRole: "insert" });

    const res = await report(t);

    expect(res.counts.agree).toBe(1);
  });

  test("walks every page, caps the sample ids, and resumes from its cursor", async () => {
    const t = convexTest(schema, modules);
    const total = PAGE_SIZE + SAMPLE_LIMIT + 3;
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Inserts ${i}`,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
    // "Inserts N" has no kind and no flag: all agree. Make them all gain.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("selectorOptions").collect()) {
        await ctx.db.patch(row._id, { value: "Inserts" });
      }
    });

    const whole = await report(t);
    expect(whole.counts.scanned).toBe(total);
    expect(whole.counts.gained).toBe(total);
    expect(whole.samples.gained).toHaveLength(SAMPLE_LIMIT);

    const first = await report(t, { maxPages: 1 });
    expect(first.truncated).toBe(true);
    expect(first.counts.scanned).toBe(PAGE_SIZE);
    const second = await report(t, { cursor: first.continueCursor });
    expect(second.truncated).toBe(false);
    expect(second.counts.scanned).toBe(total - PAGE_SIZE);
  });
});

// ===========================================================================
// reportBaseAnomalies — reads the title
// ===========================================================================

describe("reportBaseAnomalies", () => {
  async function seedSet(
    t: T,
    value: string,
    types: Array<{ value: string; cards?: number; metadata?: Doc<"selectorOptions">["metadata"] }>,
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
          ...(type.metadata ? { metadata: type.metadata } : {}),
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

  const report = (t: T, args: Record<string, unknown> = {}) =>
    t.action(internal.backfillVariantTypeRole.reportBaseAnomalies, args);

  test("counts each anomaly once per set, names the sets, and ignores the healthy shapes", async () => {
    const t = convexTest(schema, modules);
    await seedSet(t, "Healthy", [{ value: "Base", cards: 2 }, { value: "Inserts" }]);
    // No Base and no cards anywhere: a hand-built set not yet told its base.
    await seedSet(t, "Unbuilt", [{ value: "Gold" }, { value: "Inserts" }]);
    const twoBases = await seedSet(t, "Two bases", [
      { value: "Base" },
      { value: "Bases", cards: 1 },
    ]);
    // No type titled Base, but cards hang off one: two such types count the SET once.
    const noBase = await seedSet(t, "No base", [
      { value: "Base Set", cards: 3 },
      { value: "Other", cards: 1 },
    ]);
    const before = await allRows(t);

    const res = await report(t);

    expect(res.counts).toEqual({
      setsScanned: 4,
      multipleBase: 1,
      noBaseWithCards: 1,
      // "Base" beside "Bases" is also one word twice.
      sameWordSiblings: 1,
    });
    expect(res.multipleBaseSetIds).toEqual([twoBases.setId]);
    expect(res.noBaseWithCardsSetIds).toEqual([noBase.setId]);
    expect(res.sameWordSiblingsSetIds).toEqual([twoBases.setId]);
    expect(res.truncated).toBe(false);
    expect(res.message).toMatch(/^Report only — nothing written\./);
    expect(await allRows(t)).toEqual(before);
  });

  test("a stray isBase flag does not make a Base: the title decides", async () => {
    const t = convexTest(schema, modules);
    const set = await seedSet(t, "Flag only", [
      { value: "Gold", cards: 2, metadata: { isBase: true } },
    ]);

    const res = await report(t);

    expect(res.counts.multipleBase).toBe(0);
    expect(res.noBaseWithCardsSetIds).toEqual([set.setId]);
  });

  test("counts same-word siblings once per set, plural or singular, and not different words", async () => {
    const t = convexTest(schema, modules);
    const clash = await seedSet(t, "Clash", [
      { value: "Promo" },
      { value: "Promos" },
      { value: "Rated Rookie" },
      { value: "rated   rookies" },
    ]);
    await seedSet(t, "Fine", [{ value: "Promo" }, { value: "Promotion" }, { value: "Insert Set" }, { value: "Inserts" }]);

    const res = await report(t);

    expect(res.counts.sameWordSiblings).toBe(1);
    expect(res.sameWordSiblingsSetIds).toEqual([clash.setId]);
  });

  test("walks every page and caps the sample ids", async () => {
    const t = convexTest(schema, modules);
    const total = REPORT_PAGE_SIZE + REPORT_SAMPLE_LIMIT;
    for (let i = 0; i < total; i++) {
      await seedSet(t, `Set ${i}`, [{ value: "Base" }, { value: "Bases" }]);
    }

    const res = await report(t);

    expect(res.pages).toBeGreaterThan(1);
    expect(res.counts.setsScanned).toBe(total);
    expect(res.counts.multipleBase).toBe(total);
    expect(res.multipleBaseSetIds).toHaveLength(REPORT_SAMPLE_LIMIT);
  });

  test("a truncated report says so and resumes from its cursor", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < REPORT_PAGE_SIZE + 3; i++) {
      await seedSet(t, `Set ${i}`, [{ value: "Gold", cards: 1 }]);
    }

    const first = await report(t, { maxPages: 1 });
    expect(first.truncated).toBe(true);
    expect(first.continueCursor).toBeDefined();
    expect(first.counts.setsScanned).toBe(REPORT_PAGE_SIZE);

    const second = await report(t, { cursor: first.continueCursor });
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
