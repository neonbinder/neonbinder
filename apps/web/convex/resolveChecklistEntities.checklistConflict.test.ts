/**
 * PR 451 (NEO-478) — `resolveChecklistEntities` and a card's open
 * `checklistConflict`.
 *
 *  - Both sides' names are resolved, so a player or team the operator may
 *    pick in "Checklist says otherwise" arrives as a decided name rather than
 *    a pending one.
 *  - `assertCardBatchWithinLimits` bounds the four conflict lists to the
 *    card caps (20 players, 8 teams, 120 characters a name) and refuses the
 *    whole call.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_CARD_PLAYERS, MAX_CARD_TEAMS } from "./features/cardAttention";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_resolve_conflict_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_resolve_conflict_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;
type Conflict = {
  players?: { marketplace: string[]; checklist: string[] };
  teams?: { marketplace: string[]; checklist: string[] };
};

async function seedTree(t: T): Promise<{ sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Test Set",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

function card(over: {
  players?: string[];
  teams?: string[];
  checklistConflict?: Conflict;
}) {
  return {
    cardNumber: "1",
    cardName: "Card 1",
    teams: over.teams ?? [],
    players: over.players ?? [],
    platformData: {},
    ...(over.checklistConflict ? { checklistConflict: over.checklistConflict } : {}),
  };
}

async function resolve(t: T, cards: ReturnType<typeof card>[]) {
  const { sportId, leafId } = await seedTree(t);
  return t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.resolveChecklistEntities, {
    selectorOptionId: leafId,
    sportId,
    cards,
  });
}

describe("resolveChecklistEntities: both sides of a checklist disagreement are resolved", () => {
  test("surfaces the marketplace's AND the checklist's players and teams", async () => {
    const t = convexTest(schema, modules);
    const result = await resolve(t, [
      card({
        players: ["Pete Alonso"],
        teams: ["New York Mets"],
        checklistConflict: {
          players: { marketplace: ["Pete Alonso"], checklist: ["Kyle Schwarber"] },
          teams: { marketplace: ["New York Mets"], checklist: ["Philadelphia Phillies"] },
        },
      }),
    ]);
    expect(result.unknownPlayers).toEqual(expect.arrayContaining(["Pete Alonso", "Kyle Schwarber"]));
    expect(result.unknownTeams).toEqual(
      expect.arrayContaining(["New York Mets", "Philadelphia Phillies"]),
    );
  });

  test("a card with no disagreement resolves only its own names", async () => {
    const t = convexTest(schema, modules);
    const result = await resolve(t, [
      card({ players: ["Pete Alonso"], teams: ["New York Mets"] }),
    ]);
    expect(result.unknownPlayers).toEqual(["Pete Alonso"]);
    expect(result.unknownTeams).toEqual(["New York Mets"]);
  });

  test("a players-only disagreement resolves the checklist player without inventing a team", async () => {
    const t = convexTest(schema, modules);
    const result = await resolve(t, [
      card({
        players: ["Pete Alonso"],
        checklistConflict: {
          players: { marketplace: ["Pete Alonso"], checklist: ["Kyle Schwarber"] },
        },
      }),
    ]);
    expect(result.unknownPlayers).toEqual(expect.arrayContaining(["Kyle Schwarber"]));
    expect(result.unknownTeams).toEqual([]);
  });
});

describe("resolveChecklistEntities: the checklistConflict lists are bounded", () => {
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const cases: Array<[string, Conflict, RegExp]> = [
    [
      "marketplace players over the cap",
      { players: { marketplace: many(MAX_CARD_PLAYERS + 1, "P"), checklist: [] } },
      /21 marketplace players in its checklist disagreement, above the 20 limit/,
    ],
    [
      "checklist players over the cap",
      { players: { marketplace: [], checklist: many(MAX_CARD_PLAYERS + 1, "P") } },
      /21 checklist players in its checklist disagreement/,
    ],
    [
      "marketplace teams over the cap",
      { teams: { marketplace: many(MAX_CARD_TEAMS + 1, "T"), checklist: [] } },
      /9 marketplace teams in its checklist disagreement, above the 8 limit/,
    ],
    [
      "checklist teams over the cap",
      { teams: { marketplace: [], checklist: many(MAX_CARD_TEAMS + 1, "T") } },
      /9 checklist teams in its checklist disagreement/,
    ],
    [
      "a checklist player name over 120 characters",
      { players: { marketplace: [], checklist: ["P".repeat(121)] } },
      /checklist name of 121 characters in its checklist disagreement/,
    ],
    [
      "a marketplace team name over 120 characters",
      { teams: { marketplace: ["T".repeat(121)], checklist: [] } },
      /marketplace name of 121 characters in its checklist disagreement/,
    ],
  ];

  test.each(cases)("refuses %s", async (_label, conflict, message) => {
    const t = convexTest(schema, modules);
    await expect(resolve(t, [card({ checklistConflict: conflict })])).rejects.toThrow(message);
  });

  test("accepts lists exactly at the caps", async () => {
    const t = convexTest(schema, modules);
    const result = await resolve(t, [
      card({
        checklistConflict: {
          players: { marketplace: many(MAX_CARD_PLAYERS, "A"), checklist: many(MAX_CARD_PLAYERS, "B") },
          teams: { marketplace: many(MAX_CARD_TEAMS, "C"), checklist: many(MAX_CARD_TEAMS, "D") },
        },
      }),
    ]);
    expect(result.unknownPlayers.length).toBeGreaterThan(0);
  });
});
