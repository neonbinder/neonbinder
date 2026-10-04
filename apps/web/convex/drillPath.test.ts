/**
 * NEO-224 — `resolveDrillPath`, the server half of the set builder's trusted-id
 * gate. A pasted `?sport=…&year=…` is raw text; this answers with the deepest
 * valid ROOT-FIRST prefix so no garbage ever reaches a `v.id("selectorOptions")`
 * column query (an argument-validation throw takes the page down).
 *
 * Fixture: one full chain sport > year > brand > set > variantType(Base-flag
 * optional) > insert > parallel, plus a second tree to hang "wrong parent"
 * cases off. Rows are inserted raw, like the neighbouring selector tests.
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

const ADMIN = { subject: "admin", role: "admin" };
const SIGNED_IN = { subject: "user" };

type T = ReturnType<typeof convexTest>;
type OptionId = Id<"selectorOptions">;
type Level =
  | "sport"
  | "year"
  | "manufacturer"
  | "setName"
  | "variantType"
  | "insert"
  | "parallel";

async function row(
  t: T,
  level: Level,
  value: string,
  parentId?: OptionId,
  metadata?: { isBase?: boolean; variantRole?: "insert" | "parallel" },
): Promise<OptionId> {
  return t.run((ctx) =>
    ctx.db.insert("selectorOptions", {
      level,
      value,
      platformData: {},
      ...(parentId ? { parentId } : {}),
      ...(metadata ? { metadata } : {}),
      children: [],
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

/** A complete seven-level chain whose variant type is a plain Insert type. */
async function seedChain(t: T) {
  const sport = await row(t, "sport", "Baseball");
  const year = await row(t, "year", "1990", sport);
  const brand = await row(t, "manufacturer", "Topps", year);
  const set = await row(t, "setName", "Topps Flagship", brand);
  const type = await row(t, "variantType", "Insert", set, { variantRole: "insert" });
  const insert = await row(t, "insert", "All-Stars", type);
  const parallel = await row(t, "parallel", "Gold", insert);
  return { sport, year, brand, set, type, insert, parallel };
}

const resolve = (t: T, ids: string[]) =>
  t.withIdentity(ADMIN).query(api.drillPath.resolveDrillPath, { ids });

const idsOf = (path: Array<{ _id: string }>) => path.map((step) => step._id);

describe("resolveDrillPath", () => {
  test("a valid full chain resolves to every step with its level", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);

    const path = await resolve(t, [c.sport, c.year, c.brand, c.set, c.type, c.insert, c.parallel]);

    expect(path).toEqual([
      { _id: c.sport, level: "sport" },
      { _id: c.year, level: "year" },
      { _id: c.brand, level: "manufacturer" },
      { _id: c.set, level: "setName" },
      { _id: c.type, level: "variantType" },
      { _id: c.insert, level: "insert" },
      { _id: c.parallel, level: "parallel" },
    ]);
  });

  test("an empty list resolves to an empty path", async () => {
    const t = convexTest(schema, modules);
    expect(await resolve(t, [])).toEqual([]);
  });

  test("a prefix resolves as itself", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);
    expect(idsOf(await resolve(t, [c.sport, c.year]))).toEqual([c.sport, c.year]);
  });

  test("a garbage string stops the path there instead of throwing", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);

    expect(await resolve(t, ["not-an-id"])).toEqual([]);
    expect(idsOf(await resolve(t, [c.sport, "not-an-id", c.brand]))).toEqual([c.sport]);
  });

  test("an empty string stops the path", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);
    expect(idsOf(await resolve(t, [c.sport, ""]))).toEqual([c.sport]);
  });

  test("a string past 128 characters is refused without touching the table", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);

    expect(idsOf(await resolve(t, [c.sport, "a".repeat(129)]))).toEqual([c.sport]);
    // 128 is still under the cap: it fails as an id, not as a length.
    expect(idsOf(await resolve(t, [c.sport, "a".repeat(128)]))).toEqual([c.sport]);
  });

  test("an id from another table (a team) is not a selectorOptions id", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);
    const teamId = await t.run((ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        nameNormalized: "padres",
        sportId: c.sport,
        lastUpdated: 1_700_000_000_000,
      }),
    );

    expect(await resolve(t, [teamId])).toEqual([]);
    expect(idsOf(await resolve(t, [c.sport, teamId]))).toEqual([c.sport]);
  });

  test("a deleted row's id stops the path", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);
    await t.run((ctx) => ctx.db.delete(c.year));

    expect(idsOf(await resolve(t, [c.sport, c.year, c.brand]))).toEqual([c.sport]);
  });

  test("a real set under a different brand is a wrong parent and stops there", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);
    const otherBrand = await row(t, "manufacturer", "Fleer", c.year);
    const otherSet = await row(t, "setName", "Fleer Ultra", otherBrand);

    // brand Topps, set Fleer Ultra (which hangs off Fleer): cut at the set.
    expect(idsOf(await resolve(t, [c.sport, c.year, c.brand, otherSet]))).toEqual([
      c.sport,
      c.year,
      c.brand,
    ]);
  });

  test("a year under a different sport is a wrong parent", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);
    const hockey = await row(t, "sport", "Hockey");

    expect(idsOf(await resolve(t, [hockey, c.year]))).toEqual([hockey]);
  });

  test("a row of the wrong level at a position stops the path", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);

    // A sport id sitting in the year slot, and a brand in the sport slot.
    expect(idsOf(await resolve(t, [c.sport, c.sport]))).toEqual([c.sport]);
    expect(await resolve(t, [c.brand])).toEqual([]);
  });

  test("a sport that has a parent is not a sport", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);
    const oddSport = await row(t, "sport", "Odd", c.sport);

    expect(await resolve(t, [oddSport])).toEqual([]);
  });

  test("a year that has no parent is refused: only a sport sits at the root", async () => {
    const t = convexTest(schema, modules);
    const orphanYear = await row(t, "year", "1991");

    expect(await resolve(t, [orphanYear])).toEqual([]);
  });

  test("everything after the first bad link is dropped, even ids that would be fine alone", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);

    // year is garbage; brand/set are real, but below a broken link they hang off nothing.
    expect(idsOf(await resolve(t, [c.sport, "zzz", c.brand, c.set]))).toEqual([c.sport]);
  });

  test("stops at a Base variant type even when a deeper id follows it", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);
    const base = await row(t, "variantType", "Base", c.set, { isBase: true });
    // A well-formed child of Base: would be valid on its own, but the
    // cascade shows no column beneath Base.
    const underBase = await row(t, "insert", "Stray", base);

    const path = await resolve(t, [c.sport, c.year, c.brand, c.set, base, underBase]);

    expect(idsOf(path)).toEqual([c.sport, c.year, c.brand, c.set, base]);
  });

  test("a variant type that is merely named Base is not terminal", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);
    // No isBase flag: the role is an NB flag, never the display name.
    const lookalike = await row(t, "variantType", "Base", c.set);
    const child = await row(t, "insert", "Child", lookalike);

    expect(
      idsOf(await resolve(t, [c.sport, c.year, c.brand, c.set, lookalike, child])),
    ).toEqual([c.sport, c.year, c.brand, c.set, lookalike, child]);
  });

  test("reads only the first seven ids and ignores the rest", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);
    const ids = [c.sport, c.year, c.brand, c.set, c.type, c.insert, c.parallel];

    // An eighth, garbage entry must not matter or throw...
    expect(idsOf(await resolve(t, [...ids, "junk"]))).toEqual(ids);
    // ...and neither may a flood of them.
    expect(idsOf(await resolve(t, [...ids, ...Array(500).fill("junk")]))).toEqual(ids);
  });

  test("rejects a signed-in non-admin and a signed-out caller", async () => {
    const t = convexTest(schema, modules);
    const c = await seedChain(t);

    await expect(
      t.withIdentity(SIGNED_IN).query(api.drillPath.resolveDrillPath, { ids: [c.sport] }),
    ).rejects.toThrow();
    await expect(t.query(api.drillPath.resolveDrillPath, { ids: [c.sport] })).rejects.toThrow();
  });
});
