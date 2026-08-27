/**
 * NEO-189 — reconciliation when SportLots reuses a card number.
 *
 * SportLots files a card and its variations under ONE number and separates
 * them in the description: "#11 Alec Bohm" and "#11 Alec Bohm [ VAR Action
 * Image ]" are different cards sharing the number 11. BSC does the opposite —
 * it suffixes the number (11b) and keeps the description clean.
 *
 * `fetchCardChecklist` used to assume a SportLots number identified one row.
 * A real 2025 Topps sync reported "350 paired, 393 BSC-only, 0 SL-only"; each
 * of those numbers was wrong in a different way, and all three failures were
 * silent. These tests pin each one.
 *
 * Adapter mocking follows convex/fetchCardChecklist.stickyPairing.test.ts.
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
      },
      returns: v.object({
        success: v.boolean(),
        cards: v.array(v.any()),
        message: v.optional(v.string()),
      }),
      handler: async () => ({ success: true, cards: mockState.bscCards }),
    }),
    fetchBscCardTeamNames: internalAction({
      args: { bscCardIds: v.array(v.string()) },
      returns: v.record(v.string(), v.string()),
      handler: async (): Promise<Record<string, string>> => ({}),
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
  subject: "admin_user_189",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_189",
  name: "Admin",
  role: "admin",
};

async function seedTree(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: { bsc: { b0: "baseball" } },
      platformSlotSeq: { bsc: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2021",
      platformData: { bsc: { b0: "2021" } },
      platformSlotSeq: { bsc: 1 },
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
      primaryPlatformId: { bsc: "b0", sportlots: "s0" },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
  });
}

/** The 2021 Heritage #11 group, exactly as each marketplace reports it. */
function heritage11() {
  mockState.bscCards = [
    {
      cardNumber: "11",
      cardName: "Phillies 2021 Rookie Stars",
      players: ["Alec Bohm", "Spencer Howard"],
      platformRef: "bsc-11",
      sourceBscSetSlug: "base",
    },
    {
      cardNumber: "11b",
      cardName: "Alec Bohm",
      players: ["Alec Bohm"],
      cardVariation: "Action",
      isVariation: true,
      platformRef: "bsc-11b",
      sourceBscSetSlug: "base",
    },
    {
      cardNumber: "11c",
      cardName: "Alec Bohm",
      players: ["Alec Bohm"],
      cardVariation: "Alternate",
      isVariation: true,
      platformRef: "bsc-11c",
      sourceBscSetSlug: "base",
    },
  ];
  // Every SL row carries the number 11 — the base AND both variations.
  mockState.slCards = [
    {
      cardNumber: "11",
      cardName: "Alec Bohm|Spencer Howard",
      platformRef: "2021 Topps Heritage #11 Alec Bohm|Spencer Howard",
      sportlotsRef: "11",
      sourceSlSetId: "189991",
    },
    {
      cardNumber: "11",
      cardName: "Alec Bohm",
      cardVariation: "Action Image",
      isVariation: true,
      platformRef: "2021 Topps Heritage #11 Alec Bohm [ VAR Action Image ]",
      sportlotsRef: "11",
      sourceSlSetId: "189991",
    },
    {
      cardNumber: "11",
      cardName: "Alec Bohm",
      cardVariation: "Throwback Alternate",
      isVariation: true,
      platformRef: "2021 Topps Heritage #11 Alec Bohm [ VAR Throwback Alternate ]",
      sportlotsRef: "11",
      sourceSlSetId: "189991",
    },
  ];
}

beforeEach(() => {
  mockState.bscCards = [];
  mockState.slCards = [];
});

describe("fetchCardChecklist — SportLots reuses card numbers (NEO-189)", () => {
  test("SL variation rows are no longer swallowed by the base card's claim", async () => {
    // THE BUG: claims were keyed by card NUMBER, so BSC #11 claiming SL's "11"
    // marked both SL variation rows as taken. They vanished from both buckets —
    // the observed "0 SL-only" on a set that plainly had more.
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    heritage11();

    const res = await t.withIdentity(ADMIN).action(
      api.selectorOptions.fetchCardChecklist,
      { selectorOptionId: insertId },
    );

    // The discriminating assertion: every SL ROW must be reachable somewhere.
    // Counting NB cards would not catch this — on the old code the totals still
    // came to 3 (1 matched + 2 BSC-only), because the two SL variation rows
    // simply ceased to exist rather than showing up anywhere.
    const seenSlRefs = new Set(
      [
        ...res.autoMatched.map((m) => m.card),
        ...res.unmatchedBsc,
        ...res.unmatchedSl,
      ]
        .map((c) => c.platformData.sportlots?.ref)
        .filter(Boolean),
    );
    expect([...seenSlRefs].sort()).toEqual(
      mockState.slCards.map((c) => c.platformRef!).sort(),
    );
  });

  test("each BSC variation pairs with the SL row describing the SAME variation", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    heritage11();

    const res = await t.withIdentity(ADMIN).action(
      api.selectorOptions.fetchCardChecklist,
      { selectorOptionId: insertId },
    );

    const byBscRef = new Map(
      res.autoMatched.map((m) => [m.card.platformData.bsc?.ref, m.card]),
    );
    // "Action" ⊂ "Action Image", "Alternate" ⊂ "Throwback Alternate".
    expect(byBscRef.get("bsc-11b")?.platformData.sportlots?.ref).toBe(
      "2021 Topps Heritage #11 Alec Bohm [ VAR Action Image ]",
    );
    expect(byBscRef.get("bsc-11c")?.platformData.sportlots?.ref).toBe(
      "2021 Topps Heritage #11 Alec Bohm [ VAR Throwback Alternate ]",
    );
    expect(res.unmatchedBsc).toHaveLength(0);
    expect(res.unmatchedSl).toHaveLength(0);
  });

  test("the BASE card pairs with SL's base row, never with one of its variations", async () => {
    // THE BUG: slByNumber was last-write-wins, so get("11") answered with
    // whichever variation was scraped last and the base paired with it.
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    heritage11();

    const res = await t.withIdentity(ADMIN).action(
      api.selectorOptions.fetchCardChecklist,
      { selectorOptionId: insertId },
    );

    const base = res.autoMatched.find(
      (m) => m.card.platformData.bsc?.ref === "bsc-11",
    );
    expect(base?.card.platformData.sportlots?.ref).toBe(
      "2021 Topps Heritage #11 Alec Bohm|Spencer Howard",
    );
  });

  test("a BSC variation SportLots does not carry stays BSC-only, not force-matched", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    heritage11();
    // SL knows the base and one variation; the "Alternate" is BSC-only.
    mockState.slCards = mockState.slCards.filter(
      (c) => !c.cardVariation?.includes("Throwback"),
    );

    const res = await t.withIdentity(ADMIN).action(
      api.selectorOptions.fetchCardChecklist,
      { selectorOptionId: insertId },
    );

    expect(res.unmatchedBsc.map((c) => c.cardNumber)).toEqual(["11c"]);
    expect(res.unmatchedSl).toHaveLength(0);
  });

  test("a set with no variations reconciles exactly as before", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    mockState.bscCards = [
      { cardNumber: "1", cardName: "A", platformRef: "bsc-1", sourceBscSetSlug: "base" },
      { cardNumber: "2", cardName: "B", platformRef: "bsc-2", sourceBscSetSlug: "base" },
    ];
    mockState.slCards = [
      { cardNumber: "1", cardName: "A", platformRef: "#1 A", sportlotsRef: "1", sourceSlSetId: "189991" },
      { cardNumber: "2", cardName: "B", platformRef: "#2 B", sportlotsRef: "2", sourceSlSetId: "189991" },
    ];

    const res = await t.withIdentity(ADMIN).action(
      api.selectorOptions.fetchCardChecklist,
      { selectorOptionId: insertId },
    );
    expect(res.autoMatched).toHaveLength(2);
    expect(res.unmatchedBsc).toHaveLength(0);
    expect(res.unmatchedSl).toHaveLength(0);
  });

  test("SL variations with no BSC counterpart are OFFERED, not discarded", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    heritage11();
    // BSC knows only the base; SL carries both variations.
    mockState.bscCards = mockState.bscCards.filter((c) => !c.isVariation);

    const res = await t.withIdentity(ADMIN).action(
      api.selectorOptions.fetchCardChecklist,
      { selectorOptionId: insertId },
    );

    expect(res.autoMatched).toHaveLength(1);
    expect(res.unmatchedSl).toHaveLength(2);
    expect(
      res.unmatchedSl.map((c) => c.platformData.sportlots?.ref).sort(),
    ).toEqual([
      "2021 Topps Heritage #11 Alec Bohm [ VAR Action Image ]",
      "2021 Topps Heritage #11 Alec Bohm [ VAR Throwback Alternate ]",
    ]);
  });
});
