/**
 * NEO-291 — `applyParallelGroupings`' flag rewrite on a level move.
 *
 * A promotion or demotion changes what a row IS, so its `isInsert`/
 * `isParallel` flags must change with it — not merge, REPLACE (see
 * `withVariantFlags` in convex/variantRole.ts). This file was previously
 * untested altogether; these cases are the ones the ticket's derivation
 * touches directly.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_apg_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_apg_001",
  name: "Admin User",
  role: "admin",
};

const SENTINEL = 1_000_000;

/** A variant type whose `variant`-tagged BSC slot carries `role`'s token. */
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

describe("applyParallelGroupings — promotion replaces the flags with isParallel (NEO-291)", () => {
  test("promoting an insert to a parallel sets isParallel and clears isInsert, keeping other metadata", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const source = await insertInsert(t, variantTypeId, "Refractor", {
      isInsert: true,
      cardNumberPrefix: "DK-",
    });
    const target = await insertInsert(t, variantTypeId, "Base Refractor");

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId,
      promotions: [{ insertId: source, targetInsertId: target }],
      demotions: [],
    });

    expect(result).toEqual({ success: true, promoted: 1, demoted: 0, reparented: 0 });

    const row = await getRow(t, source);
    expect(row?.level).toBe("parallel");
    expect(row?.parentId).toBe(target);
    // isInsert is GONE (replaced, not merged) and the unrelated key survives.
    expect(row?.metadata).toEqual({ isParallel: true, cardNumberPrefix: "DK-" });
  });

  test("promoting a row with no prior metadata gets exactly isParallel", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const source = await insertInsert(t, variantTypeId, "Refractor");
    const target = await insertInsert(t, variantTypeId, "Base Refractor");

    await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId,
      promotions: [{ insertId: source, targetInsertId: target }],
      demotions: [],
    });

    const row = await getRow(t, source);
    expect(row?.metadata).toEqual({ isParallel: true });
  });
});

describe("applyParallelGroupings — demotion replaces the flags with the variant type's role (NEO-291)", () => {
  test("demoting under an insert-role variant type sets isInsert, keeping other metadata", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const insertRow = await insertInsert(t, variantTypeId, "Refractor");
    const parallelRow = await insertParallel(t, insertRow, "Gold /99", {
      isParallel: true,
      cardNumberPrefix: "GR-",
    });

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId,
      promotions: [],
      demotions: [{ parallelId: parallelRow }],
    });

    expect(result).toEqual({ success: true, promoted: 0, demoted: 1, reparented: 0 });

    const row = await getRow(t, parallelRow);
    expect(row?.level).toBe("insert");
    expect(row?.parentId).toBe(variantTypeId);
    // isParallel is GONE (replaced) and the unrelated key survives.
    expect(row?.metadata).toEqual({ isInsert: true, cardNumberPrefix: "GR-" });
  });

  test("demoting under a parallel-role variant type sets isParallel — the base-set-parallel shape", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "parallel");
    const insertRow = await insertInsert(t, variantTypeId, "Refractor");
    const parallelRow = await insertParallel(t, insertRow, "Gold /99", {
      isParallel: true,
    });

    await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId,
      promotions: [],
      demotions: [{ parallelId: parallelRow }],
    });

    const row = await getRow(t, parallelRow);
    expect(row?.level).toBe("insert");
    expect(row?.metadata).toEqual({ isParallel: true });
  });

  test("demoting under a role-less variant type clears both flags", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Mystery",
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const insertRow = await insertInsert(t, variantTypeId, "Refractor");
    const parallelRow = await insertParallel(t, insertRow, "Gold /99", {
      isParallel: true,
      cardNumberPrefix: "GR-",
    });

    await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId,
      promotions: [],
      demotions: [{ parallelId: parallelRow }],
    });

    const row = await getRow(t, parallelRow);
    expect(row?.metadata).toEqual({ cardNumberPrefix: "GR-" });
  });
});

describe("applyParallelGroupings — no row lands beside a parallel holding the same marketplace set (NEO-300)", () => {
  test("promoting an insert whose BSC id a target parallel already holds is refused, and nothing moves", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome", undefined, { bsc: { b0: "chrome-v" } });
    await insertParallel(t, chrome, "Refractor", undefined, { bsc: { b0: "refractor-v" } });
    // The copy Sync Inserts used to re-create.
    const copy = await insertInsert(t, vt, "Refractor", undefined, { bsc: { b0: "refractor-v" } });

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [{ insertId: copy, targetInsertId: chrome }],
        demotions: [],
      }),
    ).rejects.toThrow('"Refractor" is already a parallel of "Chrome".');

    const row = await getRow(t, copy);
    expect(row?.level).toBe("insert");
    expect(row?.parentId).toBe(vt);
    expect(row?.lastUpdated).toBe(SENTINEL);
  });

  test("the twin's own name is given when it differs", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    await insertParallel(t, chrome, "Refractors", undefined, { sportlots: { s0: "sl-ref" } });
    const copy = await insertInsert(t, vt, "Refractor", undefined, { sportlots: { s0: "sl-ref" } });

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [{ insertId: copy, targetInsertId: chrome }],
        demotions: [],
      }),
    ).rejects.toThrow('"Refractor" is already a parallel of "Chrome" as "Refractors".');
  });

  test("reparenting a parallel next to its twin is refused the same way", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const prizm = await insertInsert(t, vt, "Prizm");
    await insertParallel(t, chrome, "Refractor", undefined, { bsc: { b0: "refractor-v" } });
    const other = await insertParallel(t, prizm, "Refractor", undefined, { bsc: { b0: "refractor-v" } });

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [],
        demotions: [],
        reparentings: [{ parallelId: other, newInsertId: chrome }],
      }),
    ).rejects.toThrow('"Refractor" is already a parallel of "Chrome".');
    expect((await getRow(t, other))?.parentId).toBe(prizm);
  });

  test("two rows arriving at one target in the same plan are compared with each other", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const a = await insertInsert(t, vt, "Refractor", undefined, { bsc: { b0: "refractor-v" } });
    const b = await insertInsert(t, vt, "Refractor B", undefined, { bsc: { b0: "refractor-v" } });

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [
          { insertId: a, targetInsertId: chrome },
          { insertId: b, targetInsertId: chrome },
        ],
        demotions: [],
      }),
    ).rejects.toThrow('"Refractor B" is already a parallel of "Chrome" as "Refractor".');
    // All-or-nothing: the first promotion did not land either.
    expect((await getRow(t, a))?.level).toBe("insert");
  });

  test("never by name: a same-named parallel with a different id does not block", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    await insertParallel(t, chrome, "Refractor", undefined, { bsc: { b0: "refractor-v" } });
    const other = await insertInsert(t, vt, "Refractor", undefined, { bsc: { b0: "other-v" } });

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [{ insertId: other, targetInsertId: chrome }],
      demotions: [],
    });
    expect(result.promoted).toBe(1);
  });

  test("the same id on DIFFERENT sides is not the same set", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    await insertParallel(t, chrome, "Refractor", undefined, { bsc: { b0: "x1" } });
    const other = await insertInsert(t, vt, "Refractor SL", undefined, { sportlots: { s0: "x1" } });

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [{ insertId: other, targetInsertId: chrome }],
      demotions: [],
    });
    expect(result.promoted).toBe(1);
  });

  test("NEO-137 M:1 is allowed: one SportLots set over two rows that BSC splits", async () => {
    // Refractor and Gold Refractor share SportLots' one set but are two BSC
    // variantNames. Grouping Gold beside Refractor is a real operator
    // decision, not a duplicate (security audit, NEO-300).
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    await insertParallel(t, chrome, "Refractor", undefined, {
      bsc: { b0: "refractor-v" },
      sportlots: { s0: "sl-refractors" },
    });
    const gold = await insertInsert(t, vt, "Gold Refractor", undefined, {
      bsc: { b0: "gold-refractor-v" },
      sportlots: { s0: "sl-refractors" },
    });

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [{ insertId: gold, targetInsertId: chrome }],
      demotions: [],
    });
    expect(result.promoted).toBe(1);
    const row = await getRow(t, gold);
    expect(row?.level).toBe("parallel");
    expect(row?.parentId).toBe(chrome);
  });

  test("a true duplicate on both sides is still refused", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const both = { bsc: { b0: "refractor-v" }, sportlots: { s0: "sl-refractors" } };
    await insertParallel(t, chrome, "Refractor", undefined, both);
    const copy = await insertInsert(t, vt, "Refractor", undefined, both);

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [{ insertId: copy, targetInsertId: chrome }],
        demotions: [],
      }),
    ).rejects.toThrow('"Refractor" is already a parallel of "Chrome".');
  });

  test("a row linked only on the side it shares is indistinguishable there, and refused", async () => {
    // The only side both rows are linked on carries the same id; the other
    // row's extra BSC link says nothing about this one.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    await insertParallel(t, chrome, "Refractor", undefined, {
      bsc: { b0: "refractor-v" },
      sportlots: { s0: "sl-refractors" },
    });
    const slOnly = await insertInsert(t, vt, "Refractor", undefined, {
      sportlots: { s0: "sl-refractors" },
    });

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [{ insertId: slOnly, targetInsertId: chrome }],
        demotions: [],
      }),
    ).rejects.toThrow('"Refractor" is already a parallel of "Chrome".');
  });

  test("a twin LEAVING the target in the same plan does not block the swap", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const old = await insertParallel(t, chrome, "Refractor", undefined, { bsc: { b0: "refractor-v" } });
    const copy = await insertInsert(t, vt, "Refractor", undefined, { bsc: { b0: "refractor-v" } });

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [{ insertId: copy, targetInsertId: chrome }],
      demotions: [{ parallelId: old }],
    });
    expect(result).toEqual({ success: true, promoted: 1, demoted: 1, reparented: 0 });
  });
});
