/**
 * NEO-291 / NEO-334 — `applyParallelGroupings`' metadata on a level move.
 *
 * A promotion or demotion changes a row's level and parent, and since
 * NEO-334 it writes NO role flag: a row's kind is read from its variant
 * type's title, so `metadata` is left exactly as found (a stray retired flag
 * is not cleared here; `stripRoleFlags` does that).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { ConvexError } from "convex/values";
import { groupingRefusal } from "./selectorOptions";

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

/**
 * A variant type whose TITLE carries `role` (NEO-334: "Inserts" or
 * "Parallels"), with the tagged BSC slot a sync leaves beside it.
 */
async function insertVariantType(
  t: ReturnType<typeof convexTest>,
  role: "insert" | "parallel",
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: role === "insert" ? "Inserts" : "Parallels",
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

describe("applyParallelGroupings — a promotion writes no flag (NEO-334)", () => {
  test("promoting an insert to a parallel moves it and leaves its metadata exactly as found", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const source = await insertInsert(t, variantTypeId, "Refractor", {
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
    // No role is written beside the prefix.
    expect(row?.metadata).toEqual({ cardNumberPrefix: "DK-" });
  });

  test("promoting a row with no metadata leaves it with none", async () => {
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
    expect(row?.level).toBe("parallel");
    expect(row?.metadata).toBeUndefined();
  });
});

describe("applyParallelGroupings — a demotion writes no flag (NEO-334)", () => {
  test("demoting under an Insert-titled variant type moves the row and leaves its metadata as found", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "insert");
    const insertRow = await insertInsert(t, variantTypeId, "Refractor");
    const parallelRow = await insertParallel(t, insertRow, "Gold /99", {
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
    expect(row?.metadata).toEqual({ cardNumberPrefix: "GR-" });
  });

  test("demoting under a Parallel-titled variant type — the base-set-parallel shape — writes no flag either", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await insertVariantType(t, "parallel");
    const insertRow = await insertInsert(t, variantTypeId, "Refractor");
    const parallelRow = await insertParallel(t, insertRow, "Gold /99");

    await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId,
      promotions: [],
      demotions: [{ parallelId: parallelRow }],
    });

    const row = await getRow(t, parallelRow);
    expect(row?.level).toBe("insert");
    expect(row?.metadata).toBeUndefined();
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

describe("applyParallelGroupings — a row ungrouped in this save can take parallels in the same save (NEO-300)", () => {
  /** Chrome (insert) with Autos as its parallel; Gold as a separate insert. */
  async function seed(t: ReturnType<typeof convexTest>) {
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome", undefined, { bsc: { b0: "chrome-v" } });
    const autos = await insertParallel(t, chrome, "Autos", undefined, { bsc: { b0: "autos-v" } });
    return { vt, chrome, autos };
  }

  test("✕ Autos (demote) + move Gold under Autos (promote), in one save", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { vt, chrome, autos } = await seed(t);
    const gold = await insertInsert(t, vt, "Gold", undefined, { bsc: { b0: "gold-v" } });

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [{ insertId: gold, targetInsertId: autos }],
      demotions: [{ parallelId: autos }],
    });
    expect(result).toEqual({ success: true, promoted: 1, demoted: 1, reparented: 0 });

    const [autosRow, goldRow, chromeRow, vtRow] = await Promise.all([
      getRow(t, autos),
      getRow(t, gold),
      getRow(t, chrome),
      getRow(t, vt),
    ]);
    expect(autosRow?.level).toBe("insert");
    expect(autosRow?.parentId).toBe(vt);
    expect(goldRow?.level).toBe("parallel");
    expect(goldRow?.parentId).toBe(autos);
    expect(autosRow?.children).toEqual([gold]);
    expect(chromeRow?.children).toEqual([]);
    expect(new Set(vtRow?.children)).toEqual(new Set([chrome, autos]));
  });

  test("✕ Autos (demote) + move sibling parallel Gold under Autos (reparent), in one save", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { vt, chrome, autos } = await seed(t);
    const gold = await insertParallel(t, chrome, "Gold", undefined, { bsc: { b0: "gold-v" } });

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [],
      demotions: [{ parallelId: autos }],
      reparentings: [{ parallelId: gold, newInsertId: autos }],
    });
    expect(result).toEqual({ success: true, promoted: 0, demoted: 1, reparented: 1 });

    const [autosRow, goldRow, chromeRow] = await Promise.all([
      getRow(t, autos),
      getRow(t, gold),
      getRow(t, chrome),
    ]);
    expect(autosRow?.level).toBe("insert");
    expect(autosRow?.parentId).toBe(vt);
    expect(goldRow?.level).toBe("parallel");
    expect(goldRow?.parentId).toBe(autos);
    expect(autosRow?.children).toEqual([gold]);
    expect(chromeRow?.children).toEqual([]);
  });

  test("without the demotion, a parallel target is still refused — by name", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { vt, autos } = await seed(t);
    const gold = await insertInsert(t, vt, "Gold");

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [{ insertId: gold, targetInsertId: autos }],
        demotions: [],
      }),
    ).rejects.toThrow(groupingRefusal.notAnInsert("Autos"));
    expect((await getRow(t, gold))?.level).toBe("insert");
  });

  test("the duplicate guard sees the demoted target's post-plan children: only what arrives", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { vt, chrome, autos } = await seed(t);
    // A Gold twin already under Chrome does not count against Autos…
    await insertParallel(t, chrome, "Gold", undefined, { bsc: { b0: "gold-v" } });
    const gold = await insertInsert(t, vt, "Gold", undefined, { bsc: { b0: "gold-v" } });
    const ok = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [{ insertId: gold, targetInsertId: autos }],
      demotions: [{ parallelId: autos }],
    });
    expect(ok.promoted).toBe(1);

    // …but two indistinguishable rows arriving at a demoted target are refused.
    const t2 = convexTest(schema, modules);
    const asAdmin2 = t2.withIdentity(ADMIN_IDENTITY);
    const s2 = await seed(t2);
    const a = await insertInsert(t2, s2.vt, "Gold", undefined, { bsc: { b0: "gold-v" } });
    const b = await insertInsert(t2, s2.vt, "Gold Copy", undefined, { bsc: { b0: "gold-v" } });
    await expect(
      asAdmin2.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: s2.vt,
        promotions: [
          { insertId: a, targetInsertId: s2.autos },
          { insertId: b, targetInsertId: s2.autos },
        ],
        demotions: [{ parallelId: s2.autos }],
      }),
    ).rejects.toThrow('"Gold Copy" is already a parallel of "Autos" as "Gold".');
    // All-or-nothing: the demotion did not land either.
    expect((await getRow(t2, s2.autos))?.level).toBe("parallel");
  });
});

describe("applyParallelGroupings — chains are refused, server-side (NEO-300)", () => {
  test("a promotion target that is itself promoted in the same plan", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const autos = await insertInsert(t, vt, "Autos");
    const gold = await insertInsert(t, vt, "Gold");

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [
          { insertId: autos, targetInsertId: chrome },
          { insertId: gold, targetInsertId: autos },
        ],
        demotions: [],
      }),
    ).rejects.toThrow(groupingRefusal.chain("Autos"));
    expect((await getRow(t, autos))?.level).toBe("insert");
    expect((await getRow(t, gold))?.level).toBe("insert");
  });

  test("a demoted target that is also reparented is two moves for one row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const prizm = await insertInsert(t, vt, "Prizm");
    const autos = await insertParallel(t, chrome, "Autos");

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [],
        demotions: [{ parallelId: autos }],
        reparentings: [{ parallelId: autos, newInsertId: prizm }],
      }),
    ).rejects.toThrow(groupingRefusal.twoMoves("Autos"));
  });

  test("a reparent target that is itself reparented in the same plan", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const prizm = await insertInsert(t, vt, "Prizm");
    const autos = await insertParallel(t, chrome, "Autos");
    const gold = await insertParallel(t, chrome, "Gold");

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [],
        demotions: [],
        reparentings: [
          { parallelId: autos, newInsertId: prizm },
          { parallelId: gold, newInsertId: autos },
        ],
      }),
    ).rejects.toThrow(groupingRefusal.chain("Autos"));
  });

  test("a promoted row that would keep parallels is refused — by name", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const prizm = await insertInsert(t, vt, "Prizm");
    await insertParallel(t, chrome, "Refractor");

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [{ insertId: chrome, targetInsertId: prizm }],
        demotions: [],
      }),
    ).rejects.toThrow(groupingRefusal.hasParallels("Chrome"));
  });

  test("…but not when this same save moves its parallels out", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const prizm = await insertInsert(t, vt, "Prizm");
    const refractor = await insertParallel(t, chrome, "Refractor");

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [{ insertId: chrome, targetInsertId: prizm }],
      demotions: [{ parallelId: refractor }],
    });
    expect(result).toEqual({ success: true, promoted: 1, demoted: 1, reparented: 0 });
    expect((await getRow(t, chrome))?.parentId).toBe(prizm);
    expect((await getRow(t, refractor))?.parentId).toBe(vt);
  });
});

/**
 * NEO-418 — the handler now reads in two concurrent waves before it checks
 * anything, then validates in the order it always did. A plan with two
 * faults must still be refused with the FIRST one in that order, even when
 * the later fault's evidence arrived in an earlier wave. Each case also
 * proves the later fault is real on its own, so the pair is not vacuous.
 */
describe("applyParallelGroupings — the first refusal is unchanged by batched reads (NEO-418)", () => {
  test("a demotion refusal (its parent, read second) beats a deleted promotion source (read first)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const otherVt = await insertVariantType(t, "insert");
    const stray = await insertParallel(t, await insertInsert(t, otherVt, "Elsewhere"), "Stray");
    const gone = await insertInsert(t, vt, "Gone");
    await t.run(async (ctx) => ctx.db.delete(gone));
    const promotions = [{ insertId: gone, targetInsertId: chrome }];

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions,
        demotions: [{ parallelId: stray }],
      }),
    ).rejects.toThrow(groupingRefusal.moved("Stray"));
    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions,
        demotions: [],
      }),
    ).rejects.toThrow(groupingRefusal.gone());
  });

  test("a later promotion's deleted target beats an earlier promotion that keeps parallels", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const prizm = await insertInsert(t, vt, "Prizm");
    const gold = await insertInsert(t, vt, "Gold");
    await insertParallel(t, chrome, "Refractor");
    const gone = await insertInsert(t, vt, "Gone");
    await t.run(async (ctx) => ctx.db.delete(gone));
    const keepsParallels = { insertId: chrome, targetInsertId: prizm };

    // Every source and target is checked before any source's own parallels.
    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [keepsParallels, { insertId: gold, targetInsertId: gone }],
        demotions: [],
      }),
    ).rejects.toThrow(groupingRefusal.gone());
    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [keepsParallels],
        demotions: [],
      }),
    ).rejects.toThrow(groupingRefusal.hasParallels("Chrome"));
  });

  test("a reparenting's deleted target (read second) beats a promotion that keeps parallels (read first)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const prizm = await insertInsert(t, vt, "Prizm");
    await insertParallel(t, chrome, "Refractor");
    const autos = await insertParallel(t, prizm, "Autos");
    const gone = await insertInsert(t, vt, "Gone");
    await t.run(async (ctx) => ctx.db.delete(gone));
    const promotions = [{ insertId: chrome, targetInsertId: prizm }];

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions,
        demotions: [],
        reparentings: [{ parallelId: autos, newInsertId: gone }],
      }),
    ).rejects.toThrow(groupingRefusal.gone());
    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions,
        demotions: [],
      }),
    ).rejects.toThrow(groupingRefusal.hasParallels("Chrome"));
    // All-or-nothing, as before: nothing moved.
    expect((await getRow(t, chrome))?.level).toBe("insert");
    expect((await getRow(t, autos))?.parentId).toBe(prizm);
  });
});

/**
 * NEO-418 — refusal precedence, table-driven. Every pair of faults, in both
 * argument orders, is refused with the sentence the ORIGINAL (one awaited
 * read at a time) check order produces: demotions, then promotion sources
 * and targets, then reparenting sources, then the promotion target / own
 * parallels checks, then the reparenting target checks. Within one stage the
 * entry that comes first in the arguments wins. The `STAGE` numbers below are
 * that order; they are the oracle, not a copy of the handler.
 */
describe("applyParallelGroupings — two faults in one plan: the earlier check in the original order wins (NEO-418)", () => {
  type T = ReturnType<typeof convexTest>;
  type RowId = Id<"selectorOptions">;
  type Plan = {
    promotions: Array<{ insertId: RowId; targetInsertId: RowId }>;
    demotions: Array<{ parallelId: RowId }>;
    reparentings: Array<{ parallelId: RowId; newInsertId: RowId }>;
  };
  type Fault = { plan: Plan; sentence: string };

  const KINDS = [
    "demoteGone",
    "demoteMoved",
    "promoGone",
    "promoMoved",
    "reparentGone",
    "reparentMoved",
    "twoMoves",
    "hasParallels",
    "promoChain",
    "promoNotAnInsert",
    "reparentChain",
    "reparentNotAnInsert",
  ] as const;
  type Kind = (typeof KINDS)[number];

  /** Position in the original check order; lower is refused first. */
  const STAGE: Record<Kind, number> = {
    demoteGone: 1, // demotion loop: row deleted
    demoteMoved: 1, // demotion loop: parent in another variant type
    promoGone: 2, // promotion loop: source deleted
    promoMoved: 2, // promotion loop: source in another variant type
    reparentGone: 3, // reparenting loop: target deleted
    reparentMoved: 3, // reparenting loop: row is not a parallel
    twoMoves: 3, // reparenting loop: row also demoted
    hasParallels: 4, // promotion checks: source keeps parallels
    promoChain: 4, // promotion checks: target is itself promoted
    promoNotAnInsert: 4, // promotion checks: target is a parallel
    reparentChain: 5, // reparenting checks: target is itself reparented
    reparentNotAnInsert: 5, // reparenting checks: target is a parallel
  };

  const emptyPlan = (): Plan => ({ promotions: [], demotions: [], reparentings: [] });

  /** Fresh rows for one fault; every name is unique to its kind. */
  async function build(
    t: T,
    kind: Kind,
    vt: RowId,
    otherVt: RowId,
  ): Promise<Fault> {
    const plan = emptyPlan();
    const removed = async (id: RowId) => {
      await t.run(async (ctx) => ctx.db.delete(id));
      return id;
    };
    switch (kind) {
      case "demoteGone": {
        const home = await insertInsert(t, vt, "Home dg");
        const gone = await removed(await insertParallel(t, home, "Gone dg"));
        plan.demotions.push({ parallelId: gone });
        return { plan, sentence: groupingRefusal.gone() };
      }
      case "demoteMoved": {
        const elsewhere = await insertInsert(t, otherVt, "Elsewhere dm");
        const stray = await insertParallel(t, elsewhere, "Stray dm");
        plan.demotions.push({ parallelId: stray });
        return { plan, sentence: groupingRefusal.moved("Stray dm") };
      }
      case "promoGone": {
        const gone = await removed(await insertInsert(t, vt, "Gone pg"));
        const target = await insertInsert(t, vt, "Target pg");
        plan.promotions.push({ insertId: gone, targetInsertId: target });
        return { plan, sentence: groupingRefusal.gone() };
      }
      case "promoMoved": {
        const foreign = await insertInsert(t, otherVt, "Foreign pm");
        const target = await insertInsert(t, vt, "Target pm");
        plan.promotions.push({ insertId: foreign, targetInsertId: target });
        return { plan, sentence: groupingRefusal.moved("Foreign pm") };
      }
      case "reparentGone": {
        const home = await insertInsert(t, vt, "Home rg");
        const moving = await insertParallel(t, home, "Moving rg");
        const gone = await removed(await insertInsert(t, vt, "Gone rg"));
        plan.reparentings.push({ parallelId: moving, newInsertId: gone });
        return { plan, sentence: groupingRefusal.gone() };
      }
      case "reparentMoved": {
        const notParallel = await insertInsert(t, vt, "Not parallel rm");
        const target = await insertInsert(t, vt, "Target rm");
        plan.reparentings.push({ parallelId: notParallel, newInsertId: target });
        return { plan, sentence: groupingRefusal.moved("Not parallel rm") };
      }
      case "twoMoves": {
        const home = await insertInsert(t, vt, "Home tm");
        const other = await insertInsert(t, vt, "Other tm");
        const both = await insertParallel(t, home, "Both tm");
        plan.demotions.push({ parallelId: both });
        plan.reparentings.push({ parallelId: both, newInsertId: other });
        return { plan, sentence: groupingRefusal.twoMoves("Both tm") };
      }
      case "hasParallels": {
        const keeper = await insertInsert(t, vt, "Keeper hp");
        await insertParallel(t, keeper, "Kept hp");
        const target = await insertInsert(t, vt, "Target hp");
        plan.promotions.push({ insertId: keeper, targetInsertId: target });
        return { plan, sentence: groupingRefusal.hasParallels("Keeper hp") };
      }
      case "promoChain": {
        const x = await insertInsert(t, vt, "X pc");
        const middle = await insertInsert(t, vt, "Middle pc");
        const top = await insertInsert(t, vt, "Top pc");
        plan.promotions.push(
          { insertId: x, targetInsertId: middle },
          { insertId: middle, targetInsertId: top },
        );
        return { plan, sentence: groupingRefusal.chain("Middle pc") };
      }
      case "promoNotAnInsert": {
        const x = await insertInsert(t, vt, "X pn");
        const home = await insertInsert(t, vt, "Home pn");
        const parallel = await insertParallel(t, home, "Parallel pn");
        plan.promotions.push({ insertId: x, targetInsertId: parallel });
        return { plan, sentence: groupingRefusal.notAnInsert("Parallel pn") };
      }
      case "reparentChain": {
        const a = await insertInsert(t, vt, "A rc");
        const b = await insertInsert(t, vt, "B rc");
        const first = await insertParallel(t, a, "First rc");
        const second = await insertParallel(t, b, "Second rc");
        plan.reparentings.push(
          { parallelId: first, newInsertId: b },
          { parallelId: second, newInsertId: first },
        );
        return { plan, sentence: groupingRefusal.chain("First rc") };
      }
      case "reparentNotAnInsert": {
        const a = await insertInsert(t, vt, "A rn");
        const b = await insertInsert(t, vt, "B rn");
        const moving = await insertParallel(t, a, "Moving rn");
        const parallel = await insertParallel(t, b, "Parallel rn");
        plan.reparentings.push({ parallelId: moving, newInsertId: parallel });
        return { plan, sentence: groupingRefusal.notAnInsert("Parallel rn") };
      }
    }
  }

  /** The ConvexError's sentence, exactly (not a substring match). */
  async function refusalOf(run: Promise<unknown>): Promise<string> {
    try {
      await run;
    } catch (err) {
      if (err instanceof ConvexError && typeof err.data === "string") return err.data;
      throw err;
    }
    throw new Error("expected the plan to be refused, but it was applied");
  }

  const allRows = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).sort((a, b) =>
        a._id < b._id ? -1 : 1,
      ),
    );

  async function world() {
    const t = convexTest(schema, modules);
    const vt = await insertVariantType(t, "insert");
    const otherVt = await insertVariantType(t, "insert");
    return { t, vt, otherVt, asAdmin: t.withIdentity(ADMIN_IDENTITY) };
  }

  test.each(KINDS)("%s on its own is refused with its own sentence", async (kind) => {
    const { t, vt, otherVt, asAdmin } = await world();
    const fault = await build(t, kind, vt, otherVt);
    expect(
      await refusalOf(
        asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
          variantTypeId: vt,
          ...fault.plan,
        }),
      ),
    ).toBe(fault.sentence);
  });

  const pairs = KINDS.flatMap((first) =>
    KINDS.filter((second) => second !== first).map((second) => [first, second] as const),
  );

  test.each(pairs)("%s listed before %s", async (first, second) => {
    const { t, vt, otherVt, asAdmin } = await world();
    const a = await build(t, first, vt, otherVt);
    const b = await build(t, second, vt, otherVt);
    // Same stage: the entry that comes first in the arguments is refused.
    const expected = STAGE[second] < STAGE[first] ? b.sentence : a.sentence;
    const before = await allRows(t);

    expect(
      await refusalOf(
        asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
          variantTypeId: vt,
          promotions: [...a.plan.promotions, ...b.plan.promotions],
          demotions: [...a.plan.demotions, ...b.plan.demotions],
          reparentings: [...a.plan.reparentings, ...b.plan.reparentings],
        }),
      ),
    ).toBe(expected);
    // All-or-nothing: a refused plan writes nothing.
    expect(await allRows(t)).toEqual(before);
  });
});

/**
 * NEO-418 — wave 2 skips a same-parent reparenting (it is a silent no-op in
 * the check), and must not let that entry replace a real move of the same row
 * either way round.
 */
describe("applyParallelGroupings — a same-parent reparenting is a no-op (NEO-418)", () => {
  async function seed(t: ReturnType<typeof convexTest>) {
    const vt = await insertVariantType(t, "insert");
    const home = await insertInsert(t, vt, "Home");
    const other = await insertInsert(t, vt, "Other");
    const moving = await insertParallel(t, home, "Moving");
    const sibling = await insertParallel(t, home, "Sibling");
    return { vt, home, other, moving, sibling };
  }

  test("a lone same-parent entry moves nothing and reports none", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const s = await seed(t);
    const before = await Promise.all([s.moving, s.sibling, s.home, s.other].map((id) => getRow(t, id)));

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: s.vt,
      promotions: [],
      demotions: [],
      reparentings: [{ parallelId: s.moving, newInsertId: s.home }],
    });

    expect(result).toEqual({ success: true, promoted: 0, demoted: 0, reparented: 0 });
    const after = await Promise.all([s.moving, s.sibling, s.home, s.other].map((id) => getRow(t, id)));
    expect(after).toEqual(before);
  });

  for (const [label, order] of [
    ["same-parent first", ["same", "real"]],
    ["real move first", ["real", "same"]],
  ] as const) {
    test(`${label}: the real move lands, the same-parent entry never undoes it`, async () => {
      const t = convexTest(schema, modules);
      const asAdmin = t.withIdentity(ADMIN_IDENTITY);
      const s = await seed(t);
      const entry = {
        same: { parallelId: s.moving, newInsertId: s.home },
        real: { parallelId: s.moving, newInsertId: s.other },
      };

      const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: s.vt,
        promotions: [],
        demotions: [],
        reparentings: order.map((k) => entry[k]),
      });

      expect(result).toEqual({ success: true, promoted: 0, demoted: 0, reparented: 1 });
      expect((await getRow(t, s.moving))?.parentId).toBe(s.other);
      expect((await getRow(t, s.home))?.children).toEqual([s.sibling]);
      expect((await getRow(t, s.other))?.children).toEqual([s.moving]);
    });
  }
});

/**
 * NEO-418 — a promotion and a reparenting that land under one target in the
 * same save both write that target's children array from the one in-memory
 * set; neither may drop the target's existing children or the other arrival.
 */
describe("applyParallelGroupings — a promotion and a reparenting under one target (NEO-418)", () => {
  test("the target's children hold its existing parallel and both arrivals", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const target = await insertInsert(t, vt, "Target");
    const home = await insertInsert(t, vt, "Home");
    const promoted = await insertInsert(t, vt, "Promoted");
    const existing = await insertParallel(t, target, "Existing");
    const moving = await insertParallel(t, home, "Moving");

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [{ insertId: promoted, targetInsertId: target }],
      demotions: [],
      reparentings: [{ parallelId: moving, newInsertId: target }],
    });

    expect(result).toEqual({ success: true, promoted: 1, demoted: 0, reparented: 1 });
    // Promotions apply before reparentings, after what was already there.
    expect((await getRow(t, target))?.children).toEqual([existing, promoted, moving]);
    expect((await getRow(t, home))?.children).toEqual([]);
    expect(new Set((await getRow(t, vt))?.children)).toEqual(new Set([target, home]));
    expect((await getRow(t, promoted))?.parentId).toBe(target);
    expect((await getRow(t, moving))?.parentId).toBe(target);
  });
});

/**
 * NEO-418 — a demoted target's own parallels are never read for the
 * duplicate guard (after the plan its children are exactly what arrives), so
 * whatever the parallels range holds under it cannot leak in. A stray
 * parallel row filed under the demoted row (corrupt, but constructible) shares
 * a marketplace id with an arrival; the original ignores it, and so must the
 * cached version.
 */
describe("applyParallelGroupings — a demoted target promoted onto and reparented onto (NEO-418)", () => {
  test("only what arrives is compared; a stray row under the demoted target does not block", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const autos = await insertParallel(t, chrome, "Autos", undefined, { bsc: { b0: "autos-v" } });
    const gold = await insertInsert(t, vt, "Gold", undefined, { bsc: { b0: "gold-v" } });
    const silver = await insertParallel(t, chrome, "Silver", undefined, { bsc: { b0: "silver-v" } });
    // A twin of Gold already under Chrome, and the stray under Autos.
    await insertParallel(t, chrome, "Gold Twin", undefined, { bsc: { b0: "gold-v" } });
    await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "parallel",
        value: "Gold Stray",
        parentId: autos,
        platformData: { bsc: { b0: "gold-v" } },
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    const result = await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [{ insertId: gold, targetInsertId: autos }],
      demotions: [{ parallelId: autos }],
      reparentings: [{ parallelId: silver, newInsertId: autos }],
    });

    expect(result).toEqual({ success: true, promoted: 1, demoted: 1, reparented: 1 });
    expect((await getRow(t, autos))?.level).toBe("insert");
    expect((await getRow(t, autos))?.children).toEqual([gold, silver]);
    expect((await getRow(t, gold))?.parentId).toBe(autos);
    expect((await getRow(t, silver))?.parentId).toBe(autos);
    expect((await getRow(t, chrome))?.children).not.toContain(silver);
    expect((await getRow(t, chrome))?.children).not.toContain(autos);
  });
});

describe("applyParallelGroupings — refusals are operator sentences, never ids (NEO-300)", () => {
  test("a row from ANOTHER variant type cannot be demoted into this one", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const otherVt = await insertVariantType(t, "insert");
    const otherInsert = await insertInsert(t, otherVt, "Elsewhere");
    const stray = await insertParallel(t, otherInsert, "Stray");

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [],
        demotions: [{ parallelId: stray }],
      }),
    ).rejects.toThrow(groupingRefusal.moved("Stray"));
  });

  test("a deleted row is the generic refresh sentence", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const vt = await insertVariantType(t, "insert");
    const chrome = await insertInsert(t, vt, "Chrome");
    const gone = await insertInsert(t, vt, "Gone");
    await t.run(async (ctx) => ctx.db.delete(gone));

    await expect(
      asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: vt,
        promotions: [{ insertId: gone, targetInsertId: chrome }],
        demotions: [],
      }),
    ).rejects.toThrow(groupingRefusal.gone());
  });

  test("no refusal sentence carries a document id", () => {
    const sentences = [
      groupingRefusal.gone(),
      groupingRefusal.moved("Autos"),
      groupingRefusal.notAnInsert("Autos"),
      groupingRefusal.chain("Autos"),
      groupingRefusal.hasParallels("Autos"),
      groupingRefusal.twoMoves("Autos"),
      groupingRefusal.tooMany(200),
    ];
    for (const s of sentences) expect(s).not.toMatch(/[a-z0-9]{20,}/);
  });
});
