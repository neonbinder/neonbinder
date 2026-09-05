/**
 * NEO-211 G — the pre-merge instrument.
 *
 * The new matcher prefers marketplace id over display name, which only helps
 * rows that HAVE an id. This query sizes the three populations that will
 * behave differently on the first forced sync after deploy — rows with no id
 * on a side (they fall to the name tier), siblings that already fold to one
 * name, and marketplace ids held by more than one sibling (both of which make
 * the matcher WITHHOLD rather than guess).
 *
 * Run it against dev before merge and against prod before the first forced
 * sync. The counts are the whole point, so they are what is asserted.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_000_000;

describe("auditSelectorOptionsForResync", () => {
  test("counts id-less rows, folded sibling names and shared marketplace ids", async () => {
    const t = convexTest(schema, modules);

    const parentId: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Topps Inc",
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    await t.run(async (ctx) => {
      // Fully linked — the boring case.
      await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Topps",
        platformData: { bsc: { b0: "t1" }, sportlots: { s0: "s1" } },
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      });
      // BSC only: falls to the name tier on the SportLots side.
      await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Bowman",
        platformData: { bsc: { b0: "b1" } },
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      });
      // Shares "b1" with Bowman — legal under NEO-137, but tier 1 withholds.
      await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Bowman Draft",
        platformData: { bsc: { b0: "b1" } },
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      });
      // Two siblings folding to one name: tier 2 withholds on both.
      await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Chrome",
        platformData: {},
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      });
      await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "  chrome ",
        platformData: {},
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      });
      // NEO-239 — a row nobody linked. It used to carry `isCustom: true` and
      // be EXCLUDED from the id counts on the theory that it was a different
      // kind of row. It is not: "no BSC id, no SL id" is exactly the fact this
      // audit exists to size, and hiding a whole population from it made the
      // pre-resync estimate wrong in the direction that matters.
      await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "My Own Set",
        platformData: {},
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      });
    });

    const report = await t.query(
      internal.selectorOptions.auditSelectorOptionsForResync,
      {},
    );

    expect(report.scanned.truncated).toBe(false);
    const setName = report.byLevel.find((l) => l.level === "setName")!;
    expect(setName.rows).toBe(6);
    // Every row is countable now — see the seed note above.
    expect(setName.linkableRows).toBe(6);
    // Chrome ×2 plus the unlinked row: everything without a BSC slug.
    expect(setName.missingBsc).toBe(3);
    // Everything except "Topps".
    expect(setName.missingSportlots).toBe(5);
    // No variantType rows in this fixture, so nothing is missing a variant tag.
    expect(setName.missingVariantFacet).toBe(0);
    expect(setName.valueCollisionGroups).toBe(1);
    expect(setName.sharedMarketplaceIds).toBe(1);

    expect(report.samples.valueCollision[0]).toMatchObject({
      level: "setName",
      key: "chrome",
      rowCount: 2,
    });
    expect(report.samples.sharedId[0]).toMatchObject({
      level: "setName",
      side: "bsc",
      marketplaceId: "b1",
      rowCount: 2,
    });
    expect(
      report.samples.missingId.some(
        (s) => s.value === "Bowman" && s.side === "sportlots",
      ),
    ).toBe(true);
    // NEO-239 — and an UNLINKED row IS reported. It is the clearest instance of
    // the thing the sample list is for.
    expect(
      report.samples.missingId.some((s) => s.value === "My Own Set"),
    ).toBe(true);
  });

  test("a collision only counts inside one sibling group", async () => {
    const t = convexTest(schema, modules);
    // The matcher is scoped to (level, parentId): the same name under two
    // different parents is not ambiguous, because no store call sees both.
    await t.run(async (ctx) => {
      const a = await ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Topps Inc",
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      });
      const b = await ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Panini Inc",
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      });
      for (const parentId of [a, b]) {
        await ctx.db.insert("selectorOptions", {
          level: "setName",
          value: "Chrome",
          platformData: {},
          parentId,
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });

    const report = await t.query(
      internal.selectorOptions.auditSelectorOptionsForResync,
      {},
    );
    const setName = report.byLevel.find((l) => l.level === "setName")!;
    expect(setName.valueCollisionGroups).toBe(0);
  });
});
