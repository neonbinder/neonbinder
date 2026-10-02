/**
 * NEO-312 — building an insert's parallels from the insert's own checklist,
 * end to end through `getParallelsForBuild` / `buildParallelChecklist`.
 *
 * The tree shape and mocking style follow
 * `convex/fetchCardChecklist.facetSources.test.ts` and
 * `convex/applyParallelGroupings.facet.test.ts`: both marketplace adapters are
 * replaced wholesale with test-controlled actions, so these tests assert on
 * what actually gets built rather than on live marketplace HTML.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import {
  BLOCKED_CROSS_LISTED,
  BLOCKED_NO_IDS,
  BLOCKED_NOTHING_MATCHED,
  BLOCKED_SCANS,
  BLOCKED_TOO_MANY_CARDS,
  MAX_INSERT_CARDS_FOR_BUILD,
  blockedAllPaused,
  blockedSidePaused,
} from "./parallelChecklistBuild";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo312",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo312",
  role: "admin",
};

const SENTINEL = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Adapter mocks — both marketplaces are replaced wholesale, exactly the
// pattern `fetchCardChecklist.facetSources.test.ts` uses for SportLots.
// ---------------------------------------------------------------------------

type StubCard = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  isVariation?: boolean;
  cardVariation?: string;
  printRun?: number;
  platformRef: string;
  sourceBscSetSlug?: string;
};

const bscState = vi.hoisted(() => ({
  success: true,
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
        if (!bscState.success) return { success: false, cards: [] };
        return { success: true, cards: bscState.cards };
      },
    }),
  };
});

const slState = vi.hoisted(() => ({
  success: true,
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
        if (!slState.success) return { success: false, cards: [] };
        return { success: true, cards: slState.bySlId[slId] ?? [] };
      },
    }),
  };
});

beforeEach(() => {
  bscState.success = true;
  bscState.cards = [];
  bscState.calls = [];
  slState.success = true;
  slState.bySlId = {};
  slState.calls = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Fixture: sport → year → setName(Bowman) → variantType(Insert, tagged
// `variant`) → insert(Anime) → parallel(Anime Kanji). Named after the E2E
// fixture (F6 in the plan) on purpose.
// ---------------------------------------------------------------------------

type T = ReturnType<typeof convexTest>;

async function seedTree(t: T) {
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
      value: "Bowman",
      parentId: year,
      platformData: { bsc: { b0: "bowman" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const variantType = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      parentId: setName,
      platformData: { bsc: { b0: "insert" } },
      platformFacets: { bsc: { b0: "variant" } },
      metadata: { variantRole: "insert" },
      children: [],
      lastUpdated: SENTINEL,
    });
    const insert = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Anime",
      parentId: variantType,
      // Untagged — legacy insert rule buckets it to variantName. This is the
      // insert's ANCESTOR id, never sent once the parallel is fetched.
      platformData: { bsc: { b0: "anime" }, sportlots: { s0: "SL-INSERT-1" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    await ctx.db.patch(variantType, { children: [insert] });
    return { sport, year, setName, variantType, insert };
  });
}

async function seedParallel(
  t: T,
  insertId: Id<"selectorOptions">,
  overrides: Partial<Pick<Doc<"selectorOptions">, "platformData" | "platformFacets" | "value">> = {},
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "parallel",
      value: "Anime Kanji",
      parentId: insertId,
      platformData: {
        bsc: { b0: "anime-kanji" },
        sportlots: { s0: "SL-PARALLEL-1" },
      },
      platformFacets: { bsc: { b0: "variantName" } },
      children: [],
      lastUpdated: SENTINEL,
      ...overrides,
    });
    const insert = (await ctx.db.get(insertId))!;
    await ctx.db.patch(insertId, { children: [...(insert.children ?? []), id] });
    return id;
  });
}

async function insertPlayer(t: T, sportId: Id<"selectorOptions">, name: string) {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      lastUpdated: SENTINEL,
    }),
  );
}

async function insertCard(
  t: T,
  insertId: Id<"selectorOptions">,
  card: Partial<Doc<"cardChecklist">> & { cardNumber: string; cardName: string },
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId: insertId,
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

// ---------------------------------------------------------------------------

describe("getParallelsForBuild", () => {
  test("lists a parallel's own sides and whether it has cards", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Ken Griffey Jr." });

    const result = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { insertId: insert });

    expect(result.truncated).toBe(false);
    expect(result.parallels).toEqual([
      {
        _id: parallelId,
        value: "Anime Kanji",
        sides: { bsc: true, sportlots: true },
        hasCards: false,
      },
    ]);
  });

  test("a non-insert row (or one that's gone) answers an empty list, not a throw", async () => {
    const t = convexTest(schema, modules);
    const { setName } = await seedTree(t);
    const result = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { insertId: setName });
    expect(result).toEqual({ parallels: [], truncated: false });
  });

  test("a parallel with a scanned card is reported blocked", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      imageUrls: { front: "gs://bucket/front.jpg" },
    });

    const result = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { insertId: insert });
    expect(result.parallels[0].blocked).toBe(BLOCKED_SCANS);
  });

  test("a parallel with no marketplace ids of its own reports both sides false", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    await seedParallel(t, insert, { platformData: {}, platformFacets: undefined });

    const result = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { insertId: insert });
    expect(result.parallels[0].sides).toEqual({ bsc: false, sportlots: false });
  });
});

describe("buildParallelChecklist — the happy path", () => {
  test("copies a linked card, sets src to the parallel's own slot, and reports counts", async () => {
    const t = convexTest(schema, modules);
    const { sport, insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    const griffey = await insertPlayer(t, sport, "Ken Griffey Jr.");
    await insertCard(t, insert, {
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      playerIds: [griffey],
      playerLinks: [{ playerId: griffey, nameOnCard: "Ken Griffey Jr." }],
    });

    bscState.cards = [
      {
        cardNumber: "1",
        cardName: "Ken Griffey Jr.",
        players: ["Ken Griffey Jr."],
        platformRef: "bsc-ref-1",
        sourceBscSetSlug: "anime-kanji",
      },
    ];
    slState.bySlId["SL-PARALLEL-1"] = [
      {
        cardNumber: "1",
        cardName: "Ken Griffey Jr.",
        players: ["Ken Griffey Jr."],
        platformRef: "sl-ref-1",
        printRun: 99,
      },
    ];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("built");
    expect(result.copied).toBe(1);
    expect(result.notCopied).toBe(0);
    expect(result.rebuilt).toBe(false);
    expect(result.sidesFetched.sort()).toEqual(["bsc", "sportlots"]);

    const copies = await cardsOn(t, parallelId);
    expect(copies).toHaveLength(1);
    const copy = copies[0];
    expect(copy.platformData.bsc).toEqual({ ref: "bsc-ref-1", src: "b0" });
    expect(copy.platformData.sportlots).toEqual({ ref: "sl-ref-1", src: "s0" });
    // M5/M3 — the linked SportLots card is the only source of printRun.
    expect(copy.printRun).toBe(99);
    expect(copy.selectorOptionId).toBe(parallelId);
  });

  test("imageUrls is never copied onto the parallel's new row", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, {
      cardNumber: "1",
      cardName: "Team Card",
      teamOnCardIds: [],
      imageUrls: { front: "gs://bucket/front.jpg" },
    });
    bscState.cards = [
      { cardNumber: "1", cardName: "Team Card", platformRef: "bsc-1" },
    ];

    await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    const [copy] = await cardsOn(t, parallelId);
    expect(copy).not.toHaveProperty("imageUrls");
  });

  test("no enrichment is queued by a build", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Team Card" });
    bscState.cards = [{ cardNumber: "1", cardName: "Team Card", platformRef: "bsc-1" }];

    await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });

  test("a card with no link on any side is not copied (J2)", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "99", cardName: "Nobody Fetched" });
    bscState.cards = []; // nothing matches
    slState.bySlId["SL-PARALLEL-1"] = [];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("built");
    expect(result.copied).toBe(0);
    expect(result.notCopied).toBe(1);
    expect(await cardsOn(t, parallelId)).toHaveLength(0);
  });

  test("variation pairs are copied together, with variationOfCardId remapped", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    const parentId = await insertCard(t, insert, { cardNumber: "5", cardName: "Ken Griffey Jr." });
    await insertCard(t, insert, {
      cardNumber: "5b",
      cardName: "Ken Griffey Jr.",
      cardVariation: "Action",
      variationOfCardId: parentId,
    });

    bscState.cards = [
      { cardNumber: "5", cardName: "Ken Griffey Jr.", platformRef: "bsc-5" },
      {
        cardNumber: "5b",
        cardName: "Ken Griffey Jr.",
        platformRef: "bsc-5b",
        isVariation: true,
        cardVariation: "Action",
      },
    ];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });
    expect(result.copied).toBe(2);

    const copies = await cardsOn(t, parallelId);
    const newParent = copies.find((c) => c.cardNumber === "5")!;
    const newChild = copies.find((c) => c.cardNumber === "5b")!;
    expect(newChild.variationOfCardId).toBe(newParent._id);
    expect(newChild.variationOfCardId).not.toBe(parentId);
  });

  test("sides the parallel doesn't hold are skipped, and the insert's own id is never sent", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    // A parallel with a BSC id but no SportLots id of its own.
    const parallelId = await seedParallel(t, insert, {
      platformData: { bsc: { b0: "anime-kanji" } },
      platformFacets: { bsc: { b0: "variantName" } },
    });
    await insertCard(t, insert, { cardNumber: "1", cardName: "Ken Griffey Jr." });
    bscState.cards = [{ cardNumber: "1", cardName: "Ken Griffey Jr.", platformRef: "bsc-1" }];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.sidesFetched).toEqual(["bsc"]);
    expect(result.sidesSkipped).toEqual(["sportlots"]);
    expect(slState.calls).toHaveLength(0);
    // The insert's own SportLots id ("SL-INSERT-1") is never what would have
    // been asked for even if SL had been fetched.
    expect(slState.calls).not.toContain("SL-INSERT-1");
  });
});

describe("buildParallelChecklist — the insert's own ids never reach the adapter args", () => {
  test("the recorded BSC facet filters carry the PARALLEL's own tagged slot, not the insert's", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Ken Griffey Jr." });
    bscState.cards = [{ cardNumber: "1", cardName: "Ken Griffey Jr.", platformRef: "bsc-1" }];

    await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(bscState.calls).toHaveLength(1);
    // The chain judged with the insert row taken out: the parallel's own
    // `variantName` slot ("anime-kanji"), never the insert's ("anime").
    expect(bscState.calls[0].variantName).toEqual(["anime-kanji"]);
    expect(JSON.stringify(bscState.calls[0])).not.toContain("anime\"");
  });

  test("the SportLots platformFilters carry the parallel's own set id, not the insert's", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Ken Griffey Jr." });
    slState.bySlId["SL-PARALLEL-1"] = [
      { cardNumber: "1", cardName: "Ken Griffey Jr.", platformRef: "sl-1" },
    ];

    await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(slState.calls).toEqual(["SL-PARALLEL-1"]);
    expect(slState.calls).not.toContain("SL-INSERT-1");
  });
});

describe("buildParallelChecklist — SKU is kept on the same card, fresh otherwise (R2)", () => {
  test("a copy that is clearly the old card (same key, same ref) keeps the old SKU", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Ken Griffey Jr." });
    await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      platformData: { bsc: { ref: "bsc-1", src: "b0" } },
      sku: "NB-BB-KEPT-SKU",
    });
    bscState.cards = [{ cardNumber: "1", cardName: "Ken Griffey Jr.", platformRef: "bsc-1" }];

    await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    const [copy] = await cardsOn(t, parallelId);
    expect(copy.sku).toBe("NB-BB-KEPT-SKU");
  });

  test("a copy whose ref changed from the old card's gets a fresh SKU", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Ken Griffey Jr." });
    await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      platformData: { bsc: { ref: "stale-ref", src: "b0" } },
      sku: "NB-BB-OLD-SKU",
    });
    bscState.cards = [{ cardNumber: "1", cardName: "Ken Griffey Jr.", platformRef: "fresh-ref" }];

    await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    const [copy] = await cardsOn(t, parallelId);
    expect(copy.sku).not.toBe("NB-BB-OLD-SKU");
    expect(copy.sku).toBeTruthy();
  });

  test("two old cards sharing one key both lose the SKU carry — ambiguous which one a copy replaces", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Ken Griffey Jr." });
    await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      platformData: { bsc: { ref: "bsc-1", src: "b0" } },
      sku: "NB-BB-SKU-A",
    });
    await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      platformData: { bsc: { ref: "bsc-1", src: "b0" } },
      sku: "NB-BB-SKU-B",
    });
    bscState.cards = [{ cardNumber: "1", cardName: "Ken Griffey Jr.", platformRef: "bsc-1" }];

    await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    const [copy] = await cardsOn(t, parallelId);
    expect(copy.sku).not.toBe("NB-BB-SKU-A");
    expect(copy.sku).not.toBe("NB-BB-SKU-B");
  });
});

describe("buildParallelChecklist — earlierLinksMissing / stillListedNotRelinked / legacyLinksRemoved", () => {
  test("an old ref the fresh fetch still lists, but the insert card is now ambiguous there, is stillListedNotRelinked", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, {
      cardNumber: "1",
      cardName: "Team Card",
      pendingTeamNames: ["Yankees"],
    });
    await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Team Card",
      pendingTeamNames: ["Yankees"],
      platformData: { bsc: { ref: "bsc-old-ref", src: "b0" } },
    });
    // Two BSC candidates for number "1" — an unresolvable guess, so the
    // insert card stays ambiguous on BSC. Neither candidate is "bsc-old-ref",
    // so the earlier-link tiebreak (which would otherwise resolve it) never
    // sees it as a candidate; "bsc-old-ref" is still listed under an
    // unrelated number, which is what "stillListedNotRelinked" means.
    bscState.cards = [
      { cardNumber: "1", cardName: "A", platformRef: "bsc-cand-a" },
      { cardNumber: "1", cardName: "B", platformRef: "bsc-cand-b" },
      { cardNumber: "999", cardName: "Unrelated", platformRef: "bsc-old-ref" },
    ];
    slState.bySlId["SL-PARALLEL-1"] = [
      { cardNumber: "1", cardName: "Team Card", platformRef: "sl-1" },
    ];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.ambiguous.bsc).toBe(1);
    expect(result.earlierLinksMissing.bsc).toBe(0);
    expect(result.stillListedNotRelinked.bsc).toBe(1);
  });

  test("an old ref on a side the parallel no longer owns is legacyLinksRemoved, not earlierLinksMissing", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    // This parallel owns BSC only — no SportLots id of its own.
    const parallelId = await seedParallel(t, insert, {
      platformData: { bsc: { b0: "anime-kanji" } },
      platformFacets: { bsc: { b0: "variantName" } },
    });
    await insertCard(t, insert, { cardNumber: "1", cardName: "Ken Griffey Jr." });
    // The pre-NEO-312 inheritance bug: this old card carries a SportLots ref
    // even though the parallel itself never held a SportLots id.
    await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      platformData: {
        bsc: { ref: "bsc-old", src: "b0" },
        sportlots: { ref: "legacy-sl-ref", src: "s0" },
      },
    });
    bscState.cards = [{ cardNumber: "1", cardName: "Ken Griffey Jr.", platformRef: "bsc-fresh" }];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.legacyLinksRemoved.sportlots).toBe(1);
    expect(result.earlierLinksMissing.sportlots).toBe(0);
    expect(result.stillListedNotRelinked.sportlots).toBe(0);
  });
});

describe("buildParallelChecklist — capped result lists (MAX_LISTED_CARDS)", () => {
  test("extraOnMarketplace.cards and cards.leftOff are capped at 50, counts stay exact", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    // One card that copies, so the build doesn't hit BLOCKED_NOTHING_MATCHED.
    await insertCard(t, insert, { cardNumber: "1", cardName: "Copies Fine" });
    bscState.cards = [{ cardNumber: "1", cardName: "Copies Fine", platformRef: "bsc-1" }];

    // 60 insert cards that link nowhere — left off — and 60 BSC cards no
    // insert card claims — unclaimed/extra.
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: insert,
          cardNumber: `unmatched-${i}`,
          cardName: `Unmatched ${i}`,
          platformData: {},
          sortOrder: i + 1,
          lastUpdated: SENTINEL,
        });
      }
    });
    for (let i = 0; i < 60; i++) {
      bscState.cards.push({
        cardNumber: `extra-${i}`,
        cardName: `Extra ${i}`,
        platformRef: `bsc-extra-${i}`,
      });
    }

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.notCopied).toBe(60);
    expect(result.cards.leftOff).toHaveLength(50);
    expect(result.extraOnMarketplace.bsc.count).toBe(60);
    expect(result.extraOnMarketplace.bsc.cards).toHaveLength(50);
  });
});

describe("buildParallelChecklist — unreachable ids and over-cap sets are blocked", () => {
  test("an owned id that can't be reached names the missing row in the block sentence", async () => {
    const t = convexTest(schema, modules);
    const { insert, year } = await seedTree(t);
    await t.run(async (ctx) => ctx.db.patch(year, { platformData: { sportlots: { s0: "2024" } } }));
    const parallelId = await seedParallel(t, insert, {
      platformData: { bsc: { b0: "anime-kanji" } },
      platformFacets: { bsc: { b0: "variantName" } },
    });
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("2024");
    expect(result.blockedReason).toContain("linked");
  });

  test("more than 10 SportLots sets of its own blocks the build", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const manySlIds: Record<string, string> = {};
    for (let i = 0; i <= 10; i++) manySlIds[`s${i}`] = `SL-SET-${i}`;
    const parallelId = await seedParallel(t, insert, {
      platformData: { sportlots: manySlIds },
      platformFacets: undefined,
    });
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(
      "it has more than 10 SportLots sets linked, which is more than one build reads — unlink the extras first",
    );
    expect(slState.calls).toHaveLength(0);
  });

  test("more than 10 BSC fan-out combinations blocks the build", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    // Eleven distinct values under the parallel's own `variantName` facet —
    // one BSC request per value, more than MAX_BSC_FAN_OUT.
    const manyBscIds: Record<string, string> = {};
    const manyBscFacets: Record<string, string> = {};
    for (let i = 0; i <= 10; i++) {
      manyBscIds[`b${i}`] = `anime-kanji-${i}`;
      manyBscFacets[`b${i}`] = "variantName";
    }
    const parallelId = await seedParallel(t, insert, {
      platformData: { bsc: manyBscIds },
      platformFacets: { bsc: manyBscFacets },
    });
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(
      "its BSC links add up to more than 10 lookups, which is more than one build reads — unlink the extras first",
    );
    expect(bscState.calls).toHaveLength(0);
  });
});

describe("buildParallelChecklist — card-level facts carry, the parallel wins on parallel facts (hobby A4)", () => {
  test("an autograph observed on the insert card survives the copy; the parallel's own parallelName wins", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    await t.run((ctx) =>
      ctx.db.patch(insert, { features: { cardType: "Insert", autographed: "None" } }),
    );
    const parallelId = await seedParallel(t, insert, {
      value: "Anime Kanji",
      // The parallel already declares what it IS.
    });
    await t.run((ctx) =>
      ctx.db.patch(parallelId, {
        features: { cardType: "Parallel", parallelName: "Kanji" },
      }),
    );
    await insertCard(t, insert, {
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      // A fact OBSERVED on this card only — differs from the insert's own
      // snapshot ("None").
      features: { cardType: "Insert", autographed: "Yes", signedBy: "Ken Griffey Jr." },
    });
    bscState.cards = [{ cardNumber: "1", cardName: "Ken Griffey Jr.", platformRef: "bsc-1" }];

    await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    const [copy] = await cardsOn(t, parallelId);
    expect(copy.features?.autographed).toBe("Yes");
    expect(copy.features?.signedBy).toBe("Ken Griffey Jr.");
    // The parallel's own snapshot wins on what the parallel IS.
    expect(copy.features?.cardType).toBe("Parallel");
    expect(copy.features?.parallelName).toBe("Kanji");
  });
});

describe("buildParallelChecklist — rebuild (J3)", () => {
  test("rebuilding deletes the old cards, then inserts the fresh copies", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Ken Griffey Jr." });
    const oldCardId = await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      platformData: { bsc: { ref: "stale-ref", src: "b0" } },
    });
    bscState.cards = [{ cardNumber: "1", cardName: "Ken Griffey Jr.", platformRef: "fresh-ref" }];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("built");
    expect(result.rebuilt).toBe(true);
    const copies = await cardsOn(t, parallelId);
    expect(copies).toHaveLength(1);
    expect(copies[0]._id).not.toBe(oldCardId);
    expect(copies[0].platformData.bsc?.ref).toBe("fresh-ref");
  });

  test("a link the old cards held that no new copy carries is counted earlierLinksMissing", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    // The insert now has only ONE card; the parallel used to carry a second
    // ref ("orphan-ref") that the fresh build will not reproduce.
    await insertCard(t, insert, { cardNumber: "1", cardName: "Ken Griffey Jr." });
    await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      platformData: { bsc: { ref: "kept-differently", src: "b0" } },
    });
    await insertCard(t, parallelId, {
      cardNumber: "2",
      cardName: "Someone Else",
      platformData: { bsc: { ref: "orphan-ref", src: "b0" } },
    });
    bscState.cards = [{ cardNumber: "1", cardName: "Ken Griffey Jr.", platformRef: "fresh-ref" }];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    // Both old refs are missing from the fresh build: "kept-differently" is
    // not reproduced (the new copy's ref is "fresh-ref"), and "orphan-ref"
    // belonged to a card number the insert no longer has at all.
    expect(result.earlierLinksMissing.bsc).toBe(2);
  });
});

describe("buildParallelChecklist — blocks write nothing", () => {
  test("no marketplace ids of its own: blocked, nothing changes", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert, { platformData: {}, platformFacets: undefined });
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(BLOCKED_NO_IDS);
    expect(await cardsOn(t, parallelId)).toHaveLength(0);
    expect(bscState.calls).toHaveLength(0);
    expect(slState.calls).toHaveLength(0);
  });

  test("ids that can't be reached (owned but the scope above is incomplete): blocked, nothing fetched", async () => {
    const t = convexTest(schema, modules);
    const { insert, year } = await seedTree(t);
    // Break BSC's required scope: the year row loses its BSC id, so BSC is
    // unresolvable even though the parallel owns a source id of its own.
    await t.run(async (ctx) => ctx.db.patch(year, { platformData: { sportlots: { s0: "2024" } } }));
    const parallelId = await seedParallel(t, insert, {
      platformData: { bsc: { b0: "anime-kanji" } },
      platformFacets: { bsc: { b0: "variantName" } },
    });
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(bscState.calls).toHaveLength(0);
    expect(await cardsOn(t, parallelId)).toHaveLength(0);
  });

  test("a scanned card blocks the build before any marketplace is asked", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });
    await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Someone",
      imageUrls: { front: "gs://bucket/front.jpg" },
    });

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(BLOCKED_SCANS);
    expect(bscState.calls).toHaveLength(0);
    expect(slState.calls).toHaveLength(0);
    expect(await cardsOn(t, parallelId)).toHaveLength(1);
  });

  test("a cross-listed card blocks the build, and nothing is deleted", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });
    const homeCardId = await insertCard(t, parallelId, { cardNumber: "1", cardName: "Someone" });
    await t.run(async (ctx) =>
      ctx.db.insert("cardCrossListings", {
        cardChecklistId: homeCardId,
        selectorOptionId: insert,
        lastUpdated: SENTINEL,
      }),
    );
    bscState.cards = [{ cardNumber: "1", cardName: "Someone", platformRef: "bsc-1" }];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(BLOCKED_CROSS_LISTED);
    expect(await cardsOn(t, parallelId)).toHaveLength(1);
  });

  test("more than 5000 insert cards blocks the build", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await t.run(async (ctx) => {
      for (let i = 0; i <= MAX_INSERT_CARDS_FOR_BUILD; i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: insert,
          cardNumber: String(i),
          cardName: `Card ${i}`,
          platformData: {},
          sortOrder: i,
          lastUpdated: SENTINEL,
        });
      }
    });

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(BLOCKED_TOO_MANY_CARDS);
    expect(bscState.calls).toHaveLength(0);
    expect(await cardsOn(t, parallelId)).toHaveLength(0);
  }, 30_000);

  test("zero matches on a parallel that already has cards is blocked, not silently emptied", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone New" });
    await insertCard(t, parallelId, { cardNumber: "1", cardName: "Someone Old" });
    bscState.cards = []; // nothing matches on either side
    slState.bySlId["SL-PARALLEL-1"] = [];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(BLOCKED_NOTHING_MATCHED);
    // Nothing touched — the old card is exactly as it was.
    expect(await cardsOn(t, parallelId)).toHaveLength(1);
  });

  test("a failed side aborts before any delete", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });
    await insertCard(t, parallelId, { cardNumber: "1", cardName: "Someone Old" });
    bscState.success = false; // BSC fails
    slState.bySlId["SL-PARALLEL-1"] = [
      { cardNumber: "1", cardName: "Someone", platformRef: "sl-1" },
    ];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    // The old card survives untouched: the failed side aborted before the
    // delete/insert phase ever ran.
    const cards = await cardsOn(t, parallelId);
    expect(cards).toHaveLength(1);
    expect(cards[0].cardName).toBe("Someone Old");
  });

  test("a rebuild is blocked when a paused side's old cards hold links on it", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });
    await insertCard(t, parallelId, {
      cardNumber: "1",
      cardName: "Someone",
      platformData: { sportlots: { ref: "sl-old-ref", src: "s0" } },
    });
    bscState.cards = [{ cardNumber: "1", cardName: "Someone", platformRef: "bsc-1" }];
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "sportlots");

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(blockedSidePaused("sportlots"));
    expect(await cardsOn(t, parallelId)).toHaveLength(1);
  });

  test("every side paused, with the parallel owning ids on both: blockedAllPaused, nothing fetched", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "sportlots,buysportscards");

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(blockedAllPaused(["bsc", "sportlots"]));
    expect(bscState.calls).toHaveLength(0);
    expect(slState.calls).toHaveLength(0);
  });

  test("deleteParallelCardsPage refuses a page where a card changed under it, deleting nothing on that page", async () => {
    // The low-level guard `insertParallelCardsPage`'s sibling relies on:
    // every card in a page is checked BEFORE any is deleted, so a scan or
    // cross-listing that appeared since the action's own pre-flight check
    // still loses nothing on the page it is found on.
    const t = convexTest(schema, modules);
    const { insert } = await seedTree(t);
    const parallelId = await seedParallel(t, insert);
    const untouched = await insertCard(t, parallelId, { cardNumber: "1", cardName: "Fine" });
    const scanned = await insertCard(t, parallelId, {
      cardNumber: "2",
      cardName: "Scanned",
      imageUrls: { front: "gs://bucket/front.jpg" },
    });

    const page = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.deleteParallelCardsPage, {
        parallelId,
      }),
    );
    expect(page.deleted).toBe(0);
    expect(page.blockedReason).toBe(BLOCKED_SCANS);
    // Nothing on the page was deleted — not even the card that was fine.
    const remaining = await cardsOn(t, parallelId);
    expect(remaining.map((c) => c._id).sort()).toEqual([scanned, untouched].sort());
  });

  test("a scan that appears after the FIRST delete page is reported as BLOCKED_CHANGED_MID_BUILD, not the plain scan message", () => {
    // Pinned as source, in the style of the NEO-291/NEO-306 blocks in
    // `publicFunctionAuth.test.ts`: the distinction ("this parallel has
    // scans" vs "something changed while this rebuild was already under
    // way") only exists inside the action's own control flow — deletedTotal
    // is local to `buildParallelChecklist` and is not observable through any
    // return value once a rebuild has fully succeeded or fully blocked.
    const src = readFileSync(join(__dirname, "parallelChecklistBuild.ts"), "utf8");
    expect(src).toMatch(
      /deletedTotal > 0 \? BLOCKED_CHANGED_MID_BUILD : page\.blockedReason/,
    );
  });
});
