/**
 * NEO-335 — `cardChecklist.teamSuggestionsForPreview`, the wizard's pre-save
 * per-player team evidence. The tier DECISIONS are pinned in
 * lib/teamFill.test.ts; this file proves the WIRING: which stored cards are
 * read (this node, the node a parallel copies, the flagged base — and not
 * another insert), the name → player rule (exactly one, or nothing), the sport
 * filter, the admin gate and the cap.
 *
 * Fixture: sport → year → setName → { base variantType (isBase), insert →
 * parallel, other insert }, with `cardPlayerLinks` rows written beside each
 * card the way every production `playerIds` writer does.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";
import { TEAM_SUGGESTION_MAX_PLAYERS } from "./cardChecklist";
import { TEAMS_SECTION_PLAYERS_PER_REQUEST } from "../components/SetSelector/teams-on-cards";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_team_suggest",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_team_suggest",
  role: "admin",
};
const SIGNED_IN = {
  subject: "user_team_suggest",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_team_suggest",
};

type T = ReturnType<typeof convexTest>;

async function seed(t: T) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: now,
    });
    const otherSportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Football",
      platformData: {},
      children: [],
      lastUpdated: now,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1985",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: now,
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Test Set",
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: now,
    });
    const node = (level: "variantType" | "insert" | "parallel", value: string, parentId: Id<"selectorOptions">, isBase?: boolean) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        platformData: {},
        parentId,
        children: [],
        lastUpdated: now,
        ...(isBase ? { metadata: { isBase: true } } : {}),
      });
    // Named "Flagship", not "Base": the base is found by its flag.
    const baseId = await node("variantType", "Flagship", setId, true);
    const insertId = await node("variantType", "Inserts", setId);
    const parallelId = await node("parallel", "Gold", insertId);
    const otherInsertId = await node("variantType", "Other", setId);
    await ctx.db.patch(setId, { children: [baseId, insertId, otherInsertId] });
    await ctx.db.patch(insertId, { children: [parallelId] });

    const team = (name: string, sport = sportId) =>
      ctx.db.insert("teams", {
        name,
        nameNormalized: normalizeTeamName(name),
        sportId: sport,
        lastUpdated: now,
      });
    const reds = await team("Reds");
    const phillies = await team("Phillies");
    const yankees = await team("Yankees");
    const jets = await team("Jets", otherSportId);

    return { sportId, baseId, insertId, parallelId, otherInsertId, reds, phillies, yankees, jets };
  });
}

async function player(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  teamYears: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }> = [],
) {
  return t.run((ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      teamYears,
      lastUpdated: Date.now(),
    }),
  );
}

async function storedCard(
  t: T,
  sportId: Id<"selectorOptions">,
  selectorOptionId: Id<"selectorOptions">,
  playerIds: Array<Id<"players">>,
  teamOnCardIds: Array<Id<"teams">>,
) {
  await t.run(async (ctx) => {
    const cardId = await ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber: "1",
      cardName: "Card",
      platformData: {},
      sortOrder: 0,
      lastUpdated: Date.now(),
      playerIds,
      teamOnCardIds,
    });
    for (const playerId of new Set(playerIds)) {
      await ctx.db.insert("cardPlayerLinks", { cardChecklistId: cardId, playerId, sportId });
    }
  });
}

describe("teamSuggestionsForPreview — stored rows", () => {
  test("sameNode: the player's solo card under the node being synced answers", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const bench = await player(t, s.sportId, "Johnny Bench");
    await storedCard(t, s.sportId, s.insertId, [bench], [s.reds]);

    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ playerId: bench }],
    });
    expect(result.setYear).toBe(1985);
    expect(result.players).toEqual([
      {
        playerId: bench,
        answer: { tier: "sameNode", teams: [{ teamId: s.reds, name: "Reds" }] },
        candidates: [],
      },
    ]);
  });

  test("parallelOf and baseSet are read; another insert is not", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = await player(t, s.sportId, "Player A");
    const b = await player(t, s.sportId, "Player B");
    const c = await player(t, s.sportId, "Player C");
    await storedCard(t, s.sportId, s.insertId, [a], [s.reds]); // the node a parallel copies
    await storedCard(t, s.sportId, s.baseId, [b], [s.phillies]); // the flagged base
    await storedCard(t, s.sportId, s.otherInsertId, [c], [s.yankees]); // never evidence

    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.parallelId,
      players: [{ playerId: a }, { playerId: b }, { playerId: c }],
    });
    expect(result.players.map((p) => p.answer?.tier ?? null)).toEqual([
      "parallelOf",
      "baseSet",
      null,
    ]);
    expect(result.players[2].candidates).toEqual([]);
  });

  test("two printed teams under the node → candidates, never a pick", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const rose = await player(t, s.sportId, "Pete Rose", [{ teamId: s.reds, fromYear: 1963 }]);
    await storedCard(t, s.sportId, s.insertId, [rose], [s.reds]);
    await storedCard(t, s.sportId, s.insertId, [rose], [s.phillies]);

    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: rose }],
      })
    ).players;
    expect(result.answer).toBeNull();
    expect(new Set(result.candidates.map((c) => c.teamId))).toEqual(new Set([s.reds, s.phillies]));
  });
});

describe("teamSuggestionsForPreview — career and names", () => {
  test("a name resolves to exactly one player; two same-name players is no evidence", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await player(t, s.sportId, "Johnny Bench", [{ teamId: s.reds, fromYear: 1967, toYear: 1983 }]);
    await player(t, s.sportId, "Bob Allen", [{ teamId: s.reds, fromYear: 1980 }]);
    await player(t, s.sportId, "Bob Allen", [{ teamId: s.phillies, fromYear: 1980 }]);

    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ name: "Johnny Bench" }, { name: "Bob Allen" }, { name: "Nobody Atall" }],
    });
    expect(result.players[0].answer).toEqual({
      tier: "oneTeamCareer",
      teams: [{ teamId: s.reds, name: "Reds" }],
    });
    expect(result.players[1]).toEqual({ playerId: null, answer: null, candidates: [] });
    expect(result.players[2]).toEqual({ playerId: null, answer: null, candidates: [] });
  });

  test("one stint covering the set year answers", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const traded = await player(t, s.sportId, "Traded Guy", [
      { teamId: s.reds, fromYear: 1980, toYear: 1984 },
      { teamId: s.phillies, fromYear: 1985, toYear: 1988 },
    ]);
    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ playerId: traded }],
    });
    expect(result.players[0].answer?.tier).toBe("oneStintInYear");
    expect(result.players[0].answer?.teams.map((x) => x.teamId)).toEqual([s.phillies]);
  });

  test("another sport's team is never offered (the commit would refuse it)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const twoSport = await player(t, s.sportId, "Two Sport", [{ teamId: s.jets, fromYear: 1980 }]);
    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ playerId: twoSport }],
    });
    expect(result.players[0]).toEqual({ playerId: twoSport, answer: null, candidates: [] });
  });
});

describe("teamSuggestionsForPreview — gate and bounds", () => {
  test("refuses a signed-out caller and a signed-in non-admin", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const args = { selectorOptionId: s.insertId, players: [] };
    await expect(t.query(api.cardChecklist.teamSuggestionsForPreview, args)).rejects.toThrow();
    await expect(
      t.withIdentity(SIGNED_IN).query(api.cardChecklist.teamSuggestionsForPreview, args),
    ).rejects.toThrow();
    await expect(
      t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, args),
    ).resolves.toEqual({ setYear: 1985, players: [] });
  });

  test("refuses more players than the cap, by count", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const players = Array.from({ length: TEAM_SUGGESTION_MAX_PLAYERS + 1 }, (_, i) => ({
      name: `Player ${i}`,
    }));
    await expect(
      t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players,
      }),
    ).rejects.toThrow(/Too many players/);
  });

  test("the wizard slices its requests at the server's cap", () => {
    expect(TEAMS_SECTION_PLAYERS_PER_REQUEST).toBe(TEAM_SUGGESTION_MAX_PLAYERS);
  });

  test("a deleted node answers empty rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.delete(s.parallelId));
    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.parallelId,
      players: [{ name: "Anyone" }],
    });
    expect(result).toEqual({
      setYear: null,
      players: [{ playerId: null, answer: null, candidates: [] }],
    });
  });
});
