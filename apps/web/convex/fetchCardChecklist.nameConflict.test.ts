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
 *   1. A real disagreement reaching the client at all. That used to mean two
 *      assertions, because the cards travelled on two wires — the action's
 *      return and the streamed `checklistCandidates` query. The return no
 *      longer carries cards, so there is one wire and one assertion.
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
      // NEO-239 — the BSC slot names its facet; without the tag the row has no
      // `variant` axis and BSC is skipped.
      platformFacets: { bsc: { b0: "variant" } },
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

/**
 * NEO-251 — the same, but the two sides carry PLAYER LISTS rather than titles.
 *
 * The card names are held identical on purpose: the two conflicts are separate
 * fields that fail separately, and a fixture that moved both at once could not
 * tell a roster guard from a title guard firing.
 */
function playersPairOn(n: string, bscPlayers: string[], slPlayers: string[]) {
  // An empty roster is sent as an ABSENT key, which is what both adapters do
  // (`players: players.length ? players : undefined`). It matters: the merge is
  // `bsc.players ?? sl.players`, so a literal `[]` from BSC would win over a
  // real SportLots roster — see the test that pins that behaviour below.
  mockState.bscCards.push({
    cardNumber: n,
    cardName: "Card " + n,
    ...(bscPlayers.length ? { players: bscPlayers } : {}),
    platformRef: `bsc-${n}`,
    sourceBscSetSlug: "base",
  });
  mockState.slCards.push({
    cardNumber: n,
    cardName: "Card " + n,
    ...(slPlayers.length ? { players: slPlayers } : {}),
    platformRef: `2021 Topps #${n} Card ${n}`,
    sourceSlSetId: "189991",
  });
}

async function fetch(t: ReturnType<typeof convexTest>, id: Id<"selectorOptions">) {
  return t.withIdentity(ADMIN).action(api.selectorOptions.fetchCardChecklist, {
    selectorOptionId: id,
  });
}

/**
 * The candidate rows as the MODAL receives them.
 *
 * There is one wire now. `fetchCardChecklist` returns counts and a message;
 * every card reaches `CardPairingModal` through `getReadyCandidates`, which is
 * therefore the only place a missing `nameConflict` can be caught.
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

    await fetch(t, insertId);
    const { matched } = await buckets(t, insertId);

    expect(matched).toHaveLength(1);
    expect(matched[0].nameConflict).toEqual({
      bsc: "Mike Yastrzemski",
      sportlots: "Mike Yastrzemski|Carl Yastrzemski",
    });
    // The committed default is unchanged: BSC still wins unless an operator
    // says otherwise. This field ADDS the loser, it does not swap the winner.
    expect(matched[0].cardName).toBe("Mike Yastrzemski");
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

    await fetch(t, insertId);
    const { matched } = await buckets(t, insertId);

    expect(matched).toHaveLength(5);
    for (const m of matched) {
      // `not.toHaveProperty`, not `toBeUndefined`: the point is that the key is
      // ABSENT from the wire object, which is what keeps the payload flat.
      expect(m).not.toHaveProperty("nameConflict");
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

    await fetch(t, insertId);
    const { matched, bscOnly, slOnly } = await buckets(t, insertId);

    expect(matched).toHaveLength(0);
    expect(bscOnly[0]).not.toHaveProperty("nameConflict");
    expect(slOnly[0]).not.toHaveProperty("nameConflict");
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

    await fetch(t, insertId);
    const { matched } = await buckets(t, insertId);

    expect(matched[0]).not.toHaveProperty("nameConflict");
    expect(matched[0].cardName).toBe("Wander Franco");
  });
});

/**
 * NEO-251 — the roster half of the same guard, on the AUTO-MATCHED path.
 *
 * Same shape as the name half above and for the same reason: most of a 660-row
 * set auto-matches inside `fetchCardChecklist`, where `players = bsc.players ??
 * sl.players` picked a winner and dropped the loser before the modal existed.
 * These names become `playerIds`, which the listing title is generated from —
 * so an unreported disagreement surfaces to a buyer rather than to an operator.
 */
describe("fetchCardChecklist — auto-matched player disagreements (NEO-251)", () => {
  /** The motivating row, one field over: SportLots knows about Carl. */
  test("a disagreeing pair reaches the client with BOTH rosters", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    playersPairOn(
      "227c",
      ["Mike Yastrzemski"],
      ["Mike Yastrzemski", "Carl Yastrzemski"],
    );

    await fetch(t, insertId);
    const { matched } = await buckets(t, insertId);

    expect(matched).toHaveLength(1);
    expect(matched[0].playersConflict).toEqual({
      bsc: ["Mike Yastrzemski"],
      sportlots: ["Mike Yastrzemski", "Carl Yastrzemski"],
    });
    // The committed default is unchanged: BSC still wins unless an operator
    // says otherwise, which is what makes the modal's `chosen: "bsc"` a
    // truthful statement rather than a guess.
    expect(matched[0].players).toEqual(["Mike Yastrzemski"]);
    // The TITLES agree, so nothing is said about them. The two guards are
    // independent and this fixture proves it in both directions.
    expect(matched[0]).not.toHaveProperty("nameConflict");
  });

  test("rows whose rosters merely READ differently carry no extra field", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    playersPairOn("1", ["Alec Bohm"], ["Alec Bohm"]); // identical
    playersPairOn(
      "2",
      ["Alec Bohm", "Spencer Howard"],
      ["Spencer Howard", "Alec Bohm"],
    ); // list order
    playersPairOn("3", ["Bohm, Alec"], ["Alec Bohm"]); // token order
    playersPairOn("4", ["Jose Ramirez"], ["José Ramírez"]); // BSC strips accents
    playersPairOn("5", ["Ken Griffey Jr."], ["Ken Griffey Jr"]); // punctuation

    await fetch(t, insertId);
    const { matched } = await buckets(t, insertId);

    expect(matched).toHaveLength(5);
    for (const m of matched) {
      // `not.toHaveProperty`, not `toBeUndefined`: the point is that the key is
      // ABSENT from the wire object, which is what keeps the payload flat on
      // the ~99% of rows that agree.
      expect(m).not.toHaveProperty("playersConflict");
    }
  });

  test("a SportLots-only roster is not a disagreement — SportLots simply wins", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    playersPairOn("60", [], ["Wander Franco"]);

    await fetch(t, insertId);
    const { matched } = await buckets(t, insertId);

    expect(matched[0]).not.toHaveProperty("playersConflict");
    expect(matched[0].players).toEqual(["Wander Franco"]);
  });

  /**
   * An EMPTY BSC roster is an ABSENT one, so SportLots wins.
   *
   * The merge used to be `bsc.players ?? sl.players`, and `[]` is not nullish —
   * so a BSC row carrying a literal empty array beat a real SportLots roster
   * and dropped it silently, with no conflict raised either (one empty side is
   * genuinely not a disagreement, and `conflictingPlayers` requires both).
   *
   * Both adapters send an absent key rather than `[]` today
   * (`players.length ? players : undefined`), so nothing observable changed.
   * It is pinned because NEO-251 is what makes it matter: SportLots supplies
   * rosters now, so "absent" versus "empty" is the difference between keeping
   * and losing every one of them if an adapter ever starts emitting `[]`.
   */
  test("a literal empty BSC roster does not beat SportLots'", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    mockState.bscCards.push({
      cardNumber: "61",
      cardName: "Card 61",
      players: [],
      platformRef: "bsc-61",
      sourceBscSetSlug: "base",
    });
    mockState.slCards.push({
      cardNumber: "61",
      cardName: "Card 61",
      players: ["Wander Franco"],
      platformRef: "2021 Topps #61 Card 61",
      sourceSlSetId: "189991",
    });

    await fetch(t, insertId);
    const { matched } = await buckets(t, insertId);

    // Not a disagreement — there is nothing to choose between.
    expect(matched[0]).not.toHaveProperty("playersConflict");
    expect(matched[0].players).toEqual(["Wander Franco"]);
  });

  test("an unmatched row has nobody to disagree with, and says nothing", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    mockState.bscCards.push({
      cardNumber: "10",
      cardName: "Wander Franco",
      players: ["Wander Franco"],
      platformRef: "bsc-10",
      sourceBscSetSlug: "base",
    });
    mockState.slCards.push({
      cardNumber: "99",
      cardName: "Julio Rodriguez",
      players: ["Julio Rodriguez"],
      platformRef: "2021 Topps #99 Julio Rodriguez",
      sourceSlSetId: "189991",
    });

    await fetch(t, insertId);
    const { bscOnly, slOnly } = await buckets(t, insertId);

    expect(bscOnly[0]).not.toHaveProperty("playersConflict");
    expect(slOnly[0]).not.toHaveProperty("playersConflict");
  });

  /**
   * NEO-251 — `preferred`: the operator settled this same disagreement last
   * sync, and the NB row still carries their answer.
   *
   * The evidence is NB's OWN — the committed row's players — never a
   * marketplace's opinion about which side is right. Without it the merge
   * defaults to BSC on every sync and the review screen re-asks an answered
   * question with the same wrong default, forever.
   */
  test("a committed row carrying SportLots' roster is reported as preferred", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    await t.run(async (ctx) => {
      const sportId = (await ctx.db.get(insertId))!.parentId!;
      const mike = await ctx.db.insert("players", {
        name: "Mike Yastrzemski",
        nameNormalized: "mike yastrzemski",
        sportId,
        lastUpdated: Date.now(),
      });
      const carl = await ctx.db.insert("players", {
        name: "Carl Yastrzemski",
        nameNormalized: "carl yastrzemski",
        sportId,
        lastUpdated: Date.now(),
      });
      await ctx.db.insert("cardChecklist", {
        selectorOptionId: insertId,
        cardNumber: "227c",
        cardName: "Card 227c",
        playerIds: [mike, carl],
        platformData: { bsc: { ref: "bsc-227c" } },
        sortOrder: 0,
        lastUpdated: Date.now(),
      });
    });
    playersPairOn(
      "227c",
      ["Mike Yastrzemski"],
      ["Mike Yastrzemski", "Carl Yastrzemski"],
    );

    await fetch(t, insertId);
    const { matched } = await buckets(t, insertId);

    expect(matched[0].playersConflict?.preferred).toBe("sportlots");
    // Still a HINT: the merged card keeps BSC's roster, so the modal's default
    // remains a truthful statement about what the card carries.
    expect(matched[0].players).toEqual(["Mike Yastrzemski"]);
  });

  test("a committed row matching neither side reports no preference", async () => {
    const t = convexTest(schema, modules);
    const insertId = await seedTree(t);
    await t.run(async (ctx) => {
      const sportId = (await ctx.db.get(insertId))!.parentId!;
      const other = await ctx.db.insert("players", {
        name: "Willie Mays",
        nameNormalized: "mays willie",
        sportId,
        lastUpdated: Date.now(),
      });
      await ctx.db.insert("cardChecklist", {
        selectorOptionId: insertId,
        cardNumber: "227c",
        cardName: "Card 227c",
        playerIds: [other],
        platformData: { bsc: { ref: "bsc-227c" } },
        sortOrder: 0,
        lastUpdated: Date.now(),
      });
    });
    playersPairOn(
      "227c",
      ["Mike Yastrzemski"],
      ["Mike Yastrzemski", "Carl Yastrzemski"],
    );

    await fetch(t, insertId);
    const { matched } = await buckets(t, insertId);

    expect(matched[0].playersConflict).toBeTruthy();
    expect(matched[0].playersConflict?.preferred).toBeUndefined();
  });
});
