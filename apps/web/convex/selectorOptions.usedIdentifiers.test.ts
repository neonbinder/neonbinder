/**
 * NEO-306 (v1 decision 7) — `getUsedInsertIdentifiersBySet` reads the
 * parallel-level children of each insert too.
 *
 * "Make insert of…" lands SportLots links on a PARALLEL of an insert. The
 * Inserts and Parallels reconciles hold back every id this query reports as
 * used; before this it read only `insert`-level rows, so an id placed one
 * level down was re-offered and could land on a second row — the NEO-305
 * "one SL id on two rows" bug, one level deeper.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_PARALLELS_PER_INSERT } from "./selectorOptions";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_neo306_used", role: "admin" };

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const insert = (fields: Record<string, unknown>) =>
      ctx.db.insert("selectorOptions", {
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
        ...fields,
      } as never) as Promise<Id<"selectorOptions">>;
    const setId = await insert({ level: "setName", value: "Bowman" });
    const insertTypeId = await insert({
      level: "variantType",
      value: "Insert",
      parentId: setId,
      metadata: { variantRole: "insert" },
    });
    const parallelTypeId = await insert({
      level: "variantType",
      value: "Parallel",
      parentId: setId,
      metadata: { variantRole: "parallel" },
    });
    const autosId = await insert({
      level: "insert",
      value: "All-America Game Autos",
      parentId: insertTypeId,
      platformData: { bsc: { b0: "bsc-autos" }, sportlots: { s0: "SL-AUTOS" } },
    });
    // A parallel OF the insert, holding its own ids on both sides.
    const redInkId = await insert({
      level: "parallel",
      value: "Red Ink",
      parentId: autosId,
      platformData: {
        bsc: { b0: "bsc-red-ink" },
        sportlots: { s0: "SL-RED-INK", s1: "SL-RED-INK-2" },
      },
    });
    await ctx.db.patch(autosId, { children: [redInkId] });
    await ctx.db.patch(insertTypeId, { children: [autosId] });
    await ctx.db.patch(setId, { children: [insertTypeId, parallelTypeId] });
    return { setId, insertTypeId, parallelTypeId };
  });
}

describe("getUsedInsertIdentifiersBySet — parallels of inserts (NEO-306)", () => {
  test("an id on a parallel-of-insert row is reported as used, on the SportLots AND the BSC arrays", async () => {
    const t = convexTest(schema, modules);
    const { setId, parallelTypeId } = await seed(t);

    // The Parallels reconcile's call: its own type excluded, siblings counted.
    const used = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.getUsedInsertIdentifiersBySet, {
        setId,
        excludeVariantTypeId: parallelTypeId,
      });

    expect(used.slPlatformValues.sort()).toEqual([
      "SL-AUTOS",
      "SL-RED-INK",
      "SL-RED-INK-2",
    ]);
    expect(used.bscPlatformValues.sort()).toEqual(["bsc-autos", "bsc-red-ink"]);
    // Names stay insert-level only: a parallel's name says nothing about
    // which top-level insert is taken.
    expect(used.values).toEqual(["All-America Game Autos"]);
  });

  test("excluding the insert's own type excludes its parallels too (the keep shelf re-offers them)", async () => {
    const t = convexTest(schema, modules);
    const { setId, insertTypeId } = await seed(t);

    const used = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.getUsedInsertIdentifiersBySet, {
        setId,
        excludeVariantTypeId: insertTypeId,
      });
    expect(used).toEqual({ values: [], slPlatformValues: [], bscPlatformValues: [] });
  });

  test("an insert with more than MAX_PARALLELS_PER_INSERT parallels is refused, never half-reported (fail closed)", async () => {
    // A short list would re-offer an id already placed on an unread
    // parallel; the security audit asked for a bound that refuses instead.
    const t = convexTest(schema, modules);
    const { setId, parallelTypeId } = await seed(t);
    await t.run(async (ctx) => {
      const autos = (
        await ctx.db
          .query("selectorOptions")
          .withIndex("by_level_and_parent", (q) => q.eq("level", "insert"))
          .collect()
      )[0];
      for (let i = 0; i < MAX_PARALLELS_PER_INSERT; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "parallel",
          value: `Colour ${i}`,
          parentId: autos._id,
          platformData: {},
          children: [],
          lastUpdated: 1_700_000_000_000,
        });
      }
    });

    await expect(
      t.withIdentity(ADMIN).query(api.selectorOptions.getUsedInsertIdentifiersBySet, {
        setId,
        excludeVariantTypeId: parallelTypeId,
      }),
    ).rejects.toThrow(/more than 1000 parallels/);
  });
});
