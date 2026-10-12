/**
 * NEO-341 — the "every team lookup has landed" marker, and when it is written.
 *
 * `fetchCardChecklist` publishes candidates, then patches BSC teams onto them
 * in chunks. The client cannot unlock Confirm on the action's promise: an
 * action resolves on its own response, independently of the subscription that
 * carries the `runMutation` writes it made, so the last chunk's teams could
 * arrive after the operator had confirmed without them. The client now waits
 * for its subscription to show `ready === total` (with `total` equal to the
 * reported `candidateCount`).
 *
 * That only works if `ready === total` is reached by the LAST lookup write and
 * by nothing earlier — and if it is reached at all. Before this, every row was
 * written `pending` whenever any row needed a lookup and only looked-up rows
 * were flipped, so a set with any parsed team never got there. These tests pin
 * both halves against the real action, with both marketplaces module-mocked
 * (no live server; NEO-247).
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
  slCards: [] as Card[],
  /** Team per BSC ref; a ref absent here resolves to "no team". */
  teamByRef: {} as Record<string, string>,
  /** Called at the start of every team-lookup chunk, with that chunk's refs. */
  onLookup: undefined as undefined | ((refs: string[]) => Promise<void>),
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
      handler: async (_ctx, args): Promise<Record<string, string>> => {
        await mockState.onLookup?.(args.bscCardIds);
        const out: Record<string, string> = {};
        for (const ref of args.bscCardIds) {
          const team = mockState.teamByRef[ref];
          if (team) out[ref] = team;
        }
        return out;
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
  mockState.slCards = [];
  mockState.teamByRef = {};
  mockState.onLookup = undefined;
});

describe("fetchCardChecklist — ready === total is the end of the team lookups (NEO-341)", () => {
  test("rows with no lookup owed land ready; looked-up rows stay pending until their chunk is written", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    // 60 BSC cards needing a lookup = two chunks (50 + 10); one BSC card whose
    // team came from the parse; two SportLots-only cards (no BSC ref to look
    // anything up by). Distinct numbers, so nothing auto-matches.
    mockState.bscCards = [
      ...Array.from({ length: 60 }, (_, i) => bscCard(String(i + 1))),
      bscCard("100", ["Mets"]),
    ];
    mockState.slCards = [slCard("200"), slCard("201")];
    mockState.teamByRef = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`bsc-${i + 1}`, `Team ${i + 1}`]),
    );

    // Snapshot the subscription at the START of each chunk's lookup, i.e.
    // after every write that precedes it.
    const before: Array<{ chunk: string[]; ready: number; total: number }> = [];
    mockState.onLookup = async (refs) => {
      const v = await view(t, rowId);
      before.push({ chunk: refs, ready: v.ready, total: v.total });
    };

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(true);
    expect(result.candidateCount).toBe(63);
    expect(before.map((b) => b.chunk.length)).toEqual([50, 10]);
    // Before the first chunk: the whole batch is there and exactly the three
    // rows that owe no lookup are ready.
    expect(before[0]).toMatchObject({ total: 63, ready: 3 });
    // Before the LAST chunk: still short by exactly that chunk — the marker
    // cannot be reached by anything earlier than the last lookup write.
    expect(before[1]).toMatchObject({ total: 63, ready: 53 });

    // After the action: every row ready, and every looked-up team on its row.
    const after = await view(t, rowId);
    expect(after.total).toBe(result.candidateCount);
    expect(after.ready).toBe(after.total);
    for (let i = 1; i <= 60; i++) {
      const card = after.cards.find((c) => c.cardNumber === String(i));
      expect(card?.teams).toEqual([`Team ${i}`]);
      expect(card?.teamResolved).toBe(true);
    }
    expect(after.cards.find((c) => c.cardNumber === "100")?.teams).toEqual([
      "Mets",
    ]);
  });

  test("a lookup that finds no team still settles its row", async () => {
    // BSC has no team for an insert or a checklist card. That is an answer:
    // leaving the row pending would hold Confirm shut forever.
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: false });
    mockState.bscCards = [bscCard("1"), bscCard("2")];
    mockState.teamByRef = { "bsc-1": "Reds" };

    await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    const after = await view(t, rowId);
    expect(after).toMatchObject({ total: 2, ready: 2 });
    expect(after.cards.find((c) => c.cardNumber === "2")?.teams).toBeUndefined();
  });

  test("a set where every team came from the parse is settled the moment it is written", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.bscCards = [bscCard("1", ["Reds"])];
    mockState.slCards = [slCard("2")];
    let lookups = 0;
    mockState.onLookup = async () => {
      lookups++;
    };

    await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(lookups).toBe(0);
    expect(await view(t, rowId)).toMatchObject({ total: 2, ready: 2 });
  });
});
