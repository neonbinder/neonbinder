/**
 * NEO-334 — `backfillVariantTypeRole`: `reportBaseAnomalies` (READ-ONLY)
 * reads the TITLE: two Bases, no Base with cards off a type, and same-word
 * siblings. The strip and the title-vs-flag report went with the retired
 * schema fields (NEO-334 PR B).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { REPORT_PAGE_SIZE, REPORT_SAMPLE_LIMIT } from "./backfillVariantTypeRole";
import { insertTestCard } from "../lib/testing/card-row";

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

async function allRows(t: T) {
  return t.run(async (ctx) => ctx.db.query("selectorOptions").collect());
}

// ===========================================================================
// reportBaseAnomalies — reads the title
// ===========================================================================

describe("reportBaseAnomalies", () => {
  async function seedSet(
    t: T,
    value: string,
    types: Array<{ value: string; cards?: number }>,
  ): Promise<{ setId: Id<"selectorOptions">; typeIds: Array<Id<"selectorOptions">> }> {
    return t.run(async (ctx) => {
      // NEO-363 — a card cannot exist without a sport above it.
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        lastUpdated: SENTINEL,
      });
      const setId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value,
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: SENTINEL,
      });
      const typeIds: Array<Id<"selectorOptions">> = [];
      for (const type of types) {
        const typeId = await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: type.value,
          platformData: {},
          parentId: setId,
          children: [],
          lastUpdated: SENTINEL,
        });
        typeIds.push(typeId);
        for (let i = 0; i < (type.cards ?? 0); i++) {
          await insertTestCard(ctx, {
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
    expect(src).not.toMatch(/export const \w+ = (query|mutation|action|internalMutation)\(/);
  });
});
