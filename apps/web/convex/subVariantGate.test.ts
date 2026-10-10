/**
 * NEO-334 — sub-variants (`parallel`-level rows) live ONLY under an insert of
 * an Insert type (Jason, 2026-10-10). Never under the Base, a Parallel type,
 * or a variant type with no role — and the role is the NB flag, never the
 * row's name.
 *
 * Every write path that can create a `parallel`-level row is pinned here:
 *
 *   - addCustomSelectorOption        ("+ Custom" in the Sub-Variants column)
 *   - storeSelectorOptions           (the aggregator store)
 *   - storeReconciledOptions         ("Sync Sub-Variants" → reconcile store)
 *   - applyParallelGroupings         (Group Parallels: promotions, reparentings)
 *
 * The sixth creator, "Make insert of…" (`setInsertConversion.ts`), already
 * lands parallels only under inserts of the target set's Insert-role type and
 * is covered by its own tests.
 *
 * Each refusal is checked to write nothing; each allowed call to write the row.
 */

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  SUB_VARIANT_INSERT_ONLY,
  SUB_VARIANT_INSERT_ONLY_MESSAGE,
} from "./variantRole";
import { groupingRefusal } from "./selectorOptions";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_neo334", role: "admin" };

type T = ReturnType<typeof convexTest>;
type OptionId = Id<"selectorOptions">;
type Metadata = { isBase?: boolean; variantRole?: "insert" | "parallel" };

async function row(
  t: T,
  level: "setName" | "variantType" | "insert" | "parallel",
  value: string,
  parentId?: OptionId,
  metadata?: Metadata,
): Promise<OptionId> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level,
      value,
      platformData: {},
      ...(parentId ? { parentId } : {}),
      ...(metadata ? { metadata } : {}),
      children: [],
      lastUpdated: 1_700_000_000_000,
    });
    if (parentId) {
      const parent = (await ctx.db.get(parentId))!;
      await ctx.db.patch(parentId, { children: [...parent.children, id] });
    }
    return id;
  });
}

/** A set with one variant type of the given role, and one insert under it. */
async function seedType(t: T, metadata: Metadata | undefined, value = "Insert") {
  const set = await row(t, "setName", "Topps Chrome");
  const type = await row(t, "variantType", value, set, metadata);
  const insert = await row(t, "insert", "Refractor Rookies", type);
  return { set, type, insert };
}

/** The variant types a sub-variant must be refused under. */
const REFUSED_TYPES: ReadonlyArray<[string, Metadata | undefined, string]> = [
  ["a Parallel type", { variantRole: "parallel" }, "Parallel"],
  ["the Base", { isBase: true }, "Base"],
  ["a type with no role", undefined, "Promo"],
  // The role decides, never the name.
  ["a roleless type called \"Insert\"", undefined, "Insert"],
];

const INSERT_TYPE: Metadata = { variantRole: "insert" };

async function parallelsUnder(t: T, insert: OptionId) {
  return t.run((ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "parallel").eq("parentId", insert),
      )
      .collect(),
  );
}

/** The `data` of the ConvexError `run` throws; fails the test if it resolves. */
async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConvexError);
  return (thrown as ConvexError<unknown>).data;
}

const STRUCTURED_REFUSAL = {
  code: SUB_VARIANT_INSERT_ONLY,
  reason: SUB_VARIANT_INSERT_ONLY_MESSAGE,
};

describe("addCustomSelectorOption — a sub-variant only under an Insert type (NEO-334)", () => {
  test("creates the sub-variant under an insert of an Insert type", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedType(t, INSERT_TYPE);

    const id = await t.withIdentity(ADMIN).mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "parallel", value: "Gold", parentId: insert },
    );

    const rows = await parallelsUnder(t, insert);
    expect(rows.map((r) => r._id)).toEqual([id]);
    expect(rows[0].metadata).toEqual({ isParallel: true });
  });

  for (const [label, metadata, value] of REFUSED_TYPES) {
    test(`refuses under ${label}, structured, and writes nothing`, async () => {
      const t = convexTest(schema, modules);
      const { insert } = await seedType(t, metadata, value);

      const data = await refusalOf(() =>
        t.withIdentity(ADMIN).mutation(
          api.selectorOptions.addCustomSelectorOption,
          { level: "parallel", value: "Gold", parentId: insert },
        ),
      );

      expect(data).toEqual(STRUCTURED_REFUSAL);
      expect(await parallelsUnder(t, insert)).toEqual([]);
      const parent = await t.run((ctx) => ctx.db.get(insert));
      expect(parent?.children).toEqual([]);
    });
  }

  test("refuses BEFORE the idempotent duplicate return: a same-named legacy row is not handed back", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedType(t, { variantRole: "parallel" }, "Parallel");
    // A row that could only have been made before the rule.
    await row(t, "parallel", "Gold", insert);

    const data = await refusalOf(() =>
      t.withIdentity(ADMIN).mutation(
        api.selectorOptions.addCustomSelectorOption,
        { level: "parallel", value: "Gold", parentId: insert },
      ),
    );
    expect(data).toEqual(STRUCTURED_REFUSAL);
  });

  test("refuses a parentless sub-variant, and one whose parent is not an insert", async () => {
    const t = convexTest(schema, modules);
    const { type } = await seedType(t, INSERT_TYPE);
    const asAdmin = t.withIdentity(ADMIN);

    expect(
      await refusalOf(() =>
        asAdmin.mutation(api.selectorOptions.addCustomSelectorOption, {
          level: "parallel",
          value: "Gold",
        }),
      ),
    ).toEqual(STRUCTURED_REFUSAL);
    // Straight under the Insert type itself: the type is not an insert.
    expect(
      await refusalOf(() =>
        asAdmin.mutation(api.selectorOptions.addCustomSelectorOption, {
          level: "parallel",
          value: "Gold",
          parentId: type,
        }),
      ),
    ).toEqual(STRUCTURED_REFUSAL);
  });

  test("leaves every other level alone: an insert under a roleless type is still created", async () => {
    const t = convexTest(schema, modules);
    const { type } = await seedType(t, undefined, "Promo");

    const id = await t.withIdentity(ADMIN).mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "insert", value: "Holiday", parentId: type },
    );
    expect(id).toBeTruthy();
  });
});

describe("storeSelectorOptions — sub-variants only under an Insert type (NEO-334)", () => {
  const store = (t: T, parentId: OptionId) =>
    t.withIdentity(ADMIN).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "parallel",
      parentId,
      options: [{ value: "Gold", platformData: { bsc: "gold-slug" } }],
    });

  test("stores under an insert of an Insert type", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedType(t, INSERT_TYPE);

    const result = await store(t, insert);

    expect(result.success).toBe(true);
    expect((await parallelsUnder(t, insert)).map((r) => r.value)).toEqual(["Gold"]);
  });

  for (const [label, metadata, value] of REFUSED_TYPES) {
    test(`refuses under ${label} and writes nothing`, async () => {
      const t = convexTest(schema, modules);
      const { insert } = await seedType(t, metadata, value);

      expect(await refusalOf(() => store(t, insert))).toEqual(STRUCTURED_REFUSAL);
      expect(await parallelsUnder(t, insert)).toEqual([]);
    });
  }
});

describe("storeReconciledOptions — sub-variants only under an Insert type (NEO-334)", () => {
  const store = (t: T, parentId: OptionId) =>
    t.withIdentity(ADMIN).mutation(api.setReconciliation.storeReconciledOptions, {
      level: "parallel",
      parentId,
      reconciledItems: [
        { value: "Gold", platformData: { bsc: "gold-slug" }, metadata: undefined },
      ],
    });

  test("stores under an insert of an Insert type", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedType(t, INSERT_TYPE);

    const result = await store(t, insert);

    expect(result.success).toBe(true);
    expect((await parallelsUnder(t, insert)).map((r) => r.value)).toEqual(["Gold"]);
  });

  for (const [label, metadata, value] of REFUSED_TYPES) {
    test(`refuses under ${label} and writes nothing`, async () => {
      const t = convexTest(schema, modules);
      const { insert } = await seedType(t, metadata, value);

      expect(await refusalOf(() => store(t, insert))).toEqual(STRUCTURED_REFUSAL);
      expect(await parallelsUnder(t, insert)).toEqual([]);
    });
  }
});

describe("applyParallelGroupings — moves under an insert only on an Insert type (NEO-334)", () => {
  async function seedGroupable(t: T, metadata: Metadata | undefined, value: string) {
    const { type, insert: target } = await seedType(t, metadata, value);
    const source = await row(t, "insert", "Refractor Rookies Gold", type);
    return { type, target, source };
  }

  test("promotes under an Insert type", async () => {
    const t = convexTest(schema, modules);
    const { type, target, source } = await seedGroupable(t, INSERT_TYPE, "Insert");

    const result = await t.withIdentity(ADMIN).mutation(
      api.selectorOptions.applyParallelGroupings,
      {
        variantTypeId: type,
        promotions: [{ insertId: source, targetInsertId: target }],
        demotions: [],
      },
    );

    expect(result.promoted).toBe(1);
    expect((await parallelsUnder(t, target)).map((r) => r._id)).toEqual([source]);
  });

  for (const [label, metadata, value] of REFUSED_TYPES) {
    test(`refuses a promotion under ${label} and moves nothing`, async () => {
      const t = convexTest(schema, modules);
      const { type, target, source } = await seedGroupable(t, metadata, value);

      const data = await refusalOf(() =>
        t.withIdentity(ADMIN).mutation(api.selectorOptions.applyParallelGroupings, {
          variantTypeId: type,
          promotions: [{ insertId: source, targetInsertId: target }],
          demotions: [],
        }),
      );

      expect(data).toBe(groupingRefusal.notInsertType());
      expect(await parallelsUnder(t, target)).toEqual([]);
      const moved = await t.run((ctx) => ctx.db.get(source));
      expect(moved?.level).toBe("insert");
    });
  }

  test("refuses a reparenting under a Parallel type", async () => {
    const t = convexTest(schema, modules);
    const { type, target, source } = await seedGroupable(
      t,
      { variantRole: "parallel" },
      "Parallel",
    );
    // A legacy sub-variant under `source`, from before the rule.
    const legacy = await row(t, "parallel", "Gold /50", source);

    const data = await refusalOf(() =>
      t.withIdentity(ADMIN).mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId: type,
        promotions: [],
        demotions: [],
        reparentings: [{ parallelId: legacy, newInsertId: target }],
      }),
    );

    expect(data).toBe(groupingRefusal.notInsertType());
    const unmoved = await t.run((ctx) => ctx.db.get(legacy));
    expect(unmoved?.parentId).toBe(source);
  });

  test("still accepts a demotion-only plan under a Parallel type: lifting a legacy sub-variant out is the fix", async () => {
    const t = convexTest(schema, modules);
    const { type, source } = await seedGroupable(
      t,
      { variantRole: "parallel" },
      "Parallel",
    );
    const legacy = await row(t, "parallel", "Gold /50", source);

    const result = await t.withIdentity(ADMIN).mutation(
      api.selectorOptions.applyParallelGroupings,
      { variantTypeId: type, promotions: [], demotions: [{ parallelId: legacy }] },
    );

    expect(result.demoted).toBe(1);
    const lifted = await t.run((ctx) => ctx.db.get(legacy));
    expect(lifted?.level).toBe("insert");
    expect(lifted?.parentId).toBe(type);
  });
});
