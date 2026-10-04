/**
 * NEO-321 — building the base set's parallels from the Base's NB checklist,
 * through `getParallelsForBuild` / `buildParallelChecklist` /
 * `insertParallelCardsPage`.
 *
 * Same mocking style as `parallelChecklistBuild.test.ts`: both marketplace
 * adapters are replaced wholesale with test-controlled actions.
 *
 * Tree: sport → year → setName(Topps Chrome) ─┬─ variantType "Base" (isBase)
 *                                             └─ variantType "Parallel"
 *                                                (variantRole "parallel")
 *                                                 └─ insert "Gold Wave"
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import {
  BLOCKED_MANY_BASES,
  BLOCKED_NO_BASE,
  BLOCKED_NO_IDS,
  blockedSourceHasNoCards,
  pickBaseVariantType,
  snapshotForCopies,
} from "./parallelChecklistBuild";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo321",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo321",
  role: "admin",
};

const SENTINEL = 1_700_000_000_000;

type StubCard = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  isVariation?: boolean;
  cardVariation?: string;
  platformRef: string;
};

const bscState = vi.hoisted(() => ({
  cards: [] as StubCard[],
  calls: [] as Array<Record<string, string[]>>,
}));
vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        facetFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        sourceFacet: v.optional(v.string()),
      },
      returns: v.any(),
      handler: async (_ctx, args) => {
        bscState.calls.push(args.facetFilters ?? {});
        return { success: true, cards: bscState.cards };
      },
    }),
  };
});

const slState = vi.hoisted(() => ({
  bySlId: {} as Record<string, StubCard[]>,
  calls: [] as string[],
}));
vi.mock("./adapters/sportlots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/sportlots")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchSportLotsChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.string())),
      },
      returns: v.any(),
      handler: async (_ctx, args) => {
        const slId = args.platformFilters?.parallel ?? "";
        slState.calls.push(slId);
        return { success: true, cards: slState.bySlId[slId] ?? [] };
      },
    }),
  };
});

beforeEach(() => {
  bscState.cards = [];
  bscState.calls = [];
  slState.bySlId = {};
  slState.calls = [];
});

type T = ReturnType<typeof convexTest>;
type Row = Partial<Doc<"selectorOptions">>;

async function seedSet(
  t: T,
  opts: { base?: Row | null; parallelType?: Row; gold?: Row } = {},
) {
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      parentId: sport,
      platformData: { bsc: { b0: "2024" }, sportlots: { s0: "2024" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const setName = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps Chrome",
      parentId: year,
      platformData: { bsc: { b0: "topps-chrome" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const base =
      opts.base === null
        ? undefined
        : await ctx.db.insert("selectorOptions", {
            level: "variantType",
            value: "Base",
            parentId: setName,
            platformData: { bsc: { b0: "base" } },
            platformFacets: { bsc: { b0: "variant" } },
            metadata: { isBase: true },
            features: { cardType: "Base", parallelName: "Base" },
            children: [],
            lastUpdated: SENTINEL,
            ...opts.base,
          });
    const parallelType = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Parallel",
      parentId: setName,
      // Ids the Parallel TYPE holds — the scope above a base parallel, never
      // its own source.
      platformData: { bsc: { b0: "parallel" } },
      platformFacets: { bsc: { b0: "variant" } },
      metadata: { variantRole: "parallel" },
      children: [],
      lastUpdated: SENTINEL,
      ...opts.parallelType,
    });
    const gold = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Gold Wave",
      parentId: parallelType,
      platformData: { bsc: { b0: "gold-wave" }, sportlots: { s0: "SL-GOLD" } },
      platformFacets: { bsc: { b0: "variantName" } },
      metadata: { isParallel: true },
      features: { cardType: "Parallel", parallelName: "Base" },
      children: [],
      lastUpdated: SENTINEL,
      ...opts.gold,
    });
    await ctx.db.patch(parallelType, { children: [gold] });
    return { sport, year, setName, base, parallelType, gold };
  });
}

async function addCard(
  t: T,
  selectorOptionId: Id<"selectorOptions">,
  card: Partial<Doc<"cardChecklist">> & { cardNumber: string; cardName: string },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      platformData: {},
      sortOrder: 0,
      lastUpdated: SENTINEL,
      ...card,
    }),
  );
}

const cardsOn = (t: T, selectorOptionId: Id<"selectorOptions">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", selectorOptionId))
      .collect(),
  );

describe("pickBaseVariantType — the NB flag, never the name", () => {
  test("exactly one isBase row is the Base, whatever it is called", () => {
    const rows = [
      { value: "Base", metadata: {} },
      { value: "Flagship", metadata: { isBase: true } },
    ];
    expect(pickBaseVariantType(rows)).toEqual({ base: rows[1] });
  });
  test("none → no Base yet; two → more than one", () => {
    expect(pickBaseVariantType([{ metadata: {} }])).toEqual({ blockedReason: BLOCKED_NO_BASE });
    expect(
      pickBaseVariantType([{ metadata: { isBase: true } }, { metadata: { isBase: true } }]),
    ).toEqual({ blockedReason: BLOCKED_MANY_BASES });
  });
});

describe("snapshotForCopies — risk 2, a legacy cardType: Insert", () => {
  const parallelRole = { metadata: { variantRole: "parallel" as const } };
  test("a base parallel born 'Insert' copies as 'Parallel'", () => {
    const out = snapshotForCopies(
      { level: "insert", value: "Gold Wave", features: { cardType: "Insert", era: "Modern" } },
      parallelRole,
    );
    expect(out).toEqual({ cardType: "Parallel", era: "Modern" });
  });
  test("a real insert (insert-role parent) keeps 'Insert'; absent stays absent", () => {
    const insertRole = { metadata: { variantRole: "insert" as const } };
    expect(
      snapshotForCopies({ level: "insert", value: "Anime", features: { cardType: "Insert" } }, insertRole),
    ).toEqual({ cardType: "Insert" });
    expect(
      snapshotForCopies({ level: "insert", value: "Gold", features: { era: "Modern" } }, parallelRole),
    ).toEqual({ era: "Modern" });
  });
  test("an operator's value that is not the level-only reading is left alone", () => {
    expect(
      snapshotForCopies({ level: "insert", value: "Gold", features: { cardType: "Base" } }, parallelRole),
    ).toEqual({ cardType: "Base" });
  });
});

describe("getParallelsForBuild — standing on the Parallel variant type", () => {
  test("the source is the set's Base, and its base parallels are listed", async () => {
    const t = convexTest(schema, modules);
    const { base, parallelType, gold } = await seedSet(t);
    await addCard(t, base!, { cardNumber: "1", cardName: "Aaron Judge" });

    const result = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { sourceId: parallelType });

    expect(result.source).toEqual({ id: base, value: "Base", kind: "base", hasCards: true });
    expect(result.sourceBlocked).toBeUndefined();
    expect(result.truncated).toBe(false);
    expect(result.parallels).toEqual([
      { _id: gold, value: "Gold Wave", sides: { bsc: true, sportlots: true }, hasCards: false },
    ]);
  });

  test("an insert reports itself as the source, hasCards false when it has none", async () => {
    const t = convexTest(schema, modules);
    const { gold } = await seedSet(t);
    const result = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { sourceId: gold });
    expect(result.source).toEqual({ id: gold, value: "Gold Wave", kind: "insert", hasCards: false });
  });

  test("no Base: no source, sourceBlocked says so, the parallels still list", async () => {
    const t = convexTest(schema, modules);
    const { parallelType } = await seedSet(t, { base: null });
    const result = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { sourceId: parallelType });
    expect(result.source).toBeUndefined();
    expect(result.sourceBlocked).toBe(BLOCKED_NO_BASE);
    expect(result.parallels).toHaveLength(1);
  });

  test("the Base is found by its flag after both rows are renamed", async () => {
    const t = convexTest(schema, modules);
    const { base, parallelType } = await seedSet(t, {
      base: { value: "Flagship" },
      parallelType: { value: "Base" },
    });
    const result = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { sourceId: parallelType });
    expect(result.source?.id).toBe(base);
    expect(result.source?.value).toBe("Flagship");
  });

  test("a variant type with no parallel role answers an empty list", async () => {
    const t = convexTest(schema, modules);
    const { base } = await seedSet(t);
    const result = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { sourceId: base! });
    expect(result).toEqual({ parallels: [], truncated: false });
  });
});

describe("buildParallelChecklist — a base parallel", () => {
  test("copies the Base's cards, re-linked to the parallel's own cards, prefix from the Base's chain", async () => {
    const t = convexTest(schema, modules);
    const { base, gold } = await seedSet(t, {
      base: { metadata: { isBase: true, cardNumberPrefix: "B-" } },
      // A prefix on the Parallel type must NOT be read as the Base's.
      parallelType: { metadata: { variantRole: "parallel", cardNumberPrefix: "P-" } },
      gold: { metadata: { isParallel: true, cardNumberPrefix: "G-" } },
    });
    const sourceCard = await addCard(t, base!, {
      cardNumber: "B-7",
      cardName: "Aaron Judge",
      features: { cardType: "Base", parallelName: "Base", autographed: "On Card" },
    });
    bscState.cards = [{ cardNumber: "G-7", cardName: "Aaron Judge", platformRef: "bsc-gold-7" }];
    slState.bySlId["SL-GOLD"] = [{ cardNumber: "G-7", cardName: "Aaron Judge", platformRef: "sl-gold-7" }];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });

    expect(result.status).toBe("built");
    expect(result.copied).toBe(1);
    expect(result.sidesFetched).toEqual(["bsc", "sportlots"]);
    // The parallel's own ids scope the request; the Parallel type's id is
    // the variant facet above it, never the Base's.
    expect(bscState.calls[0].variantName).toEqual(["gold-wave"]);
    expect(bscState.calls[0].variant).toEqual(["parallel"]);
    expect(slState.calls).toEqual(["SL-GOLD"]);

    const [copy] = await cardsOn(t, gold);
    expect(copy.cardNumber).toBe("B-7");
    expect(copy.platformData?.bsc?.ref).toBe("bsc-gold-7");
    expect(copy.platformData?.sportlots?.ref).toBe("sl-gold-7");
    // The card-level fact survives; the parallel wins on what it IS.
    expect(copy.features?.cardType).toBe("Parallel");
    expect(copy.features?.autographed).toBe("On Card");
    // The Base's own card is untouched.
    const [still] = await cardsOn(t, base!);
    expect(still._id).toBe(sourceCard);
    expect(still.platformData).toEqual({});
  });

  test("a legacy base parallel snapshot saying 'Insert' does not reach the copies", async () => {
    const t = convexTest(schema, modules);
    const { base, gold } = await seedSet(t, {
      gold: { metadata: undefined, features: { cardType: "Insert" } },
    });
    await addCard(t, base!, { cardNumber: "1", cardName: "Aaron Judge" });
    bscState.cards = [{ cardNumber: "1", cardName: "Aaron Judge", platformRef: "bsc-1" }];

    await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });

    const [copy] = await cardsOn(t, gold);
    expect(copy.features?.cardType).toBe("Parallel");
  });

  test("no Base: blocked, nothing fetched, nothing written", async () => {
    const t = convexTest(schema, modules);
    const { gold } = await seedSet(t, { base: null });
    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(BLOCKED_NO_BASE);
    expect(bscState.calls).toHaveLength(0);
    expect(slState.calls).toHaveLength(0);
  });

  test("two Bases: blocked", async () => {
    const t = convexTest(schema, modules);
    const { gold, setName } = await seedSet(t);
    await t.run((ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base Two",
        parentId: setName,
        platformData: {},
        metadata: { isBase: true },
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });
    expect(result.blockedReason).toBe(BLOCKED_MANY_BASES);
    expect(bscState.calls).toHaveLength(0);
  });

  test("a Base with no cards: blocked before any fetch, and stale review state is not cleared", async () => {
    const t = convexTest(schema, modules);
    const { gold } = await seedSet(t);
    const candidate = await t.run((ctx) =>
      ctx.db.insert("checklistCandidates", {
        selectorOptionId: gold,
        batchId: "batch-1",
        createdByUserId: "user-1",
        cardNumber: "1",
        cardName: "Whoever",
        platformData: {},
        bucket: "matched",
        stem: "1",
        status: "ready",
        lastUpdated: SENTINEL,
      }),
    );
    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(blockedSourceHasNoCards("Base"));
    expect(bscState.calls).toHaveLength(0);
    expect(slState.calls).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.get(candidate))).not.toBeNull();
  });

  test("an insert with no cards blocks its parallel the same way", async () => {
    const t = convexTest(schema, modules);
    const { gold } = await seedSet(t);
    const parallel = await t.run(async (ctx) => {
      const id = await ctx.db.insert("selectorOptions", {
        level: "parallel",
        value: "Gold Wave Refractor",
        parentId: gold,
        platformData: { bsc: { b0: "gold-wave-refractor" } },
        platformFacets: { bsc: { b0: "variantName" } },
        children: [],
        lastUpdated: SENTINEL,
      });
      await ctx.db.patch(gold, { children: [id] });
      return id;
    });
    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: parallel });
    expect(result.blockedReason).toBe(blockedSourceHasNoCards("Gold Wave"));
    expect(bscState.calls).toHaveLength(0);
  });

  test("a base parallel with no ids of its own is skipped on every side — the Parallel type's ids are never inherited", async () => {
    const t = convexTest(schema, modules);
    const { base, gold } = await seedSet(t, {
      gold: { platformData: {}, platformFacets: undefined },
    });
    await addCard(t, base!, { cardNumber: "1", cardName: "Aaron Judge" });
    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });
    expect(result.blockedReason).toBe(BLOCKED_NO_IDS);
    expect(bscState.calls).toHaveLength(0);
    expect(slState.calls).toHaveLength(0);
  });

  test("an insert under an insert-role (or role-less) type is not a parallel", async () => {
    const t = convexTest(schema, modules);
    const { gold } = await seedSet(t, { parallelType: { metadata: { variantRole: "insert" } } });
    await expect(
      t
        .withIdentity(ADMIN)
        .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold }),
    ).rejects.toThrow(/isn't a parallel/);
  });
});

describe("insertParallelCardsPage — the source guard", () => {
  test("a page sent for any row but the resolved source is refused, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const { base, gold, parallelType } = await seedSet(t);
    const card = await addCard(t, base!, { cardNumber: "1", cardName: "Aaron Judge" });
    const page = (sourceId: Id<"selectorOptions">) =>
      t.run((ctx) =>
        ctx.runMutation(internal.parallelChecklistBuild.insertParallelCardsPage, {
          parallelId: gold,
          sourceId,
          copies: [
            {
              sourceCardId: card,
              expect: { cardNumber: "1", cardName: "Aaron Judge", namesOnCard: [] },
              bsc: { ref: "bsc-1" },
            },
          ],
          remap: [],
        }),
      );
    // Audit S1 — the `changed` sentinel, never a throw: by now the action
    // has deleted the old cards and must report that.
    const refused = await page(parallelType);
    expect(refused).toEqual({
      created: [],
      missing: 0,
      skippedChangedSource: 0,
      processed: 0,
      changed: true,
    });
    expect(await cardsOn(t, gold)).toHaveLength(0);

    const ok = await page(base!);
    expect(ok.changed).toBe(false);
    expect(ok.created).toHaveLength(1);
  });
});

describe("copies carry the parallel row's NB name as parallelName and in the title (NEO-321)", () => {
  test("base kind: a Base card copied onto Gold Wave is titled 'Gold Wave', never 'Base'", async () => {
    const t = convexTest(schema, modules);
    // The base parallel's snapshot inherited "Base" from the Parallel type.
    const { base, gold } = await seedSet(t);
    await addCard(t, base!, {
      cardNumber: "1",
      cardName: "Aaron Judge",
      features: { cardType: "Base", parallelName: "Base" },
    });
    await addCard(t, base!, {
      cardNumber: "1b",
      cardName: "Aaron Judge",
      cardVariation: "Image Variation",
      sortOrder: 1,
      features: { cardType: "Base", parallelName: "Image Variation" },
    });
    bscState.cards = [
      { cardNumber: "1", cardName: "Aaron Judge", platformRef: "bsc-1" },
      {
        cardNumber: "1b",
        cardName: "Aaron Judge",
        isVariation: true,
        cardVariation: "Gold Wave Image Var.",
        platformRef: "bsc-1b",
      },
    ];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });
    expect(result.copied).toBe(2);

    const copies = await cardsOn(t, gold);
    for (const copy of copies) {
      expect(copy.features?.parallelName).toBe("Gold Wave");
      expect(copy.listingTitle).toContain("Gold Wave");
    }
    const variation = copies.find((c) => c.cardVariation === "Image Variation");
    expect(variation?.listingTitle).toContain("Image Variation");
    // The marketplace's own label for the variation never reaches NB data.
    expect(JSON.stringify(copies)).not.toContain("Image Var.");
    // The Base's own cards are untouched.
    for (const card of await cardsOn(t, base!)) {
      expect(card.listingTitle ?? "").not.toContain("Gold Wave");
    }
  });

  test("insert kind: an insert card copied onto Gold Wave Refractors is titled with that name", async () => {
    const t = convexTest(schema, modules);
    const { gold } = await seedSet(t);
    const refractors = await t.run(async (ctx) => {
      const id = await ctx.db.insert("selectorOptions", {
        level: "parallel",
        value: "Gold Wave Refractors",
        parentId: gold,
        platformData: { bsc: { b0: "gold-wave-refractors" } },
        platformFacets: { bsc: { b0: "variantName" } },
        features: { cardType: "Parallel", parallelName: "Base" },
        children: [],
        lastUpdated: SENTINEL,
      });
      await ctx.db.patch(gold, { children: [id] });
      return id;
    });
    await addCard(t, gold, {
      cardNumber: "7",
      cardName: "Juan Soto",
      features: { cardType: "Parallel", parallelName: "Base" },
    });
    bscState.cards = [{ cardNumber: "7", cardName: "Juan Soto", platformRef: "bsc-7" }];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: refractors });
    expect(result.copied).toBe(1);

    const [copy] = await cardsOn(t, refractors);
    expect(copy.features?.parallelName).toBe("Gold Wave Refractors");
    expect(copy.listingTitle).toContain("Gold Wave Refractors");
  });
});
