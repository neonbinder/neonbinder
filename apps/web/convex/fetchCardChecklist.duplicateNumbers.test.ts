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
// The real parsers, not the mocked action: SportLots rows below are built from
// the exact live descriptions, so these tests cover the adapter's reading of
// "[ VAR ]" as well as the pairing.
import {
  parseSlSubjects,
  parseSlVariationMarker,
  tokenizeSlDescription,
} from "./adapters/sportlots";
import { normalizePlayerName } from "./players";
import {
  buildPairingResult,
  candidateToPairingCard,
  seedPairingState,
} from "../lib/set-build/pairing";
import { cancelScheduled } from "../lib/testing/drain-scheduled";

type Card = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  attributes?: string[];
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

/**
 * A SportLots row as the adapter parses it from a live description, e.g.
 * `slRow("16", "Pete Crow-Armstrong [ VAR ]")`.
 */
function slRow(cardNumber: string, description: string): Card {
  const { isVariation, variationLabel, residual } =
    parseSlVariationMarker(description);
  const { players } = parseSlSubjects(residual);
  return {
    cardNumber,
    cardName: residual,
    ...(players ? { players } : {}),
    ...(isVariation ? { isVariation: true } : {}),
    ...(variationLabel ? { cardVariation: variationLabel } : {}),
    platformRef: `2024 Topps Chrome #${cardNumber} ${description}`,
    sportlotsRef: cardNumber,
    sourceSlSetId: "189991",
  };
}

function bscRow(cardNumber: string, name: string, extra: Partial<Card> = {}): Card {
  return {
    cardNumber,
    cardName: name,
    players: [name],
    platformRef: `bsc-${cardNumber}`,
    sourceBscSetSlug: "base",
    ...extra,
  };
}

describe("fetchCardChecklist — an unlabelled SportLots [ VAR ] under the base number (NEO-339, 2024 Topps Chrome)", () => {
  for (const flagged of [true, false]) {
    test(`BSC 16 + 16b against SL #16 + #16 [ VAR ]: two pairs, no conflict (BSC ${flagged ? "flags" : "does not flag"} 16b)`, async () => {
      mockState.bscCards = [
        bscRow("16", "Pete Crow-Armstrong"),
        bscRow("16b", "Pete Crow-Armstrong", flagged ? { isVariation: true } : {}),
      ];
      mockState.slCards = [
        slRow("16", "Pete Crow-Armstrong"),
        slRow("16", "Pete Crow-Armstrong [ VAR ]"),
      ];

      const res = await fetchAndBucket();

      expect(pairs(res)).toEqual({
        "bsc-16": "2024 Topps Chrome #16 Pete Crow-Armstrong",
        "bsc-16b": "2024 Topps Chrome #16 Pete Crow-Armstrong [ VAR ]",
      });
      expect(res.bscOnly).toHaveLength(0);
      expect(res.slOnly).toHaveLength(0);
      for (const m of res.matched) {
        expect(m).not.toHaveProperty("nameConflict");
        expect(m).not.toHaveProperty("playersConflict");
      }
    });

    test(`BSC 122b + 122c (both Langford) against one SL #122 [ VAR ]: a tie, all three unmatched (BSC ${flagged ? "flags" : "does not flag"} them)`, async () => {
      const v = flagged ? { isVariation: true } : {};
      mockState.bscCards = [
        bscRow("122", "Wyatt Langford"),
        bscRow("122b", "Wyatt Langford", v),
        bscRow("122c", "Wyatt Langford", v),
      ];
      mockState.slCards = [
        slRow("122", "Wyatt Langford"),
        slRow("122", "Wyatt Langford [ VAR ]"),
      ];

      const res = await fetchAndBucket();

      // The base pairs by number; neither variation is given the VAR row.
      expect(pairs(res)).toEqual({
        "bsc-122": "2024 Topps Chrome #122 Wyatt Langford",
      });
      expect(bscRefs(res.bscOnly)).toEqual(["bsc-122b", "bsc-122c"]);
      expect(slRefs(res.slOnly)).toEqual([
        "2024 Topps Chrome #122 Wyatt Langford [ VAR ]",
      ]);
    });
  }

  test("BSC 122b + 122c (flagged, no base listed) against SL #122 [ VAR ] alone: all unmatched", async () => {
    mockState.bscCards = [
      bscRow("122b", "Wyatt Langford", { isVariation: true }),
      bscRow("122c", "Wyatt Langford", { isVariation: true }),
    ];
    mockState.slCards = [slRow("122", "Wyatt Langford [ VAR ]")];

    const res = await fetchAndBucket();

    expect(res.matched).toHaveLength(0);
    expect(res.bscOnly).toHaveLength(2);
    expect(res.slOnly).toHaveLength(1);
  });

  test("a set that suffixes its BASE cards (1a, no bare #1 on BSC) is not read as variations", async () => {
    // 2021 Topps ships 1a as the base. With no bare BSC #1 beside it, 1a is
    // not a variation and keeps its old route to SL's base row.
    mockState.bscCards = [bscRow("1a", "Fernando Tatis Jr.")];
    mockState.slCards = [slRow("1", "Fernando Tatis Jr.")];

    const res = await fetchAndBucket();

    expect(pairs(res)).toEqual({
      "bsc-1a": "2024 Topps Chrome #1 Fernando Tatis Jr.",
    });
  });
});


/**
 * A SportLots row exactly as the adapter derives it (the `fetchSportLotsChecklist`
 * row loop): the variation marker, then the attribute tokens, then the players
 * off what is left. `slRow` above skips the tokenizer; these shapes need it.
 */
function slParsed(cardNumber: string, description: string): Card {
  const { isVariation, variationLabel, residual: withoutVariation } =
    parseSlVariationMarker(description);
  const { attributes, residual } = tokenizeSlDescription(withoutVariation);
  const { players } = parseSlSubjects(residual);
  return {
    cardNumber,
    cardName: residual || withoutVariation,
    ...(players ? { players } : {}),
    ...(attributes.length ? { attributes } : {}),
    ...(isVariation ? { isVariation: true } : {}),
    ...(variationLabel ? { cardVariation: variationLabel } : {}),
    platformRef: `2023 Topps Chrome #${cardNumber} ${description}`,
    sportlotsRef: cardNumber,
    sourceSlSetId: "189991",
  };
}

/**
 * Fetch, pair (the dialog's reducer, every unmatched card kept, as the set
 * builder's spec does), and commit, with the named players already in NB so
 * each name resolves to exactly one row. Returns the committed rows by number
 * and each player's id by name.
 */
async function fetchPairAndCommit(playerNames: string[]) {
  const t = convexTest(schema, modules);
  const insertId = await seedTree(t);
  const sportId = await t.run(async (ctx) => {
    const sport = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .first();
    return sport!._id;
  });
  const idByName = new Map<string, Id<"players">>();
  for (const name of playerNames) {
    const id = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name,
        nameNormalized: normalizePlayerName(name),
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    idByName.set(name, id);
  }
  const admin = t.withIdentity(ADMIN);
  await admin.action(api.selectorOptions.fetchCardChecklist, {
    selectorOptionId: insertId,
  });
  const live = await admin.query(api.checklistCandidates.getReadyCandidates, {
    selectorOptionId: insertId,
  });
  const state = seedPairingState({
    autoMatched: live.cards
      .filter((c) => c.bucket === "matched")
      .map((c) => ({ card: candidateToPairingCard(c), confidence: c.confidence ?? 1 })),
    unmatchedBsc: live.cards.filter((c) => c.bucket === "bscOnly").map(candidateToPairingCard),
    unmatchedSl: live.cards.filter((c) => c.bucket === "slOnly").map(candidateToPairingCard),
  });
  const { cards } = buildPairingResult(state, {
    keepUnmatchedBsc: true,
    keepUnmatchedSl: true,
  });
  await admin.action(api.selectorOptions.commitCardChecklist, {
    selectorOptionId: insertId,
    sportId,
    cards,
  });
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", insertId))
      .collect(),
  );
  await cancelScheduled(t);
  return { rows, idByName };
}

describe("fetchCardChecklist — a SportLots VAR keeps its player (NEO-339, 2023 Topps Chrome)", () => {
  // BSC's own rows for #1 (read live, 2026-10-19): 1, 1b "VAR: Base image
  // variation", 1c "VAR: SSP", all Adley Rutschman.
  const BSC_ONE = [
    bscRow("1", "Adley Rutschman"),
    bscRow("1b", "Adley Rutschman", {
      isVariation: true,
      cardVariation: "Base image variation",
    }),
    bscRow("1c", "Adley Rutschman", { isVariation: true, cardVariation: "SSP" }),
  ];

  test("SportLots' [ VAR SSP ] is a variation with its player, not a second plain #1 with none", () => {
    const row = slParsed("1", "Adley Rutschman [ VAR SSP ]");
    expect(row).toMatchObject({
      cardName: "Adley Rutschman",
      players: ["Adley Rutschman"],
      isVariation: true,
      cardVariation: "SSP",
      attributes: ["SSP"],
    });
  });

  test("a word after [ VAR ] is not glued to the name", () => {
    const row = slParsed("182", "Riley Greene [ VAR ] RC");
    expect(row).toMatchObject({
      cardName: "Riley Greene",
      players: ["Riley Greene"],
      isVariation: true,
      attributes: ["RC"],
    });
    expect(row).not.toHaveProperty("cardVariation");
  });

  test("BSC 1 + 1b + 1c against SL #1, #1 [ VAR ], #1 [ VAR SSP ]: three pairs, every card carrying the player", async () => {
    mockState.bscCards = BSC_ONE;
    mockState.slCards = [
      slParsed("1", "Adley Rutschman RC"),
      slParsed("1", "Adley Rutschman [ VAR ]"),
      slParsed("1", "Adley Rutschman [ VAR SSP ]"),
    ];

    const res = await fetchAndBucket();

    expect(pairs(res)).toEqual({
      "bsc-1": "2023 Topps Chrome #1 Adley Rutschman RC",
      "bsc-1b": "2023 Topps Chrome #1 Adley Rutschman [ VAR ]",
      "bsc-1c": "2023 Topps Chrome #1 Adley Rutschman [ VAR SSP ]",
    });
    expect(res.bscOnly).toHaveLength(0);
    expect(res.slOnly).toHaveLength(0);
    for (const m of res.matched) {
      expect(m.players).toEqual(["Adley Rutschman"]);
      expect(m).not.toHaveProperty("nameConflict");
      expect(m).not.toHaveProperty("playersConflict");
    }
  });

  test("[ VAR ] RC against BSC 182b: one pair, no roster disagreement", async () => {
    mockState.bscCards = [
      bscRow("182", "Riley Greene"),
      bscRow("182b", "Riley Greene", { isVariation: true }),
    ];
    mockState.slCards = [
      slParsed("182", "Riley Greene RC"),
      slParsed("182", "Riley Greene [ VAR ] RC"),
    ];

    const res = await fetchAndBucket();

    expect(pairs(res)).toEqual({
      "bsc-182": "2023 Topps Chrome #182 Riley Greene RC",
      "bsc-182b": "2023 Topps Chrome #182 Riley Greene [ VAR ] RC",
    });
    for (const m of res.matched) {
      expect(m.players).toEqual(["Riley Greene"]);
      expect(m).not.toHaveProperty("playersConflict");
    }
  });

  test("a SportLots VAR matched to a BSC variation that names no player carries SportLots' player", async () => {
    mockState.bscCards = [
      bscRow("95", "Corbin Carroll"),
      bscRow("95b", "Card #95b", { isVariation: true, players: undefined }),
    ];
    mockState.slCards = [
      slParsed("95", "Corbin Carroll RC"),
      slParsed("95", "Corbin Carroll [ VAR ]"),
    ];

    const res = await fetchAndBucket();

    expect(pairs(res)).toEqual({
      "bsc-95": "2023 Topps Chrome #95 Corbin Carroll RC",
      "bsc-95b": "2023 Topps Chrome #95 Corbin Carroll [ VAR ]",
    });
    const variation = res.matched.find((m) => m.platformData.bsc?.ref === "bsc-95b")!;
    expect(variation.players).toEqual(["Corbin Carroll"]);
  });

  test("committed: the base card and both variations link the same player, and the variations hang off #1", async () => {
    mockState.bscCards = BSC_ONE;
    mockState.slCards = [
      slParsed("1", "Adley Rutschman RC"),
      slParsed("1", "Adley Rutschman [ VAR ]"),
      slParsed("1", "Adley Rutschman [ VAR SSP ]"),
    ];

    const { rows, idByName } = await fetchPairAndCommit(["Adley Rutschman"]);

    const byNumber = new Map(rows.map((r) => [r.cardNumber, r]));
    expect([...byNumber.keys()].sort()).toEqual(["1", "1b", "1c"]);
    const rutschman = idByName.get("Adley Rutschman");
    for (const number of ["1", "1b", "1c"]) {
      expect(byNumber.get(number)!.playerIds).toEqual([rutschman]);
    }
    expect(byNumber.get("1b")!.variationOfCardId).toBe(byNumber.get("1")!._id);
    expect(byNumber.get("1c")!.variationOfCardId).toBe(byNumber.get("1")!._id);
  });

  test("committed, the live #1 shape: both SportLots VARs and BSC 1b hang off base #1, each with the player", async () => {
    // Read from the preview at 244f846: SportLots serves three #1 rows, the
    // VAR ones with a line break before the bracket; BSC lists 1 and 1b.
    // BSC 1b against two SportLots variations of the same player is a tie, so
    // the three variations stay unpaired (invariant 8) and are kept as
    // singles; the commit still files each one under #1.
    mockState.bscCards = BSC_ONE.slice(0, 2);
    mockState.slCards = [
      slParsed("1", "Adley Rutschman"),
      slParsed("1", "Adley Rutschman\r\n    [ VAR ]"),
      slParsed("1", "Adley Rutschman\r\n    [ VAR SSP ]"),
    ];
    for (const row of mockState.slCards.slice(1)) {
      expect(row).toMatchObject({
        cardName: "Adley Rutschman",
        players: ["Adley Rutschman"],
        isVariation: true,
      });
    }

    const { rows, idByName } = await fetchPairAndCommit(["Adley Rutschman"]);

    expect(rows).toHaveLength(4);
    const base = rows.filter((r) => r.platformData?.bsc?.ref === "bsc-1");
    expect(base).toHaveLength(1);
    const variations = rows.filter((r) => r._id !== base[0]._id);
    // 1b, and the two SportLots VARs (still numbered 1, as SportLots prints).
    expect(variations.map((r) => r.cardNumber).sort()).toEqual(["1", "1", "1b"]);
    for (const r of rows) {
      expect(r.playerIds).toEqual([idByName.get("Adley Rutschman")]);
    }
    for (const r of variations) {
      expect(r.variationOfCardId).toBe(base[0]._id);
    }
    expect(base[0].variationOfCardId).toBeUndefined();
    const ssp = variations.find((r) =>
      r.platformData?.sportlots?.ref?.includes("[ VAR SSP ]"),
    )!;
    expect(ssp.cardVariation).toBe("SSP");
  });

  test("committed: a one-word name BSC lists (\"Ichiro\") links, though SportLots' parser refuses it", async () => {
    // 2023 Topps Chrome Update Legend Autographs: BSC lists CLA-I as
    // "Ichiro" (read live, 2026-10-19). SportLots' "Ichiro AU" yields no
    // players (`parseSlSubjects` refuses a single token), which is not a
    // disagreement, so the merged card carries BSC's name.
    mockState.bscCards = [bscRow("CLA-I", "Ichiro")];
    mockState.slCards = [slParsed("CLA-I", "Ichiro AU")];
    expect(mockState.slCards[0]).not.toHaveProperty("players");

    const { rows, idByName } = await fetchPairAndCommit(["Ichiro"]);

    expect(rows).toHaveLength(1);
    expect(rows[0].playerIds).toEqual([idByName.get("Ichiro")]);
  });
});
