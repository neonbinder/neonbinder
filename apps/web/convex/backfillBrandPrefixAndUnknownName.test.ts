/**
 * NEO-237 — the one-shot backfill over every `manufacturer` row: renaming a
 * flagged "All Brands" row to "Unknown" (and clearing its
 * `features.manufacturer`), and defaulting `metadata.setNamePrefix` on every
 * other row to its own value. Mirrors `backfillBrandUnknownRole.test.ts`'s
 * shape for the two independent arms (per-invocation `confirm`, per-deployment
 * `ALLOW_SELECTOR_BACKFILL`) and its dry-run-writes-nothing discipline.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_000_000;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function seedYear(t: ReturnType<typeof convexTest>, value = "1995") {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "year",
      value,
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
  opts: {
    isBrandUnknown?: boolean;
    setNamePrefix?: string;
    features?: Record<string, string>;
  } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: {},
      ...(opts.isBrandUnknown !== undefined || opts.setNamePrefix
        ? {
            metadata: {
              ...(opts.isBrandUnknown !== undefined
                ? { isBrandUnknown: opts.isBrandUnknown }
                : {}),
              ...(opts.setNamePrefix ? { setNamePrefix: opts.setNamePrefix } : {}),
            },
          }
        : {}),
      ...(opts.features ? { features: opts.features } : {}),
      parentId,
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

const dry = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.backfillBrandPrefixAndUnknownName.run, {});

const armed = (t: ReturnType<typeof convexTest>) => {
  vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
  return t.mutation(internal.backfillBrandPrefixAndUnknownName.run, {
    confirm: "BACKFILL",
  });
};

const armedButNoFlag = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.backfillBrandPrefixAndUnknownName.run, {
    confirm: "BACKFILL",
  });

describe("backfillBrandPrefixAndUnknownName — the dry run", () => {
  test("reports exactly what an armed run would do, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands", {
      isBrandUnknown: true,
    });
    const topps = await seedManufacturer(t, year, "Topps");

    const report = await dry(t);

    expect(report.armed).toBe(false);
    expect(report.counts).toEqual({
      renamed: 1,
      renameClash: 0,
      alreadyNamed: 0,
      prefixed: 1,
      alreadyPrefixed: 0,
    });
    expect(report.rows).toEqual([
      { id: bucket, value: "All Brands", action: "renamed" },
      { id: topps, value: "Topps", action: "prefixed" },
    ]);

    // Nothing written.
    const after = await t.run(async (ctx) => [
      await ctx.db.get(bucket),
      await ctx.db.get(topps),
    ]);
    expect(after[0]?.value).toBe("All Brands");
    expect(after[0]?.lastUpdated).toBe(SENTINEL);
    expect(after[1]?.metadata?.setNamePrefix).toBeUndefined();
    expect(after[1]?.lastUpdated).toBe(SENTINEL);
  });

  test("the token WITHOUT the deployment flag is refused, and says which flag", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands", {
      isBrandUnknown: true,
    });

    const report = await armedButNoFlag(t);

    expect(report.armed).toBe(false);
    expect(report.message).toContain("ALLOW_SELECTOR_BACKFILL");
    expect(report.counts.renamed).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(bucket));
    expect(row?.value).toBe("All Brands");
    expect(row?.lastUpdated).toBe(SENTINEL);
  });

  test("an omitted `confirm` is a dry run", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    await seedManufacturer(t, year, "Topps");

    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const report = await t.mutation(
      internal.backfillBrandPrefixAndUnknownName.run,
      { confirm: "yes" },
    );

    expect(report.armed).toBe(false);
    const rows = await t.run((ctx) => ctx.db.query("selectorOptions").collect());
    expect(rows.every((r) => r.metadata?.setNamePrefix === undefined)).toBe(
      true,
    );
  });
});

describe("backfillBrandPrefixAndUnknownName — the armed run", () => {
  test("renames the flagged 'All Brands' row to 'Unknown' through planValueRename, and clears features.manufacturer", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands", {
      isBrandUnknown: true,
      features: { manufacturer: "All Brands", era: "Vintage" },
    });

    const report = await armed(t);

    expect(report.armed).toBe(true);
    expect(report.counts.renamed).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(bucket));
    expect(row?.value).toBe("Unknown");
    expect(row?.metadata?.isBrandUnknown).toBe(true);
    // NEO-272 already treats an absent manufacturer feature as the norm for
    // this row; the snapshot on the row should say the same.
    expect(row?.features?.manufacturer).toBeUndefined();
    // Other features survive — only the one key is touched.
    expect(row?.features?.era).toBe("Vintage");
  });

  test("every other manufacturer row gets setNamePrefix = its own value", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");
    const upperDeck = await seedManufacturer(t, year, "  Upper Deck  ");

    const report = await armed(t);

    expect(report.counts.prefixed).toBe(2);
    const [toppsRow, udRow] = await t.run(async (ctx) => [
      await ctx.db.get(topps),
      await ctx.db.get(upperDeck),
    ]);
    expect(toppsRow?.metadata?.setNamePrefix).toBe("Topps");
    // The prefix is the value TRIMMED — never the raw stored value verbatim.
    expect(udRow?.metadata?.setNamePrefix).toBe("Upper Deck");
  });

  test("a flagged row named anything other than 'All Brands' is left alone (already_named) — an operator's rename survives", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const renamed = await seedManufacturer(t, year, "Custom Bucket Name", {
      isBrandUnknown: true,
    });

    const report = await armed(t);

    expect(report.counts.alreadyNamed).toBe(1);
    expect(report.counts.renamed).toBe(0);
    const row = await t.run((ctx) => ctx.db.get(renamed));
    expect(row?.value).toBe("Custom Bucket Name");
    expect(row?.lastUpdated).toBe(SENTINEL);
  });

  test("a flagged row already named 'Unknown' is already_named, not re-renamed", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });

    const report = await armed(t);

    expect(report.counts.alreadyNamed).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(unknown));
    expect(row?.lastUpdated).toBe(SENTINEL);
  });

  test("a rename clash — a sibling already named 'Unknown' — is reported and left alone", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands", {
      isBrandUnknown: true,
    });
    const collidingUnknown = await seedManufacturer(t, year, "Unknown");

    const report = await armed(t);

    expect(report.counts.renameClash).toBe(1);
    expect(report.counts.renamed).toBe(0);
    const [bucketRow, collidingRow] = await t.run(async (ctx) => [
      await ctx.db.get(bucket),
      await ctx.db.get(collidingUnknown),
    ]);
    expect(bucketRow?.value).toBe("All Brands");
    expect(bucketRow?.lastUpdated).toBe(SENTINEL);
    // The sibling that already holds the name is untouched, but it DOES still
    // get its own prefix default (pass 2 applies independently of pass 1).
    expect(collidingRow?.metadata?.setNamePrefix).toBe("Unknown");
  });

  test("a row already carrying a prefix is already_prefixed, and it is NOT overwritten", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps", {
      setNamePrefix: "TCG",
    });

    const report = await armed(t);

    expect(report.counts.alreadyPrefixed).toBe(1);
    expect(report.counts.prefixed).toBe(0);
    const row = await t.run((ctx) => ctx.db.get(topps));
    expect(row?.metadata?.setNamePrefix).toBe("TCG");
    expect(row?.lastUpdated).toBe(SENTINEL);
  });

  test("levels other than manufacturer are not scanned at all", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands", {
      isBrandUnknown: true,
    });
    const setName = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "All Brands",
        platformData: {},
        parentId: bucket,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    const report = await armed(t);

    expect(report.scanned).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(setName));
    expect(row?.metadata?.setNamePrefix).toBeUndefined();
  });

  test("is IDEMPOTENT — a second run writes nothing and reports the steady state", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands", {
      isBrandUnknown: true,
    });
    const topps = await seedManufacturer(t, year, "Topps");

    await armed(t);
    const afterFirst = await t.run(async (ctx) => [
      await ctx.db.get(bucket),
      await ctx.db.get(topps),
    ]);

    const second = await armed(t);
    expect(second.counts).toEqual({
      renamed: 0,
      renameClash: 0,
      alreadyNamed: 1,
      prefixed: 0,
      alreadyPrefixed: 1,
    });
    const afterSecond = await t.run(async (ctx) => [
      await ctx.db.get(bucket),
      await ctx.db.get(topps),
    ]);
    expect(afterSecond[0]?.lastUpdated).toBe(afterFirst[0]?.lastUpdated);
    expect(afterSecond[1]?.lastUpdated).toBe(afterFirst[1]?.lastUpdated);
  });

  test("narrowing by `parentId` reads one year and leaves the others alone", async () => {
    const t = convexTest(schema, modules);
    const [y1995, y1996] = await Promise.all([seedYear(t, "1995"), seedYear(t, "1996")]);
    const topps1995 = await seedManufacturer(t, y1995, "Topps");
    const topps1996 = await seedManufacturer(t, y1996, "Topps");

    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const report = await t.mutation(
      internal.backfillBrandPrefixAndUnknownName.run,
      { confirm: "BACKFILL", parentId: y1995 },
    );

    expect(report.scanned).toBe(1);
    expect(report.counts.prefixed).toBe(1);
    const [row1995, row1996] = await t.run(async (ctx) => [
      await ctx.db.get(topps1995),
      await ctx.db.get(topps1996),
    ]);
    expect(row1995?.metadata?.setNamePrefix).toBe("Topps");
    expect(row1996?.metadata?.setNamePrefix).toBeUndefined();
    expect(row1996?.lastUpdated).toBe(SENTINEL);
  });

  test("the per-row report is CAPPED, while the counts stay exact", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 55; i++) {
      const year = await seedYear(t, `${1900 + i}`);
      await seedManufacturer(t, year, "Topps");
    }

    const report = await armed(t);

    expect(report.counts.prefixed).toBe(55);
    expect(report.rows).toHaveLength(50);
  });
});
