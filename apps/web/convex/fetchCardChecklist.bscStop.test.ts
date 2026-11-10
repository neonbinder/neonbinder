/**
 * PR 451 (NEO-487) — the chunk loop in `fetchCardChecklist` stops asking BSC
 * about team names once a lookup stops early.
 *
 * The adapter (`fetchBscCardTeamNames`) marks cards it never asked
 * `skipped: true` (a 429, an open cooldown, or a wave in which every card
 * failed). From then on this fetch must not ask BSC about the remaining
 * chunks either: asking inside a block only extends it. The remaining cards
 * are recorded as FAILED lookups (never as "BSC has no team", never with a
 * guessed team), so their rows still go `ready` and Confirm unlocks; a failed
 * lookup is what makes the commit queue the card on the `bscTeamPool` lane
 * (commitCardChecklist.teamAnswers.test.ts pins that half).
 *
 * Both marketplaces are module-mocked (no live server; NEO-247); the mock
 * mirrors teamsSettled's, plus the `skipped` field and `waitKey` arg.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

type Card = {
  cardNumber: string;
  cardName: string;
  platformRef?: string;
  sourceBscSetSlug?: string;
  sourceSlSetId?: string;
  teams?: string[];
};

const mockState = vi.hoisted(() => ({
  bscCards: [] as Card[],
  /** The refs each chunk's lookup was asked for, in order. */
  chunksAsked: [] as string[][],
  /** What the lookup does for the Nth chunk (1-based); default: answers every ref. */
  behave: undefined as
    | undefined
    | ((call: number, refs: string[]) => "answer" | "throw" | "skipAll" | { answerFirst: number }),
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
        sourceFacet: v.optional(v.union(v.literal("setName"), v.literal("variantName"))),
        waitKey: v.optional(v.string()),
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
      args: { bscCardIds: v.array(v.string()), waitKey: v.optional(v.string()) },
      returns: v.array(
        v.object({
          bscCardId: v.string(),
          rawTeamName: v.string(),
          teamNames: v.array(v.string()),
          success: v.boolean(),
          attributeTokens: v.array(v.string()),
          skipped: v.optional(v.literal(true)),
        }),
      ),
      handler: async (_ctx, args) => {
        mockState.chunksAsked.push(args.bscCardIds);
        const call = mockState.chunksAsked.length;
        const what = mockState.behave?.(call, args.bscCardIds) ?? "answer";
        if (what === "throw") throw new Error("lookup chunk failed");
        const answered = what === "answer" ? Infinity : what === "skipAll" ? 0 : what.answerFirst;
        return args.bscCardIds.map((bscCardId, i) =>
          i < answered
            ? { bscCardId, rawTeamName: "Reds", teamNames: ["Reds"], success: true, attributeTokens: [] }
            : { bscCardId, rawTeamName: "", teamNames: [], success: false, attributeTokens: [], skipped: true as const },
        );
      },
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
      returns: v.object({ success: v.boolean(), cards: v.array(v.any()), message: v.optional(v.string()) }),
      handler: async () => ({ success: true, cards: [] }),
    }),
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_user_341",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_341",
  name: "Admin",
  role: "admin",
};

/**
 * A four-level chain, with each side's SET link switchable.
 *
 * `sport` and `year` always carry both marketplaces' ids: those are query
 * SCOPE — SportLots' `sprt`/`yr` and BSC's own two facets — and every real
 * chain has them. They are exactly what must NOT make a set look attached, so
 * they stay on even in the fixtures that expect one side or none.
 */
async function seedTree(
  t: ReturnType<typeof convexTest>,
  opts: { bscSet: boolean; slSet: boolean },
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
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
      // The BSC set link. Untagged, which is the ordinary synced shape: the
      // level rule resolves a setName row's slug to the `setName` facet.
      platformData: opts.bscSet ? { bsc: { b0: "topps" } } : {},
      ...(opts.bscSet ? { platformSlotSeq: { bsc: 1 } } : {}),
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    return await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {
        // `variant` is query scope for BSC, and mandatory for a checklist
        // fetch — it is carried whenever the BSC set is, so the BSC side is
        // resolvable rather than merely attached.
        ...(opts.bscSet ? { bsc: { b0: "base" } } : {}),
        // SportLots has no setName level: its one flat set id lives here.
        ...(opts.slSet ? { sportlots: { s0: "189991" } } : {}),
      },
      ...(opts.bscSet ? { platformFacets: { bsc: { b0: "variant" } } } : {}),
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
  });
}

const bscCard = (n: string, teams?: string[]): Card => ({
  cardNumber: n,
  cardName: `BSC Card ${n}`,
  platformRef: `bsc-${n}`,
  sourceBscSetSlug: "topps",
  ...(teams ? { teams } : {}),
});

const slCard = (n: string): Card => ({
  cardNumber: n,
  cardName: `SL Card ${n}`,
  platformRef: `2021 Topps #${n}`,
  sourceSlSetId: "189991",
});

/** What the pairing dialog's subscription would show right now. */
async function view(t: ReturnType<typeof convexTest>, rowId: Id<"selectorOptions">) {
  return t
    .withIdentity(ADMIN)
    .query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: rowId,
    });
}


beforeEach(() => {
  mockState.bscCards = [];
  mockState.chunksAsked = [];
  mockState.behave = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

/** The fetch loop's own chunk size (TEAM_LOOKUP_CHUNK, private to selectorOptions). */
const CHUNK = 50;

async function fetchWith(count: number) {
  const t = convexTest(schema, modules);
  const rowId = await seedTree(t, { bscSet: true, slSet: false });
  mockState.bscCards = Array.from({ length: count }, (_, i) => bscCard(String(i + 1)));
  const result = await t.withIdentity(ADMIN).action(api.selectorOptions.fetchCardChecklist, {
    selectorOptionId: rowId,
  });
  return { t, rowId, result, after: await view(t, rowId) };
}

describe("fetchCardChecklist — the team lookup stops asking BSC once a chunk stops early (PR 451)", () => {
  test("control: with no stop every chunk is asked", async () => {
    const { after } = await fetchWith(CHUNK + 10);
    expect(mockState.chunksAsked.map((c) => c.length)).toEqual([CHUNK, 10]);
    expect(after.cards.every((c) => c.teamLookup === "answered")).toBe(true);
  });

  test("a chunk answered with skipped cards means the next chunk is never asked", async () => {
    mockState.behave = () => "skipAll";
    const { after, result } = await fetchWith(CHUNK + 10);

    expect(mockState.chunksAsked.map((c) => c.length)).toEqual([CHUNK]);
    // Every card, asked or not, settles as a FAILED lookup with no team.
    expect(after).toMatchObject({ total: CHUNK + 10, ready: CHUNK + 10 });
    expect(result.readyAfterTeams).toBe(CHUNK + 10);
    for (const card of after.cards) {
      expect(card.teamLookup).toBe("failed");
      expect(card.teams).toBeUndefined();
    }
  });

  test("answers that landed before the stop are kept; only the unasked cards become failed", async () => {
    mockState.behave = () => ({ answerFirst: 12 });
    const { after } = await fetchWith(CHUNK + 5);

    expect(mockState.chunksAsked).toHaveLength(1);
    const byNumber = (n: number) => after.cards.find((c) => c.cardNumber === String(n))!;
    expect(byNumber(1)).toMatchObject({ teamLookup: "answered", teams: ["Reds"] });
    expect(byNumber(12)).toMatchObject({ teamLookup: "answered", teams: ["Reds"] });
    expect(byNumber(13).teamLookup).toBe("failed");
    expect(byNumber(13).teams).toBeUndefined();
    expect(byNumber(CHUNK + 5).teamLookup).toBe("failed");
  });

  test("a chunk whose lookup throws stops the rest too, and the fetch still succeeds with every row settled", async () => {
    mockState.behave = () => "throw";
    const { after, result } = await fetchWith(CHUNK + 10);

    expect(result.success).toBe(true);
    expect(mockState.chunksAsked).toHaveLength(1);
    expect(after).toMatchObject({ total: CHUNK + 10, ready: CHUNK + 10 });
    expect(after.cards.every((c) => c.teamLookup === "failed")).toBe(true);
  });

  test("a stop in the second chunk leaves the first chunk's answers alone", async () => {
    mockState.behave = (call) => (call === 1 ? "answer" : "skipAll");
    const { after } = await fetchWith(CHUNK * 2 + 10);

    expect(mockState.chunksAsked.map((c) => c.length)).toEqual([CHUNK, CHUNK]);
    expect(after.cards.filter((c) => c.teamLookup === "answered")).toHaveLength(CHUNK);
    expect(after.cards.filter((c) => c.teamLookup === "failed")).toHaveLength(CHUNK + 10);
  });
});
