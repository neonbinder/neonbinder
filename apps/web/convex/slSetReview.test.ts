/**
 * NEO-306 — the SportLots-only review (`convex/slSetReview.ts`).
 *
 * Sync Sets no longer mints SportLots-only names as sets (NEO-237) nor parks
 * the flagship's colours nowhere (NEO-305's absorb): every such name is one
 * entry in its brand's review, and the operator files each as its own set or
 * as a row under a variant type of one of the brand's BSC-linked sets.
 *
 * Pinned here:
 *   - the sync writes ONE doc per (year, brand), replaced only for a brand
 *     whose list came back ok; a single-brand sync leaves other brands'
 *     docs alone; a pause writes nothing; an unchanged list writes nothing;
 *   - "the colours are not sets" (moved from the deleted
 *     syncSetsFlagshipAbsorbs.test.ts): 2026 Bowman's Blue/Gold wait in the
 *     review, no set is minted for them;
 *   - the reads: entries + BSC-holding sets + a read-time suggestion; a
 *     set's variant types without the Base;
 *   - the save: validation by id (nothing written on a refusal), an id the
 *     review does not hold is skipped, every role landing, a same-key sibling
 *     skipped and never merged, an already-linked id skipped, the known-brand
 *     split for Unknown, covered ids after the save, the doc deleted when
 *     done, the BSC slots untouched, and a save resumed after a thrown chunk
 *     finishing with no duplicate.
 *
 * Both adapters are module-mocked, so nothing here reaches a marketplace.
 */

import { convexTest } from "convex-test";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { applySlSetReviewImpl, rowNameUnderSet } from "./slSetReview";

type Option = { value: string; platformValue: string };

const mockState = vi.hoisted(() => ({
  bsc: { success: true, options: [] as Option[] } as {
    success: boolean;
    options: Option[];
    message?: string;
  },
  sl: { success: true, options: [] as Option[] } as {
    success: boolean;
    options: Option[];
    message?: string;
  },
}));

vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscSelectorOptions: action({
      args: {
        level: v.string(),
        parentFilters: v.object({
          sport: v.optional(v.string()),
          year: v.optional(v.string()),
          manufacturer: v.optional(v.string()),
          setName: v.optional(v.string()),
          variantType: v.optional(v.string()),
        }),
        platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        requestId: v.optional(v.string()),
      },
      returns: v.object({
        success: v.boolean(),
        options: v.array(v.object({ value: v.string(), platformValue: v.string() })),
        message: v.optional(v.string()),
      }),
      handler: async () => mockState.bsc,
    }),
  };
});

vi.mock("./adapters/sportlots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/sportlots")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchSportLotsSelectorOptions: action({
      args: {
        level: v.string(),
        parentFilters: v.object({
          sport: v.optional(v.string()),
          year: v.optional(v.string()),
          manufacturer: v.optional(v.string()),
          setName: v.optional(v.string()),
          variantType: v.optional(v.string()),
        }),
        platformFilters: v.optional(v.record(v.string(), v.string())),
        labelContext: v.optional(v.object({ manufacturer: v.optional(v.string()) })),
        brandScope: v.optional(v.object({ setNamePrefix: v.string() })),
        requestId: v.optional(v.string()),
      },
      returns: v.object({
        success: v.boolean(),
        options: v.array(v.object({ value: v.string(), platformValue: v.string() })),
        message: v.optional(v.string()),
      }),
      handler: async () => mockState.sl,
    }),
  };
});

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo306_review",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo306_review",
  name: "Admin User",
  role: "admin",
};

const PAUSE_ENV = "NEONBINDER_PAUSED_PLATFORMS";
let savedPause: string | undefined;

/** 2026 Bowman on SportLots, labels as the real-brand adapter strips them. */
const BOWMAN_SL: Option[] = [
  { value: "Bowman", platformValue: "sl-bowman" },
  { value: "Chrome", platformValue: "sl-chrome" },
  { value: "Sapphire Edition", platformValue: "sl-sapphire" },
  { value: "Blue", platformValue: "sl-blue" },
  { value: "Gold", platformValue: "sl-gold" },
  { value: "All-America", platformValue: "sl-aa" },
  { value: "All-America Game Autos", platformValue: "sl-aa-autos" },
];
const BOWMAN_BSC: Option[] = [
  { value: "Bowman", platformValue: "bsc-bowman" },
  { value: "Bowman Chrome", platformValue: "bsc-bowman-chrome" },
  { value: "Bowman Sapphire Edition", platformValue: "bsc-bowman-sapphire" },
];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  savedPause = process.env[PAUSE_ENV];
  delete process.env[PAUSE_ENV];
  mockState.bsc = { success: true, options: BOWMAN_BSC };
  mockState.sl = { success: true, options: BOWMAN_SL };
});

afterEach(() => {
  if (savedPause === undefined) delete process.env[PAUSE_ENV];
  else process.env[PAUSE_ENV] = savedPause;
});

type T = ReturnType<typeof convexTest>;
type RowId = Id<"selectorOptions">;

async function insertRow(t: T, fields: Record<string, unknown>): Promise<RowId> {
  return t.run(async (ctx) => {
    const id = (await ctx.db.insert("selectorOptions", {
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
      ...fields,
    } as never)) as RowId;
    const parentId = fields.parentId as RowId | undefined;
    if (parentId) {
      const parent = await ctx.db.get(parentId);
      await ctx.db.patch(parentId, { children: [...(parent?.children ?? []), id] });
    }
    return id;
  });
}

/** Baseball / 2026 with ids on both sides, and brands carrying SL ids. */
async function seedYear(t: T) {
  const sportId = await insertRow(t, {
    level: "sport",
    value: "Baseball",
    platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
    platformSlotSeq: { bsc: 1, sportlots: 1 },
  });
  const yearId = await insertRow(t, {
    level: "year",
    value: "2026",
    parentId: sportId,
    platformData: { bsc: { b0: "2026" }, sportlots: { s0: "2026" } },
    platformSlotSeq: { bsc: 1, sportlots: 1 },
  });
  const bowmanId = await insertRow(t, {
    level: "manufacturer",
    value: "Bowman",
    parentId: yearId,
    metadata: { setNamePrefix: "Bowman" },
    platformData: { sportlots: { s0: "BOW" } },
    platformSlotSeq: { sportlots: 1 },
    teamIds: undefined,
  });
  const toppsId = await insertRow(t, {
    level: "manufacturer",
    value: "Topps",
    parentId: yearId,
    metadata: { setNamePrefix: "Topps" },
    platformData: { sportlots: { s0: "TOP" } },
    platformSlotSeq: { sportlots: 1 },
  });
  return { sportId, yearId, bowmanId, toppsId };
}

/**
 * Bowman's flagship (holding a BSC id) with Base / Insert / Parallel types
 * as a variant-type sync writes them — flagged roles beside tagged slots —
 * plus one named type with no role. And an SL-only set with no BSC id.
 */
async function seedBowmanSets(t: T, bowmanId: RowId) {
  const flagshipId = await insertRow(t, {
    level: "setName",
    value: "Bowman",
    parentId: bowmanId,
    platformData: { bsc: { b0: "bsc-bowman" } },
    platformSlotSeq: { bsc: 1 },
    features: { league: "MLB" },
  });
  const type = (value: string, bscId: string | undefined, metadata?: object) =>
    insertRow(t, {
      level: "variantType",
      value,
      parentId: flagshipId,
      ...(bscId
        ? {
            platformData: { bsc: { b0: bscId } },
            platformFacets: { bsc: { b0: "variant" } },
            platformSlotSeq: { bsc: 1 },
          }
        : {}),
      ...(metadata ? { metadata } : {}),
      features: { league: "MLB", set: "Bowman" },
    });
  const baseId = await type("Base", "base", { isBase: true });
  const insertTypeId = await type("Insert", "insert", { variantRole: "insert" });
  const parallelTypeId = await type("Parallel", "parallel", { variantRole: "parallel" });
  const promoTypeId = await type("Promo", "promo");
  const slOnlySetId = await insertRow(t, {
    level: "setName",
    value: "Bowman Prospects Lite",
    parentId: bowmanId,
  });
  const slOnlyTypeId = await insertRow(t, {
    level: "variantType",
    value: "Parallel",
    parentId: slOnlySetId,
    metadata: { variantRole: "parallel" },
  });
  return {
    flagshipId,
    baseId,
    insertTypeId,
    parallelTypeId,
    promoTypeId,
    slOnlySetId,
    slOnlyTypeId,
  };
}

async function seedReviewDoc(
  t: T,
  yearId: RowId,
  manufacturerId: RowId,
  entries: Array<{ slId: string; label: string }>,
  extra: Partial<Doc<"slSetReviews">> = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("slSetReviews", {
      yearId,
      manufacturerId,
      entries,
      classifiedAt: 1_700_000_000_000,
      ...extra,
    }),
  );
}

async function reviews(t: T): Promise<Array<Doc<"slSetReviews">>> {
  return t.run(async (ctx) => ctx.db.query("slSetReviews").collect());
}

async function childrenAt(t: T, parentId: RowId, level: Doc<"selectorOptions">["level"]) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) => q.eq("level", level).eq("parentId", parentId))
      .collect(),
  );
}

const sync = (t: T, yearId: RowId, manufacturerId?: RowId) =>
  t.withIdentity(ADMIN).action(api.selectorOptions.syncSetsAcrossManufacturers, {
    yearId,
    ...(manufacturerId ? { manufacturerId } : {}),
  });

const save = (
  t: T,
  manufacturerId: RowId,
  decisions: Array<{ slId: string; variantTypeId?: RowId }>,
) =>
  t.withIdentity(ADMIN).action(api.slSetReview.applySlSetReview, {
    manufacturerId,
    decisions,
  });

// ───────────────────────────────────────────────────────────────────────────
// Sync Sets writes the review
// ───────────────────────────────────────────────────────────────────────────

describe("Sync Sets writes the SportLots-only names into the brand's review", () => {
  test("2026 Bowman: the colours are NOT sets — they wait in Bowman's review with every other SportLots-only name", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    mockState.sl = { success: true, options: BOWMAN_SL };

    const result = await sync(t, yearId, bowmanId);

    expect(result.success).toBe(true);
    // BSC's three sets, and nothing minted from SportLots.
    expect((await childrenAt(t, bowmanId, "setName")).map((r) => r.value).sort()).toEqual([
      "Bowman",
      "Bowman Chrome",
      "Bowman Sapphire Edition",
    ]);
    const docs = await reviews(t);
    expect(docs).toHaveLength(1);
    expect(docs[0].yearId).toBe(yearId);
    expect(docs[0].manufacturerId).toBe(bowmanId);
    // Flattened, sorted by folded label.
    expect(docs[0].entries).toEqual([
      { slId: "sl-aa", label: "All-America" },
      { slId: "sl-aa-autos", label: "All-America Game Autos" },
      { slId: "sl-blue", label: "Blue" },
      { slId: "sl-gold", label: "Gold" },
    ]);
    expect(result.slPendingReview).toBe(4);
    expect(result.message).toContain("4 SportLots sets to sort");
  });

  test("a single-brand sync replaces ONLY that brand's doc; another brand's review is untouched", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId, toppsId } = await seedYear(t);
    const toppsDocId = await seedReviewDoc(t, yearId, toppsId, [
      { slId: "sl-heritage", label: "Heritage" },
    ], { saveStartedAt: 5 });
    const before = await t.run(async (ctx) => ctx.db.get(toppsDocId));

    await sync(t, yearId, bowmanId);

    expect(await t.run(async (ctx) => ctx.db.get(toppsDocId))).toEqual(before);
    expect((await reviews(t)).map((d) => d.manufacturerId).sort()).toEqual(
      [bowmanId, toppsId].sort(),
    );
  });

  test("SportLots paused: the phase does not run and no doc is written", async () => {
    process.env[PAUSE_ENV] = "sportlots";
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);

    const result = await sync(t, yearId, bowmanId);

    expect(result.pausedSides).toContain("sportlots");
    expect(await reviews(t)).toEqual([]);
  });

  test("a failed SportLots list keeps the brand's previous review exactly as it was", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    const docId = await seedReviewDoc(t, yearId, bowmanId, [{ slId: "sl-old", label: "Old" }]);
    const before = await t.run(async (ctx) => ctx.db.get(docId));
    mockState.sl = { success: false, options: [], message: "down" };

    await sync(t, yearId, bowmanId);

    expect(await t.run(async (ctx) => ctx.db.get(docId))).toEqual(before);
  });

  test("an unchanged list writes nothing; a changed one replaces the entries and clears saveStartedAt", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    await sync(t, yearId, bowmanId);
    const [first] = await reviews(t);
    // A half-finished save on the unchanged list survives the re-sync.
    await t.run(async (ctx) => ctx.db.patch(first._id, { saveStartedAt: 42 }));
    const marked = await t.run(async (ctx) => ctx.db.get(first._id));

    await sync(t, yearId, bowmanId);
    expect(await t.run(async (ctx) => ctx.db.get(first._id))).toEqual(marked);

    mockState.sl = {
      success: true,
      options: BOWMAN_SL.filter((o) => o.platformValue !== "sl-gold"),
    };
    await sync(t, yearId, bowmanId);
    const [after] = await reviews(t);
    expect(after.entries.map((e) => e.slId)).not.toContain("sl-gold");
    expect(after.saveStartedAt).toBeUndefined();
  });

  test("a brand whose every name is covered loses its review doc", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    await seedReviewDoc(t, yearId, bowmanId, [{ slId: "sl-old", label: "Old" }]);
    mockState.sl = { success: true, options: BOWMAN_SL.slice(0, 3) }; // all variants of known sets

    await sync(t, yearId, bowmanId);

    expect(await reviews(t)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The reads
// ───────────────────────────────────────────────────────────────────────────

describe("the dialog's reads", () => {
  test("getSlSetReview: entries, the BSC-holding sets for 'Variant of', and a read-time suggestion", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    const ids = await seedBowmanSets(t, bowmanId);
    const chromeId = await insertRow(t, {
      level: "setName",
      value: "Bowman Chrome",
      parentId: bowmanId,
      platformData: { bsc: { b0: "bsc-bowman-chrome" } },
    });
    await seedReviewDoc(t, yearId, bowmanId, [
      { slId: "sl-aa", label: "All-America" },
      { slId: "sl-chrome-blue", label: "Chrome Blue" },
      { slId: "sl-gold", label: "Gold" },
    ], { rootsTruncated: 3 });

    const review = await t
      .withIdentity(ADMIN)
      .query(api.slSetReview.getSlSetReview, { manufacturerId: bowmanId });

    expect(review?.brandValue).toBe("Bowman");
    expect(review?.moreNextSync).toBe(3);
    expect(review?.partial).toBe(false);
    // The SportLots-only set (no BSC id) is not a target.
    expect(review?.ofSets.map((s) => s.value)).toEqual(["Bowman", "Bowman Chrome"]);
    expect(review?.ofSets.map((s) => s._id)).not.toContain(ids.slOnlySetId);
    // Longest whole-word prefix of the NB name ("Bowman Chrome Blue").
    expect(review?.entries).toEqual([
      { slId: "sl-aa", label: "All-America", suggestedOfSetId: ids.flagshipId },
      { slId: "sl-chrome-blue", label: "Chrome Blue", suggestedOfSetId: chromeId },
      { slId: "sl-gold", label: "Gold", suggestedOfSetId: ids.flagshipId },
    ]);

    const summary = await t
      .withIdentity(ADMIN)
      .query(api.slSetReview.getSlSetReviewSummary, { manufacturerId: bowmanId });
    expect(summary).toEqual({ pending: 3, partial: false, moreNextSync: 3 });
  });

  test("no doc → null from both reads", async () => {
    const t = convexTest(schema, modules);
    const { bowmanId } = await seedYear(t);
    const asAdmin = t.withIdentity(ADMIN);
    expect(
      await asAdmin.query(api.slSetReview.getSlSetReview, { manufacturerId: bowmanId }),
    ).toBeNull();
    expect(
      await asAdmin.query(api.slSetReview.getSlSetReviewSummary, { manufacturerId: bowmanId }),
    ).toBeNull();
  });

  test("getVariantTypesOfSet: the set's types with their NB role, the Base excluded", async () => {
    const t = convexTest(schema, modules);
    const { bowmanId } = await seedYear(t);
    const ids = await seedBowmanSets(t, bowmanId);

    const types = await t
      .withIdentity(ADMIN)
      .query(api.slSetReview.getVariantTypesOfSet, { setId: ids.flagshipId });

    expect(types).toEqual([
      { _id: ids.insertTypeId, value: "Insert", role: "insert" },
      { _id: ids.parallelTypeId, value: "Parallel", role: "parallel" },
      { _id: ids.promoTypeId, value: "Promo" },
    ]);
  });

  test("rowNameUnderSet: the target set's name comes off the front; otherwise the label stands", () => {
    expect(rowNameUnderSet("Gold", "Bowman", "Bowman")).toBe("Gold");
    expect(rowNameUnderSet("All-America Game Autos", "Bowman", "Bowman")).toBe(
      "All-America Game Autos",
    );
    expect(rowNameUnderSet("Chrome Blue Refractor", "Bowman", "Bowman Chrome")).toBe(
      "Blue Refractor",
    );
    // A name that does not start with the set's keeps SportLots' label.
    expect(rowNameUnderSet("Heritage", "Topps", "Bowman")).toBe("Heritage");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The save
// ───────────────────────────────────────────────────────────────────────────

describe("applySlSetReview — validation by id writes nothing on a refusal", () => {
  async function refusalSeed(t: T) {
    const seeded = await seedYear(t);
    const ids = await seedBowmanSets(t, seeded.bowmanId);
    const toppsSetId = await insertRow(t, {
      level: "setName",
      value: "Topps",
      parentId: seeded.toppsId,
      platformData: { bsc: { b0: "bsc-topps" } },
    });
    const toppsTypeId = await insertRow(t, {
      level: "variantType",
      value: "Parallel",
      parentId: toppsSetId,
      metadata: { variantRole: "parallel" },
    });
    await seedReviewDoc(t, seeded.yearId, seeded.bowmanId, [
      { slId: "sl-gold", label: "Gold" },
      { slId: "sl-blue", label: "Blue" },
    ]);
    return { ...seeded, ...ids, toppsTypeId };
  }

  test.each([
    ["the Base", (ids: Awaited<ReturnType<typeof refusalSeed>>) => ids.baseId, /Base/],
    [
      "another brand's set's type",
      (ids: Awaited<ReturnType<typeof refusalSeed>>) => ids.toppsTypeId,
      /isn't under one of this brand's sets/,
    ],
    [
      "a type under a set with no BSC id",
      (ids: Awaited<ReturnType<typeof refusalSeed>>) => ids.slOnlyTypeId,
      /isn't linked to BuySportsCards/,
    ],
    [
      "a row that is not a variant type",
      (ids: Awaited<ReturnType<typeof refusalSeed>>) => ids.flagshipId,
      /isn't a variant type/,
    ],
  ])("%s is refused before any write", async (_name, pick, message) => {
    const t = convexTest(schema, modules);
    const ids = await refusalSeed(t);
    const before = await t.run(async (ctx) => ({
      rows: await ctx.db.query("selectorOptions").collect(),
      docs: await ctx.db.query("slSetReviews").collect(),
    }));

    await expect(
      save(t, ids.bowmanId, [
        { slId: "sl-blue" },
        { slId: "sl-gold", variantTypeId: pick(ids) },
      ]),
    ).rejects.toThrow(message);

    expect(
      await t.run(async (ctx) => ({
        rows: await ctx.db.query("selectorOptions").collect(),
        docs: await ctx.db.query("slSetReviews").collect(),
      })),
    ).toEqual(before);
  });

  test("more than 200 decisions are refused", async () => {
    const t = convexTest(schema, modules);
    const ids = await refusalSeed(t);
    await expect(
      save(
        t,
        ids.bowmanId,
        Array.from({ length: 201 }, (_, i) => ({ slId: `sl-${i}` })),
      ),
    ).rejects.toThrow(/at most 200/);
  });

  test("an slId the review does not hold is skipped and counted — never written", async () => {
    const t = convexTest(schema, modules);
    const ids = await refusalSeed(t);

    const result = await save(t, ids.bowmanId, [
      { slId: "sl-forged", variantTypeId: ids.parallelTypeId },
      { slId: "sl-forged-set" },
    ]);

    expect(result.skippedByReason.notInReview).toBe(2);
    expect(result.sets).toBe(0);
    expect(await childrenAt(t, ids.parallelTypeId, "insert")).toEqual([]);
    const listed = await t.query(internal.selectorOptions.listBrandSubtreeSlIds, {
      manufacturerId: ids.bowmanId,
    });
    expect(listed.ids).not.toContain("sl-forged");
    expect(listed.ids).not.toContain("sl-forged-set");
  });
});

describe("applySlSetReview — every landing", () => {
  test("own set, under a Parallel-role type, an Insert-role type and a named type with no role — flags, features, teams, children, links; the doc goes when done", async () => {
    const t = convexTest(schema, modules);
    const { sportId, yearId, bowmanId } = await seedYear(t);
    const ids = await seedBowmanSets(t, bowmanId);
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        nameNormalized: "padres",
        sportId,
        lastUpdated: 1,
      }),
    );
    await t.run(async (ctx) => ctx.db.patch(ids.parallelTypeId, { teamIds: [teamId] }));
    await seedReviewDoc(t, yearId, bowmanId, [
      { slId: "sl-aa", label: "All-America" },
      { slId: "sl-aa-autos", label: "All-America Game Autos" },
      { slId: "sl-gold", label: "Gold" },
      { slId: "sl-promo", label: "Promo Night" },
    ]);
    const bscBefore = await t.run(async (ctx) =>
      Promise.all(
        [ids.flagshipId, ids.insertTypeId, ids.parallelTypeId, ids.promoTypeId].map(async (id) => {
          const row = await ctx.db.get(id);
          return { platformData: row?.platformData, platformFacets: row?.platformFacets };
        }),
      ),
    );

    const result = await save(t, bowmanId, [
      { slId: "sl-aa" },
      { slId: "sl-aa-autos", variantTypeId: ids.insertTypeId },
      { slId: "sl-gold", variantTypeId: ids.parallelTypeId },
      { slId: "sl-promo", variantTypeId: ids.promoTypeId },
    ]);

    expect(result).toEqual({
      sets: 1,
      underType: { insert: 1, parallel: 1, none: 1 },
      skipped: 0,
      skippedByReason: {
        notInReview: 0,
        alreadyLinked: 0,
        nameTaken: 0,
        existsElsewhere: 0,
        invalid: 0,
      },
      knownBrandsAdded: 0,
      remaining: 0,
      incomplete: false,
    });

    // Own set: set + Base carrying the SportLots id.
    const aa = (await childrenAt(t, bowmanId, "setName")).find(
      (r) => r.value === "Bowman All-America",
    )!;
    const [aaBase] = await childrenAt(t, aa._id, "variantType");
    expect(aaBase.platformData).toEqual({ sportlots: { s0: "sl-aa" } });

    // Under the Parallel type: "Gold" (the set's name off the front),
    // isParallel, cardType Parallel, the type's features and teams, the link.
    const [gold] = await childrenAt(t, ids.parallelTypeId, "insert");
    expect(gold.value).toBe("Gold");
    expect(gold.metadata).toEqual({ isParallel: true });
    expect(gold.features).toMatchObject({ league: "MLB", set: "Bowman", cardType: "Parallel" });
    expect(gold.teamIds).toEqual([teamId]);
    expect(gold.platformData).toEqual({ sportlots: { s0: "sl-gold" } });
    expect(gold.platformLabels).toEqual({ sportlots: { s0: "Gold" } });
    expect(gold.createdByUserId).toBe(ADMIN.subject);
    expect((await t.run(async (ctx) => ctx.db.get(ids.parallelTypeId)))!.children).toEqual([
      gold._id,
    ]);

    // Under the Insert type: isInsert, cardType Insert.
    const [autos] = await childrenAt(t, ids.insertTypeId, "insert");
    expect(autos.value).toBe("All-America Game Autos");
    expect(autos.metadata).toEqual({ isInsert: true });
    expect(autos.features?.cardType).toBe("Insert");

    // Under a named type with no role: no flag, the level-only cardType.
    const [promo] = await childrenAt(t, ids.promoTypeId, "insert");
    expect(promo.metadata).toBeUndefined();
    expect(promo.features?.cardType).toBe("Insert");

    // The BSC slots of every touched row deep-equal their pre-save snapshot.
    const bscAfter = await t.run(async (ctx) =>
      Promise.all(
        [ids.flagshipId, ids.insertTypeId, ids.parallelTypeId, ids.promoTypeId].map(async (id) => {
          const row = await ctx.db.get(id);
          return { platformData: row?.platformData, platformFacets: row?.platformFacets };
        }),
      ),
    );
    expect(bscAfter).toEqual(bscBefore);

    // Every saved id is covered now — the next sync will not offer it.
    const covered = await t.query(internal.selectorOptions.listBrandSubtreeSlIds, {
      manufacturerId: bowmanId,
    });
    expect(covered.ids).toEqual(
      expect.arrayContaining(["sl-aa", "sl-aa-autos", "sl-gold", "sl-promo"]),
    );
    expect(await reviews(t)).toEqual([]);
  });

  test("after a save, the next Sync Sets offers none of the saved names", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    await sync(t, yearId, bowmanId);
    const flagship = (await childrenAt(t, bowmanId, "setName")).find(
      (r) => r.value === "Bowman",
    )!;
    const parallelTypeId = await insertRow(t, {
      level: "variantType",
      value: "Parallel",
      parentId: flagship._id,
      metadata: { variantRole: "parallel" },
    });
    await save(t, bowmanId, [
      { slId: "sl-blue", variantTypeId: parallelTypeId },
      { slId: "sl-gold", variantTypeId: parallelTypeId },
    ]);

    await sync(t, yearId, bowmanId);

    const [doc] = await reviews(t);
    expect(doc.entries.map((e) => e.slId)).toEqual(["sl-aa", "sl-aa-autos"]);
  });

  test("a same-key sibling under the type is skipped and counted, never merged by name", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    const ids = await seedBowmanSets(t, bowmanId);
    const existingId = await insertRow(t, {
      level: "insert",
      value: "gold",
      parentId: ids.parallelTypeId,
      platformData: { bsc: { b0: "bsc-gold" } },
      platformSlotSeq: { bsc: 1 },
    });
    const existingBefore = await t.run(async (ctx) => ctx.db.get(existingId));
    await seedReviewDoc(t, yearId, bowmanId, [{ slId: "sl-gold", label: "Gold" }]);

    const result = await save(t, bowmanId, [
      { slId: "sl-gold", variantTypeId: ids.parallelTypeId },
    ]);

    expect(result.skippedByReason.nameTaken).toBe(1);
    expect(result.underType.parallel).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.get(existingId))).toEqual(existingBefore);
    expect(await childrenAt(t, ids.parallelTypeId, "insert")).toHaveLength(1);
    // Decided: it leaves the review (the next sync offers it again).
    expect(await reviews(t)).toEqual([]);
  });

  test("an id already linked under the brand is skipped as already linked and leaves the review", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    const ids = await seedBowmanSets(t, bowmanId);
    await insertRow(t, {
      level: "insert",
      value: "Gold Refractor",
      parentId: ids.insertTypeId,
      platformData: { sportlots: { s0: "sl-gold" } },
      platformSlotSeq: { sportlots: 1 },
    });
    await seedReviewDoc(t, yearId, bowmanId, [
      { slId: "sl-gold", label: "Gold" },
      { slId: "sl-blue", label: "Blue" },
    ]);

    const result = await save(t, bowmanId, [
      { slId: "sl-gold", variantTypeId: ids.parallelTypeId },
    ]);

    expect(result.skippedByReason.alreadyLinked).toBe(1);
    expect(await childrenAt(t, ids.parallelTypeId, "insert")).toEqual([]);
    const [doc] = await reviews(t);
    expect(doc.entries.map((e) => e.slId)).toEqual(["sl-blue"]);
    // A save that left entries behind is a partial save for the pill.
    expect(result.remaining).toBe(1);
    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.slSetReview.getSlSetReviewSummary, { manufacturerId: bowmanId }),
    ).toEqual({ pending: 1, partial: true, moreNextSync: 0 });
  });

  test("Unknown's review: a name matching a known brand is filed as a set under that brand (NEO-294 split)", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedYear(t);
    const unknownId = await insertRow(t, {
      level: "manufacturer",
      value: "Unknown",
      parentId: yearId,
      metadata: { isBrandUnknown: true },
      platformData: { sportlots: { s0: "All Brands" } },
    });
    await seedReviewDoc(t, yearId, unknownId, [
      { slId: "901", label: "Pucko Swedish Elite League" },
      { slId: "902", label: "Roanoke Express ECHL" },
    ]);

    const result = await save(t, unknownId, [{ slId: "901" }, { slId: "902" }]);

    expect(result.knownBrandsAdded).toBe(1);
    expect(result.sets).toBe(2);
    const brands = await childrenAt(t, yearId, "manufacturer");
    const pucko = brands.find((b) => b.value === "Pucko")!;
    expect((await childrenAt(t, pucko._id, "setName")).map((r) => r.value)).toEqual([
      "Pucko Swedish Elite League",
    ]);
    expect((await childrenAt(t, unknownId, "setName")).map((r) => r.value)).toEqual([
      "Roanoke Express ECHL",
    ]);
    expect(await reviews(t)).toEqual([]);
  });
});

describe("applySlSetReview — a save resumed after a thrown chunk", () => {
  test("the first chunk commits and leaves the review; the second throws; save again finishes with no duplicate", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    const ids = await seedBowmanSets(t, bowmanId);
    const entries = Array.from({ length: 45 }, (_, i) => ({
      slId: `sl-${String(i).padStart(2, "0")}`,
      label: `Colour ${String(i).padStart(2, "0")}`,
    }));
    await seedReviewDoc(t, yearId, bowmanId, entries);
    const decisions = entries.map((e) => ({ slId: e.slId, variantTypeId: ids.parallelTypeId }));

    const rowsUnderType = getFunctionName(internal.slSetReview.createSlRowsUnderVariantType);
    let rowCalls = 0;
    // The two action capabilities the save uses, over the real test backend,
    // with the SECOND phase-2 chunk failing as a transaction would.
    type Ctx = Parameters<typeof applySlSetReviewImpl>[0];
    const flaky: Ctx = {
      runQuery: ((ref: FunctionReference<"query">, args: Record<string, unknown>) =>
        t.query(ref, args)) as Ctx["runQuery"],
      runMutation: (async (
        ref: FunctionReference<"mutation">,
        args: Record<string, unknown>,
      ) => {
        if (getFunctionName(ref) === rowsUnderType && ++rowCalls === 2) {
          throw new Error("transaction failed");
        }
        return t.mutation(ref, args);
      }) as Ctx["runMutation"],
    };

    const first = await applySlSetReviewImpl(flaky, ADMIN.subject, {
      manufacturerId: bowmanId,
      decisions,
    });

    expect(first.incomplete).toBe(true);
    expect(first.underType.parallel).toBe(40);
    expect(first.remaining).toBe(5);
    expect(await childrenAt(t, ids.parallelTypeId, "insert")).toHaveLength(40);
    const [partial] = await reviews(t);
    expect(partial.entries).toHaveLength(5);
    expect(partial.saveStartedAt).toBeDefined();
    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.slSetReview.getSlSetReviewSummary, { manufacturerId: bowmanId }),
    ).toEqual({ pending: 5, partial: true, moreNextSync: 0 });

    // "Save again" re-sends the same decisions.
    const second = await save(t, bowmanId, decisions);

    expect(second.incomplete).toBe(false);
    expect(second.underType.parallel).toBe(5);
    expect(second.skippedByReason.notInReview).toBe(40);
    const rows = await childrenAt(t, ids.parallelTypeId, "insert");
    expect(rows).toHaveLength(45);
    expect(new Set(rows.map((r) => r.value)).size).toBe(45);
    const typeRow = await t.run(async (ctx) => ctx.db.get(ids.parallelTypeId));
    expect(new Set(typeRow!.children).size).toBe(45);
    expect(await reviews(t)).toEqual([]);
  });
});
