/**
 * NEO-294 / NEO-325 — `ensureBrandRowForName` (convex/brandRehome.ts): find or
 * mint the manufacturer row called `name` under a year.
 *
 * NEO-325 added the exactly-one guard: two manufacturer rows already folding
 * to the name cannot be told apart by it, so the helper refuses (`id: null`,
 * `created: false`) and writes nothing, rather than adopt "the first" one the
 * index returns. Driven through `t.run` because the helper is not a Convex
 * function; lives at the convex/ root for the `import.meta.glob` reason in
 * `bscTeamEnrichmentQueue.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { ensureBrandRowForName } from "./brandRehome";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function seedYear(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1997",
      platformData: {},
      features: { sport: "Hockey" },
      children: [],
      lastUpdated: 1,
    }),
  );
}

async function seedBrand(
  t: ReturnType<typeof convexTest>,
  yearId: Id<"selectorOptions">,
  value: string,
  over: Record<string, unknown> = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: 1,
      ...over,
    }),
  );
}

const call = (
  t: ReturnType<typeof convexTest>,
  yearId: Id<"selectorOptions">,
  name: string,
) => t.run((ctx) => ensureBrandRowForName(ctx, { yearId, name }));

const snapshot = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("selectorOptions").collect());

describe("ensureBrandRowForName — the exactly-one guard (NEO-325)", () => {
  test("two rows folding to the name: refuses with id null, created false, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);
    await seedBrand(t, yearId, "Topps", { metadata: { setNamePrefix: "Topps" } });
    await seedBrand(t, yearId, "topps ", { metadata: { setNamePrefix: "Topps" } });
    const before = await snapshot(t);

    const result = await call(t, yearId, "Topps");

    expect(result).toEqual({ id: null, created: false });
    expect(await snapshot(t)).toEqual(before);
  });

  test("a third, differently named row does not make the pair unique", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);
    await seedBrand(t, yearId, "Topps");
    await seedBrand(t, yearId, "Topps");
    await seedBrand(t, yearId, "Bowman");

    expect(await call(t, yearId, "Topps")).toEqual({ id: null, created: false });
  });

  test("exactly one same-named row is adopted, with its own prefix, and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);
    const brandId = await seedBrand(t, yearId, "Topps", {
      metadata: { setNamePrefix: "Topps Co" },
    });
    const before = await snapshot(t);

    const result = await call(t, yearId, "topps");

    expect(result).toEqual({
      id: brandId,
      created: false,
      setNamePrefix: "Topps Co",
    });
    expect(await snapshot(t)).toEqual(before);
  });

  test("rows with the same name under a DIFFERENT year do not count as a twin", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);
    const otherYear = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "year",
        value: "1998",
        platformData: {},
        children: [],
        lastUpdated: 1,
      }),
    );
    const brandId = await seedBrand(t, yearId, "Topps");
    await seedBrand(t, otherYear, "Topps");

    const result = await call(t, yearId, "Topps");

    expect(result.id).toBe(brandId);
    expect(result.created).toBe(false);
  });

  test("no row of the name mints one, once: the second call returns it and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);

    const first = await call(t, yearId, "Topps");
    const afterFirst = await snapshot(t);
    const second = await call(t, yearId, "Topps");

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ id: first.id, created: false });
    expect(await snapshot(t)).toEqual(afterFirst);
  });

  test("the flagged Unknown row wearing the name is still refused (id null)", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);
    await seedBrand(t, yearId, "Topps", { metadata: { isBrandUnknown: true } });

    expect(await call(t, yearId, "Topps")).toEqual({ id: null, created: false });
  });
});
