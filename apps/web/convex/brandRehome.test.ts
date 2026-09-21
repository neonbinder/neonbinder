/**
 * NEO-237 — `brandRehome.ts`: moving sets out of a year's Unknown row and
 * under a brand, a pure NB operation (same `_id`, subtree, slots and cards
 * untouched; only `parentId` and the two `children` caches move).
 *
 * Covers `findBrandUnknownRow`, `rehomeSetRowsToBrand` (the shared core) and
 * `rehomeSetsFromBrandUnknown` (the prefix-filtering door), plus
 * `rehomedNotice`'s pluralisation.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  findBrandUnknownRow,
  rehomedNotice,
  rehomeSetRowsToBrand,
  rehomeSetsFromBrandUnknown,
} from "./brandRehome";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_000_000;

async function seedYear(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1995",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function seedManufacturer(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
  opts: { isBrandUnknown?: boolean } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: {},
      ...(opts.isBrandUnknown !== undefined
        ? { metadata: { isBrandUnknown: opts.isBrandUnknown } }
        : {}),
      parentId,
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
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

async function linkChild(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  childId: Id<"selectorOptions">,
) {
  await t.run(async (ctx) => {
    const parent = await ctx.db.get(parentId);
    await ctx.db.patch(parentId, {
      children: [...(parent?.children ?? []), childId],
    });
  });
}

describe("rehomedNotice", () => {
  test("singular for one set", () => {
    expect(rehomedNotice(1)).toBe("1 set moved out of Unknown");
  });
  test("plural otherwise, including zero", () => {
    expect(rehomedNotice(0)).toBe("0 sets moved out of Unknown");
    expect(rehomedNotice(3)).toBe("3 sets moved out of Unknown");
  });
});

describe("findBrandUnknownRow", () => {
  test("finds the flagged row under the year", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    await seedManufacturer(t, year, "Topps");
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });

    const found = await t.run((ctx) => findBrandUnknownRow(ctx, year));
    expect(found?._id).toBe(unknown);
  });

  test("returns null when the year has no flagged row yet", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    await seedManufacturer(t, year, "Topps");

    const found = await t.run((ctx) => findBrandUnknownRow(ctx, year));
    expect(found).toBeNull();
  });
});

describe("rehomeSetRowsToBrand", () => {
  test("moves a row's parentId and both children caches", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const topps = await seedManufacturer(t, year, "Topps");
    const setId = await seedSet(t, unknown, "Topps Chrome");
    await linkChild(t, unknown, setId);

    const result = await t.run(async (ctx) =>
      rehomeSetRowsToBrand(ctx, {
        rows: [(await ctx.db.get(setId))!],
        brandId: topps,
      }),
    );

    expect(result).toEqual({ rehomed: 1, clashes: 0 });
    const [row, oldParent, newParent] = await t.run(async (ctx) => [
      await ctx.db.get(setId),
      await ctx.db.get(unknown),
      await ctx.db.get(topps),
    ]);
    expect(row?.parentId).toBe(topps);
    // Same _id, and nothing about the row itself changed besides parentId.
    expect(row?.value).toBe("Topps Chrome");
    expect(oldParent?.children).toEqual([]);
    expect(newParent?.children).toEqual([setId]);
  });

  test("a sibling name clash under the target: the row STAYS under its old parent, counted", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const topps = await seedManufacturer(t, year, "Topps");
    await seedSet(t, topps, "Chrome"); // already exists under the target
    const doomed = await seedSet(t, unknown, "Chrome");
    await linkChild(t, unknown, doomed);

    const result = await t.run(async (ctx) =>
      rehomeSetRowsToBrand(ctx, {
        rows: [(await ctx.db.get(doomed))!],
        brandId: topps,
      }),
    );

    expect(result).toEqual({ rehomed: 0, clashes: 1 });
    const row = await t.run((ctx) => ctx.db.get(doomed));
    expect(row?.parentId).toBe(unknown);
  });

  test("a row already under the target brand is a no-op, not a clash", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");
    const setId = await seedSet(t, topps, "Chrome");

    const result = await t.run(async (ctx) =>
      rehomeSetRowsToBrand(ctx, {
        rows: [(await ctx.db.get(setId))!],
        brandId: topps,
      }),
    );
    expect(result).toEqual({ rehomed: 0, clashes: 0 });
  });

  test("refuses when the target is not a manufacturer row", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const setId = await seedSet(t, unknown, "Chrome");

    await expect(
      t.run((ctx) =>
        rehomeSetRowsToBrand(ctx, {
          rows: [],
          brandId: year, // a year row, not a manufacturer
        }),
      ),
    ).rejects.toThrow(/not a manufacturer row/);
    void setId;
  });

  test("refuses when the target IS the brand-unknown row", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });

    await expect(
      t.run((ctx) => rehomeSetRowsToBrand(ctx, { rows: [], brandId: unknown })),
    ).rejects.toThrow(/is the brand-unknown row/);
  });

  test("non-setName rows in `rows` are skipped and counted as nothing", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });

    const result = await t.run(async (ctx) =>
      rehomeSetRowsToBrand(ctx, {
        rows: [(await ctx.db.get(unknown))!], // a manufacturer row, not setName
        brandId: topps,
      }),
    );
    expect(result).toEqual({ rehomed: 0, clashes: 0 });
  });
});

describe("rehomeSetsFromBrandUnknown", () => {
  test("moves every prefix-matching set from Unknown to the brand", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const topps = await seedManufacturer(t, year, "Topps");
    const matching = await seedSet(t, unknown, "Topps Chrome");
    const nonMatching = await seedSet(t, unknown, "Panini Prizm");
    await linkChild(t, unknown, matching);
    await linkChild(t, unknown, nonMatching);

    const result = await t.run((ctx) => rehomeSetsFromBrandUnknown(ctx, {
      yearId: year,
      brandId: topps,
      prefix: "Topps",
    }));

    expect(result).toEqual({ rehomed: 1, clashes: 0 });
    const [movedRow, staleRow] = await t.run(async (ctx) => [
      await ctx.db.get(matching),
      await ctx.db.get(nonMatching),
    ]);
    expect(movedRow?.parentId).toBe(topps);
    expect(staleRow?.parentId).toBe(unknown);
  });

  test("an empty prefix moves nothing", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const topps = await seedManufacturer(t, year, "Topps");
    await seedSet(t, unknown, "Topps Chrome");

    const result = await t.run((ctx) => rehomeSetsFromBrandUnknown(ctx, {
      yearId: year,
      brandId: topps,
      prefix: "   ",
    }));
    expect(result).toEqual({ rehomed: 0, clashes: 0 });
  });

  test("a year with no Unknown row yet returns zeros rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");

    const result = await t.run((ctx) => rehomeSetsFromBrandUnknown(ctx, {
      yearId: year,
      brandId: topps,
      prefix: "Topps",
    }));
    expect(result).toEqual({ rehomed: 0, clashes: 0 });
  });

  test("when the brand IS the Unknown row itself, nothing moves", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    await seedSet(t, unknown, "Topps Chrome");

    const result = await t.run((ctx) => rehomeSetsFromBrandUnknown(ctx, {
      yearId: year,
      brandId: unknown,
      prefix: "Topps",
    }));
    expect(result).toEqual({ rehomed: 0, clashes: 0 });
  });
});
