/**
 * NEO-90: integration tests for `fetchCardChecklist`'s (convex/selectorOptions.ts)
 * new synchronous BSC team-lookup wiring — the step inserted right after
 * building the reconciled `out: ReconciledCard[]` array and right before the
 * unknown-player/team bucketing step. This is what moved team resolution
 * for regular player cards from the old background
 * `processBscTeamEnrichmentQueue` (still covered separately in
 * `convex/bscTeamEnrichmentQueue.test.ts` / `convex/featurePropagation.test.ts`
 * as a historical-backfill/retry safety net) into the SAME request that
 * builds the "Confirm New Players & Teams" preview dialog.
 *
 * Lives at the convex/ ROOT (not co-located under convex/adapters/) for the
 * same import.meta.glob reason documented in
 * `convex/bscTeamEnrichmentQueue.test.ts`.
 *
 * `fetchCardChecklist` fans out to BOTH `api.adapters.buysportscards.fetchBscChecklist`
 * and `api.adapters.sportlots.fetchSportLotsChecklist` before reconciling —
 * both of those real adapters need marketplace credentials (BSC bearer
 * token / SL session cookie) that aren't worth seeding here just to reach
 * the reconciliation logic this file actually targets. Instead, following
 * the `vi.mock` module-replacement convention already established in
 * `convex/bscTeamEnrichmentQueue.tolerance.test.ts` (there: mocking
 * `resolveBscCardTeam` to force a throw), we mock BOTH adapter actions'
 * exports directly so `fetchCardChecklist` gets controlled BSC/SL card
 * lists without any real network I/O, and mock
 * `internal.adapters.buysportscards.fetchBscCardTeamNames` itself (per the
 * task brief) rather than mocking raw `fetch` a third time — this test
 * targets fetchCardChecklist's OWN wiring (what it does with the map that
 * comes back), not fetchBscCardTeamNames's internals (already covered in
 * `convex/fetchBscCardTeamNames.test.ts`).
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

type BscCard = {
  cardNumber: string;
  cardName: string;
  team?: string;
  teams?: string[];
  players?: string[];
  attributes?: string[];
  printRun?: number;
  autographType?: string;
  cardVariation?: string;
  platformRef?: string;
  sportlotsRef?: string;
  sourceBscSetSlug?: string;
};

type SlCard = {
  cardNumber: string;
  cardName: string;
  team?: string;
  teams?: string[];
  players?: string[];
  attributes?: string[];
  printRun?: number;
  autographType?: string;
  cardVariation?: string;
  platformRef?: string;
  sportlotsRef?: string;
};

// vi.mock factories are hoisted above imports/other module-scope code, so
// mutable per-test fixtures must live behind vi.hoisted rather than a plain
// module-scope `let`.
const mockState = vi.hoisted(() => ({
  bscCards: [] as BscCard[],
  slCards: [] as SlCard[],
  teamNamesResult: {} as Record<string, string>,
  teamLookupCalls: [] as string[][],
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
      handler: async (): Promise<{ success: boolean; cards: BscCard[] }> => ({
        success: true,
        cards: mockState.bscCards,
      }),
    }),
    fetchBscCardTeamNames: internalAction({
      args: { bscCardIds: v.array(v.string()) },
      returns: v.record(v.string(), v.string()),
      handler: async (_ctx, args): Promise<Record<string, string>> => {
        mockState.teamLookupCalls.push(args.bscCardIds);
        return mockState.teamNamesResult;
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
      handler: async (): Promise<{ success: boolean; cards: SlCard[] }> => ({
        success: true,
        cards: mockState.slCards,
      }),
    }),
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_001",
  name: "Admin User",
  role: "admin",
};

/** The sport row of the seeded chain — what the client reads off its own
 *  `getAncestorChain` subscription and hands to resolve/commit. */
async function sportRowId(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("selectorOptions").collect();
    return rows.find((r) => r.level === "sport")!._id;
  });
}

/**
 * The candidate rows as the pairing dialog receives them.
 *
 * This is the assertion surface for team enrichment, and it is the only one:
 * `fetchCardChecklist` returns a count and a message, and the resolved team
 * names reach the client by being PATCHED onto these rows (chunk by chunk, as
 * each BSC lookup lands) rather than by riding back on the action's return.
 */
async function buckets(
  t: ReturnType<typeof convexTest>,
  id: Id<"selectorOptions">,
) {
  const live = await t
    .withIdentity(ADMIN_IDENTITY)
    .query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
  return {
    matched: live.cards.filter((c) => c.bucket === "matched"),
    bscOnly: live.cards.filter((c) => c.bucket === "bscOnly"),
    slOnly: live.cards.filter((c) => c.bucket === "slOnly"),
  };
}

/**
 * A candidate row reduced to the card shape the operator confirms with.
 *
 * Mirrors `CardChecklist`'s own `toCard`: the staging row carries bookkeeping
 * (`_id`, `stem`, `bucket`, `teamResolved`) that `previewCardValidator` — a
 * strict object — would reject on the way into resolve/commit.
 */
function toPairingCard(
  c: Awaited<ReturnType<typeof buckets>>["bscOnly"][number],
) {
  return {
    cardNumber: c.cardNumber,
    cardName: c.cardName,
    teams: c.teams,
    players: c.players,
    attributes: c.attributes,
    isRookie: c.isRookie,
    isRelic: c.isRelic,
    printRun: c.printRun,
    autographType: c.autographType,
    cardVariation: c.cardVariation,
    isVariation: c.isVariation,
    platformData: c.platformData,
  };
}

/**
 * Seed a sport -> year -> setName -> variantType chain with BSC platform
 * slugs on sport/year/setName (fetchCardChecklist's BSC_REQUIRED_LEVELS
 * precondition) and return the variantType leaf id — the id callers pass
 * as `selectorOptionId` to `fetchCardChecklist`.
 */
async function seedTree(t: ReturnType<typeof convexTest>): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
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
      value: "2024",
      platformData: { bsc: { b0: "2024" }, sportlots: { s0: "2024" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [yearId] });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: { bsc: { b0: "2024-topps" } },
      platformSlotSeq: { bsc: 1 },
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(yearId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      // NEO-239 — BSC's `variant` axis comes from a TAGGED slot on this row,
      // never from its display value. An empty `platformData` here used to
      // still produce `variant: ["base"]` on the wire (derived from the name);
      // now it means the BSC side of the chain is unresolvable and skipped.
      platformData: { bsc: { b0: "base" } },
      platformFacets: { bsc: { b0: "variant" } },
      primaryPlatformId: { bsc: "b0" },
      platformSlotSeq: { bsc: 1 },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    return variantTypeId;
  });
}

beforeEach(() => {
  mockState.bscCards = [];
  mockState.slCards = [];
  mockState.teamNamesResult = {};
  mockState.teamLookupCalls = [];
});

describe("fetchCardChecklist's synchronous BSC team-lookup wiring (NEO-90)", () => {
  test("a card whose team is already recoverable (TC-suffix) is excluded from the lookup batch entirely", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await seedTree(t);

    mockState.bscCards = [
      {
        cardNumber: "1",
        cardName: "Kansas City Royals",
        teams: ["Kansas City Royals"], // already resolved via parsePlayersField's TC-suffix handling
        players: ["Kansas City Royals"],
        platformRef: "bsc-1",
      },
    ];

    const result = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: variantTypeId,
    });

    expect(result.success).toBe(true);
    expect(mockState.teamLookupCalls).toHaveLength(0);
    // NEO-137: BSC-only candidate — nothing is an NB card until pairing.
    const { bscOnly } = await buckets(t, variantTypeId);
    expect(bscOnly).toHaveLength(1);
    expect(bscOnly[0].teams).toEqual(["Kansas City Royals"]);
  });

  test("a card with a BSC ref and no team gets resolved via fetchBscCardTeamNames and flows into unknownTeams", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await seedTree(t);

    mockState.bscCards = [
      {
        cardNumber: "50",
        cardName: "Elly De La Cruz",
        players: ["Elly De La Cruz"],
        platformRef: "bsc-50",
        // no team/teams — parsePlayersField's bulk parse found nothing.
      },
    ];
    mockState.teamNamesResult = { "bsc-50": "Cincinnati Reds" };

    const result = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: variantTypeId,
    });

    expect(result.success).toBe(true);
    expect(mockState.teamLookupCalls).toEqual([["bsc-50"]]);
    // The resolved name has to be ON THE ROW the modal reads. This is the
    // whole point of the enrichment: the lookup is what the fetch spends most
    // of its ~80s on, and until it lands here the operator confirms a card
    // with no team and the review wizard never asks about "Cincinnati Reds".
    const { bscOnly } = await buckets(t, variantTypeId);
    expect(bscOnly).toHaveLength(1);
    expect(bscOnly[0].teams).toEqual(["Cincinnati Reds"]);

    // NEO-137: unknown-entity bucketing moved out of fetch — it now runs on
    // the CONFIRMED card set, after the operator pairs. `sportId` comes off
    // the ancestor chain the client already subscribes to, not off the fetch.
    const resolved = await asAdmin.action(
      api.selectorOptions.resolveChecklistEntities,
      {
        selectorOptionId: variantTypeId,
        sportId: await sportRowId(t),
        cards: bscOnly.map(toPairingCard),
      },
    );
    expect(resolved.unknownTeams).toContain("Cincinnati Reds");
  });

  test("a SportLots-only card (no platformData.bsc) is skipped entirely — not in the lookup batch, no team populated", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await seedTree(t);

    // BSC returns nothing for this card; it only exists on SL and is
    // never claimed by the BSC walk, so it surfaces as an unmatched="bsc"
    // row carrying only platformData.sportlots.
    mockState.bscCards = [];
    mockState.slCards = [
      {
        cardNumber: "77",
        cardName: "Some SL-only Card",
        players: ["Some Player"],
        platformRef: "sl-77",
      },
    ];

    const result = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: variantTypeId,
    });

    expect(result.success).toBe(true);
    expect(mockState.teamLookupCalls).toHaveLength(0);
    // NEO-137: an SL-only card is a candidate in the unmatched-SL column. It
    // is NOT turned into an NB card unless the operator keeps it — which is
    // what stops a shared SL set's sibling-owned cards being invented here.
    const { slOnly } = await buckets(t, variantTypeId);
    expect(slOnly).toHaveLength(1);
    expect(slOnly[0].platformData.bsc).toBeUndefined();
    expect(slOnly[0].platformData.sportlots).toEqual({ ref: "sl-77" });
    expect(slOnly[0].teams).toBeUndefined();
  });

  test("needsTeamLookup empty (mixed batch, nothing needs lookup) — fetchBscCardTeamNames is never called", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await seedTree(t);

    mockState.bscCards = [
      {
        cardNumber: "1",
        cardName: "Kansas City Royals",
        teams: ["Kansas City Royals"], // already resolved
        players: ["Kansas City Royals"],
        platformRef: "bsc-1",
      },
    ];
    mockState.slCards = [
      {
        cardNumber: "77",
        cardName: "Some SL-only Card", // no BSC ref — also excluded
        players: ["Some Player"],
        platformRef: "sl-77",
      },
    ];

    const result = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: variantTypeId,
    });

    expect(result.success).toBe(true);
    expect(mockState.teamLookupCalls).toHaveLength(0);
    const { bscOnly, slOnly } = await buckets(t, variantTypeId);
    expect(bscOnly).toHaveLength(1);
    expect(slOnly).toHaveLength(1);
  });
});
