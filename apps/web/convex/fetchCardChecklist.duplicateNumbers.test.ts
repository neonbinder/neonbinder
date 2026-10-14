/**
 * NEO-339 — BSC↔SportLots pairing on a card number printed twice.
 *
 * 2014 Topps Chrome "All Time Rookie Reprints" #482 is two real cards: Rickey
 * Henderson and Tony Gwynn. `fetchCardChecklist` used to keep the FIRST
 * SportLots #482 it scraped and pair every BSC #482 to it, so which player a
 * card was paired with depended on scrape order, and one SportLots row could
 * sit in two pairs.
 *
 * Invariants 7 and 8: a number is not guaranteed unique, and a tie leaves the
 * cards unmatched for the operator — never given to the first candidate. On a
 * duplicated number the cards pair by player when exactly one pairing fits
 * both ways; a number printed once on each side pairs as before, with a
 * conflict when the players differ.
 *
 * Harness copied from convex/fetchCardChecklist.variationPairing.test.ts.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

type Card = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  cardVariation?: string;
  isVariation?: boolean;
  platformRef?: string;
  sportlotsRef?: string;
  sourceBscSetSlug?: string;
  sourceSlSetId?: string;
};

const mockState = vi.hoisted(() => ({
  bscCards: [] as Card[],
  slCards: [] as Card[],
}));

vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action, internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        // NEO-189: fetchCardChecklist now sends facet-keyed filters.
        facetFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        sourceFacet: v.optional(
          v.union(v.literal("setName"), v.literal("variantName")),
        ),
      },
      returns: v.object({
        success: v.boolean(),
        cards: v.array(v.any()),
        message: v.optional(v.string()),
        collisions: v.optional(v.array(v.any())),
      }),
      handler: async () => ({ success: true, cards: mockState.bscCards }),
    }),
    // NEO-335: one entry per requested id; an empty list reads as every
    // lookup failed, which the caller treats exactly as "no team" before.
    fetchBscCardTeamNames: internalAction({
      args: { bscCardIds: v.array(v.string()) },
      returns: v.array(
        v.object({
          bscCardId: v.string(),
          teamName: v.string(),
          success: v.boolean(),
        }),
      ),
      handler: async () => [],
    }),
  };
});

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
      returns: v.object({
        success: v.boolean(),
        cards: v.array(v.any()),
        message: v.optional(v.string()),
      }),
      handler: async () => ({ success: true, cards: mockState.slCards }),
    }),
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_user_339",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_339",
  name: "Admin",
  role: "admin",
};

/**
 * The candidate rows as the pairing dialog receives them.
 *
 * `fetchCardChecklist` returns a count and a message; every card reaches the
 * client through `getReadyCandidates`, so a variation lost in reconciliation
 * has to be caught on this query — it is the only wire the cards travel.
 */
async function buckets(
  t: ReturnType<typeof convexTest>,
  id: Id<"selectorOptions">,
) {
  const live = await t
    .withIdentity(ADMIN)
    .query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
  return {
    matched: live.cards.filter((c) => c.bucket === "matched"),
    bscOnly: live.cards.filter((c) => c.bucket === "bscOnly"),
    slOnly: live.cards.filter((c) => c.bucket === "slOnly"),
  };
}

async function seedTree(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      // NEO-239 — SportLots is scoped by `sprt` + `yr`, so those two ids are
      // what make the SL side of this chain resolvable at all. Without them
      // SportLots is SKIPPED rather than queried by display name.
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2021",
      platformData: { bsc: { b0: "2021" }, sportlots: { s0: "2021" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Heritage",
      platformData: { bsc: { b0: "topps-heritage" } },
      platformSlotSeq: { bsc: 1 },
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    return await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: { b0: "base" }, sportlots: { s0: "189991" } },
      // NEO-239 — the BSC slot says which FACET its id belongs to. Untagged,
      // the row has no `variant` axis and BSC is skipped entirely rather than
      // queried across every variant in the set.
      platformFacets: { bsc: { b0: "variant" } },
      primaryPlatformId: { bsc: "b0", sportlots: "s0" },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
  });
}


const BSC_HENDERSON: Card = {
  cardNumber: "482",
  cardName: "Rickey Henderson",
  players: ["Rickey Henderson"],
  platformRef: "bsc-482-henderson",
  sourceBscSetSlug: "base",
};
const BSC_GWYNN: Card = {
  cardNumber: "482",
  cardName: "Tony Gwynn",
  players: ["Tony Gwynn"],
  platformRef: "bsc-482-gwynn",
  sourceBscSetSlug: "base",
};
// SportLots' structured roster is optional (parseSlSubjects returns nothing on
// doubt); Henderson carries one and Gwynn relies on the card name, so both
// ways a SportLots row says who it shows are exercised.
const SL_HENDERSON: Card = {
  cardNumber: "482",
  cardName: "Rickey Henderson",
  players: ["Rickey Henderson"],
  platformRef: "2014 Topps Chrome #482 Rickey Henderson",
  sportlotsRef: "482",
  sourceSlSetId: "189991",
};
const SL_GWYNN: Card = {
  cardNumber: "482",
  cardName: "Tony Gwynn",
  platformRef: "2014 Topps Chrome #482 Tony Gwynn",
  sportlotsRef: "482",
  sourceSlSetId: "189991",
};

async function fetchAndBucket() {
  const t = convexTest(schema, modules);
  const insertId = await seedTree(t);
  await t.withIdentity(ADMIN).action(
    api.selectorOptions.fetchCardChecklist,
    { selectorOptionId: insertId },
  );
  return buckets(t, insertId);
}

type Bucketed = Awaited<ReturnType<typeof fetchAndBucket>>;

/** bscRef → slRef for every matched pair. */
function pairs(res: Bucketed): Record<string, string | undefined> {
  return Object.fromEntries(
    res.matched.map((c) => [
      c.platformData.bsc?.ref ?? "",
      c.platformData.sportlots?.ref,
    ]),
  );
}

const bscRefs = (rows: Bucketed["bscOnly"]) =>
  rows.map((c) => c.platformData.bsc?.ref).sort();
const slRefs = (rows: Bucketed["slOnly"]) =>
  rows.map((c) => c.platformData.sportlots?.ref).sort();

beforeEach(() => {
  mockState.bscCards = [];
  mockState.slCards = [];
});

describe("fetchCardChecklist — a card number printed twice (NEO-339)", () => {
  test("both sides list #482 twice: two pairs, by player, whatever the scrape order", async () => {
    // SportLots scraped Henderson first, BSC listed Gwynn first: the old
    // first-row index paired BOTH BSC cards to SL Henderson.
    mockState.bscCards = [BSC_GWYNN, BSC_HENDERSON];
    mockState.slCards = [SL_HENDERSON, SL_GWYNN];

    const res = await fetchAndBucket();

    expect(pairs(res)).toEqual({
      "bsc-482-henderson": SL_HENDERSON.platformRef,
      "bsc-482-gwynn": SL_GWYNN.platformRef,
    });
    expect(res.bscOnly).toHaveLength(0);
    expect(res.slOnly).toHaveLength(0);
    for (const m of res.matched) {
      expect(m).not.toHaveProperty("nameConflict");
      expect(m).not.toHaveProperty("playersConflict");
    }
  });

  test("SportLots lists #482 twice, BSC once (Gwynn): Gwynn pairs Gwynn, SL Henderson is unmatched", async () => {
    mockState.bscCards = [BSC_GWYNN];
    mockState.slCards = [SL_HENDERSON, SL_GWYNN];

    const res = await fetchAndBucket();

    expect(pairs(res)).toEqual({ "bsc-482-gwynn": SL_GWYNN.platformRef });
    expect(res.bscOnly).toHaveLength(0);
    expect(slRefs(res.slOnly)).toEqual([SL_HENDERSON.platformRef]);
  });

  test("BSC lists #482 twice, SportLots once (Henderson): Henderson pairs Henderson, BSC Gwynn is unmatched", async () => {
    // BSC Gwynn first: the old lookup paired it to SL Henderson by number
    // alone, then paired BSC Henderson to the same SL row as well.
    mockState.bscCards = [BSC_GWYNN, BSC_HENDERSON];
    mockState.slCards = [SL_HENDERSON];

    const res = await fetchAndBucket();

    expect(pairs(res)).toEqual({
      "bsc-482-henderson": SL_HENDERSON.platformRef,
    });
    expect(bscRefs(res.bscOnly)).toEqual(["bsc-482-gwynn"]);
    expect(res.slOnly).toHaveLength(0);
  });

  test("SportLots lists #482 twice, BSC once with a player matching neither: all unmatched", async () => {
    mockState.bscCards = [
      {
        cardNumber: "482",
        cardName: "Rickey Hendersen",
        // One letter off SL Henderson: close enough for the 0.92 fuzzy
        // fallback, which must not get to guess on an ambiguous number.
        players: ["Rickey Hendersen"],
        platformRef: "bsc-482-other",
        sourceBscSetSlug: "base",
      },
    ];
    mockState.slCards = [SL_HENDERSON, SL_GWYNN];

    const res = await fetchAndBucket();

    expect(res.matched).toHaveLength(0);
    expect(bscRefs(res.bscOnly)).toEqual(["bsc-482-other"]);
    expect(slRefs(res.slOnly)).toEqual(
      [SL_HENDERSON.platformRef, SL_GWYNN.platformRef].sort(),
    );
  });

  test("a SportLots row the duplicate rule left unmatched is not fuzzy-paired to a card on another number", async () => {
    // BSC #999 has no SportLots counterpart by number and names the same
    // player as the SL Henderson #482 left over above. The fuzzy fallback
    // would hand it that row; the row was left for the operator instead.
    mockState.bscCards = [
      BSC_GWYNN,
      { ...BSC_HENDERSON, cardNumber: "999", platformRef: "bsc-999-henderson" },
    ];
    mockState.slCards = [SL_HENDERSON, SL_GWYNN];

    const res = await fetchAndBucket();

    expect(pairs(res)).toEqual({ "bsc-482-gwynn": SL_GWYNN.platformRef });
    expect(bscRefs(res.bscOnly)).toEqual(["bsc-999-henderson"]);
    expect(slRefs(res.slOnly)).toEqual([SL_HENDERSON.platformRef]);
  });

  test("two cards on each side that cannot be told apart by player: all four unmatched", async () => {
    // The same player twice on each side: a tie both ways. No pair is given
    // to the first candidate.
    mockState.bscCards = [
      { ...BSC_HENDERSON, platformRef: "bsc-482-a" },
      { ...BSC_HENDERSON, platformRef: "bsc-482-b" },
    ];
    mockState.slCards = [
      { ...SL_HENDERSON, platformRef: "#482 Rickey Henderson (a)" },
      { ...SL_HENDERSON, platformRef: "#482 Rickey Henderson (b)" },
    ];

    const res = await fetchAndBucket();

    expect(res.matched).toHaveLength(0);
    expect(res.bscOnly).toHaveLength(2);
    expect(res.slOnly).toHaveLength(2);
  });

  test("one card each side with different players: still paired, with the conflict raised (unchanged)", async () => {
    mockState.bscCards = [BSC_GWYNN];
    mockState.slCards = [SL_HENDERSON];

    const res = await fetchAndBucket();

    expect(pairs(res)).toEqual({ "bsc-482-gwynn": SL_HENDERSON.platformRef });
    expect(res.matched[0].nameConflict).toEqual({
      bsc: "Tony Gwynn",
      sportlots: "Rickey Henderson",
    });
    expect(res.matched[0].playersConflict).toMatchObject({
      bsc: ["Tony Gwynn"],
      sportlots: ["Rickey Henderson"],
    });
    expect(res.bscOnly).toHaveLength(0);
    expect(res.slOnly).toHaveLength(0);
  });

  test("a SportLots variation on the duplicated number does not count as a candidate (NEO-189)", async () => {
    // One base row and one VAR row under #482 on SportLots is the NEO-189
    // shape, not a duplicated number: BSC #482 pairs the base by number.
    mockState.bscCards = [BSC_GWYNN];
    mockState.slCards = [
      {
        ...SL_GWYNN,
        cardVariation: "Refractor",
        isVariation: true,
        platformRef: "2014 Topps Chrome #482 Tony Gwynn [ VAR Refractor ]",
      },
      SL_GWYNN,
    ];

    const res = await fetchAndBucket();

    expect(pairs(res)).toEqual({ "bsc-482-gwynn": SL_GWYNN.platformRef });
    expect(slRefs(res.slOnly)).toEqual([
      "2014 Topps Chrome #482 Tony Gwynn [ VAR Refractor ]",
    ]);
  });
});
