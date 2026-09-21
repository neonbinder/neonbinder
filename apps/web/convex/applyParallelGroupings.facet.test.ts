/**
 * NEO-293 — `applyParallelGroupings` tags the BSC ids it would otherwise
 * strand.
 *
 * BSC files a parallel of an insert as a `variantName` under `variant=insert`,
 * so the insert-level sync lands it as an insert row with an UNTAGGED BSC
 * slot: at `insert` the level rule already answers `variantName`. Promotion
 * moves the row to `parallel`, where the level rule is silent, and the same id
 * went inert — `bscSourceView` bucketed it "untagged", the checklist fetch
 * skipped BSC, the panel said "needs re-mapping".
 *
 * The fix records the fact at the one moment the writer holds it: the slots
 * are tagged `variantName` in the same patch as the level move. These tests
 * pin that, pin what is NOT touched (tagged slots, SportLots, demotion), and
 * — the part that matters to the operator — walk the full chain through
 * `resolveBscFacetFilters` and `bscSourceView` afterwards to show the parallel
 * resolves as a BSC source with the insert ancestor's variantName overridden.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { bscSourceView, resolveBscFacetFilters } from "./bscFacets";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_apg_facet_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_apg_facet_001",
  name: "Admin User",
  role: "admin",
};

const SENTINEL = 1_000_000;

type T = ReturnType<typeof convexTest>;
type Row = Doc<"selectorOptions">;

/**
 * The prod shape, minus nothing that matters: sport › year › set (untagged
 * setName slot, the level rule reads it) › Insert variant type (`variant`
 * tagged, as the variantType sync writes it) › inserts beneath.
 */
async function seedChainToInsertVariantType(t: T) {
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: { b0: "baseball" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2026",
      parentId: sport,
      platformData: { bsc: { b0: "2026" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const set = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Bowman",
      parentId: year,
      platformData: { bsc: { b0: "bowman" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const variantType = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      parentId: set,
      platformData: { bsc: { b0: "insert" } },
      platformFacets: { bsc: { b0: "variant" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    await ctx.db.patch(sport, { children: [year] });
    await ctx.db.patch(year, { children: [set] });
    await ctx.db.patch(set, { children: [variantType] });
    return { sport, year, set, variantType };
  });
}

/** An insert-level row as the insert sync leaves it: BSC id, no tag. */
async function seedInsert(
  t: T,
  variantTypeId: Id<"selectorOptions">,
  value: string,
  row: Partial<Pick<Row, "platformData" | "platformFacets" | "platformLabels">> = {},
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value,
      parentId: variantTypeId,
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
      ...row,
    });
    const parent = (await ctx.db.get(variantTypeId))!;
    await ctx.db.patch(variantTypeId, { children: [...parent.children, id] });
    return id;
  });
}

async function seedParallel(
  t: T,
  insertId: Id<"selectorOptions">,
  value: string,
  row: Partial<Pick<Row, "platformData" | "platformFacets">> = {},
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "parallel",
      value,
      parentId: insertId,
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
      ...row,
    });
    const parent = (await ctx.db.get(insertId))!;
    await ctx.db.patch(insertId, { children: [...parent.children, id] });
    return id;
  });
}

async function getRow(t: T, id: Id<"selectorOptions">): Promise<Row> {
  const row = await t.run(async (ctx) => ctx.db.get(id));
  if (!row) throw new Error(`row ${id} vanished`);
  return row;
}

/** Root→leaf, by walking `parentId` — the chain the checklist fetch builds. */
async function chainTo(t: T, leafId: Id<"selectorOptions">): Promise<Row[]> {
  return t.run(async (ctx) => {
    const chain: Row[] = [];
    let cursor: Id<"selectorOptions"> | undefined = leafId;
    while (cursor) {
      const row: Row | null = await ctx.db.get(cursor);
      if (!row) break;
      chain.unshift(row);
      cursor = row.parentId;
    }
    return chain;
  });
}

async function promote(
  t: T,
  variantTypeId: Id<"selectorOptions">,
  insertId: Id<"selectorOptions">,
  targetInsertId: Id<"selectorOptions">,
) {
  return t
    .withIdentity(ADMIN_IDENTITY)
    .mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId,
      promotions: [{ insertId, targetInsertId }],
      demotions: [],
    });
}

async function demote(
  t: T,
  variantTypeId: Id<"selectorOptions">,
  parallelId: Id<"selectorOptions">,
) {
  return t
    .withIdentity(ADMIN_IDENTITY)
    .mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId,
      promotions: [],
      demotions: [{ parallelId }],
    });
}

describe("applyParallelGroupings — promotion tags untagged BSC slots `variantName` (NEO-293)", () => {
  test("an untagged BSC slot on the promoted row is tagged variantName, in the same write as the level move", async () => {
    const t = convexTest(schema, modules);
    const { variantType } = await seedChainToInsertVariantType(t);
    const anime = await seedInsert(t, variantType, "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    const kanji = await seedInsert(t, variantType, "Anime Kanji", {
      platformData: { bsc: { b0: "anime-kanji" } },
      platformLabels: { bsc: { b0: "Anime Kanji" } },
    });

    const result = await promote(t, variantType, kanji, anime);
    expect(result).toEqual({ success: true, promoted: 1, demoted: 0, reparented: 0 });

    const row = await getRow(t, kanji);
    expect(row.level).toBe("parallel");
    expect(row.parentId).toBe(anime);
    expect(row.platformFacets).toEqual({ bsc: { b0: "variantName" } });
    // The id and its label are untouched — the tag says what the id IS, it
    // does not move or rename it.
    expect(row.platformData).toEqual({ bsc: { b0: "anime-kanji" } });
    expect(row.platformLabels).toEqual({ bsc: { b0: "Anime Kanji" } });
    // The insert it now sits under was not touched beyond its children list.
    const parent = await getRow(t, anime);
    expect(parent.platformFacets).toBeUndefined();
    expect(parent.children).toEqual([kanji]);
  });

  test("slots already carrying a tag are left exactly as written; only the untagged ones are tagged", async () => {
    const t = convexTest(schema, modules);
    const { variantType } = await seedChainToInsertVariantType(t);
    const anime = await seedInsert(t, variantType, "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    // b0 untagged from the sync; b1 an operator's setName split (NEO-189),
    // which genuinely IS a setName and must not become a variantName.
    const kanji = await seedInsert(t, variantType, "Anime Kanji", {
      platformData: { bsc: { b0: "anime-kanji", b1: "bowman-draft" } },
      platformFacets: { bsc: { b1: "setName" } },
    });

    await promote(t, variantType, kanji, anime);

    const row = await getRow(t, kanji);
    expect(row.platformFacets).toEqual({
      bsc: { b0: "variantName", b1: "setName" },
    });
  });

  test("SportLots slots are not tagged, and a row with no BSC side gains no `platformFacets` at all", async () => {
    const t = convexTest(schema, modules);
    const { variantType } = await seedChainToInsertVariantType(t);
    const anime = await seedInsert(t, variantType, "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    const slOnly = await seedInsert(t, variantType, "Anime Kanji", {
      platformData: { sportlots: { s0: "884412" } },
    });

    await promote(t, variantType, slOnly, anime);

    const row = await getRow(t, slOnly);
    expect(row.level).toBe("parallel");
    // No BSC slot means nothing to tag, and nothing is fabricated: the row has
    // no `platformFacets` key rather than an empty `{ bsc: {} }`.
    expect(row.platformFacets).toBeUndefined();
    expect(row.platformData).toEqual({ sportlots: { s0: "884412" } });
  });

  test("a row whose BSC slots are all tagged already is written without a facet change", async () => {
    const t = convexTest(schema, modules);
    const { variantType } = await seedChainToInsertVariantType(t);
    const anime = await seedInsert(t, variantType, "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    const kanji = await seedInsert(t, variantType, "Anime Kanji", {
      platformData: { bsc: { b0: "anime-kanji" } },
      platformFacets: { bsc: { b0: "variantName" } },
    });

    await promote(t, variantType, kanji, anime);

    const row = await getRow(t, kanji);
    expect(row.platformFacets).toEqual({ bsc: { b0: "variantName" } });
  });

  test("demotion (parallel → insert) keeps the tag — variantName is what the level rule says at insert anyway", async () => {
    const t = convexTest(schema, modules);
    const { variantType } = await seedChainToInsertVariantType(t);
    const anime = await seedInsert(t, variantType, "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    const kanji = await seedInsert(t, variantType, "Anime Kanji", {
      platformData: { bsc: { b0: "anime-kanji" } },
    });
    await promote(t, variantType, kanji, anime);
    expect((await getRow(t, kanji)).platformFacets).toEqual({
      bsc: { b0: "variantName" },
    });

    const result = await demote(t, variantType, kanji);
    expect(result).toEqual({ success: true, promoted: 0, demoted: 1, reparented: 0 });

    const row = await getRow(t, kanji);
    expect(row.level).toBe("insert");
    expect(row.parentId).toBe(variantType);
    expect(row.platformFacets).toEqual({ bsc: { b0: "variantName" } });
    // And it resolves identically to how it would have untagged at insert.
    const plan = resolveBscFacetFilters(await chainTo(t, kanji));
    expect(plan.filters.variantName).toEqual(["anime-kanji"]);
    expect(plan.sourceFacet).toBe("variantName");
  });

  test("demotion of a parallel that was never tagged does not tag it either", async () => {
    // Demotion is not a second tagging door. A parallel that arrived at
    // `parallel` some other way (seeded directly here) carries an untagged
    // slot; moving it up leaves the slot as it was. At `insert` the level rule
    // reads it as variantName regardless, so nothing is lost.
    const t = convexTest(schema, modules);
    const { variantType } = await seedChainToInsertVariantType(t);
    const anime = await seedInsert(t, variantType, "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    const kanji = await seedParallel(t, anime, "Anime Kanji", {
      platformData: { bsc: { b0: "anime-kanji" } },
    });

    await demote(t, variantType, kanji);

    const row = await getRow(t, kanji);
    expect(row.level).toBe("insert");
    expect(row.platformFacets).toBeUndefined();
  });
});

describe("after promotion, the full chain resolves the parallel as a BSC source (NEO-293)", () => {
  test("resolveBscFacetFilters: variant stays the insert id, variantName is the parallel's slug (insert ancestor overridden)", async () => {
    const t = convexTest(schema, modules);
    const { variantType } = await seedChainToInsertVariantType(t);
    const anime = await seedInsert(t, variantType, "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    const kanji = await seedInsert(t, variantType, "Anime Kanji", {
      platformData: { bsc: { b0: "anime-kanji" } },
    });

    // BEFORE: as an insert, the level rule already resolves it. The bug was
    // never at this level.
    const before = resolveBscFacetFilters(await chainTo(t, kanji));
    expect(before.filters.variantName).toEqual(["anime-kanji"]);

    await promote(t, variantType, kanji, anime);

    // AFTER: sport › year › Bowman › Insert › Anime › Anime Kanji. Every axis
    // present, the parallel's variantName WINS over the insert ancestor's
    // (deepest contributor rule), and `variant` is still the insert axis —
    // the parallel narrows variantName, it does not move to a parallel axis.
    const chain = await chainTo(t, kanji);
    expect(chain.map((r) => r.level)).toEqual([
      "sport",
      "year",
      "setName",
      "variantType",
      "insert",
      "parallel",
    ]);
    const plan = resolveBscFacetFilters(chain);
    expect(plan.filters).toEqual({
      sport: ["baseball"],
      year: ["2026"],
      setName: ["bowman"],
      variant: ["insert"],
      variantName: ["anime-kanji"],
    });
    expect(plan.sourceFacet).toBe("variantName");
  });

  test("bscSourceView on the promoted parallel: one source, nothing untagged, no missing scope", async () => {
    const t = convexTest(schema, modules);
    const { variantType } = await seedChainToInsertVariantType(t);
    const anime = await seedInsert(t, variantType, "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    const kanji = await seedInsert(t, variantType, "Anime Kanji", {
      platformData: { bsc: { b0: "anime-kanji" } },
      platformLabels: { bsc: { b0: "Anime Kanji" } },
    });

    await promote(t, variantType, kanji, anime);

    const chain = await chainTo(t, kanji);
    const leaf = chain[chain.length - 1];
    const view = bscSourceView(leaf, chain);

    expect(view.untagged).toEqual([]);
    expect(view.sources).toEqual([
      { slot: "b0", facet: "variantName", id: "anime-kanji", label: "Anime Kanji" },
    ]);
    expect(view.scope.own).toEqual([]);
    expect(view.scope.missing).toEqual([]);
    expect(view.scope.filters.variantName).toEqual(["anime-kanji"]);
    expect(view.scope.filters.variant).toEqual(["insert"]);
  });

  test("the control: a parallel seeded directly at `parallel` with an untagged slot is still inert — the level rule was not widened", async () => {
    // This is the base-set-parallel guarantee. `legacyBscFacetForLevel`
    // ("parallel") must stay silent; only the promotion path tags, because
    // only it knows where the id came from.
    const t = convexTest(schema, modules);
    const { variantType } = await seedChainToInsertVariantType(t);
    const anime = await seedInsert(t, variantType, "Anime", {
      platformData: { bsc: { b0: "anime" } },
    });
    const stranded = await seedParallel(t, anime, "Anime Kanji", {
      platformData: { bsc: { b0: "anime-kanji" } },
    });

    const chain = await chainTo(t, stranded);
    const leaf = chain[chain.length - 1];
    const plan = resolveBscFacetFilters(chain);
    // The insert ancestor's variantName survives because the leaf contributed
    // nothing — which is the pre-NEO-293 symptom, and stays the behaviour for
    // any parallel the promotion did not write.
    expect(plan.filters.variantName).toEqual(["anime"]);
    const view = bscSourceView(leaf, chain);
    expect(view.sources).toEqual([]);
    expect(view.untagged).toEqual([{ slot: "b0", id: "anime-kanji", label: "anime-kanji" }]);
  });
});
