/**
 * NEO-334 — the variant-type rename guard, at every door.
 *
 * A variant type's TITLE is its kind (Base / Insert(s) / Parallel(s)), so a
 * rename that changes the kind while rows sit beneath the type is refused,
 * a second Base is refused outright, and one word gets one row.
 *
 * The pure decision table is in variantRole.test.ts. This file pins:
 *
 *   - `variantTypeRenameCheck` / `assertVariantTypeRenameAllowed` gathering
 *     the facts (children, cards printed on the type, cards cross-listed into
 *     it, sub-variants under an Insert type's inserts, a sibling Base) and
 *     doing it with bounded reads;
 *   - the doors: `renameSelectorOption` (throws), `applySelectorSyncSuggestions`
 *     (counts it skipped) with `getSelectorSyncSuggestions` omitting the
 *     refused label, `storeReconciledOptions`' tier-0 title edit (keeps the
 *     linkage, reports `renameRefused`), `addCustomSelectorOption` (same word,
 *     second Base; variant type only).
 */

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import {
  assertVariantTypeRenameAllowed,
  variantTypeRenameCheck,
} from "./lib/selectorAncestry";
import {
  VARIANT_TYPE_RENAME_MESSAGES,
  VARIANT_TYPE_RENAME_REFUSED,
  sameWordSiblingMessage,
  variantTypeKind,
} from "./variantRole";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_neo334_rename", role: "admin" };
const SENTINEL = 1_000_000;

type T = ReturnType<typeof convexTest>;
type RowId = Id<"selectorOptions">;
type Row = Doc<"selectorOptions">;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function insertRow(
  t: T,
  fields: Partial<Row> & { level: Row["level"]; value: string },
): Promise<RowId> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
      ...fields,
    } as Omit<Row, "_id" | "_creationTime">);
    if (fields.parentId) {
      const parent = await ctx.db.get(fields.parentId);
      await ctx.db.patch(fields.parentId, {
        children: [...(parent?.children ?? []), id],
      });
    }
    return id;
  });
}

async function seedSet(t: T): Promise<RowId> {
  const sport = await insertRow(t, { level: "sport", value: "Baseball" });
  const year = await insertRow(t, { level: "year", value: "2026", parentId: sport });
  const brand = await insertRow(t, {
    level: "manufacturer",
    value: "Bowman",
    parentId: year,
    metadata: { setNamePrefix: "Bowman" },
  });
  return insertRow(t, { level: "setName", value: "Bowman", parentId: brand });
}

const variantType = (t: T, setId: RowId, value: string, extra: Partial<Row> = {}) =>
  insertRow(t, { level: "variantType", value, parentId: setId, ...extra });

const addCard = (t: T, selectorOptionId: RowId) =>
  t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber: "1",
      cardName: "Aaron Judge",
      platformData: {},
      sortOrder: 0,
      lastUpdated: SENTINEL,
    }),
  );

const getRow = (t: T, id: RowId) => t.run(async (ctx) => ctx.db.get(id));

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

const refused = (message: string) => ({ code: VARIANT_TYPE_RENAME_REFUSED, message });

/**
 * The real `db`, wrapped so every terminal read is recorded. The check must
 * read with `.first()` or a single parent's page, and nothing at all when the
 * answer needs no facts.
 */
function countingDb(db: unknown) {
  const calls: string[] = [];
  const TERMINALS = new Set(["first", "collect", "take", "unique", "paginate"]);
  const wrapQuery = (q: object, table: string): object =>
    new Proxy(q, {
      get(target, prop) {
        const value = (target as Record<string | symbol, unknown>)[prop];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (typeof prop === "string" && TERMINALS.has(prop)) {
            calls.push(`${table}.${prop}`);
            return result;
          }
          return result && typeof result === "object" ? wrapQuery(result, table) : result;
        };
      },
    });
  const wrapped = new Proxy(db as object, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (prop === "query") {
        return (table: string) =>
          wrapQuery((value as (t: string) => object).call(target, table), table);
      }
      if (prop === "get") {
        return (id: unknown) => {
          calls.push("get");
          return (value as (i: unknown) => unknown).call(target, id);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { calls, db: wrapped as never };
}

// ===========================================================================
// variantTypeRenameCheck — the facts it gathers
// ===========================================================================

describe("variantTypeRenameCheck", () => {
  const check = (t: T, id: RowId, next: string) =>
    t.run(async (ctx) => {
      const row = (await ctx.db.get(id))!;
      return variantTypeRenameCheck(ctx, row, next);
    });

  test("a row that is not a variant type is allowed, with no reads", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const insertId = await insertRow(t, { level: "insert", value: "Base", parentId: setId });
    await addCard(t, insertId);

    const calls = await t.run(async (ctx) => {
      const row = (await ctx.db.get(insertId))!;
      const counted = countingDb(ctx.db);
      const out = await variantTypeRenameCheck({ db: counted.db }, row, "Promo");
      expect(out).toEqual({ ok: true });
      return counted.calls;
    });
    expect(calls).toEqual([]);
  });

  test.each([
    ["Promo", "Gold"],
    ["Inserts", "Insert"],
    ["Parallels", "parallel"],
    ["Promo", "Promos"],
  ])("%j -> %j keeps the kind: allowed with rows beneath, and no reads", async (from, to) => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, from);
    await insertRow(t, { level: "insert", value: "Gold Foil", parentId: id });
    await addCard(t, id);

    const calls = await t.run(async (ctx) => {
      const row = (await ctx.db.get(id))!;
      const counted = countingDb(ctx.db);
      expect(await variantTypeRenameCheck({ db: counted.db }, row, to)).toEqual({ ok: true });
      return counted.calls;
    });
    expect(calls).toEqual([]);
  });

  test("an EMPTY type may change kind freely", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Promo");

    for (const next of ["Inserts", "Parallels", "Base", "Gold"]) {
      expect(await check(t, id, next), next).toEqual({ ok: true });
    }
  });

  test("an inserts child beneath is rows beneath: a kind change is refused with the general sentence", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Promo");
    await insertRow(t, { level: "insert", value: "Holiday", parentId: id });

    expect(await check(t, id, "Parallels")).toEqual({
      ok: false,
      code: VARIANT_TYPE_RENAME_REFUSED,
      message: VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows,
    });
  });

  test("a card printed straight on the type counts as rows beneath", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Promo");
    await addCard(t, id);

    expect(await check(t, id, "Inserts")).toMatchObject({
      ok: false,
      message: VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows,
    });
  });

  test("a card CROSS-LISTED into the type counts too", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Promo");
    const other = await variantType(t, setId, "Gold");
    const card = await addCard(t, other);
    await t.run(async (ctx) => {
      await ctx.db.insert("cardCrossListings", {
        cardChecklistId: card,
        selectorOptionId: id,
        lastUpdated: SENTINEL,
      });
    });

    expect(await check(t, id, "Parallels")).toMatchObject({
      ok: false,
      message: VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows,
    });
  });

  test("an Insert type with a sub-variant under one of its inserts gets the sub-variant sentence", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Inserts");
    await insertRow(t, { level: "insert", value: "Anime", parentId: id });
    const second = await insertRow(t, { level: "insert", value: "Holiday", parentId: id });
    await insertRow(t, { level: "parallel", value: "Gold", parentId: second });

    expect(await check(t, id, "Promo")).toEqual({
      ok: false,
      code: VARIANT_TYPE_RENAME_REFUSED,
      message: VARIANT_TYPE_RENAME_MESSAGES.insertHasSubVariants,
    });
  });

  test("an Insert type whose inserts hold no sub-variants gets the general sentence", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Inserts");
    await insertRow(t, { level: "insert", value: "Anime", parentId: id });

    expect(await check(t, id, "Promo")).toMatchObject({
      message: VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows,
    });
  });

  test("any type with rows beneath, renamed Base, gets the to-Base sentence", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Promo");
    await insertRow(t, { level: "insert", value: "Holiday", parentId: id });

    for (const next of ["Base", "bases"]) {
      expect(await check(t, id, next), next).toMatchObject({
        message: VARIANT_TYPE_RENAME_MESSAGES.toBaseWithRows,
      });
    }
  });

  test("the Base with its checklist hanging off it gets the Base-has-cards sentence", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Base");
    await addCard(t, id);

    expect(await check(t, id, "Core")).toMatchObject({
      message: VARIANT_TYPE_RENAME_MESSAGES.baseHasCards,
    });
  });

  test("the Base keeps its plural: Base -> Bases is allowed with cards, and is never its own sibling Base", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Base");
    await addCard(t, id);

    expect(await check(t, id, "Bases")).toEqual({ ok: true });
  });

  test("a second Base is refused even for an empty type, and the sentence is the approved one", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await variantType(t, setId, "Base");
    const id = await variantType(t, setId, "Promo");

    expect(await check(t, id, "Base")).toEqual({
      ok: false,
      code: VARIANT_TYPE_RENAME_REFUSED,
      message: "This set already has a Base.",
    });
    expect(await check(t, id, "Gold")).toEqual({ ok: true });
  });

  test("a Base in ANOTHER set is no sibling", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const otherSet = await insertRow(t, { level: "setName", value: "Chrome" });
    await variantType(t, otherSet, "Base");
    const id = await variantType(t, setId, "Promo");

    expect(await check(t, id, "Base")).toEqual({ ok: true });
  });

  test("reads stay bounded: cards are probed with first(), never collected, and a sub-variant stops the scan", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Inserts");
    const inserts: RowId[] = [];
    for (let i = 0; i < 25; i++) {
      inserts.push(await insertRow(t, { level: "insert", value: `Insert ${i}`, parentId: id }));
    }
    await insertRow(t, { level: "parallel", value: "Gold", parentId: inserts[0] });

    const calls = await t.run(async (ctx) => {
      const row = (await ctx.db.get(id))!;
      const counted = countingDb(ctx.db);
      const out = await variantTypeRenameCheck({ db: counted.db }, row, "Promo");
      expect(out).toMatchObject({ message: VARIANT_TYPE_RENAME_MESSAGES.insertHasSubVariants });
      return counted.calls;
    });

    // The card tables are never collected.
    expect(calls.filter((c) => c.startsWith("cardChecklist.") || c.startsWith("cardCrossListings."))).toEqual([
      "cardChecklist.first",
      "cardCrossListings.first",
    ]);
    // One child probe, one page of inserts, and the scan stops at the first
    // insert holding a sub-variant (the first of 25 here).
    expect(calls.filter((c) => c === "selectorOptions.first")).toHaveLength(2);
    expect(calls.filter((c) => c === "selectorOptions.collect")).toHaveLength(1);
  });

  test("a printed card spares the cross-listing probe", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Promo");
    await addCard(t, id);

    const calls = await t.run(async (ctx) => {
      const row = (await ctx.db.get(id))!;
      const counted = countingDb(ctx.db);
      await variantTypeRenameCheck({ db: counted.db }, row, "Inserts");
      return counted.calls;
    });
    expect(calls).not.toContain("cardCrossListings.first");
  });
});

describe("assertVariantTypeRenameAllowed", () => {
  test("throws the structured ConvexError the rename control renders, and nothing when allowed", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Promo");
    await insertRow(t, { level: "insert", value: "Holiday", parentId: id });

    const data = await t.run(async (ctx) => {
      const row = (await ctx.db.get(id))!;
      await assertVariantTypeRenameAllowed(ctx, row, "Gold");
      try {
        await assertVariantTypeRenameAllowed(ctx, row, "Parallels");
      } catch (e) {
        return (e as ConvexError<unknown>).data;
      }
      return null;
    });
    expect(data).toEqual(refused(VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows));
  });
});

// ===========================================================================
// renameSelectorOption
// ===========================================================================

describe("renameSelectorOption — the kind guard (NEO-334)", () => {
  const rename = (t: T, id: RowId, value: string) =>
    t.withIdentity(ADMIN).mutation(api.selectorOptions.renameSelectorOption, { id, value });

  test("a kind-changing rename with rows beneath is refused, structured, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Inserts");
    const insert = await insertRow(t, { level: "insert", value: "Anime", parentId: id });
    await insertRow(t, { level: "parallel", value: "Gold", parentId: insert });
    const before = await getRow(t, id);

    const data = await refusalOf(() => rename(t, id, "Promo"));

    expect(data).toEqual(refused(VARIANT_TYPE_RENAME_MESSAGES.insertHasSubVariants));
    expect(await getRow(t, id)).toEqual(before);
  });

  test("an EMPTY type may be renamed to another kind", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Promo");

    const res = await rename(t, id, "Parallels");

    expect(res).toEqual({ success: true, message: 'Renamed to "Parallels"' });
    expect((await getRow(t, id))?.value).toBe("Parallels");
  });

  test("a rename that keeps the kind is allowed with rows beneath, singular to plural included", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Inserts");
    await insertRow(t, { level: "insert", value: "Anime", parentId: id });

    await rename(t, id, "Insert");
    expect((await getRow(t, id))?.value).toBe("Insert");
  });

  test("a second Base is refused with the approved sentence", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await variantType(t, setId, "Base");
    const id = await variantType(t, setId, "Promo");

    const data = await refusalOf(() => rename(t, id, "Base"));

    expect(data).toEqual(refused("This set already has a Base."));
    expect((await getRow(t, id))?.value).toBe("Promo");
  });

  test("the Base with cards cannot be renamed away", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Base");
    await addCard(t, id);

    expect(await refusalOf(() => rename(t, id, "Core"))).toEqual(
      refused(VARIANT_TYPE_RENAME_MESSAGES.baseHasCards),
    );
  });

  test("one word, one row: renaming a type to its sibling's plural is a ConvexError with the sibling's title", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await variantType(t, setId, "Promos");
    const id = await variantType(t, setId, "Gold");

    const data = await refusalOf(() => rename(t, id, "Promo"));

    expect(data).toEqual(refused(sameWordSiblingMessage("Promos")));
  });

  test("a type may be renamed to the other form of its OWN word", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await variantType(t, setId, "Promo");

    await rename(t, id, "Promos");

    expect((await getRow(t, id))?.value).toBe("Promos");
  });

  test("other levels are untouched: an insert titled Base renames freely, and plural siblings keep the exact-name rule", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const type = await variantType(t, setId, "Promo");
    const insert = await insertRow(t, { level: "insert", value: "Base", parentId: type });
    await insertRow(t, { level: "insert", value: "Gold Refractor", parentId: type });
    await addCard(t, insert);

    await rename(t, insert, "Gold Refractors");

    expect((await getRow(t, insert))?.value).toBe("Gold Refractors");
  });
});

// ===========================================================================
// getSelectorSyncSuggestions / applySelectorSyncSuggestions
// ===========================================================================

describe("sync suggestions — the kind guard (NEO-334)", () => {
  /** A variant type whose BSC label differs from its NB title. */
  const typeWithLabel = (t: T, setId: RowId, value: string, bscLabel: string) =>
    variantType(t, setId, value, {
      platformData: { bsc: { b0: value.toLowerCase().replace(/\s+/g, "-") } },
      platformFacets: { bsc: { b0: "variant" } },
      platformLabels: { bsc: { b0: bscLabel } },
      primaryPlatformId: { bsc: "b0" },
      platformSlotSeq: { bsc: 1 },
    });

  const suggestions = (t: T, setId: RowId) =>
    t.withIdentity(ADMIN).query(api.selectorOptions.getSelectorSyncSuggestions, {
      level: "variantType",
      parentId: setId,
    });

  const apply = (t: T, setId: RowId, id: RowId, baseVersion = SENTINEL) =>
    t.withIdentity(ADMIN).mutation(api.selectorOptions.applySelectorSyncSuggestions, {
      level: "variantType",
      parentId: setId,
      decisions: [{ existingId: id, baseVersion, side: "bsc", action: "accept" }],
    });

  test("the query omits a label that would change the kind of a type with rows beneath it", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await typeWithLabel(t, setId, "Inserts", "Promo");
    await insertRow(t, { level: "insert", value: "Anime", parentId: id });

    expect(await suggestions(t, setId)).toEqual([]);
  });

  test("the query still offers a kind-keeping label, and any label for an EMPTY type", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const full = await typeWithLabel(t, setId, "Inserts", "Insert");
    await insertRow(t, { level: "insert", value: "Anime", parentId: full });
    const empty = await typeWithLabel(t, setId, "Gold", "Parallels");

    const out = await suggestions(t, setId);

    expect(out.map((o) => [o.existingId, o.suggestions.map((s) => s.label)]).sort()).toEqual(
      [
        [full, ["Insert"]],
        [empty, ["Parallels"]],
      ].sort(),
    );
  });

  test("the query omits a label that would make a second Base", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await variantType(t, setId, "Base");
    await typeWithLabel(t, setId, "Promo", "Base");

    expect(await suggestions(t, setId)).toEqual([]);
  });

  test("apply counts a refused kind change as skipped and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await typeWithLabel(t, setId, "Inserts", "Promo");
    await insertRow(t, { level: "insert", value: "Anime", parentId: id });
    const before = await getRow(t, id);

    const res = await apply(t, setId, id);

    expect(res).toEqual({ applied: 0, declined: 0, stale: 0, clashed: 0, skipped: 1 });
    expect(await getRow(t, id)).toEqual(before);
  });

  test("apply still lands a label that keeps the kind", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await typeWithLabel(t, setId, "Inserts", "Insert");
    await insertRow(t, { level: "insert", value: "Anime", parentId: id });

    const res = await apply(t, setId, id);

    expect(res.applied).toBe(1);
    expect((await getRow(t, id))?.value).toBe("Insert");
  });

  test("apply on an empty type lands a kind-changing label", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await typeWithLabel(t, setId, "Gold", "Parallels");

    expect((await apply(t, setId, id)).applied).toBe(1);
    expect((await getRow(t, id))?.value).toBe("Parallels");
  });

  test("apply refuses a second Base against the row as an earlier accept in the same call left it", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const a = await typeWithLabel(t, setId, "Gold", "Base");
    const b = await typeWithLabel(t, setId, "Silver", "Bases");

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.applySelectorSyncSuggestions, {
        level: "variantType",
        parentId: setId,
        decisions: [
          { existingId: a, baseVersion: SENTINEL, side: "bsc", action: "accept" },
          { existingId: b, baseVersion: SENTINEL, side: "bsc", action: "accept" },
        ],
      });

    expect(res.applied).toBe(1);
    expect(res.skipped + res.clashed).toBe(1);
    const values = [(await getRow(t, a))?.value, (await getRow(t, b))?.value].sort();
    expect(values.filter((v) => v === "Base" || v === "Bases")).toHaveLength(1);
  });

  test("a decline is never blocked by the guard", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await typeWithLabel(t, setId, "Inserts", "Promo");
    await insertRow(t, { level: "insert", value: "Anime", parentId: id });

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.applySelectorSyncSuggestions, {
        level: "variantType",
        parentId: setId,
        decisions: [{ existingId: id, baseVersion: SENTINEL, side: "bsc", action: "decline" }],
      });

    expect(res.declined).toBe(1);
  });
});

// ===========================================================================
// storeReconciledOptions — tier-0 title edit
// ===========================================================================

describe("storeReconciledOptions — a refused title edit keeps the linkage (NEO-334)", () => {
  const storeEdit = (t: T, parentId: RowId, existingId: RowId, value: string, bsc: string) =>
    t.withIdentity(ADMIN).mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId,
      reconciledItems: [
        { value, platformData: { bsc }, metadata: undefined, existingId },
      ],
    });

  const seedLinked = async (t: T, setId: RowId, value: string) =>
    variantType(t, setId, value, {
      platformData: { bsc: { b0: "old-slug" } },
      platformFacets: { bsc: { b0: "variant" } },
      primaryPlatformId: { bsc: "b0" },
      platformSlotSeq: { bsc: 1 },
    });

  test("a kind-changing edit on a type with rows beneath: renameRefused carries the sentence; the new id is still linked; the title stays", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const id = await seedLinked(t, setId, "Inserts");
    await insertRow(t, { level: "insert", value: "Anime", parentId: id });

    const res = await storeEdit(t, setId, id, "Promo", "new-slug");

    expect(res.renameRefusedTotal).toBe(1);
    expect(res.renameRefused[0]).toMatchObject({
      rowId: id,
      value: "Inserts",
      requested: "Promo",
      message: VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows,
    });
    const row = await getRow(t, id);
    expect(row?.value).toBe("Inserts");
    // Refusing a name is not a reason to drop the confirmed mapping.
    expect(JSON.stringify(row?.platformData)).toContain("new-slug");
  });

  test("a second Base is refused the same way", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await variantType(t, setId, "Base");
    const id = await seedLinked(t, setId, "Promo");

    const res = await storeEdit(t, setId, id, "Base", "new-slug");

    expect(res.renameRefused[0]).toMatchObject({
      rowId: id,
      message: VARIANT_TYPE_RENAME_MESSAGES.secondBase,
    });
    expect((await getRow(t, id))?.value).toBe("Promo");
  });

  test("a kind-keeping or empty-type edit lands", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const full = await seedLinked(t, setId, "Inserts");
    await insertRow(t, { level: "insert", value: "Anime", parentId: full });

    const res = await storeEdit(t, setId, full, "Insert", "old-slug");

    expect(res.renameRefusedTotal).toBe(0);
    expect((await getRow(t, full))?.value).toBe("Insert");
  });
});

// ===========================================================================
// addCustomSelectorOption
// ===========================================================================

describe("addCustomSelectorOption — one word, one Base (NEO-334)", () => {
  const add = (t: T, level: Row["level"], value: string, parentId: RowId) =>
    t.withIdentity(ADMIN).mutation(api.selectorOptions.addCustomSelectorOption, {
      level,
      value,
      parentId,
    });

  test.each([
    ["Promo", "Promos"],
    ["Promos", "Promo"],
    ["Insert", "Inserts"],
    ["Rated Rookie", "  rated   rookies "],
  ])("%j beside %j is refused with the sibling's title, and nothing is written", async (existing, typed) => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await variantType(t, setId, existing);

    const data = await refusalOf(() => add(t, "variantType", typed, setId));

    expect(data).toEqual({
      code: "CUSTOM_VALUE_INVALID",
      reason: sameWordSiblingMessage(existing),
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) => q.eq("level", "variantType").eq("parentId", setId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("typing the exact existing title still resolves to that row", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const existing = await variantType(t, setId, "Promo");

    expect(await add(t, "variantType", "promo", setId)).toBe(existing);
  });

  test("a second Base ('Bases' beside 'Base') is refused", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await variantType(t, setId, "Base");

    const data = (await refusalOf(() => add(t, "variantType", "Bases", setId))) as {
      code: string;
      reason: string;
    };

    expect(data.code).toBe("CUSTOM_VALUE_INVALID");
    // The same-word rule fires first (a second Base is always the same word
    // as the first), so the sentence is the sibling one.
    expect(data.reason).toBe(sameWordSiblingMessage("Base"));
  });

  test("a different word is added, and the kind is the title", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    await variantType(t, setId, "Promo");

    const id = await add(t, "variantType", "Base", setId);

    const row = await getRow(t, id);
    expect(row?.value).toBe("Base");
    expect(variantTypeKind(row)).toBe("base");
  });

  test("the insert level keeps the exact-name rule: 'Gold Refractors' beside 'Gold Refractor' is added", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const type = await variantType(t, setId, "Inserts");
    await insertRow(t, { level: "insert", value: "Gold Refractor", parentId: type });

    const id = await add(t, "insert", "Gold Refractors", type);

    expect((await getRow(t, id))?.value).toBe("Gold Refractors");
  });

  test("a variant type in ANOTHER set is no sibling", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const otherSet = await insertRow(t, { level: "setName", value: "Chrome" });
    await variantType(t, otherSet, "Promos");

    const id = await add(t, "variantType", "Promo", setId);

    expect((await getRow(t, id))?.value).toBe("Promo");
  });
});
