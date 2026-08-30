/**
 * NEO-199 — the wrong-player guard on the AUTO-MATCHED path.
 *
 * NEO-189 taught `CardPairingModal` to keep both names when an operator
 * hand-links two rows the marketplaces name differently. That covered the
 * leftovers. This covers the common case: most of a 660-row set auto-matches
 * inside `fetchCardChecklist`, where `cardName: bsc.cardName || sl?.cardName`
 * picked a winner and dropped the loser before the modal existed. A guard that
 * fires only on hand-linked rows is worse than none — the screen looks like it
 * is protecting you.
 *
 * The two halves pinned here are the two ways this can go wrong:
 *
 *   1. A real disagreement reaching the client at all, on BOTH wires (the
 *      action's return AND the streamed `checklistCandidates` query, which is
 *      what the modal actually opens on).
 *   2. Everything else staying silent. The two marketplaces spell the same name
 *      differently as a matter of routine — BSC strips accents SportLots keeps,
 *      and they join co-subjects with " / " vs "|" — so a raw compare would
 *      flag hundreds of rows per set, and the extra field would land on a
 *      payload of 908 of them.
 *
 * Adapter mocking follows convex/fetchCardChecklist.variationPairing.test.ts.
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
  subject: "admin_user_199",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_199",
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
      value: "Topps",
      platformData: { bsc: { b0: "topps" } },
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

/** One BSC row and one SL row on the same number, so they auto-match. */
function pairOn(n: string, bscName: string, slName: string) {
  mockState.bscCards.push({
    cardNumber: n,
    cardName: bscName,
    platformRef: `bsc-${n}`,
    sourceBscSetSlug: "base",
  });
  mockState.slCards.push({
    cardNumber: n,
    cardName: slName,
    platformRef: `2021 Topps #${n} ${slName}`,
    sourceSlSetId: "189991",
  });
}

async function fetch(t: ReturnType<typeof convexTest>, id: Id<"selectorOptions">) {
  return t.withIdentity(ADMIN).action(api.selectorOptions.fetchCardChecklist, {
    selectorOptionId: id,
  });
}

beforeEach(() => {
  mockState.bscCards = [];
  mockState.slCards = [];
});

describe("fetchCardChecklist — auto-matched name disagreements (NEO-199)", () => {
  /**
   * The motivating row. SportLots has "Mike Yastrzemski|Carl Yastrzemski" where
   * BSC has a bare "Mike Yastrzemski"; the card is CARL, a "Legend" short print
   * picturing a different player than the base card. Before this, the pair
   * arrived carrying only Mike's name and nothing said otherwise.
   */
  test("a disagreeing pair reaches the client with BOTH names", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    pairOn("227c", "Mike Yastrzemski", "Mike Yastrzemski|Carl Yastrzemski");

    const res = await fetch(t, insertId);

    expect(res.autoMatched).toHaveLength(1);
    const card = res.autoMatched[0].card;
    expect(card.nameConflict).toEqual({
      bsc: "Mike Yastrzemski",
      sportlots: "Mike Yastrzemski|Carl Yastrzemski",
    });
    // The committed default is unchanged: BSC still wins unless an operator
    // says otherwise. This field ADDS the loser, it does not swap the winner.
    expect(card.cardName).toBe("Mike Yastrzemski");
  });

  /**
   * The modal opens on the STREAMED candidates seconds into a fetch and stays
   * on them for the ~70s of team enrichment that follows — the action's own
   * return only takes over at the end. A conflict that travelled on one wire
   * and not the other would show up late, on a row already reviewed.
   */
  test("the streamed candidate row carries it too, not just the action's return", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    pairOn("227c", "Mike Yastrzemski", "Mike Yastrzemski|Carl Yastrzemski");

    await fetch(t, insertId);
    const live = await t
      .withIdentity(ADMIN)
      .query(api.checklistCandidates.getReadyCandidates, {
        selectorOptionId: insertId,
      });

    const streamed = live.cards.find((c) => c.cardNumber === "227c");
    expect(streamed?.bucket).toBe("matched");
    expect(streamed?.nameConflict).toEqual({
      bsc: "Mike Yastrzemski",
      sportlots: "Mike Yastrzemski|Carl Yastrzemski",
    });
  });

  /**
   * The payload half, and the reason the comparison is shared with the client
   * rather than reimplemented: these are not disagreements, they are two
   * marketplaces spelling one name their own way. A raw compare would flag most
   * of a set and put the extra object on hundreds of rows in a 908-row batch.
   */
  test("rows the marketplaces merely SPELL differently carry no extra field", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    pairOn("1", "Ken Griffey Jr.", "Ken Griffey Jr.");     // identical
    pairOn("2", "Ken Griffey Jr.", "Ken Griffey Jr");      // punctuation
    pairOn("3", "KEN GRIFFEY JR.", "Ken Griffey Jr.");     // casing
    pairOn("4", "Jose Ramirez", "José Ramírez");           // BSC strips accents
    pairOn("5", "Mike Trout / Shohei Ohtani", "Mike Trout|Shohei Ohtani");

    const res = await fetch(t, insertId);

    expect(res.autoMatched).toHaveLength(5);
    for (const m of res.autoMatched) {
      // `not.toHaveProperty`, not `toBeUndefined`: the point is that the key is
      // ABSENT from the wire object, which is what keeps the payload flat.
      expect(m.card).not.toHaveProperty("nameConflict");
    }
  });

  test("an unmatched row has nothing to disagree with, and says nothing", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    mockState.bscCards.push({
      cardNumber: "10",
      cardName: "Wander Franco",
      platformRef: "bsc-10",
      sourceBscSetSlug: "base",
    });
    mockState.slCards.push({
      cardNumber: "99",
      cardName: "Julio Rodriguez",
      platformRef: "2021 Topps #99 Julio Rodriguez",
      sourceSlSetId: "189991",
    });

    const res = await fetch(t, insertId);

    expect(res.autoMatched).toHaveLength(0);
    expect(res.unmatchedBsc[0]).not.toHaveProperty("nameConflict");
    expect(res.unmatchedSl[0]).not.toHaveProperty("nameConflict");
  });

  /**
   * A side with no name at all is not a disagreement — there is nothing to
   * choose between, and the merge already falls through to the side that has
   * one. Flagging it would put a radiogroup with one real option on the row.
   */
  test("a nameless BSC row is not a conflict — SportLots simply wins", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    pairOn("60", "", "Wander Franco");

    const res = await fetch(t, insertId);

    expect(res.autoMatched[0].card).not.toHaveProperty("nameConflict");
    expect(res.autoMatched[0].card.cardName).toBe("Wander Franco");
  });
});
