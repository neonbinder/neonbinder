/**
 * NEO-306 — `backfillVariantTypeRole`: the armed one-shot that gives every
 * existing variantType row the `metadata.variantRole` NB flag its
 * `variant`-tagged BSC slot says it has, now that `variantTypeRole` no longer
 * reads the slot at runtime.
 *
 * Pinned: the dry run is the default and writes nothing; `confirm` without
 * the deployment arm is refused and writes nothing; an armed run flags
 * exactly the single-evidence rows, never the Base, never over a role, never
 * on ambiguous or absent evidence; the BSC slots deep-equal their pre-run
 * snapshot (Jason's condition: listing needs them); a second run is the
 * steady state; the action walks every page.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { PAGE_SIZE } from "./backfillVariantTypeRole";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_700_000_000_000;
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function insertType(
  t: T,
  value: string,
  bsc: Record<string, string>,
  facets: Record<string, "variant" | "setName"> | undefined,
  metadata?: Doc<"selectorOptions">["metadata"],
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value,
      platformData: Object.keys(bsc).length > 0 ? { bsc } : {},
      ...(facets ? { platformFacets: { bsc: facets } } : {}),
      ...(metadata ? { metadata } : {}),
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

/** One row per bucket, plus an insert-level row the scan must never see. */
async function seedBuckets(t: T) {
  const insertId = await insertType(t, "Inserts", { b0: "insert" }, { b0: "variant" }, {
    cardNumberPrefix: "IN-",
  });
  const parallelId = await insertType(t, "Parallels", { b0: "parallel" }, { b0: "variant" });
  const flaggedId = await insertType(
    t,
    "Odd",
    { b0: "insert" },
    { b0: "variant" },
    { variantRole: "parallel" },
  );
  const baseId = await insertType(t, "Base", { b0: "parallel" }, { b0: "variant" }, {
    isBase: true,
  });
  const ambiguousId = await insertType(t, "Both", { b0: "insert-parallel" }, { b0: "variant" });
  const untaggedId = await insertType(t, "Legacy", { b0: "insert" }, undefined);
  const promoId = await insertType(t, "Promo", { b0: "promo" }, { b0: "variant" });
  const handMadeId = await insertType(t, "Hand made", {}, undefined);
  const notATypeId = await t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Not a type",
      platformData: { bsc: { b0: "insert" } },
      platformFacets: { bsc: { b0: "variant" } },
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
  return {
    insertId,
    parallelId,
    flaggedId,
    baseId,
    ambiguousId,
    untaggedId,
    promoId,
    handMadeId,
    notATypeId,
  };
}

async function allRows(t: T) {
  return t.run(async (ctx) => ctx.db.query("selectorOptions").collect());
}

const run = (t: T, confirm?: string) =>
  t.action(internal.backfillVariantTypeRole.run, confirm ? { confirm } : {});

const EXPECTED_COUNTS = {
  scanned: 8,
  flagged: 2,
  alreadyFlagged: 1,
  base: 1,
  ambiguous: 1,
  noEvidence: 3,
};

describe("backfillVariantTypeRole", () => {
  test("the dry run is the default: it reports the five buckets and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedBuckets(t);
    const before = await allRows(t);

    const result = await run(t);

    expect(result.armed).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.counts).toEqual(EXPECTED_COUNTS);
    expect(result.message).toMatch(/^Dry run/);
    expect(await allRows(t)).toEqual(before);
  });

  test("confirm without the deployment arm is refused, reported, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedBuckets(t);
    const before = await allRows(t);

    const result = await run(t, "BACKFILL");

    expect(result.armed).toBe(false);
    expect(result.message).toMatch(/ALLOW_SELECTOR_BACKFILL/);
    expect(result.counts).toEqual(EXPECTED_COUNTS);
    expect(await allRows(t)).toEqual(before);
  });

  test("armed: single-evidence rows get the role; the Base, a role already there, ambiguous and absent evidence are left exactly as they were", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const ids = await seedBuckets(t);
    const before = new Map((await allRows(t)).map((r) => [r._id, r]));

    const result = await run(t, "BACKFILL");

    expect(result.armed).toBe(true);
    expect(result.counts).toEqual(EXPECTED_COUNTS);
    const after = new Map((await allRows(t)).map((r) => [r._id, r]));

    expect(after.get(ids.insertId)?.metadata).toEqual({
      cardNumberPrefix: "IN-",
      variantRole: "insert",
    });
    expect(after.get(ids.parallelId)?.metadata).toEqual({ variantRole: "parallel" });
    for (const untouched of [
      ids.flaggedId,
      ids.baseId,
      ids.ambiguousId,
      ids.untaggedId,
      ids.promoId,
      ids.handMadeId,
      ids.notATypeId,
    ]) {
      expect(after.get(untouched)).toEqual(before.get(untouched));
    }
    // Metadata only: every row's BSC slots and tags deep-equal the pre-run
    // snapshot, and `lastUpdated` (the dialogs' optimistic version) is not
    // bumped.
    for (const [id, row] of after) {
      const was = before.get(id)!;
      expect(row.platformData).toEqual(was.platformData);
      expect(row.platformFacets).toEqual(was.platformFacets);
      expect(row.platformLabels).toEqual(was.platformLabels);
      expect(row.lastUpdated).toBe(was.lastUpdated);
    }
  });

  test("a second armed run is the steady state: everything it flagged reads as already flagged", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "true");
    const t = convexTest(schema, modules);
    await seedBuckets(t);
    await run(t, "BACKFILL");
    const between = await allRows(t);

    const again = await run(t, "BACKFILL");

    expect(again.counts).toEqual({
      ...EXPECTED_COUNTS,
      flagged: 0,
      alreadyFlagged: 3,
    });
    expect(await allRows(t)).toEqual(between);
  });

  test("the action walks every page: more than one page of rows is all flagged", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const n = PAGE_SIZE + 7;
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Inserts ${i}`,
          platformData: { bsc: { b0: "insert" } },
          platformFacets: { bsc: { b0: "variant" } },
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });

    const result = await run(t, "BACKFILL");

    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.counts.flagged).toBe(n);
    const rows = await allRows(t);
    expect(rows.every((r) => r.metadata?.variantRole === "insert")).toBe(true);
  });

  test("a run that stops at its page cap returns continueCursor, and a run given it carries on from there", async () => {
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const n = PAGE_SIZE + 7;
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Parallels ${i}`,
          platformData: { bsc: { b0: "parallel" } },
          platformFacets: { bsc: { b0: "variant" } },
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });

    const first = await t.action(internal.backfillVariantTypeRole.run, {
      confirm: "BACKFILL",
      maxPages: 1,
    });
    expect(first.truncated).toBe(true);
    expect(first.counts.flagged).toBe(PAGE_SIZE);
    expect(first.message).toMatch(/continueCursor/);
    expect(first.continueCursor).toEqual(expect.any(String));

    const second = await t.action(internal.backfillVariantTypeRole.run, {
      confirm: "BACKFILL",
      cursor: first.continueCursor,
    });
    // Only the rows past the first page: the cursor, not a restart.
    expect(second.counts.scanned).toBe(7);
    expect(second.counts.flagged).toBe(7);
    expect(second.truncated).toBe(false);
    expect(second.continueCursor).toBeUndefined();
    const rows = await allRows(t);
    expect(rows.every((r) => r.metadata?.variantRole === "parallel")).toBe(true);
  });

  test("both functions are internal: no client can reach the backfill", () => {
    const src = readFileSync(join(__dirname, "backfillVariantTypeRole.ts"), "utf8");
    expect(src).toContain("export const runPage = internalMutation({");
    expect(src).toContain("export const run = internalAction({");
    expect(src).not.toMatch(/export const \w+ = (query|mutation|action)\(/);
  });
});
