/**
 * NEO-237 (D13) — `setFromMarketplace.ts`: the name a marketplace-minted set
 * gets (`candidateDefaultName`) and the set + Base insert the sync calls for
 * every SportLots entry NB has no set for (`insertSetWithBaseFromSl`).
 *
 * The insert is a plain helper on a `MutationCtx`, so it is driven through
 * `t.run` — there is no public door to call, by design (Jason, 2026-09-21:
 * a set a marketplace lists is saved, not reviewed).
 *
 * The last family pins the read budget: a batch caller pre-reads the year's
 * folded names once (`buildSetNameIndex`) and the helper, handed that index,
 * reads nothing but the brand row — and decides exactly what the
 * self-reading path decides. Reads are counted by wrapping `ctx.db` in a
 * Proxy, so the assertion is on the calls made, not on timing.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  buildSetNameIndex,
  candidateDefaultName,
  insertSetWithBaseFromSl,
  MAX_SET_ELSEWHERE_MATCHES,
  MAX_YEAR_SET_ROWS,
  type InsertSetWithBaseResult,
  type SetNameIndex,
} from "./setFromMarketplace";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_000_000;

async function seedTree(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1995",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const brandId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: {},
      metadata: { setNamePrefix: "Topps" },
      parentId: yearId,
      children: [],
      features: { manufacturer: "Topps" },
      lastUpdated: SENTINEL,
    });
    return { sportId, yearId, brandId };
  });
}

async function seedSet(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "setName",
      value,
      platformData: {},
      parentId,
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

describe("candidateDefaultName", () => {
  test("prepends the brand's prefix when the label does not already lead with it", () => {
    expect(candidateDefaultName("Heritage", "Topps")).toEqual({
      defaultName: "Topps Heritage",
      brandPrefix: "Topps",
    });
  });

  test("leaves the label alone when it already leads with the prefix", () => {
    expect(candidateDefaultName("Topps Chrome", "Topps")).toEqual({
      defaultName: "Topps Chrome",
    });
  });

  test("leaves the label alone when the brand has no prefix (e.g. Unknown)", () => {
    expect(candidateDefaultName("Carddass", undefined)).toEqual({
      defaultName: "Carddass",
    });
    expect(candidateDefaultName("Carddass", "   ")).toEqual({
      defaultName: "Carddass",
    });
  });

  test("brandPrefix is present iff it was actually prepended", () => {
    const prepended = candidateDefaultName("Heritage", "Topps");
    const notPrepended = candidateDefaultName("Topps Heritage", "Topps");
    expect(prepended.brandPrefix).toBeDefined();
    expect(prepended.defaultName).not.toBe("Heritage");
    expect(notPrepended.brandPrefix).toBeUndefined();
    expect(notPrepended.defaultName).toBe("Topps Heritage");
  });
});

describe("insertSetWithBaseFromSl — the D13 shape", () => {
  test("a setName row with platformData: {} and a Base carrying the SL slot, in one transaction", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);

    const result = await t.run((ctx) =>
      insertSetWithBaseFromSl(ctx, {
        brandId,
        name: "Topps Finest",
        sl: { id: "sl-9", label: "Finest" },
        createdByUserId: "clerk|operator",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [setRow, baseRow, brandRow] = await t.run(async (ctx) => [
      await ctx.db.get(result.setId),
      await ctx.db.get(result.baseId),
      await ctx.db.get(brandId),
    ]);

    expect(setRow?.level).toBe("setName");
    expect(setRow?.value).toBe("Topps Finest");
    expect(setRow?.parentId).toBe(brandId);
    // NB owns the set: no marketplace ids on it.
    expect(setRow?.platformData).toEqual({});
    expect(setRow?.platformLabels).toBeUndefined();
    expect(setRow?.children).toEqual([result.baseId]);
    expect(setRow?.createdByUserId).toBe("clerk|operator");
    // Features: the brand's are inherited (the level's own derivation adds
    // heuristics such as `isReprint` only when the name carries them).
    expect(setRow?.features).toMatchObject({ manufacturer: "Topps" });

    expect(baseRow?.level).toBe("variantType");
    expect(baseRow?.value).toBe("Base");
    expect(baseRow?.parentId).toBe(result.setId);
    // The NB flag, derived once at creation.
    expect(baseRow?.metadata?.isBase).toBe(true);
    // The link, on the Base, through `initialSlots`: slot `s0` + label.
    expect(baseRow?.platformData.sportlots).toEqual({ s0: "sl-9" });
    expect(baseRow?.platformLabels?.sportlots).toEqual({ s0: "Finest" });
    expect(baseRow?.platformSlotSeq?.sportlots).toBe(1);
    // No BSC facet, no primaryPlatformId (one slot; lowest-numbered wins by
    // default) — the D13 shape the schema specialist settled.
    expect(baseRow?.platformData.bsc).toBeUndefined();
    expect(baseRow?.platformFacets).toBeUndefined();
    expect(baseRow?.primaryPlatformId).toBeUndefined();
    expect(baseRow?.children).toEqual([]);
    expect(baseRow?.createdByUserId).toBe("clerk|operator");
    // The set's features plus the Base's own: cardType and the "Base"
    // parallelName default that `deriveOwnLevelFeatures("variantType", …)`
    // hands a base set.
    expect(baseRow?.features).toMatchObject({
      manufacturer: "Topps",
      cardType: expect.any(String),
      parallelName: "Base",
    });

    // The brand's children by union: the new set is appended.
    expect(brandRow?.children).toEqual([result.setId]);
  });

  test("the brand's children are unioned, never rebuilt, and the set-level team is copied down to both rows", async () => {
    const t = convexTest(schema, modules);
    const { sportId, brandId: bareBrandId } = await seedTree(t);
    const teamId = await t.run((ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        nameNormalized: "padres",
        sportId,
        lastUpdated: SENTINEL,
      }),
    );
    const brandId = bareBrandId;
    await t.run((ctx) => ctx.db.patch(brandId, { teamIds: [teamId] }));
    const existingSet = await seedSet(t, brandId, "Topps Stadium Club");
    await t.run((ctx) => ctx.db.patch(brandId, { children: [existingSet] }));

    const result = await t.run((ctx) =>
      insertSetWithBaseFromSl(ctx, {
        brandId,
        name: "Topps Finest",
        sl: { id: "sl-9", label: "Finest" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [setRow, baseRow, brandRow] = await t.run(async (ctx) => [
      await ctx.db.get(result.setId),
      await ctx.db.get(result.baseId),
      await ctx.db.get(brandId),
    ]);
    expect(brandRow?.children).toEqual([existingSet, result.setId]);
    expect(setRow?.teamIds).toEqual([teamId]);
    expect(baseRow?.teamIds).toEqual([teamId]);
    // No caller identity → no audit stamp, never a placeholder.
    expect(setRow?.createdByUserId).toBeUndefined();
    expect(baseRow?.createdByUserId).toBeUndefined();
  });

  test("the name is taken as given — nothing is prepended at insert time", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const result = await t.run((ctx) =>
      insertSetWithBaseFromSl(ctx, {
        brandId,
        name: "  Finest  ",
        sl: { id: "sl-9", label: "Finest" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const setRow = await t.run((ctx) => ctx.db.get(result.setId));
    // Trimmed by the same value check the "+ Custom" form applies; the
    // brand's prefix is the caller's business (`candidateDefaultName`).
    expect(setRow?.value).toBe("Finest");
  });
});

describe("insertSetWithBaseFromSl — refusals are returned, and write nothing", () => {
  async function selectorRowCount(t: ReturnType<typeof convexTest>) {
    return t.run(
      async (ctx) => (await ctx.db.query("selectorOptions").collect()).length,
    );
  }

  test("a sibling under the same brand that folds to the name → clash_at_target", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const existing = await seedSet(t, brandId, "Topps Finest");
    const before = await selectorRowCount(t);

    const result = await t.run((ctx) =>
      insertSetWithBaseFromSl(ctx, {
        brandId,
        // Different case and outer spacing: the fold every matcher uses
        // (`selectorValueKey` = lowercase + trim).
        name: "  topps FINEST ",
        sl: { id: "sl-9", label: "Finest" },
      }),
    );
    expect(result).toEqual({
      ok: false,
      reason: "clash_at_target",
      existingId: existing,
      value: "Topps Finest",
    });
    expect(await selectorRowCount(t)).toBe(before);
  });

  test("the same name under a DIFFERENT brand of the same year → exists_elsewhere, with the other brand named", async () => {
    const t = convexTest(schema, modules);
    const { yearId, brandId } = await seedTree(t);
    const otherBrand = await t.run((ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Unknown",
        platformData: {},
        parentId: yearId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const elsewhere = await seedSet(t, otherBrand, "Topps Finest");
    const before = await selectorRowCount(t);

    const result = await t.run((ctx) =>
      insertSetWithBaseFromSl(ctx, {
        brandId,
        name: "Topps Finest",
        sl: { id: "sl-9", label: "Finest" },
      }),
    );
    expect(result).toEqual({
      ok: false,
      reason: "exists_elsewhere",
      matches: [
        {
          _id: elsewhere,
          value: "Topps Finest",
          parentId: otherBrand,
          brand: "Unknown",
        },
      ],
    });
    expect(await selectorRowCount(t)).toBe(before);
  });

  test("a set under a brand of ANOTHER year is not elsewhere", async () => {
    const t = convexTest(schema, modules);
    const { sportId, brandId } = await seedTree(t);
    const otherYear = await t.run((ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "year",
        value: "1996",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const otherBrand = await t.run((ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Topps",
        platformData: {},
        parentId: otherYear,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    await seedSet(t, otherBrand, "Topps Finest");

    const result = await t.run((ctx) =>
      insertSetWithBaseFromSl(ctx, {
        brandId,
        name: "Topps Finest",
        sl: { id: "sl-9", label: "Finest" },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("elsewhere matches are capped so a runaway duplicate is a shape, not a list", async () => {
    const t = convexTest(schema, modules);
    const { yearId, brandId } = await seedTree(t);
    for (let i = 0; i < MAX_SET_ELSEWHERE_MATCHES + 5; i++) {
      const other = await t.run((ctx) =>
        ctx.db.insert("selectorOptions", {
          level: "manufacturer",
          value: `Brand ${i}`,
          platformData: {},
          parentId: yearId,
          children: [],
          lastUpdated: SENTINEL,
        }),
      );
      await seedSet(t, other, "Topps Finest");
    }
    const result = await t.run((ctx) =>
      insertSetWithBaseFromSl(ctx, {
        brandId,
        name: "Topps Finest",
        sl: { id: "sl-9", label: "Finest" },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("exists_elsewhere");
    if (result.reason !== "exists_elsewhere") return;
    expect(result.matches).toHaveLength(MAX_SET_ELSEWHERE_MATCHES);
  });

  test("a name the '+ Custom' form would refuse → invalid_name", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const before = await selectorRowCount(t);
    const result = await t.run((ctx) =>
      insertSetWithBaseFromSl(ctx, {
        brandId,
        name: "   ",
        sl: { id: "sl-9", label: "Finest" },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_name");
    expect(await selectorRowCount(t)).toBe(before);
  });

  test("a brandId that is not a manufacturer row → brand_missing", async () => {
    const t = convexTest(schema, modules);
    const { yearId, brandId } = await seedTree(t);
    await t.run((ctx) => ctx.db.delete(brandId));
    const before = await selectorRowCount(t);

    expect(
      await t.run((ctx) =>
        insertSetWithBaseFromSl(ctx, {
          brandId,
          name: "Topps Finest",
          sl: { id: "sl-9", label: "Finest" },
        }),
      ),
    ).toEqual({ ok: false, reason: "brand_missing" });
    // A row of the wrong level is refused the same way.
    expect(
      await t.run((ctx) =>
        insertSetWithBaseFromSl(ctx, {
          brandId: yearId,
          name: "Topps Finest",
          sl: { id: "sl-9", label: "Finest" },
        }),
      ),
    ).toEqual({ ok: false, reason: "brand_missing" });
    expect(await selectorRowCount(t)).toBe(before);
  });
});

describe("insertSetWithBaseFromSl — the pre-read index (the batch caller's read budget)", () => {
  type Counts = { query: number; get: number; insert: number; patch: number };

  /**
   * `ctx` with `ctx.db` wrapped so every `query`/`get`/`insert`/`patch` call
   * is counted. The helper's reads are what the budget is about; the Proxy
   * counts calls, so a "reads nothing" assertion is exact.
   */
  function countingCtx(ctx: MutationCtx): { ctx: MutationCtx; counts: Counts } {
    const counts: Counts = { query: 0, get: 0, insert: 0, patch: 0 };
    const db = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === "query" || prop === "get" || prop === "insert" || prop === "patch") {
          counts[prop]++;
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ctx: { ...ctx, db } as MutationCtx, counts };
  }

  /** A comparable, id-free view of a decision. */
  function shape(result: InsertSetWithBaseResult) {
    if (result.ok) return { ok: true };
    switch (result.reason) {
      case "clash_at_target":
        return { ok: false, reason: result.reason, value: result.value };
      case "exists_elsewhere":
        return {
          ok: false,
          reason: result.reason,
          matches: result.matches.map((m) => [m.brand, m.value]).sort(),
        };
      default:
        return { ok: false, reason: result.reason };
    }
  }

  /**
   * The same year twice: Topps holds "Topps Finest"; Unknown and Fleer each
   * hold "Topps Chrome"; another year's Topps holds "Topps Gallery" (never
   * elsewhere). The batch below meets every decision at least once,
   * including a clash against a set written EARLIER IN THE SAME BATCH.
   */
  async function seedComparableYear(t: ReturnType<typeof convexTest>) {
    const { sportId, yearId, brandId } = await seedTree(t);
    await seedSet(t, brandId, "Topps Finest");
    for (const name of ["Unknown", "Fleer"]) {
      const other = await t.run((ctx) =>
        ctx.db.insert("selectorOptions", {
          level: "manufacturer",
          value: name,
          platformData: {},
          parentId: yearId,
          children: [],
          lastUpdated: SENTINEL,
        }),
      );
      await seedSet(t, other, "Topps Chrome");
    }
    const otherYear = await t.run((ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "year",
        value: "1996",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const otherYearTopps = await t.run((ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Topps",
        platformData: {},
        parentId: otherYear,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    await seedSet(t, otherYearTopps, "Topps Gallery");
    return { brandId };
  }

  const batch = [
    "Topps Heritage", // ok
    "topps FINEST", // clash_at_target — the seeded sibling, by fold
    "Topps Chrome", // exists_elsewhere — two brands, both named
    "Topps Gallery", // ok — another year's set is not elsewhere
    " topps heritage ", // clash_at_target — written three roots ago
    "   ", // invalid_name
    "Topps Stadium Club", // ok
  ];

  test("the index path decides exactly what the self-reading path decides, root for root", async () => {
    const selfRead = convexTest(schema, modules);
    const preRead = convexTest(schema, modules);
    const a = await seedComparableYear(selfRead);
    const b = await seedComparableYear(preRead);

    const viaSelfRead = await selfRead.run(async (ctx) => {
      const out = [];
      for (const [i, name] of batch.entries()) {
        out.push(
          shape(
            await insertSetWithBaseFromSl(ctx, {
              brandId: a.brandId,
              name,
              sl: { id: `sl-${i}`, label: name },
            }),
          ),
        );
      }
      return out;
    });
    const viaIndex = await preRead.run(async (ctx) => {
      const brand = await ctx.db.get(b.brandId);
      const index = await buildSetNameIndex(ctx, brand!);
      const out = [];
      for (const [i, name] of batch.entries()) {
        out.push(
          shape(
            await insertSetWithBaseFromSl(
              ctx,
              { brandId: b.brandId, name, sl: { id: `sl-${i}`, label: name } },
              index,
            ),
          ),
        );
      }
      return out;
    });

    expect(viaIndex).toEqual(viaSelfRead);
    expect(viaIndex.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "ok",
      "clash_at_target",
      "exists_elsewhere",
      "ok",
      "clash_at_target",
      "invalid_name",
      "ok",
    ]);
    // And the databases agree afterwards.
    const names = (t: ReturnType<typeof convexTest>, brandId: Id<"selectorOptions">) =>
      t.run(async (ctx) =>
        (
          await ctx.db
            .query("selectorOptions")
            .withIndex("by_level_and_parent", (q) =>
              q.eq("level", "setName").eq("parentId", brandId),
            )
            .collect()
        )
          .map((r) => r.value)
          .sort(),
      );
    expect(await names(preRead, b.brandId)).toEqual(await names(selfRead, a.brandId));
  });

  test("buildSetNameIndex is one sibling query, one manufacturer list and one query per other brand — however many roots follow", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedComparableYear(t);
    const counts = await t.run(async (raw) => {
      const brand = await raw.db.get(brandId);
      const { ctx, counts } = countingCtx(raw);
      const index = await buildSetNameIndex(ctx, brand!);
      expect(index.truncated).toBe(false);
      expect([...index.siblingKeys.keys()]).toEqual(["topps finest"]);
      expect(index.elsewhereKeys.get("topps chrome")?.map((m) => m.brand).sort()).toEqual([
        "Fleer",
        "Unknown",
      ]);
      expect(index.elsewhereKeys.has("topps gallery")).toBe(false);
      return counts;
    });
    // Topps' siblings + the year's manufacturers + Unknown + Fleer.
    expect(counts).toEqual({ query: 4, get: 0, insert: 0, patch: 0 });
  });

  test("with the index the helper issues NO query per root — one brand get, two inserts, two patches — while without it every root reads the year", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedComparableYear(t);

    const withIndex = await t.run(async (raw) => {
      const brand = await raw.db.get(brandId);
      const index = await buildSetNameIndex(raw, brand!);
      const { ctx, counts } = countingCtx(raw);
      const results = [];
      for (const name of ["Topps Heritage", "topps FINEST", "Topps Chrome", "Topps Bowman"]) {
        results.push(
          await insertSetWithBaseFromSl(
            ctx,
            { brandId, name, sl: { id: name, label: name } },
            index,
          ),
        );
      }
      return { counts, ok: results.filter((r) => r.ok).length };
    });
    expect(withIndex.ok).toBe(2);
    expect(withIndex.counts.query).toBe(0);
    expect(withIndex.counts.get).toBe(4);
    expect(withIndex.counts.insert).toBe(4);
    expect(withIndex.counts.patch).toBe(4);

    const selfRead = await t.run(async (raw) => {
      const { ctx, counts } = countingCtx(raw);
      await insertSetWithBaseFromSl(ctx, {
        brandId,
        name: "Topps Archives",
        sl: { id: "sl-x", label: "Archives" },
      });
      return counts;
    });
    // Siblings, then the manufacturer list and each other brand's sets.
    expect(selfRead.query).toBe(4);
  });

  test("a set the helper writes is added to the index, so the next root that folds to it is a clash", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    await t.run(async (ctx) => {
      const brand = await ctx.db.get(brandId);
      const index = await buildSetNameIndex(ctx, brand!);
      expect(index.siblingKeys.size).toBe(0);
      const first = await insertSetWithBaseFromSl(
        ctx,
        { brandId, name: "Topps Heritage", sl: { id: "1", label: "Heritage" } },
        index,
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(index.siblingKeys.get("topps heritage")).toEqual({
        _id: first.setId,
        value: "Topps Heritage",
      });
      const second = await insertSetWithBaseFromSl(
        ctx,
        { brandId, name: "TOPPS HERITAGE", sl: { id: "2", label: "HERITAGE" } },
        index,
      );
      expect(second).toEqual({
        ok: false,
        reason: "clash_at_target",
        existingId: first.setId,
        value: "Topps Heritage",
      });
    });
  });

  test("a truncated index is refused before any write: exists-elsewhere cannot be answered from it", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const before = await t.run(
      async (ctx) => (await ctx.db.query("selectorOptions").collect()).length,
    );
    const truncated: SetNameIndex = {
      siblingKeys: new Map(),
      elsewhereKeys: new Map(),
      truncated: true,
    };
    const result = await t.run((ctx) =>
      insertSetWithBaseFromSl(
        ctx,
        { brandId, name: "Topps Heritage", sl: { id: "1", label: "Heritage" } },
        truncated,
      ),
    );
    expect(result).toEqual({ ok: false, reason: "index_truncated" });
    expect(
      await t.run(async (ctx) => (await ctx.db.query("selectorOptions").collect()).length),
    ).toBe(before);
  });

  test(`buildSetNameIndex reports truncation past MAX_YEAR_SET_ROWS instead of a partial index`, async () => {
    const t = convexTest(schema, modules);
    const { yearId, brandId } = await seedTree(t);
    const other = await t.run((ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Unknown",
        platformData: {},
        parentId: yearId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i <= MAX_YEAR_SET_ROWS; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "setName",
          value: `Set ${i}`,
          platformData: {},
          parentId: other,
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
    // Only the flag leaves the run (a `Map` is not a Convex value).
    const truncated = await t.run(async (ctx) => {
      const index = await buildSetNameIndex(ctx, (await ctx.db.get(brandId))!);
      return index.truncated;
    });
    expect(truncated).toBe(true);
  });
});
