/**
 * NEO-137 — a confirmed card pairing must SURVIVE a re-sync.
 *
 * This is an explicit acceptance criterion, and it is the criterion that makes
 * the whole feature real. The BSC↔SL pairing for a shared marketplace set is
 * NOT inferable — two series can each contain a card #1, with nothing in the
 * data to separate them — so if a re-sync re-derived the pairing from scratch
 * it would quietly overwrite the operator's answer with a guess, and the
 * operator would have to redo the work on every fetch.
 *
 * `fetchCardChecklist` therefore reads back the already-committed rows and
 * replays the stored BSC-ref → SL-ref binding ahead of every heuristic.
 *
 * The scenario below is 1996 Score reduced to its essentials: BSC card #1
 * belongs with SportLots "#B1", not the "#1" the number heuristic would grab.
 *
 * Adapter mocking follows the convention in
 * `convex/fetchCardChecklistTeamLookup.test.ts`.
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
  subject: "admin_user_137",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_137",
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
      value: "1996",
      platformData: { bsc: { b0: "1996" } },
      platformSlotSeq: { bsc: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Score",
      platformData: { bsc: { b0: "1996-score" } },
      platformSlotSeq: { bsc: 1 },
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    // The insert row: its own BSC series set, plus the SHARED SportLots set
    // that a sibling series also maps to.
    return await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Dugout Collection Artist's Proofs Series 2",
      platformData: {
        bsc: { b0: "dcap-series-2" },
        sportlots: { s0: "884412" },
      },
      primaryPlatformId: { bsc: "b0", sportlots: "s0" },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
  });
}

beforeEach(() => {
  mockState.bscCards = [];
  mockState.slCards = [];
});

describe("fetchCardChecklist — stored pairing survives a re-sync (NEO-137)", () => {
  test("an operator's BSC→SL binding is replayed instead of re-guessed", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const insertId = await seedTree(t);

    // The shared SportLots set returns BOTH series' cards. "#1" is the sibling
    // series' card; "#B1" is ours. Nothing in the data says so.
    mockState.bscCards = [
      {
        cardNumber: "1",
        cardName: "Cal Ripken Jr.",
        players: ["Cal Ripken Jr."],
        platformRef: "bsc-card-1",
        sourceBscSetSlug: "dcap-series-2",
      },
    ];
    mockState.slCards = [
      {
        cardNumber: "1",
        cardName: "Ken Griffey Jr.",
        platformRef: "#1 Ken Griffey Jr.",
        sportlotsRef: "1",
        sourceSlSetId: "884412",
      },
      {
        cardNumber: "B1",
        cardName: "Cal Ripken Jr.",
        platformRef: "#B1 Cal Ripken Jr.",
        sportlotsRef: "B1",
        sourceSlSetId: "884412",
      },
    ];

    // FIRST sync — the number heuristic grabs the WRONG SL card (#1), which is
    // exactly why this needs an operator.
    const first = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: insertId,
    });
    expect(first.autoMatched).toHaveLength(1);
    expect(first.autoMatched[0].card.platformData.sportlots?.ref).toBe(
      "#1 Ken Griffey Jr.",
    );

    // The operator overrides it and commits the correct pairing.
    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: insertId,
      sportId: (await t.run(async (ctx) => {
        const rows = await ctx.db.query("selectorOptions").collect();
        return rows.find((r) => r.level === "sport")!._id;
      })) as Id<"selectorOptions">,
      cards: [
        {
          cardNumber: "1",
          cardName: "Cal Ripken Jr.",
          platformData: {
            bsc: { ref: "bsc-card-1", setId: "dcap-series-2" },
            sportlots: { ref: "#B1 Cal Ripken Jr.", setId: "884412" },
          },
        },
      ],
    });

    // RE-SYNC — the heuristic would still say "#1", but the operator's answer
    // must win.
    const second = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: insertId,
    });

    expect(second.autoMatched).toHaveLength(1);
    expect(second.autoMatched[0].card.platformData.sportlots?.ref).toBe(
      "#B1 Cal Ripken Jr.",
    );
    // A replayed operator decision is certain — it is not a fresh guess.
    expect(second.autoMatched[0].confidence).toBe(1);
    // The sibling series' card is left unassigned, not silently absorbed.
    expect(
      second.unmatchedSl.map((c) => c.platformData.sportlots?.ref),
    ).toEqual(["#1 Ken Griffey Jr."]);
  });

  /**
   * SECURITY REGRESSION (audit finding F1).
   *
   * `resolveCardSlots` used to ALLOCATE a slot for any marketplace set id a
   * committed card named. On the BSC side that id is `r.setName`, taken
   * straight from the marketplace's bulk-upload response — third-party input.
   * So a rename or a display-name/slug divergence would silently grow this
   * row's mapping, and `fetchCardChecklist` filters its NEXT BSC query on ALL
   * attached slots, meaning an injected slug would widen a privileged outbound
   * fetch to an unrelated set. It also contradicted the invariant written on
   * `cardPlatformRefValidator` in schema.ts.
   *
   * Attaching a marketplace set is an operator action. An unattributable ref
   * is KEPT (it is still the card's marketplace identity) but carries no
   * `src`, so it simply cannot participate in sync-by-set yet.
   */
  test("a card naming an UNATTACHED marketplace set does not attach it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const insertId = await seedTree(t);
    const sportId = (await t.run(async (ctx) => {
      const rows = await ctx.db.query("selectorOptions").collect();
      return rows.find((r) => r.level === "sport")!._id;
    })) as Id<"selectorOptions">;

    const before = await t.run(async (ctx) => ctx.db.get(insertId));

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: insertId,
      sportId,
      cards: [
        {
          cardNumber: "1",
          cardName: "Cal Ripken Jr.",
          platformData: {
            // Neither of these is attached to the row.
            bsc: { ref: "bsc-card-1", setId: "some-other-bsc-set" },
            sportlots: { ref: "#B1 Cal Ripken Jr.", setId: "999999" },
          },
        },
      ],
    });

    const after = await t.run(async (ctx) => ctx.db.get(insertId));
    // The parent row's mapping is untouched — no slot was invented for it.
    expect(after!.platformData).toEqual(before!.platformData);
    expect(after!.platformSlotSeq).toEqual(before!.platformSlotSeq);

    // The refs survive, unattributed, rather than being dropped.
    const stored = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: insertId,
    });
    expect(stored[0].platformData.bsc).toEqual({ ref: "bsc-card-1" });
    expect(stored[0].platformData.sportlots).toEqual({
      ref: "#B1 Cal Ripken Jr.",
    });
  });

  test("the stored ref resolves to a slot on the row, so it round-trips", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const insertId = await seedTree(t);
    const sportId = (await t.run(async (ctx) => {
      const rows = await ctx.db.query("selectorOptions").collect();
      return rows.find((r) => r.level === "sport")!._id;
    })) as Id<"selectorOptions">;

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: insertId,
      sportId,
      cards: [
        {
          cardNumber: "1",
          cardName: "Cal Ripken Jr.",
          platformData: {
            bsc: { ref: "bsc-card-1", setId: "dcap-series-2" },
            sportlots: { ref: "#B1 Cal Ripken Jr.", setId: "884412" },
          },
        },
      ],
    });

    const stored = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: insertId,
    });
    expect(stored).toHaveLength(1);
    // The wire named marketplace SET ids; storage names SLOTS on this row.
    expect(stored[0].platformData.bsc).toEqual({ ref: "bsc-card-1", src: "b0" });
    expect(stored[0].platformData.sportlots).toEqual({
      ref: "#B1 Cal Ripken Jr.",
      src: "s0",
    });
  });
});
