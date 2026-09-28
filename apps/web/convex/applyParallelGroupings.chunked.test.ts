/**
 * NEO-308 — driving the REAL `applyParallelGroupings` mutation over
 * `chunkGroupingPlan`'s output, in order, the way
 * `ParallelGroupingModal.handleConfirm`'s loop will.
 *
 * `parallelGroupingPlan.test.ts` pins the pure slicing/dedup/ordering logic
 * in isolation. This file is the other half: does a multi-call save actually
 * LAND on a real (convex-test) database the way a single big call would
 * have, and does the sequencing (D before R before P, across chunk
 * boundaries) matter for real when a later chunk's validity depends on an
 * earlier chunk's patch having already committed?
 *
 * Seed helpers copied from `applyParallelGroupings.test.ts` (~L39-100) —
 * same shape, same admin identity pattern, different `subject` string so the
 * two files' convex-test instances never collide.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { groupingRefusal } from "./selectorOptions";
import { chunkGroupingPlan, type GroupingPlan } from "./parallelGroupingPlan";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_apg_chunked_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_apg_chunked_001",
  name: "Admin User",
  role: "admin",
};

const SENTINEL = 1_000_000;

async function insertVariantType(
  t: ReturnType<typeof convexTest>,
  role: "insert" | "parallel",
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: role === "insert" ? "Inserts" : "Base",
      platformData: { bsc: { b0: role } },
      platformFacets: { bsc: { b0: "variant" } },
      metadata: { variantRole: role },
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function insertInsert(
  t: ReturnType<typeof convexTest>,
  variantTypeId: Id<"selectorOptions">,
  value: string,
  metadata?: Record<string, unknown>,
  platformData: Record<string, Record<string, string>> = {},
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value,
      parentId: variantTypeId,
      platformData,
      children: [],
      ...(metadata ? { metadata } : {}),
      lastUpdated: SENTINEL,
    });
    const parent = (await ctx.db.get(variantTypeId))!;
    await ctx.db.patch(variantTypeId, { children: [...parent.children, id] });
    return id;
  });
}

async function insertParallel(
  t: ReturnType<typeof convexTest>,
  insertId: Id<"selectorOptions">,
  value: string,
  metadata?: Record<string, unknown>,
  platformData: Record<string, Record<string, string>> = {},
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "parallel",
      value,
      parentId: insertId,
      platformData,
      children: [],
      ...(metadata ? { metadata } : {}),
      lastUpdated: SENTINEL,
    });
    const parent = (await ctx.db.get(insertId))!;
    await ctx.db.patch(insertId, { children: [...parent.children, id] });
    return id;
  });
}

async function getRow(t: ReturnType<typeof convexTest>, id: Id<"selectorOptions">) {
  return t.run(async (ctx) => ctx.db.get(id));
}

/**
 * Drives the real mutation, once per chunk, in order — exactly the loop
 * `ParallelGroupingModal.handleConfirm` will run. Returns every chunk's
 * result, so a test can assert `results.length === chunk count`.
 */
async function applyChunked(
  asAdmin: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  variantTypeId: Id<"selectorOptions">,
  plan: GroupingPlan,
  limit?: number,
) {
  const chunks = chunkGroupingPlan(plan, limit);
  const results: Array<{
    success: boolean;
    promoted: number;
    demoted: number;
    reparented: number;
  }> = [];
  for (const chunk of chunks) {
    results.push(
      await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId,
        promotions: chunk.promotions,
        demotions: chunk.demotions,
        reparentings: chunk.reparentings,
      }),
    );
  }
  return results;
}

describe("applyParallelGroupings via chunkGroupingPlan — promotions under one target", () => {
  test("0 promotions: no chunks, no calls, nothing moves", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const target = await insertInsert(t, variantTypeId, "Target");

    const results = await applyChunked(asAdmin, variantTypeId, {
      promotions: [],
      demotions: [],
      reparentings: [],
    });

    expect(results).toEqual([]);
    const targetRow = await getRow(t, target);
    expect(targetRow?.children).toEqual([]);
  });

  test("200 promotions: one chunk, one call, every row lands as a parallel", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const target = await insertInsert(t, variantTypeId, "Target");
    const sources: Id<"selectorOptions">[] = [];
    for (let i = 0; i < 200; i++) {
      sources.push(await insertInsert(t, variantTypeId, `Source ${i}`));
    }

    const results = await applyChunked(asAdmin, variantTypeId, {
      promotions: sources.map((insertId) => ({ insertId, targetInsertId: target })),
      demotions: [],
      reparentings: [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].promoted).toBe(200);

    for (const s of sources) {
      const row = await getRow(t, s);
      expect(row?.level).toBe("parallel");
      expect(row?.parentId).toBe(target);
    }
    const targetRow = await getRow(t, target);
    expect(new Set(targetRow?.children)).toEqual(new Set(sources));
    expect(targetRow?.children).toHaveLength(200);
  }, 30_000);

  test("201 promotions: two chunks (200 + 1), two calls, every row lands", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const target = await insertInsert(t, variantTypeId, "Target");
    const sources: Id<"selectorOptions">[] = [];
    for (let i = 0; i < 201; i++) {
      sources.push(await insertInsert(t, variantTypeId, `Source ${i}`));
    }

    const results = await applyChunked(asAdmin, variantTypeId, {
      promotions: sources.map((insertId) => ({ insertId, targetInsertId: target })),
      demotions: [],
      reparentings: [],
    });

    expect(results).toHaveLength(2);
    expect(results[0].promoted).toBe(200);
    expect(results[1].promoted).toBe(1);

    for (const s of sources) {
      const row = await getRow(t, s);
      expect(row?.level).toBe("parallel");
      expect(row?.parentId).toBe(target);
    }
    const targetRow = await getRow(t, target);
    expect(new Set(targetRow?.children)).toEqual(new Set(sources));
    expect(targetRow?.children).toHaveLength(201);
  }, 30_000);

  // NEO-308's contract asks for ~500 too. Kept as its own test (rather than
  // folded into the 201 case) so a slow run shows up by name, not as an
  // unexplained slowdown of an assertion that isn't about scale.
  test("~500 promotions: three chunks, three calls, every row lands", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const target = await insertInsert(t, variantTypeId, "Target");
    const sources: Id<"selectorOptions">[] = [];
    for (let i = 0; i < 500; i++) {
      sources.push(await insertInsert(t, variantTypeId, `Source ${i}`));
    }

    const results = await applyChunked(asAdmin, variantTypeId, {
      promotions: sources.map((insertId) => ({ insertId, targetInsertId: target })),
      demotions: [],
      reparentings: [],
    });

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.promoted)).toEqual([200, 200, 100]);

    for (const s of sources) {
      const row = await getRow(t, s);
      expect(row?.level).toBe("parallel");
      expect(row?.parentId).toBe(target);
    }
    const targetRow = await getRow(t, target);
    expect(new Set(targetRow?.children)).toEqual(new Set(sources));
    expect(targetRow?.children).toHaveLength(500);
  }, 60_000);
});

describe("applyParallelGroupings via chunkGroupingPlan — demotion then reparent-onto-it, limit=1", () => {
  test("a row reparented onto a target this same save just demoted lands, split across two calls", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, variantTypeId, "Chrome");
    const gold = await insertParallel(t, chrome, "Gold");
    const blue = await insertParallel(t, chrome, "Blue");

    const results = await applyChunked(
      asAdmin,
      variantTypeId,
      {
        promotions: [],
        demotions: [{ parallelId: gold }],
        reparentings: [{ parallelId: blue, newInsertId: gold }],
      },
      1,
    );

    // Flattened D-then-R order, sliced at 1: [demotion], [reparenting].
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ demoted: 1, reparented: 0 });
    expect(results[1]).toMatchObject({ demoted: 0, reparented: 1 });

    const goldRow = await getRow(t, gold);
    expect(goldRow?.level).toBe("insert");
    expect(goldRow?.parentId).toBe(variantTypeId);

    const blueRow = await getRow(t, blue);
    expect(blueRow?.level).toBe("parallel");
    expect(blueRow?.parentId).toBe(gold);

    const chromeRow = await getRow(t, chrome);
    expect(chromeRow?.children).toEqual([]);
    const goldChildren = (await getRow(t, gold))?.children ?? [];
    expect(goldChildren).toEqual([blue]);
  });
});

describe("applyParallelGroupings via chunkGroupingPlan — a promotion whose source shed its parallel in an earlier chunk", () => {
  test("promoting X lands once Y (X's only parallel) has already been reparented away, limit=1", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const x = await insertInsert(t, variantTypeId, "X");
    const y = await insertParallel(t, x, "Y");
    const target = await insertInsert(t, variantTypeId, "Target");

    const results = await applyChunked(
      asAdmin,
      variantTypeId,
      {
        promotions: [{ insertId: x, targetInsertId: target }],
        demotions: [],
        reparentings: [{ parallelId: y, newInsertId: target }],
      },
      1,
    );

    // Flattened R-then-P order, sliced at 1: [reparenting], [promotion].
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ reparented: 1, promoted: 0 });
    expect(results[1]).toMatchObject({ reparented: 0, promoted: 1 });

    const xRow = await getRow(t, x);
    expect(xRow?.level).toBe("parallel");
    expect(xRow?.parentId).toBe(target);

    const yRow = await getRow(t, y);
    expect(yRow?.level).toBe("parallel");
    expect(yRow?.parentId).toBe(target);

    const targetRow = await getRow(t, target);
    expect(new Set(targetRow?.children)).toEqual(new Set([x, y]));
  });

  test("without the earlier chunk landing first, the same promotion is refused (hasParallels) — pins WHY order matters", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const x = await insertInsert(t, variantTypeId, "X");
    await insertParallel(t, x, "Y");
    const target = await insertInsert(t, variantTypeId, "Target");

    // The promotion alone, with Y still attached to X: refused.
    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId,
        promotions: [{ insertId: x, targetInsertId: target }],
        demotions: [],
      }),
    ).rejects.toThrow(/has parallels of its own/);
  });
});

describe("applyParallelGroupings via chunkGroupingPlan — a refusal partway through", () => {
  test("a refusal in the last chunk leaves the earlier chunk's rows moved and the refused chunk's rows untouched", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const target = await insertInsert(t, variantTypeId, "Target");
    const good = await insertInsert(t, variantTypeId, "Good Source");
    const bad = await insertInsert(t, variantTypeId, "Bad Source");
    // A parallel-level row: not a valid promotion target (`notAnInsert`).
    const notAnInsertTarget = await insertParallel(t, target, "Already A Parallel");

    const plan: GroupingPlan = {
      promotions: [
        { insertId: good, targetInsertId: target },
        { insertId: bad, targetInsertId: notAnInsertTarget },
      ],
      demotions: [],
      reparentings: [],
    };
    const chunks = chunkGroupingPlan(plan, 1);
    expect(chunks).toHaveLength(2);

    // Chunk 1 (good) succeeds.
    await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId,
      promotions: chunks[0].promotions,
      demotions: chunks[0].demotions,
      reparentings: chunks[0].reparentings,
    });
    const goodRow = await getRow(t, good);
    expect(goodRow?.level).toBe("parallel");
    expect(goodRow?.parentId).toBe(target);

    // Chunk 2 (bad target) is refused, and refuses BEFORE any patch — the
    // row named in it is untouched.
    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId,
        promotions: chunks[1].promotions,
        demotions: chunks[1].demotions,
        reparentings: chunks[1].reparentings,
      }),
    ).rejects.toThrow(groupingRefusal.notAnInsert("Already A Parallel"));

    const badRow = await getRow(t, bad);
    expect(badRow?.level).toBe("insert");
    expect(badRow?.parentId).toBe(variantTypeId);
  });
});

describe("applyParallelGroupings — one call of 201 is still refused (unchunked)", () => {
  test("201 entries in a single call refuses with the tooMany sentence", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const target = await insertInsert(t, variantTypeId, "Target");
    const sources: Id<"selectorOptions">[] = [];
    for (let i = 0; i < 201; i++) {
      sources.push(await insertInsert(t, variantTypeId, `Source ${i}`));
    }

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId,
        promotions: sources.map((insertId) => ({ insertId, targetInsertId: target })),
        demotions: [],
        reparentings: [],
      }),
    ).rejects.toThrow(/moves in one save/);
  }, 30_000);
});
