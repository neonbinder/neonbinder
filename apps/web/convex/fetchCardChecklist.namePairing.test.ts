/**
 * NEO-496 — the BuySportsCards ↔ SportLots player-name pairing in
 * `fetchCardChecklist` (step 1's fuzzy fallback), moved onto
 * `lib/cards/name-similarity.ts`.
 *
 * Pinned first as it behaved before the move (a BSC card no id or number
 * paired takes the unclaimed SportLots card whose name scores ≥ 0.92 against
 * its first player), then the rule 8 fix the move carries: a tie on either
 * side, or a SportLots card two BSC cards both want, is left unmatched for the
 * operator instead of going to whichever came first.
 *
 * Adapter mocking follows convex/fetchCardChecklist.nameConflict.test.ts.
 * No checklist is pasted or stored, so the stored-rows read (D9) answers
 * "none" and these runs pair marketplaces only.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { insertTestCard } from "../lib/testing/card-row";

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
  subject: "admin_user_496_names",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_496_names",
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

function bsc(n: string, player: string) {
  mockState.bscCards.push({
    cardNumber: n,
    cardName: player,
    players: [player],
    platformRef: `bsc-${n}`,
    sourceBscSetSlug: "base",
  });
}

function sl(n: string, name: string) {
  mockState.slCards.push({
    cardNumber: n,
    cardName: name,
    platformRef: `2021 Topps #${n} ${name}`,
    sourceSlSetId: "189991",
  });
}

async function fetch(t: ReturnType<typeof convexTest>, id: Id<"selectorOptions">) {
  return t.withIdentity(ADMIN).action(api.selectorOptions.fetchCardChecklist, {
    selectorOptionId: id,
  });
}

async function buckets(t: ReturnType<typeof convexTest>, id: Id<"selectorOptions">) {
  const live = await t
    .withIdentity(ADMIN)
    .query(api.checklistCandidates.getReadyCandidates, { selectorOptionId: id });
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

describe("fetchCardChecklist — BSC ↔ SportLots name pairing (pinned before NEO-496)", () => {
  test("a near name on a different number pairs, with its score as the confidence", async () => {
    const t = convexTest(schema, modules);
    const id = await seedTree(t);
    bsc("10", "Mike Trout");
    sl("T-10", "Mike Troutt");

    await fetch(t, id);
    const { matched, bscOnly, slOnly } = await buckets(t, id);

    expect(matched).toHaveLength(1);
    expect(matched[0].platformData.bsc?.ref).toBe("bsc-10");
    expect(matched[0].platformData.sportlots?.ref).toBe("2021 Topps #T-10 Mike Troutt");
    expect(matched[0].confidence).toBeGreaterThanOrEqual(0.92);
    expect(matched[0].confidence).toBeLessThan(1);
    expect(bscOnly).toHaveLength(0);
    expect(slOnly).toHaveLength(0);
  });

  test("a name below 0.92 does not pair", async () => {
    const t = convexTest(schema, modules);
    const id = await seedTree(t);
    bsc("10", "Mike Trout");
    sl("T-10", "Mike Stanton");

    await fetch(t, id);
    const { matched, bscOnly, slOnly } = await buckets(t, id);

    expect(matched).toHaveLength(0);
    expect(bscOnly).toHaveLength(1);
    expect(slOnly).toHaveLength(1);
  });

  test("a number pair outranks a name, and the numbered SportLots card is not offered to a name", async () => {
    const t = convexTest(schema, modules);
    const id = await seedTree(t);
    bsc("1", "Mike Trout");
    bsc("2", "Shohei Ohtani");
    sl("1", "Mike Trout");
    sl("T-9", "Shohei Ohtani");

    await fetch(t, id);
    const { matched } = await buckets(t, id);

    const byBsc = new Map(matched.map((m) => [m.platformData.bsc?.ref, m]));
    expect(byBsc.get("bsc-1")?.platformData.sportlots?.ref).toBe("2021 Topps #1 Mike Trout");
    expect(byBsc.get("bsc-1")?.confidence).toBe(1);
    expect(byBsc.get("bsc-2")?.platformData.sportlots?.ref).toBe("2021 Topps #T-9 Shohei Ohtani");
  });

  test("each name pairs with its own best when two different players are left over", async () => {
    const t = convexTest(schema, modules);
    const id = await seedTree(t);
    bsc("10", "Mike Trout");
    bsc("11", "Mookie Betts");
    sl("A", "Mooky Betts");
    sl("B", "Mike Troutt");

    await fetch(t, id);
    const { matched } = await buckets(t, id);

    const byBsc = new Map(matched.map((m) => [m.platformData.bsc?.ref, m]));
    expect(byBsc.get("bsc-10")?.platformData.sportlots?.ref).toBe("2021 Topps #B Mike Troutt");
    expect(byBsc.get("bsc-11")?.platformData.sportlots?.ref).toBe("2021 Topps #A Mooky Betts");
  });
});

describe("fetchCardChecklist — a name tie goes to the operator (NEO-496, rule 8)", () => {
  test("two SportLots cards with the same name: the BSC card pairs with neither", async () => {
    const t = convexTest(schema, modules);
    const id = await seedTree(t);
    bsc("10", "Mike Trout");
    sl("A", "Mike Troutt");
    sl("B", "Mike Troutt");

    await fetch(t, id);
    const { matched, bscOnly, slOnly } = await buckets(t, id);

    expect(matched).toHaveLength(0);
    expect(bscOnly).toHaveLength(1);
    expect(slOnly).toHaveLength(2);
  });

  test("two BSC cards wanting one SportLots card equally: neither gets it (was: the first in list order)", async () => {
    const t = convexTest(schema, modules);
    const id = await seedTree(t);
    bsc("10", "Mike Trout");
    bsc("11", "Mike Trout");
    sl("A", "Mike Troutt");

    await fetch(t, id);
    const { matched, bscOnly, slOnly } = await buckets(t, id);

    expect(matched).toHaveLength(0);
    expect(bscOnly).toHaveLength(2);
    expect(slOnly).toHaveLength(1);
  });

  test("a SportLots card a later BSC card claims by number is never taken by an earlier card's name", async () => {
    const t = convexTest(schema, modules);
    const id = await seedTree(t);
    bsc("10", "Mike Trout"); // no number match; its best name is SportLots #11
    bsc("11", "Mike Trout"); // pairs with SportLots #11 by number
    sl("11", "Mike Trout");

    await fetch(t, id);
    const { matched, bscOnly } = await buckets(t, id);

    expect(matched).toHaveLength(1);
    expect(matched[0].platformData.bsc?.ref).toBe("bsc-11");
    expect(matched[0].confidence).toBe(1);
    expect(bscOnly.map((c) => c.platformData.bsc?.ref)).toEqual(["bsc-10"]);
  });
});
