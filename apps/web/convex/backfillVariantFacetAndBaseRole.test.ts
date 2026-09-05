/**
 * NEO-239 — the one-shot backfill that makes existing variantType rows
 * BSC-resolvable again.
 *
 * Retiring the display-value `variant` pin left every row written before
 * NEO-189 with an untagged BSC slot and therefore an unresolvable BSC side.
 * The ids on those rows are almost all correct — the variantType sync stored
 * BSC's own `variant` facet value and seeded the row's display value from the
 * same string — so the slot id FOLDS EQUAL to the row's value on a healthy
 * row. That equality is the only evidence this task acts on.
 *
 * The rows where it does NOT hold are the known corruption: a mis-saved Base
 * mapping wrote the parent's setName slug into variantType rows. Tagging one
 * of those `variant` would send a setName slug as BSC's variant axis on every
 * checklist below it, so they are reported and left alone — which is the
 * difference between a backfill and a guess.
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

async function seedSet(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: { bsc: { b0: "2024-topps" } },
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function seedVariantType(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
  opts: {
    bsc?: Record<string, string>;
    facets?: Record<string, "setName" | "variantName" | "variant">;
    isBase?: boolean;
  } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value,
      platformData: opts.bsc ? { bsc: opts.bsc } : {},
      ...(opts.facets ? { platformFacets: { bsc: opts.facets } } : {}),
      ...(opts.isBase !== undefined ? { metadata: { isBase: opts.isBase } } : {}),
      parentId,
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

const dry = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.backfillVariantFacetAndBaseRole.run, {});

/**
 * BOTH arms: the per-invocation token AND the per-deployment flag. A helper
 * that set only one of them would make every test below a test of the other
 * one by accident.
 */
const armed = (t: ReturnType<typeof convexTest>) => {
  vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
  return t.mutation(internal.backfillVariantFacetAndBaseRole.run, {
    confirm: "BACKFILL",
  });
};

/** The token, on a deployment that was never armed. */
const armedButNoFlag = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.backfillVariantFacetAndBaseRole.run, {
    confirm: "BACKFILL",
  });

describe("backfillVariantFacetAndBaseRole — the dry run", () => {
  test("reports exactly what an armed run would do, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const base = await seedVariantType(t, setId, "Base", { bsc: { b0: "base" } });
    const insert = await seedVariantType(t, setId, "Insert", {
      bsc: { b0: "insert" },
    });

    const report = await dry(t);

    expect(report.armed).toBe(false);
    expect(report.tagged).toBe(2);
    expect(report.rolesSet).toBe(1);

    // NOT WRITTEN. This is the whole contract of a dry run, and the assertion
    // that a report the operator reads is not itself the change.
    const after = await t.run(async (ctx) => [
      await ctx.db.get(base),
      await ctx.db.get(insert),
    ]);
    expect(after[0]?.platformFacets).toBeUndefined();
    expect(after[0]?.metadata?.isBase).toBeUndefined();
    expect(after[1]?.platformFacets).toBeUndefined();
  });

  test("the token WITHOUT the deployment flag is refused, and says which flag", async () => {
    // The two arms guard different mistakes. `confirm` is per-invocation and is
    // identical on every deployment, so it cannot catch a `--prod` typed out of
    // habit — the environment flag is the half that can. A refusal, not a
    // throw: the operator still gets the report they asked for, plus the one
    // line telling them what to do next.
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const base = await seedVariantType(t, setId, "Base", { bsc: { b0: "base" } });

    const report = await armedButNoFlag(t);

    expect(report.armed).toBe(false);
    expect(report.message).toContain("ALLOW_SELECTOR_BACKFILL");
    // The plan is still reported in full, so the refusal costs the operator
    // nothing but the second command.
    expect(report.tagged).toBe(1);
    expect(report.rolesSet).toBe(1);

    // AND nothing was written.
    const row = await t.run(async (ctx) => ctx.db.get(base));
    expect(row?.platformFacets).toBeUndefined();
    expect(row?.metadata?.isBase).toBeUndefined();
    expect(row?.lastUpdated).toBe(SENTINEL);
  });

  test("an unrecognised flag value does not arm the deployment", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await seedVariantType(t, setId, "Base", { bsc: { b0: "base" } });

    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "yes");
    const report = await armedButNoFlag(t);
    expect(report.armed).toBe(false);
    expect(report.message).toContain("ALLOW_SELECTOR_BACKFILL");
  });

  test("the flag ALONE writes nothing — the per-invocation token is still required", async () => {
    // An armed deployment is a state that outlives one command. If the flag
    // were sufficient, the plain dry-run command would start writing.
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const base = await seedVariantType(t, setId, "Base", { bsc: { b0: "base" } });

    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const report = await dry(t);

    expect(report.armed).toBe(false);
    expect(report.tagged).toBe(1);
    expect(
      (await t.run(async (ctx) => ctx.db.get(base)))?.platformFacets,
    ).toBeUndefined();
  });

  test("an omitted `confirm` is a dry run — a half-typed command cannot arm itself", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await seedVariantType(t, setId, "Base", { bsc: { b0: "base" } });

    // Not the token, so not armed.
    const report = await t.mutation(internal.backfillVariantFacetAndBaseRole.run, {
      confirm: "yes",
    });
    expect(report.armed).toBe(false);
    expect(report.tagged).toBe(1);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("selectorOptions").collect(),
    );
    expect(rows.every((r) => r.platformFacets === undefined)).toBe(true);
  });
});

describe("backfillVariantFacetAndBaseRole — the armed run", () => {
  test("tags the slot and grants the base role", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const base = await seedVariantType(t, setId, "Base", { bsc: { b0: "base" } });
    const parallel = await seedVariantType(t, setId, "Parallel", {
      bsc: { b0: "parallel" },
    });

    const report = await armed(t);
    expect(report.armed).toBe(true);
    expect(report.tagged).toBe(2);
    expect(report.rolesSet).toBe(1);

    const baseRow = await t.run(async (ctx) => ctx.db.get(base));
    expect(baseRow?.platformFacets?.bsc).toEqual({ b0: "variant" });
    expect(baseRow?.metadata?.isBase).toBe(true);

    // The role comes from the SLOT ID being "base", so a Parallel row gets the
    // tag and no role.
    const parallelRow = await t.run(async (ctx) => ctx.db.get(parallel));
    expect(parallelRow?.platformFacets?.bsc).toEqual({ b0: "variant" });
    expect(parallelRow?.metadata?.isBase).toBeUndefined();
  });

  test("matching is fold-insensitive, because the display value was seeded from the slug", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await seedVariantType(t, setId, "  BASE  ", {
      bsc: { b0: "base" },
    });

    await armed(t);
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.platformFacets?.bsc).toEqual({ b0: "variant" });
    expect(row?.metadata?.isBase).toBe(true);
  });

  test("is IDEMPOTENT — a second run writes nothing and reports the steady state", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const base = await seedVariantType(t, setId, "Base", { bsc: { b0: "base" } });

    await armed(t);
    const afterFirst = await t.run(async (ctx) => ctx.db.get(base));

    const second = await armed(t);
    expect(second.tagged).toBe(0);
    expect(second.rolesSet).toBe(0);
    expect(second.skippedCounts.alreadyTagged).toBe(1);

    const afterSecond = await t.run(async (ctx) => ctx.db.get(base));
    expect(afterSecond?.lastUpdated).toBe(afterFirst?.lastUpdated);
  });

  test("never overwrites an operator's `isBase` decision", async () => {
    // `setBaseVariantType` is the operator's door onto the same field. A
    // backfill that re-derived the role from the slug on every run would undo
    // their answer the next time anybody ran it.
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const demoted = await seedVariantType(t, setId, "Base", {
      bsc: { b0: "base" },
      isBase: false,
    });

    const report = await armed(t);
    expect(report.rolesSet).toBe(0);
    expect((await t.run(async (ctx) => ctx.db.get(demoted)))?.metadata?.isBase).toBe(
      false,
    );
  });

  test("never overwrites an existing facet tag", async () => {
    // A `setName` tag on a Base row is NEO-189's motivating case — a Base
    // drawing its cards from two BSC setName sets — and is a real, deliberate
    // mapping, not a gap to fill.
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await seedVariantType(t, setId, "Base", {
      bsc: { b0: "2024-topps-series-1" },
      facets: { b0: "setName" },
    });

    const report = await armed(t);
    expect(report.tagged).toBe(0);
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.platformFacets?.bsc).toEqual(
      { b0: "setName" },
    );
  });
});

describe("backfillVariantFacetAndBaseRole — what it refuses to touch", () => {
  test("a slug that does not fold to the row's value is REPORTED, not tagged", async () => {
    // The mis-saved Base mapping: the parent's setName slug written into a
    // variantType row. Tagging it `variant` would send `variant:
    // ["2024-topps"]` on every checklist fetch under this row.
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const corrupted = await seedVariantType(t, setId, "Base", {
      bsc: { b0: "2024-topps" },
    });

    const report = await armed(t);
    expect(report.tagged).toBe(0);
    expect(report.rolesSet).toBe(0);
    expect(report.skippedCounts.slugDoesNotMatchValue).toBe(1);
    expect(report.needsRemapping).toEqual([
      { id: corrupted, value: "Base" },
    ]);

    const row = await t.run(async (ctx) => ctx.db.get(corrupted));
    expect(row?.platformFacets).toBeUndefined();
    expect(row?.metadata?.isBase).toBeUndefined();
  });

  test("a row with no BSC slot at all is counted separately — there is nothing to tag", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await seedVariantType(t, setId, "My Variant");

    const report = await armed(t);
    expect(report.tagged).toBe(0);
    expect(report.skippedCounts.noBscSlot).toBe(1);
    expect(report.needsRemapping).toEqual([]);
  });

  test("levels other than variantType are not scanned at all", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await seedVariantType(t, setId, "Base", { bsc: { b0: "base" } });

    const report = await armed(t);
    // The setName row is not in `scanned`, and its untagged slot is untouched.
    expect(report.scanned).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(setId)))?.platformFacets).toBeUndefined();
  });

  test("the corrupted-row report is CAPPED, while the count stays exact", async () => {
    // A deployment with thousands of bad rows must still return a usable
    // answer. The cap is on the list an operator reads, never on the number
    // they are told.
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    for (let i = 0; i < 55; i++) {
      await seedVariantType(t, setId, `Base ${i}`, { bsc: { b0: "2024-topps" } });
    }

    const report = await armed(t);
    expect(report.skippedCounts.slugDoesNotMatchValue).toBe(55);
    expect(report.needsRemapping).toHaveLength(50);
  });
});
