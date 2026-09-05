/**
 * NEO-219 C — validation and the cross-parent duplicate check on the custom
 * entry path.
 *
 * Covers:
 *  - checkCustomSelectorValue: year is strictly four digits, other levels are
 *    the universal floor, and the trim happens BEFORE the regex
 *  - findSelectorOptionElsewhere: a set under a sibling manufacturer is found,
 *    folded, scoped to the year, and never includes the caller's own parent
 *  - findSelectorOptionElsewhere: insert scope spans every variantType in the
 *    set; parallel scope also spans the inserts
 *  - findSelectorOptionElsewhere: admin-gated
 *  - addCustomSelectorOption: CUSTOM_VALUE_INVALID, CUSTOM_EXISTS_ELSEWHERE,
 *    the allowDuplicateElsewhere escape hatch, and the untouched per-parent
 *    idempotent return that syncSetsAcrossManufacturers depends on
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { checkCustomSelectorValue } from "./selectorSyncMatch";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_neo219_custom",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_neo219_custom",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "normal_user_neo219_custom",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|normal_user_neo219_custom",
  name: "Normal User",
  role: "user",
};

const SENTINEL_LAST_UPDATED = 1_700_000_000_000;

/** Mirrors MAX_ELSEWHERE_PARENTS in convex/selectorOptions.ts. */
const MAX_ELSEWHERE_PARENTS = 200;

type Level =
  | "sport"
  | "year"
  | "manufacturer"
  | "setName"
  | "variantType"
  | "insert"
  | "parallel";

async function insertRow(
  t: ReturnType<typeof convexTest>,
  level: Level,
  value: string,
  parentId?: Id<"selectorOptions">,
  isCustom?: boolean,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level,
      value,
      platformData: {},
      parentId,
      children: [],
      ...(isCustom ? { isCustom: true } : {}),
      lastUpdated: SENTINEL_LAST_UPDATED,
    });
    if (parentId) {
      const parent = await ctx.db.get(parentId);
      if (parent) {
        await ctx.db.patch(parentId, {
          children: [...(parent.children ?? []), id],
        });
      }
    }
    return id;
  });
}

// ===========================================================================
// checkCustomSelectorValue (pure — importable by EntityColumn)
// ===========================================================================

describe("checkCustomSelectorValue", () => {
  test("accepts a four-digit year", () => {
    expect(checkCustomSelectorValue("year", "2024")).toEqual({
      ok: true,
      value: "2024",
    });
  });

  test("trims before applying the year rule", () => {
    // The trim lives in checkSelectorValue, which runs first — so a pasted
    // value with surrounding whitespace is accepted and STORED trimmed.
    expect(checkCustomSelectorValue("year", "  2024  ")).toEqual({
      ok: true,
      value: "2024",
    });
  });

  test("rejects a letter-for-digit typo", () => {
    const result = checkCustomSelectorValue("year", "2o24");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(
      "Year must be a four-digit number",
    );
  });

  test("rejects a three-digit year", () => {
    expect(checkCustomSelectorValue("year", "024").ok).toBe(false);
  });

  test("rejects a season-shaped year (strict, Jason decision 2)", () => {
    const result = checkCustomSelectorValue("year", "1972-73");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(
      "Year must be a four-digit number",
    );
  });

  test("rejects an empty value at every level with the universal reason", () => {
    for (const level of ["year", "setName", "sport"] as const) {
      const result = checkCustomSelectorValue(level, "   ");
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe(
        "Name cannot be empty",
      );
    }
  });

  test("rejects a zero-width character before the level rule is reached", () => {
    const result = checkCustomSelectorValue("year", "20​24");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/zero-width/);
  });

  test("accepts ordinary set/insert names untouched", () => {
    expect(checkCustomSelectorValue("setName", "Bowman Chrome")).toEqual({
      ok: true,
      value: "Bowman Chrome",
    });
    // Real parallels carry slashes, parentheses and numerals.
    expect(checkCustomSelectorValue("parallel", "Gold /50")).toEqual({
      ok: true,
      value: "Gold /50",
    });
  });
});

// ===========================================================================
// findSelectorOptionElsewhere
// ===========================================================================

describe("findSelectorOptionElsewhere", () => {
  /**
   * Sport › 2021 › { Topps, All Brands › "Bowman Chrome" }
   * plus a decoy "Bowman Chrome" under a DIFFERENT year.
   */
  async function seedSetNameTree(t: ReturnType<typeof convexTest>) {
    const sportId = await insertRow(t, "sport", "Baseball");
    const year2021 = await insertRow(t, "year", "2021", sportId);
    const year2024 = await insertRow(t, "year", "2024", sportId);
    const topps = await insertRow(t, "manufacturer", "Topps", year2021);
    const allBrands = await insertRow(
      t,
      "manufacturer",
      "All Brands",
      year2021,
      true,
    );
    const otherYearTopps = await insertRow(
      t,
      "manufacturer",
      "Topps",
      year2024,
    );
    const strandedSet = await insertRow(
      t,
      "setName",
      "Bowman Chrome",
      allBrands,
    );
    await insertRow(t, "setName", "Bowman Chrome", otherYearTopps);
    return { sportId, year2021, topps, allBrands, strandedSet };
  }

  test("finds a set filed under a sibling manufacturer, with a full path", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { topps, allBrands, strandedSet } = await seedSetNameTree(t);

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: topps, value: "Bowman Chrome" },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]._id).toBe(strandedSet);
    expect(matches[0].parentId).toBe(allBrands);
    // Root-first, leaf INCLUDED — the FE renders everything but the last node
    // as "already exists under 2021 › All Brands".
    expect(matches[0].path.map((node) => node.value)).toEqual([
      "Baseball",
      "2021",
      "All Brands",
      "Bowman Chrome",
    ]);
    expect(matches[0].path.map((node) => node.level)).toEqual([
      "sport",
      "year",
      "manufacturer",
      "setName",
    ]);
  });

  test("folds case and whitespace the same way the sync matcher does", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { topps, strandedSet } = await seedSetNameTree(t);

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: topps, value: "  bowman CHROME " },
    );

    expect(matches.map((m) => m._id)).toEqual([strandedSet]);
  });

  test("does not reach across years", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { topps, strandedSet } = await seedSetNameTree(t);

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: topps, value: "Bowman Chrome" },
    );

    // The 2024 copy is a legitimately different set and must not be offered.
    expect(matches).toHaveLength(1);
    expect(matches[0]._id).toBe(strandedSet);
  });

  test("excludes the caller's own parent — that is the select-existing path", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { allBrands } = await seedSetNameTree(t);

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: allBrands, value: "Bowman Chrome" },
    );

    expect(matches).toEqual([]);
  });

  test("returns nothing at levels whose scope is the parent (manufacturer)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { year2021 } = await (async () => {
      const seeded = await seedSetNameTree(t);
      return { year2021: seeded.year2021 };
    })();

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "manufacturer", parentId: year2021, value: "Topps" },
    );

    // "Topps" exists under 2024 too, but a manufacturer's scope is its year —
    // this is exactly what keeps the internal "All Brands" creation working.
    expect(matches).toEqual([]);
  });

  test("insert scope spans every variantType in the set", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2024", sportId);
    const mfrId = await insertRow(t, "manufacturer", "Topps", yearId);
    const setId = await insertRow(t, "setName", "Topps Chrome", mfrId);
    const baseId = await insertRow(t, "variantType", "Base", setId);
    const insertVt = await insertRow(t, "variantType", "Insert", setId);
    const strandedInsert = await insertRow(
      t,
      "insert",
      "Future Stars",
      insertVt,
    );

    // A second SET, to prove the scope stops at the set boundary.
    const otherSetId = await insertRow(t, "setName", "Topps Series 1", mfrId);
    const otherVt = await insertRow(t, "variantType", "Insert", otherSetId);
    await insertRow(t, "insert", "Future Stars", otherVt);

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "insert", parentId: baseId, value: "Future Stars" },
    );

    expect(matches.map((m) => m._id)).toEqual([strandedInsert]);
  });

  test("parallel scope spans variantTypes AND the inserts under them", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2024", sportId);
    const mfrId = await insertRow(t, "manufacturer", "Topps", yearId);
    const setId = await insertRow(t, "setName", "Topps Chrome", mfrId);
    const baseId = await insertRow(t, "variantType", "Base", setId);
    const insertVt = await insertRow(t, "variantType", "Insert", setId);
    const someInsert = await insertRow(t, "insert", "Future Stars", insertVt);
    const parallelUnderInsert = await insertRow(
      t,
      "parallel",
      "Gold /50",
      someInsert,
    );

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "parallel", parentId: baseId, value: "Gold /50" },
    );

    expect(matches.map((m) => m._id)).toEqual([parallelUnderInsert]);
  });

  // ── security condition 3b: the search is bounded ────────────────────────

  test("answers an oversized value without reading anything", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { topps } = await seedSetNameTree(t);

    // 201 chars — one past MAX_SELECTOR_VALUE_LENGTH. No stored value can be
    // this long (checkSelectorValue caps the write side at 200), so "no match"
    // is the correct answer AND the cheap one; it must not fan out first.
    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: topps, value: "x".repeat(201) },
    );
    expect(matches).toEqual([]);

    // A value AT the ceiling is still searched properly.
    const atCeiling = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: topps, value: "y".repeat(200) },
    );
    expect(atCeiling).toEqual([]);
  });

  test("caps the parallel candidate-parent fan-out", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2024", sportId);
    const mfrId = await insertRow(t, "manufacturer", "Topps", yearId);
    const setId = await insertRow(t, "setName", "Topps Chrome", mfrId);

    // MAX_ELSEWHERE_PARENTS + 1 variantTypes. `by_level_and_parent` orders by
    // _creationTime, so the last one falls outside the cap.
    const variantTypeIds: Array<Id<"selectorOptions">> = [];
    for (let i = 0; i < MAX_ELSEWHERE_PARENTS + 1; i++) {
      variantTypeIds.push(
        await insertRow(t, "variantType", `VT ${i}`, setId, true),
      );
    }
    const beyondCap = variantTypeIds[variantTypeIds.length - 1];
    await insertRow(t, "parallel", "Gold /50", beyondCap);

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "parallel", parentId: variantTypeIds[0], value: "Gold /50" },
    );

    // Truncated, not exhaustive: the search is an OFFER, and a miss costs a
    // duplicate row, never data. The per-parent uniqueness check is untouched.
    expect(matches).toEqual([]);

    // Proof the same shape IS found inside the cap.
    await insertRow(t, "parallel", "Gold /50", variantTypeIds[5]);
    const inCap = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "parallel", parentId: variantTypeIds[0], value: "Gold /50" },
    );
    expect(inCap).toHaveLength(1);
    expect(inCap[0].parentId).toBe(variantTypeIds[5]);
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const { topps } = await seedSetNameTree(t);

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .query(api.selectorOptions.findSelectorOptionElsewhere, {
          level: "setName",
          parentId: topps,
          value: "Bowman Chrome",
        }),
    ).rejects.toThrow(/Admin access required/);
  });

  // =========================================================================
  // Adversarial pass (NEO-219 readiness)
  // =========================================================================

  test("folding is case AND surrounding-whitespace only — an internal double space is a DIFFERENT key", async () => {
    // `selectorValueKey` is `value.toLowerCase().trim()` — it does not
    // collapse internal runs of whitespace. So a value that differs from the
    // stranded row only by a doubled internal space folds to a DIFFERENT key
    // and is NOT reported as a match. Pinning the actual behavior here: if
    // this starts failing, `selectorValueKey` changed to collapse internal
    // whitespace, which is a real behavior change worth a deliberate review,
    // not a silent one.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { topps } = await seedSetNameTree(t);

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: topps, value: "bowman  chrome" },
    );

    expect(matches).toEqual([]);
  });

  test("caps at MAX_ELSEWHERE_MATCHES (20) rather than returning every hit", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2021", sportId);
    const home = await insertRow(t, "manufacturer", "Topps", yearId);
    // 25 sibling manufacturers, each carrying a same-named set — well past the
    // 20-match cap.
    for (let i = 0; i < 25; i++) {
      const mfr = await insertRow(t, "manufacturer", `Brand ${i}`, yearId);
      await insertRow(t, "setName", "Bowman Chrome", mfr);
    }

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: home, value: "Bowman Chrome" },
    );

    expect(matches).toHaveLength(20);
  });

  test("insert scope reports a path through the sibling variantType", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2024", sportId);
    const mfrId = await insertRow(t, "manufacturer", "Topps", yearId);
    const setId = await insertRow(t, "setName", "Topps Chrome", mfrId);
    const baseId = await insertRow(t, "variantType", "Base", setId);
    const insertVt = await insertRow(t, "variantType", "Insert", setId);
    const strandedInsert = await insertRow(
      t,
      "insert",
      "Future Stars",
      insertVt,
    );

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "insert", parentId: baseId, value: "Future Stars" },
    );

    expect(matches).toHaveLength(1);
    // Root-first, the matched row included as the last entry — the FE
    // renders "Baseball › 2024 › Topps › Topps Chrome › Insert" as the
    // breadcrumb this offer names.
    expect(matches[0].path.map((n) => n.value)).toEqual([
      "Baseball",
      "2024",
      "Topps",
      "Topps Chrome",
      "Insert",
      "Future Stars",
    ]);
    expect(matches[0].path.map((n) => n.level)).toEqual([
      "sport",
      "year",
      "manufacturer",
      "setName",
      "variantType",
      "insert",
    ]);
  });

  test("parallel scope reports a path through the insert AND its variantType", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2024", sportId);
    const mfrId = await insertRow(t, "manufacturer", "Topps", yearId);
    const setId = await insertRow(t, "setName", "Topps Chrome", mfrId);
    const baseId = await insertRow(t, "variantType", "Base", setId);
    const insertVt = await insertRow(t, "variantType", "Insert", setId);
    const someInsert = await insertRow(t, "insert", "Future Stars", insertVt);
    const parallelUnderInsert = await insertRow(
      t,
      "parallel",
      "Gold /50",
      someInsert,
    );

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "parallel", parentId: baseId, value: "Gold /50" },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].path.map((n) => n.value)).toEqual([
      "Baseball",
      "2024",
      "Topps",
      "Topps Chrome",
      "Insert",
      "Future Stars",
      "Gold /50",
    ]);
  });

  test("a manufacturer with no siblings under its year finds nothing (own row excluded, nothing else there)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2024", sportId);
    // The ONLY manufacturer under this year.
    const mfrId = await insertRow(t, "manufacturer", "Topps", yearId);
    const setId = await insertRow(t, "setName", "Topps Chrome", mfrId);

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: mfrId, value: "Topps Chrome" },
    );

    expect(matches).toEqual([]);
  });

  test("setName with no parentId at all (root-scope edge) returns nothing rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const matches = await asAdmin.query(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: undefined, value: "Topps Chrome" },
    );

    expect(matches).toEqual([]);
  });
});

// ===========================================================================
// addCustomSelectorOption — adversarial validation (NEO-219 readiness)
// ===========================================================================

describe("addCustomSelectorOption — adversarial", () => {
  test("refuses a value over the 200-char ceiling with CUSTOM_VALUE_INVALID", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await insertRow(t, "sport", "Baseball");

    const tooLong = "A".repeat(201);
    let thrown: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.addCustomSelectorOption, {
        level: "setName",
        value: tooLong,
        parentId: sportId,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConvexError);
    expect(
      (thrown as ConvexError<{ code: string; reason: string }>).data,
    ).toEqual({
      code: "CUSTOM_VALUE_INVALID",
      reason: "Name exceeds 200 characters",
    });
  });

  test("refuses a zero-width character through the mutation, not just the pure checker", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await insertRow(t, "sport", "Baseball");

    let thrown: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.addCustomSelectorOption, {
        level: "setName",
        value: "Bowman​Chrome",
        parentId: sportId,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConvexError);
    expect(
      (thrown as ConvexError<{ code: string; reason: string }>).data.reason,
    ).toMatch(/zero-width/);

    const sets = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "setName").eq("parentId", sportId),
        )
        .collect(),
    );
    expect(sets).toHaveLength(0);
  });

  test("a padded re-submission of an existing value resolves to it — no duplicate 'year' row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await insertRow(t, "sport", "Baseball");

    const first = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "year", value: "2024", parentId: sportId },
    );

    const second = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "year", value: "  2024  ", parentId: sportId },
    );

    expect(second).toBe(first);
    const years = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "year").eq("parentId", sportId),
        )
        .collect(),
    );
    expect(years).toHaveLength(1);
  });
});

// ===========================================================================
// addCustomSelectorOption — validation + cross-parent guard
// ===========================================================================

describe("addCustomSelectorOption validation", () => {
  test("refuses an invalid year with CUSTOM_VALUE_INVALID and inserts nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await insertRow(t, "sport", "Baseball");

    let thrown: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.addCustomSelectorOption, {
        level: "year",
        value: "2o24",
        parentId: sportId,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConvexError);
    expect(
      (thrown as ConvexError<{ code: string; reason: string }>).data,
    ).toEqual({
      code: "CUSTOM_VALUE_INVALID",
      reason: "Year must be a four-digit number",
    });

    const years = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "year").eq("parentId", sportId),
        )
        .collect(),
    );
    expect(years).toHaveLength(0);
  });

  test("stores the trimmed value", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await insertRow(t, "sport", "Baseball");

    const id = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "year", value: "  2024  ", parentId: sportId },
    );

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.value).toBe("2024");
    // NEO-239 — `addCustomSelectorOption` no longer writes `isCustom`. What a
    // hand-added row IS, is a row with no marketplace ids; that is the only
    // fact anything downstream reads.
    expect(row!.isCustom).toBeUndefined();
    expect(row!.platformData).toEqual({});
  });

  test("refuses a cross-parent duplicate with CUSTOM_EXISTS_ELSEWHERE", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2021", sportId);
    const topps = await insertRow(t, "manufacturer", "Topps", yearId);
    const allBrands = await insertRow(
      t,
      "manufacturer",
      "All Brands",
      yearId,
      true,
    );
    const strandedSet = await insertRow(
      t,
      "setName",
      "Bowman Chrome",
      allBrands,
    );

    let thrown: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.addCustomSelectorOption, {
        level: "setName",
        value: "Bowman Chrome",
        parentId: topps,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConvexError);
    const data = (
      thrown as ConvexError<{
        code: string;
        matches: Array<{ _id: string; path: Array<{ value: string }> }>;
      }>
    ).data;
    expect(data.code).toBe("CUSTOM_EXISTS_ELSEWHERE");
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]._id).toBe(strandedSet);
    expect(data.matches[0].path.map((n) => n.value)).toEqual([
      "Baseball",
      "2021",
      "All Brands",
      "Bowman Chrome",
    ]);

    // Nothing was created under Topps.
    const sets = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "setName").eq("parentId", topps),
        )
        .collect(),
    );
    expect(sets).toHaveLength(0);
  });

  test("creates it anyway when allowDuplicateElsewhere is set", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2021", sportId);
    const topps = await insertRow(t, "manufacturer", "Topps", yearId);
    const allBrands = await insertRow(
      t,
      "manufacturer",
      "All Brands",
      yearId,
      true,
    );
    await insertRow(t, "setName", "Bowman Chrome", allBrands);

    const id = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      {
        level: "setName",
        value: "Bowman Chrome",
        parentId: topps,
        allowDuplicateElsewhere: true,
      },
    );

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.parentId).toBe(topps);
    // NEO-239 — `addCustomSelectorOption` no longer writes `isCustom`. What a
    // hand-added row IS, is a row with no marketplace ids; that is the only
    // fact anything downstream reads.
    expect(row!.isCustom).toBeUndefined();
    expect(row!.platformData).toEqual({});

    const parent = await t.run(async (ctx) => ctx.db.get(topps));
    expect(parent!.children).toContain(id);
  });

  test("per-parent idempotent return still wins over the elsewhere check", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2021", sportId);
    const topps = await insertRow(t, "manufacturer", "Topps", yearId);
    const allBrands = await insertRow(t, "manufacturer", "All Brands", yearId);
    await insertRow(t, "setName", "Bowman Chrome", allBrands);
    const hereAlready = await insertRow(
      t,
      "setName",
      "Bowman Chrome",
      topps,
    );

    // Same name exists BOTH under this parent and elsewhere. The existing
    // sibling resolves first — typing a name that is already in this column
    // must behave like selecting it, never like an error.
    const id = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "setName", value: "bowman chrome", parentId: topps },
    );

    expect(id).toBe(hereAlready);
  });

  test("the internal All Brands creation path is unaffected", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const year2021 = await insertRow(t, "year", "2021", sportId);
    const year2024 = await insertRow(t, "year", "2024", sportId);
    // A prior year already carries an "All Brands" manufacturer — the exact
    // shape that would trip a global duplicate check.
    await insertRow(t, "manufacturer", "All Brands", year2024, true);

    // Verbatim what syncSetsAcrossManufacturers sends.
    const id = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "manufacturer", value: "All Brands", parentId: year2021 },
    );

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.value).toBe("All Brands");
    expect(row!.parentId).toBe(year2021);
    // NEO-239 — `addCustomSelectorOption` no longer writes `isCustom`. What a
    // hand-added row IS, is a row with no marketplace ids; that is the only
    // fact anything downstream reads.
    expect(row!.isCustom).toBeUndefined();
    expect(row!.platformData).toEqual({});

    // And it is still idempotent on a second call.
    const again = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "manufacturer", value: "All Brands", parentId: year2021 },
    );
    expect(again).toBe(id);
  });

  test("rejects a non-admin caller before validating anything", async () => {
    const t = convexTest(schema, modules);
    const sportId = await insertRow(t, "sport", "Baseball");

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .mutation(api.selectorOptions.addCustomSelectorOption, {
          level: "year",
          value: "2o24",
          parentId: sportId,
        }),
    ).rejects.toThrow(/Admin access required/);
  });
});
