/**
 * NEO-345 follow-up (security audit S1, S2) — the bounds and the failure
 * isolation of an answer's reach onto parallels (`autographFormat.ts`).
 *
 *   - S1: the reached parallels are walked in scheduled chunks of
 *     `PARALLEL_WALKS_PER_ACTION`, and one parallel whose walk fails strands
 *     only itself: the next one is still walked and formatted. The failure is
 *     logged with ids and the error's class only.
 *   - S2: the reach stops at `MAX_PARALLELS_PER_ANSWER` rows (exercised with
 *     the test-only smaller bound) and says so; a set with more variant types
 *     than `MAX_VARIANT_TYPES_PER_SET` has no Base the reach can trust, so a
 *     Base answer reaches nothing.
 *
 * Its own file because S1 replaces `cardChecklist.applyBscAttributeFill` with
 * a wrapper that throws for one marked card, which every other autograph test
 * must not see.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import {
  MAX_PARALLELS_PER_ANSWER,
  PARALLEL_WALKS_PER_ACTION,
  adoptAutographFormatOnParallels,
} from "./autographFormat";
import { MAX_PARALLELS_PER_INSERT, MAX_VARIANT_TYPES_PER_SET } from "./parallelChecklistBuild";

/** A card numbered this makes the fill throw: one parallel's walk fails. */
const BOOM = "BOOM-1";

vi.mock("./cardChecklist", async (importOriginal) => {
  const original = await importOriginal<typeof import("./cardChecklist")>();
  return {
    ...original,
    applyBscAttributeFill: (async (...args: Parameters<typeof original.applyBscAttributeFill>) => {
      if (args[1].cardNumber === BOOM) throw new Error("a fill that cannot finish");
      return original.applyBscAttributeFill(...args);
    }) as typeof original.applyBscAttributeFill,
  };
});

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin", role: "admin" };
const SEEDED_AT = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedInsert(t: T, parallels: number) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: SEEDED_AT,
    });
    const insertId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Signature Series",
      platformData: {},
      parentId: sportId,
      children: [],
      features: { autographed: "None" },
      lastUpdated: SEEDED_AT,
    });
    const parallelIds: Array<Id<"selectorOptions">> = [];
    for (let i = 0; i < parallels; i++) {
      parallelIds.push(
        await ctx.db.insert("selectorOptions", {
          level: "parallel",
          value: `Parallel ${i}`,
          platformData: {},
          parentId: insertId,
          children: [],
          features: { autographed: "None" },
          lastUpdated: SEEDED_AT,
        }),
      );
    }
    await ctx.db.patch(insertId, { children: parallelIds });
    return { insertId, parallelIds };
  });
}

const auCard = (t: T, selectorOptionId: Id<"selectorOptions">, cardNumber: string) =>
  t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      attributes: ["AU"],
      features: { autographed: "None" },
      platformData: {},
      sortOrder: 0,
      lastUpdated: SEEDED_AT,
    }),
  );

const get = <K extends "cardChecklist" | "selectorOptions">(t: T, id: Id<K>) =>
  t.run(async (ctx) => ctx.db.get(id));

describe("S1 — the parallels' walks are chunked and isolated", () => {
  test("parallel k's walk throws; k+1 is still walked and formatted, and the failure logs ids and the error class only", async () => {
    const t = convexTest(schema, modules);
    const { insertId, parallelIds } = await seedInsert(t, 3);
    const first = await auCard(t, parallelIds[0], "1");
    const broken = await auCard(t, parallelIds[1], BOOM);
    const next = await auCard(t, parallelIds[2], "1");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: insertId,
      value: "On Card",
    });
    await drainScheduled(t);

    expect((await get(t, first))!.features?.autographed).toBe("On Card");
    expect((await get(t, broken))!.features?.autographed).toBe("None");
    expect((await get(t, next))!.features?.autographed).toBe("On Card");

    const lines = errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("autograph_format_parallel_walk_failed"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      msg: "autograph_format_parallel_walk_failed",
      selectorOptionId: parallelIds[1],
      errorClass: "Error",
    });
    // Never the error's own words.
    expect(lines[0]).not.toContain("cannot finish");
  });

  test("the leaf's own walk failing strands no parallel: their chunks are scheduled first", async () => {
    const t = convexTest(schema, modules);
    const { insertId, parallelIds } = await seedInsert(t, 1);
    await auCard(t, insertId, BOOM);
    const parallelCard = await auCard(t, parallelIds[0], "1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.run(async (ctx) => {
      await ctx.db.patch(insertId, { features: { autographed: "None", autographFormat: "On Card" } });
      await ctx.db.patch(parallelIds[0], { features: { autographed: "None", autographFormat: "On Card" } });
    });
    await expect(
      t.action(internal.autographFormat.cascadeAutographFormat, {
        selectorOptionId: insertId,
        format: "On Card",
        parallelIds,
      }),
    ).rejects.toThrow();
    await drainScheduled(t);
    expect((await get(t, parallelCard))!.features?.autographed).toBe("On Card");
  });

  test(`${PARALLEL_WALKS_PER_ACTION + 5} reached parallels are scheduled as two chunk actions, at most ${PARALLEL_WALKS_PER_ACTION} each`, async () => {
    const t = convexTest(schema, modules);
    const { insertId, parallelIds } = await seedInsert(t, PARALLEL_WALKS_PER_ACTION + 5);
    await t.run(async (ctx) => {
      await ctx.db.patch(insertId, { features: { autographed: "None", autographFormat: "On Card" } });
    });
    const result = await t.action(internal.autographFormat.cascadeAutographFormat, {
      selectorOptionId: insertId,
      format: "On Card",
      parallelIds,
    });
    expect(result.parallels).toBe(PARALLEL_WALKS_PER_ACTION + 5);
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const chunks = scheduled.filter((f) => f.name.includes("cascadeAutographFormatParallels"));
    expect(chunks.map((f) => (f.args[0] as { parallelIds: unknown[] }).parallelIds.length)).toEqual([
      PARALLEL_WALKS_PER_ACTION,
      5,
    ]);
    await drainScheduled(t);
  });

  test("a chunk larger than the bound is refused", async () => {
    const t = convexTest(schema, modules);
    const { parallelIds } = await seedInsert(t, PARALLEL_WALKS_PER_ACTION + 1);
    await expect(
      t.action(internal.autographFormat.cascadeAutographFormatParallels, {
        format: "On Card",
        parallelIds,
      }),
    ).rejects.toThrow(/at most/);
  });
});

describe("S2 — the reach's bounds", () => {
  test("the bound is the parallel build's own list bound", () => {
    expect(MAX_PARALLELS_PER_ANSWER).toBe(MAX_PARALLELS_PER_INSERT);
    expect(MAX_PARALLELS_PER_ANSWER).toBe(500);
  });

  test("past the bound the reach adopts exactly the bound and says it was truncated", async () => {
    const t = convexTest(schema, modules);
    const { insertId, parallelIds } = await seedInsert(t, 5);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await t.run(async (ctx) =>
      adoptAutographFormatOnParallels(ctx, (await ctx.db.get(insertId))!, "On Card", undefined, { limit: 3 }),
    );
    expect(result.parallelIds).toEqual(parallelIds.slice(0, 3));
    expect(result.truncated).toBe(true);
    const held = await t.run(async (ctx) =>
      Promise.all(parallelIds.map(async (id) => (await ctx.db.get(id))!.features?.autographFormat ?? "unset")),
    );
    expect(held).toEqual(["On Card", "On Card", "On Card", "unset", "unset"]);
    const lines = warnings.mock.calls.map((call) => String(call[0])).filter((l) => l.includes("autograph_format_parallels_truncated"));
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { msg: "autograph_format_parallels_truncated", selectorOptionId: insertId, reached: 3, limit: 3 },
    ]);
  });

  test("exactly the bound is not truncated", async () => {
    const t = convexTest(schema, modules);
    const { insertId } = await seedInsert(t, 3);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await t.run(async (ctx) =>
      adoptAutographFormatOnParallels(ctx, (await ctx.db.get(insertId))!, "On Card", undefined, { limit: 3 }),
    );
    expect(result).toMatchObject({ truncated: false });
    expect(result.parallelIds).toHaveLength(3);
    expect(warnings).not.toHaveBeenCalled();
  });

  test("a test bound can only make the reach smaller", async () => {
    const t = convexTest(schema, modules);
    const { insertId } = await seedInsert(t, 2);
    const result = await t.run(async (ctx) =>
      adoptAutographFormatOnParallels(ctx, (await ctx.db.get(insertId))!, "On Card", undefined, { limit: 0 }),
    );
    // Clamped to at least one, never to nothing.
    expect(result.parallelIds).toHaveLength(1);
  });

  test(`a set with more than ${MAX_VARIANT_TYPES_PER_SET} variant types: a Base answer reaches nothing`, async () => {
    const t = convexTest(schema, modules);
    const { baseId, refractorId } = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: SEEDED_AT,
      });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Chrome",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: SEEDED_AT,
      });
      const type = (value: string) =>
        ctx.db.insert("selectorOptions", {
          level: "variantType",
          value,
          platformData: {},
          parentId: setNameId,
          children: [],
          features: { autographed: "None" },
          lastUpdated: SEEDED_AT,
        });
      const baseId = await type("Base");
      const parallelsTypeId = await type("Parallels");
      for (let i = 0; i < MAX_VARIANT_TYPES_PER_SET - 1; i++) await type(`Promo ${i}`);
      const refractorId = await ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Refractors",
        platformData: {},
        parentId: parallelsTypeId,
        children: [],
        features: { autographed: "None" },
        lastUpdated: SEEDED_AT,
      });
      return { baseId, refractorId };
    });
    const result = await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: baseId,
      value: "On Card",
    });
    expect(result).toEqual({ parallelIds: [], movedIds: [] });
    expect((await get(t, refractorId))!.features).not.toHaveProperty("autographFormat");
    await drainScheduled(t);
  });
});
