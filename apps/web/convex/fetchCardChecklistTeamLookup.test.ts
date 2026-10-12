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
  // NEO-333: both forms of BSC's team value, raw and comma split.
  teamNamesResult: {} as Record<
    string,
    { rawTeamName: string; teamNames: string[] }
  >,
  // NEO-335 — ids whose lookup FAILS (the call itself, not "no team").
  failedIds: [] as string[],
  // NEO-335 — ids the stub leaves out of its answer entirely.
  omittedIds: [] as string[],
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
    // NEO-335: one entry per requested id with the lookup's own success
    // flag. An id absent from `teamNamesResult` ANSWERED with no team; an id
    // in `failedIds` failed.
    fetchBscCardTeamNames: internalAction({
      args: { bscCardIds: v.array(v.string()) },
      returns: v.array(
        v.object({
          bscCardId: v.string(),
          rawTeamName: v.string(),
          teamNames: v.array(v.string()),
          success: v.boolean(),
        }),
      ),
      handler: async (_ctx, args) => {
        mockState.teamLookupCalls.push(args.bscCardIds);
        return args.bscCardIds
          .filter((bscCardId) => !mockState.omittedIds.includes(bscCardId))
          .map((bscCardId) =>
          mockState.failedIds.includes(bscCardId)
            ? { bscCardId, rawTeamName: "", teamNames: [], success: false }
            : {
                bscCardId,
                rawTeamName:
                  mockState.teamNamesResult[bscCardId]?.rawTeamName ?? "",
                teamNames: mockState.teamNamesResult[bscCardId]?.teamNames ?? [],
                success: true,
              },
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
  mockState.failedIds = [];
  mockState.omittedIds = [];
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
    mockState.teamNamesResult = {
      "bsc-50": {
        rawTeamName: "Cincinnati Reds",
        teamNames: ["Cincinnati Reds"],
      },
    };

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
  test("NEO-335: each candidate records how its lookup ended — answered with a team, answered blank, failed", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await seedTree(t);

    mockState.bscCards = [
      { cardNumber: "50", cardName: "Elly De La Cruz", players: ["Elly De La Cruz"], platformRef: "bsc-50" },
      { cardNumber: "51", cardName: "League Leaders", players: ["A", "B"], platformRef: "bsc-51" },
      { cardNumber: "52", cardName: "Bobby Witt Jr.", players: ["Bobby Witt Jr."], platformRef: "bsc-52" },
      // Team from the bulk parse: no lookup, so no outcome recorded at all.
      { cardNumber: "53", cardName: "Royals", teams: ["Kansas City Royals"], players: ["Royals"], platformRef: "bsc-53" },
    ];
    mockState.teamNamesResult = {
      "bsc-50": {
        rawTeamName: "Cincinnati Reds",
        teamNames: ["Cincinnati Reds"],
      },
    };
    mockState.failedIds = ["bsc-52"];

    const result = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(result.success).toBe(true);
    expect(mockState.teamLookupCalls).toEqual([["bsc-50", "bsc-51", "bsc-52"]]);

    const { bscOnly } = await buckets(t, variantTypeId);
    const byNumber = new Map(bscOnly.map((c) => [c.cardNumber, c]));
    expect(byNumber.get("50")).toMatchObject({
      teams: ["Cincinnati Reds"],
      teamLookup: "answered",
      teamResolved: true,
    });
    // BSC answered and has no team on file: an ANSWER, not a failure.
    expect(byNumber.get("51")!.teams).toBeUndefined();
    expect(byNumber.get("51")!.teamLookup).toBe("answered");
    expect(byNumber.get("51")!.teamResolved).toBe(true);
    // The call failed: still released (a failed lookup must not strand its
    // stem), but recorded as failed so the commit queues the retry.
    expect(byNumber.get("52")!.teams).toBeUndefined();
    expect(byNumber.get("52")!.teamLookup).toBe("failed");
    expect(byNumber.get("52")!.teamResolved).toBe(true);
    expect(byNumber.get("53")!.teamLookup).toBeUndefined();
  });

  test("NEO-335: a ref the adapter did not answer for at all is recorded as failed, never as \"no team\"", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await seedTree(t);

    mockState.bscCards = [
      { cardNumber: "60", cardName: "Someone", players: ["Someone"], platformRef: "bsc-60" },
    ];
    // The adapter returns an entry for nobody: a missing answer is not an
    // answer, so the commit must still queue the retry.
    mockState.omittedIds = ["bsc-60"];

    await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const { bscOnly } = await buckets(t, variantTypeId);
    expect(bscOnly).toHaveLength(1);
    expect(bscOnly[0].teams).toBeUndefined();
    expect(bscOnly[0].teamLookup).toBe("failed");
  });

  test("NEO-333 x NEO-335: a comma-joined answer carries its split parts AND the answered outcome", async () => {
    // Both merges' rules on one card: the split decides which names the card
    // carries (no NB team matches the whole string, so the parts), and the
    // lookup outcome still rides to the commit beside them.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const variantTypeId = await seedTree(t);

    mockState.bscCards = [
      { cardNumber: "70", cardName: "Dual Prospects", players: ["A", "B"], platformRef: "bsc-70" },
      { cardNumber: "71", cardName: "Someone", players: ["Someone"], platformRef: "bsc-71" },
    ];
    mockState.teamNamesResult = {
      "bsc-70": {
        rawTeamName: "Cleveland Guardians, Washington Nationals",
        teamNames: ["Cleveland Guardians", "Washington Nationals"],
      },
      // A failed call's value is never used, even if a stub supplied one.
      "bsc-71": { rawTeamName: "Boston Red Sox", teamNames: ["Boston Red Sox"] },
    };
    mockState.failedIds = ["bsc-71"];

    await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const { bscOnly } = await buckets(t, variantTypeId);
    const byNumber = new Map(bscOnly.map((c) => [c.cardNumber, c]));
    expect(byNumber.get("70")).toMatchObject({
      teams: ["Cleveland Guardians", "Washington Nationals"],
      teamLookup: "answered",
      teamResolved: true,
    });
    expect(byNumber.get("71")!.teams).toBeUndefined();
    expect(byNumber.get("71")!.teamLookup).toBe("failed");
  });
});
