/**
 * PR 451 (NEO-478) — `fetchCardChecklist` with the operator's publisher
 * checklist (`publishedChecklist` arg).
 *
 * What is pinned here (the pairing's own rules are in
 * `lib/checklists/match-published-checklist.test.ts`):
 *  - a card the checklist matched makes ZERO BSC card-listing calls; only the
 *    cards it did not match are looked up (D2), and the matched cards whose
 *    row names no team (no claim, wrapper rule 8; B1);
 *  - `checklistTeams` {matched, total}; players fill where the marketplace has
 *    none; player and team disagreements become `checklistConflict` and keep
 *    the marketplace's values (product rules 3 and 8);
 *  - a comma team text is resolved before it is compared, so an "equal" team
 *    disagreement is dropped and a real one carries the resolved names;
 *  - the server re-validates the caps, refusing the run before any
 *    marketplace is asked.
 *
 * Both adapter actions are mocked at the module boundary (the convention of
 * `fetchCardChecklistTeamLookup.test.ts`); nothing here reaches a network.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { MAX_CHECKLIST_TEAM_TEXTS } from "./checklistCandidates";

type BscCard = {
  cardNumber: string;
  cardName: string;
  teams?: string[];
  players?: string[];
  platformRef?: string;
};

const mockState = vi.hoisted(() => ({
  bscCards: [] as BscCard[],
  teamNamesResult: {} as Record<string, { rawTeamName: string; teamNames: string[] }>,
  teamLookupCalls: [] as string[][],
  teamLookupWaitKeys: [] as Array<string | undefined>,
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
      handler: async (): Promise<{ success: boolean; cards: BscCard[] }> => ({
        success: true,
        cards: mockState.bscCards,
      }),
    }),
    fetchBscCardTeamNames: internalAction({
      args: { bscCardIds: v.array(v.string()), waitKey: v.optional(v.string()) },
      returns: v.array(
        v.object({
          bscCardId: v.string(),
          rawTeamName: v.string(),
          teamNames: v.array(v.string()),
          success: v.boolean(),
          skipped: v.optional(v.literal(true)),
        }),
      ),
      handler: async (_ctx, args) => {
        mockState.teamLookupCalls.push(args.bscCardIds);
        mockState.teamLookupWaitKeys.push(args.waitKey);
        return args.bscCardIds.map((bscCardId) => ({
          bscCardId,
          rawTeamName: mockState.teamNamesResult[bscCardId]?.rawTeamName ?? "",
          teamNames: mockState.teamNamesResult[bscCardId]?.teamNames ?? [],
          success: true,
        }));
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
      handler: async () => ({ success: true, cards: [] }),
    }),
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_published_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_published_001",
  name: "Admin User",
  role: "admin",
};

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

/** The staged candidate rows, with the fields the live view does not return. */
async function candidates(t: ReturnType<typeof convexTest>) {
  const rows = await t.run((ctx) => ctx.db.query("checklistCandidates").collect());
  return new Map(rows.map((r) => [r.cardNumber, r]));
}

const bsc = (n: string, extra: Partial<BscCard> = {}): BscCard => ({
  cardNumber: n,
  cardName: `Card ${n}`,
  platformRef: `bsc-${n}`,
  ...extra,
});

beforeEach(() => {
  mockState.bscCards = [];
  mockState.teamNamesResult = {};
  mockState.teamLookupCalls = [];
  mockState.teamLookupWaitKeys = [];
});

async function run(
  publishedChecklist?: {
    rows: { number: string; players: string[]; teams: string[]; subset?: string }[];
  },
  extra: { waitKey?: string } = {},
) {
  const t = convexTest(schema, modules);
  const id = await seedTree(t);
  const result = await t
    .withIdentity(ADMIN_IDENTITY)
    .action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: id,
      ...(publishedChecklist ? { publishedChecklist } : {}),
      ...extra,
    });
  return { t, id, result };
}

describe("fetchCardChecklist with a publisher checklist: who gets looked up", () => {
  test("cards the checklist matched make zero BSC card-listing calls", async () => {
    mockState.bscCards = [
      bsc("1", { players: ["Elly De La Cruz"] }),
      bsc("2", { players: ["Rhett Lowder"] }),
    ];
    const { t, result } = await run({
      rows: [
        { number: "1", players: ["Elly De La Cruz"], teams: ["Cincinnati Reds"] },
        { number: "2", players: ["Rhett Lowder"], teams: ["Cincinnati Reds"] },
      ],
    });
    expect(result.success).toBe(true);
    expect(mockState.teamLookupCalls).toEqual([]);
    const rows = await candidates(t);
    expect(rows.get("1")).toMatchObject({ teams: ["Cincinnati Reds"], teamLookup: "checklist" });
    expect(rows.get("2")).toMatchObject({ teams: ["Cincinnati Reds"], teamLookup: "checklist" });
    expect(result.checklistTeams).toEqual({ matched: 2, total: 2 });
  });

  test("only the unmatched cards get the per-card lookup (D2)", async () => {
    mockState.bscCards = [
      bsc("1", { players: ["A One"] }),
      bsc("2", { players: ["B Two"] }),
      bsc("3", { players: ["C Three"] }),
    ];
    mockState.teamNamesResult = {
      "bsc-2": { rawTeamName: "Boston Red Sox", teamNames: ["Boston Red Sox"] },
      "bsc-3": { rawTeamName: "Chicago Cubs", teamNames: ["Chicago Cubs"] },
    };
    const { t, result } = await run({
      rows: [{ number: "1", players: ["A One"], teams: ["Cincinnati Reds"] }],
    });
    expect(mockState.teamLookupCalls).toEqual([["bsc-2", "bsc-3"]]);
    const rows = await candidates(t);
    expect(rows.get("1")?.teamLookup).toBe("checklist");
    expect(rows.get("2")).toMatchObject({ teams: ["Boston Red Sox"], teamLookup: "answered" });
    expect(result.checklistTeams).toEqual({ matched: 1, total: 3 });
  });

  test("a duplicate number on the marketplace side leaves both cards to the BSC lookup", async () => {
    mockState.bscCards = [
      bsc("5", { players: ["A One"], platformRef: "bsc-5a" }),
      bsc("5", { players: ["B Two"], platformRef: "bsc-5b" }),
    ];
    const { result } = await run({
      rows: [{ number: "5", players: ["A One"], teams: ["Cincinnati Reds"] }],
    });
    expect(mockState.teamLookupCalls.flat().sort()).toEqual(["bsc-5a", "bsc-5b"]);
    expect(result.checklistTeams).toEqual({ matched: 0, total: 2 });
  });

  test("a row that names no team is no claim: the card keeps its BSC lookup and is not counted (B1)", async () => {
    mockState.bscCards = [bsc("1", { players: ["A One"] })];
    mockState.teamNamesResult = {
      "bsc-1": { rawTeamName: "Boston Red Sox", teamNames: ["Boston Red Sox"] },
    };
    const { t, result } = await run({ rows: [{ number: "1", players: ["A One"], teams: [] }] });
    expect(mockState.teamLookupCalls).toEqual([["bsc-1"]]);
    const row = (await candidates(t)).get("1");
    expect(row?.teamLookup).toBe("answered");
    expect(row?.teams).toEqual(["Boston Red Sox"]);
    expect(result.checklistTeams).toEqual({ matched: 0, total: 1 });
  });

  test("a teamless row still fills the players of a card the marketplace gave none, and the card is looked up (B1)", async () => {
    mockState.bscCards = [bsc("1", { players: [] }), bsc("2", { players: ["B Two"] })];
    const { t, result } = await run({
      rows: [
        { number: "1", players: ["Juan Soto"], teams: [] },
        { number: "2", players: ["B Two"], teams: ["New York Mets"] },
      ],
    });
    expect(mockState.teamLookupCalls).toEqual([["bsc-1"]]);
    const rows = await candidates(t);
    expect(rows.get("1")?.players).toEqual(["Juan Soto"]);
    expect(rows.get("1")?.teamLookup).not.toBe("checklist");
    expect(rows.get("2")).toMatchObject({ teams: ["New York Mets"], teamLookup: "checklist" });
    expect(result.checklistTeams).toEqual({ matched: 1, total: 2 });
  });

  test("a teamless row still compares players: a disagreement is carried and the card is looked up (B1)", async () => {
    mockState.bscCards = [bsc("3", { players: ["Pete Alonso"] })];
    const { t } = await run({ rows: [{ number: "3", players: ["Kyle Schwarber"], teams: [] }] });
    expect(mockState.teamLookupCalls).toEqual([["bsc-3"]]);
    expect((await candidates(t)).get("3")?.checklistConflict).toEqual({
      players: { marketplace: ["Pete Alonso"], checklist: ["Kyle Schwarber"] },
    });
  });

  test("a row's subset label is accepted and never read", async () => {
    mockState.bscCards = [bsc("1", { players: ["A One"] })];
    const { t, result } = await run({
      rows: [{ number: "1", players: ["A One"], teams: ["Cincinnati Reds"], subset: "Base" }],
    });
    expect(result.success).toBe(true);
    expect((await candidates(t)).get("1")).toMatchObject({
      teams: ["Cincinnati Reds"],
      teamLookup: "checklist",
    });
  });

  test("without a checklist nothing is reported and every teamless card is looked up", async () => {
    mockState.bscCards = [bsc("1", { players: ["A One"] })];
    const { result } = await run();
    expect(result.checklistTeams).toBeUndefined();
    expect(mockState.teamLookupCalls).toEqual([["bsc-1"]]);
  });

  test("the run's waitKey rides along to the per-card lookup", async () => {
    mockState.bscCards = [bsc("1", { players: ["A One"] })];
    await run(undefined, { waitKey: "run_abc-1" });
    expect(mockState.teamLookupWaitKeys).toEqual(["run_abc-1"]);
  });
});

describe("fetchCardChecklist with a publisher checklist: fills and disagreements", () => {
  test("the row's players fill a card the marketplace gave none", async () => {
    mockState.bscCards = [bsc("1", { players: [] })];
    const { t } = await run({
      rows: [{ number: "1", players: ["Soto", "Judge"], teams: ["New York Yankees"] }],
    });
    const row = (await candidates(t)).get("1");
    expect(row?.players).toEqual(["Soto", "Judge"]);
    expect(row?.checklistConflict).toBeUndefined();
  });

  test("checklist surnames agree with the marketplace's full names: no conflict, full names kept (S4)", async () => {
    mockState.bscCards = [
      bsc("11", { players: ["Pete Alonso", "Kyle Schwarber", "Juan Soto"] }),
    ];
    const { t } = await run({
      rows: [{ number: "11", players: ["Alonso", "Schwarber", "Soto"], teams: ["New York Mets"] }],
    });
    const row = (await candidates(t)).get("11");
    expect(row?.checklistConflict).toBeUndefined();
    expect(row?.players).toEqual(["Pete Alonso", "Kyle Schwarber", "Juan Soto"]);
  });

  test("a player disagreement keeps the marketplace's player and carries both sides", async () => {
    mockState.bscCards = [bsc("3", { players: ["Pete Alonso"], teams: ["New York Mets"] })];
    const { t } = await run({
      rows: [{ number: "3", players: ["Kyle Schwarber"], teams: ["New York Mets"] }],
    });
    const row = (await candidates(t)).get("3");
    expect(row?.players).toEqual(["Pete Alonso"]);
    expect(row?.checklistConflict).toEqual({
      players: { marketplace: ["Pete Alonso"], checklist: ["Kyle Schwarber"] },
    });
  });

  test("a team disagreement keeps the marketplace's team, is not counted as answered and is not looked up", async () => {
    mockState.bscCards = [bsc("3", { players: ["A One"], teams: ["New York Mets"] })];
    const { t, result } = await run({
      rows: [{ number: "3", players: ["A One"], teams: ["Philadelphia Phillies"] }],
    });
    const row = (await candidates(t)).get("3");
    expect(row?.teams).toEqual(["New York Mets"]);
    expect(row?.teamLookup).toBeUndefined();
    expect(row?.checklistConflict).toEqual({
      teams: { marketplace: ["New York Mets"], checklist: ["Philadelphia Phillies"] },
    });
    expect(mockState.teamLookupCalls).toEqual([]);
    expect(result.checklistTeams).toEqual({ matched: 0, total: 1 });
  });

  test("a conflicting comma text is offered as its split, resolved names", async () => {
    mockState.bscCards = [bsc("3", { players: ["A One"], teams: ["New York Mets"] })];
    const { t } = await run({
      rows: [{ number: "3", players: ["A One"], teams: ["Phillies, Braves"] }],
    });
    expect((await candidates(t)).get("3")?.checklistConflict?.teams).toEqual({
      marketplace: ["New York Mets"],
      checklist: ["Phillies", "Braves"],
    });
  });

  test("a team conflict that resolves to the card's own teams is dropped, and the card is checklist-answered", async () => {
    mockState.bscCards = [
      bsc("3", { players: ["A One"], teams: ["New York Mets", "New York Yankees"] }),
    ];
    const { t, result } = await run({
      rows: [{ number: "3", players: ["A One"], teams: ["New York Yankees, New York Mets"] }],
    });
    const row = (await candidates(t)).get("3");
    expect(row?.checklistConflict).toBeUndefined();
    expect(row?.teamLookup).toBe("checklist");
    expect(result.checklistTeams).toEqual({ matched: 1, total: 1 });
  });

  test("a players-only conflict survives when the team conflict is dropped", async () => {
    mockState.bscCards = [
      bsc("3", { players: ["A One"], teams: ["New York Mets", "New York Yankees"] }),
    ];
    const { t } = await run({
      rows: [{ number: "3", players: ["B Two"], teams: ["New York Yankees, New York Mets"] }],
    });
    const row = (await candidates(t)).get("3");
    expect(row?.checklistConflict).toEqual({
      players: { marketplace: ["A One"], checklist: ["B Two"] },
    });
  });

  test("a comma text over the team cap is unusable: the card is looked up like an unmatched one", async () => {
    mockState.bscCards = [bsc("3", { players: ["A One"] })];
    const nine = Array.from({ length: 9 }, (_, i) => `Team${i}`).join(", ");
    const { t, result } = await run({
      rows: [{ number: "3", players: ["A One"], teams: [nine] }],
    });
    expect(mockState.teamLookupCalls).toEqual([["bsc-3"]]);
    expect((await candidates(t)).get("3")?.teamLookup).not.toBe("checklist");
    expect(result.checklistTeams).toEqual({ matched: 0, total: 1 });
  });
});

describe("fetchCardChecklist with a publisher checklist: more comma team texts than the resolver takes", () => {
  test("the first MAX_CHECKLIST_TEAM_TEXTS are resolved; cards past the cap fall back to the BSC lookup, no error", async () => {
    // One card per distinct comma text, plus two past the cap. Texts are
    // collected in card order, so cards n and n+1 are the ones left over.
    const n = MAX_CHECKLIST_TEAM_TEXTS;
    const total = n + 2;
    mockState.bscCards = Array.from({ length: total }, (_, i) =>
      bsc(String(i + 1), { players: [`P${i + 1}`] }),
    );
    const { t, result } = await run({
      rows: Array.from({ length: total }, (_, i) => ({
        number: String(i + 1),
        players: [`P${i + 1}`],
        teams: [`East${i + 1}, West${i + 1}`],
      })),
    });
    expect(result.success).toBe(true);
    expect(result.checklistTeams).toEqual({ matched: n, total });
    // Only the two past the cap are looked up, and nothing else.
    expect(mockState.teamLookupCalls.flat().sort()).toEqual([`bsc-${n + 1}`, `bsc-${n + 2}`]);
    const rows = await candidates(t);
    expect(rows.get("1")).toMatchObject({ teams: ["East1", "West1"], teamLookup: "checklist" });
    expect(rows.get(String(n))).toMatchObject({
      teams: [`East${n}`, `West${n}`],
      teamLookup: "checklist",
    });
    for (const past of [n + 1, n + 2]) {
      const row = rows.get(String(past));
      expect(row?.teamLookup).not.toBe("checklist");
      // No checklist team was written: the comma text is not on the card.
      expect(row?.teams ?? []).not.toContain(`East${past}`);
      expect(row?.checklistConflict).toBeUndefined();
    }
  });
});

describe("fetchCardChecklist with a publisher checklist: the server re-checks the caps", () => {
  const rejects = async (
    published: { rows: { number: string; players: string[]; teams: string[] }[] },
    message: RegExp,
  ) => {
    mockState.bscCards = [bsc("1", { players: ["A One"] })];
    await expect(run(published)).rejects.toThrow(message);
    // Refused before any marketplace is asked.
    expect(mockState.teamLookupCalls).toEqual([]);
  };

  test("refuses more than 2000 rows", async () => {
    await rejects(
      { rows: Array.from({ length: 2001 }, (_, i) => ({ number: String(i), players: [], teams: [] })) },
      /2001 rows; the limit is 2000/,
    );
  });

  test("accepts exactly 2000 rows", async () => {
    mockState.bscCards = [bsc("1", { players: ["A One"] })];
    const { result } = await run({
      rows: Array.from({ length: 2000 }, (_, i) => ({ number: String(i + 1), players: [], teams: [] })),
    });
    expect(result.success).toBe(true);
  });

  test("refuses a card number over the name cap", async () => {
    await rejects({ rows: [{ number: "9".repeat(121), players: [], teams: [] }] }, /Row 1 .*card number/);
  });

  test("refuses a player name over the cap, naming the row by position only", async () => {
    const long = "P".repeat(121);
    await rejects(
      { rows: [{ number: "1", players: [], teams: [] }, { number: "2", players: [long], teams: [] }] },
      /Row 2 of the publisher's checklist has a player name over 120/,
    );
  });

  test("refuses a row naming more than 20 players", async () => {
    await rejects(
      { rows: [{ number: "1", players: Array.from({ length: 21 }, (_, i) => `P${i}`), teams: [] }] },
      /21 players; the limit is 20/,
    );
  });

  test("refuses a row naming more than 8 teams", async () => {
    await rejects(
      { rows: [{ number: "1", players: [], teams: Array.from({ length: 9 }, (_, i) => `T${i}`) }] },
      /9 teams; the limit is 8/,
    );
  });

  test("refuses a waitKey with a character outside letters, digits, _ and -", async () => {
    mockState.bscCards = [bsc("1")];
    await expect(run(undefined, { waitKey: "bad key!" })).rejects.toThrow(/waitKey/);
  });
});
