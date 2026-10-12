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
import { normalizeLeagueName } from "./leagues";
import {
  TEAM_SUGGESTION_MAX_PLAYERS,
  TEAM_SUGGESTION_MAX_TEAM_NAMES,
} from "./cardChecklist";
import {
  TEAMS_SECTION_NAMES_PER_REQUEST,
  TEAMS_SECTION_PLAYERS_PER_REQUEST,
} from "../components/SetSelector/teams-on-cards";

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
    await player(t, s.sportId, "Johnny Bench", [{ teamId: s.reds, fromYear: 1967, toYear: 1984 }]);
    await player(t, s.sportId, "Bob Allen", [{ teamId: s.reds, fromYear: 1980 }]);
    await player(t, s.sportId, "Bob Allen", [{ teamId: s.phillies, fromYear: 1980 }]);

    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ name: "Johnny Bench" }, { name: "Bob Allen" }, { name: "Nobody Atall" }],
    });
    expect(result.players[0].answer).toEqual({
      tier: "oneTeamInWindow",
      teams: [{ teamId: s.reds, name: "Reds" }],
    });
    expect(result.players[1]).toEqual({ playerId: null, answer: null, candidates: [] });
    expect(result.players[2]).toEqual({ playerId: null, answer: null, candidates: [] });
  });

  // NEO-335 Phase 2 (C2) — REWRITTEN: Phase 1's "one stint in the set year"
  // (oneStintInYear) became one team in [setYear - 1, setYear]. The old
  // fixture (Reds to 1984, Phillies from 1985, a 1985 set) is now a TIE —
  // a 1985 card may well show the 1984 team — so it is split into the two
  // tests below.
  test("exactly one team covering [setYear-1, setYear] answers", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const traded = await player(t, s.sportId, "Traded Guy", [
      { teamId: s.reds, fromYear: 1980, toYear: 1983 },
      { teamId: s.phillies, fromYear: 1985, toYear: 1988 },
    ]);
    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ playerId: traded }],
    });
    expect(result.players[0].answer?.tier).toBe("oneTeamInWindow");
    expect(result.players[0].answer?.teams.map((x) => x.teamId)).toEqual([s.phillies]);
  });

  test("a trade the winter before the set year is a tie: both offered, nothing pre-filled", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const traded = await player(t, s.sportId, "Traded Guy", [
      { teamId: s.reds, fromYear: 1980, toYear: 1984 },
      { teamId: s.phillies, fromYear: 1985, toYear: 1988 },
    ]);
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: traded }],
      })
    ).players;
    expect(result.answer).toBeNull();
    expect(new Set(result.candidates.map((c) => c.teamId))).toEqual(new Set([s.reds, s.phillies]));
  });

  test("a legend whose one team ended long before the set gets no pre-fill (no year-blind shortcut)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const legend = await player(t, s.sportId, "Old Timer", [
      { teamId: s.yankees, fromYear: 1920, toYear: 1934 },
    ]);
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: legend }],
      })
    ).players;
    expect(result.answer).toBeNull();
    expect(result.candidates.map((c) => c.teamId)).toEqual([s.yankees]);
  });

  test("a two-sport athlete's other-sport stint does not make his window a tie", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const bo = await player(t, s.sportId, "Two Way", [
      { teamId: s.reds, fromYear: 1984, toYear: 1990 },
      { teamId: s.jets, fromYear: 1984, toYear: 1990 },
    ]);
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: bo }],
      })
    ).players;
    expect(result.answer?.teams.map((x) => x.teamId)).toEqual([s.reds]);
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
    ).resolves.toEqual({
      setYear: 1985,
      sportId: s.sportId,
      setLeagueId: null,
      players: [],
      teamNames: [],
    });
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

  test("the wizard slices its requests at the server's caps", () => {
    expect(TEAMS_SECTION_PLAYERS_PER_REQUEST).toBe(TEAM_SUGGESTION_MAX_PLAYERS);
    expect(TEAMS_SECTION_NAMES_PER_REQUEST).toBe(TEAM_SUGGESTION_MAX_TEAM_NAMES);
  });

  test("refuses more team names than the cap, by count", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [],
        teamNames: Array.from({ length: TEAM_SUGGESTION_MAX_TEAM_NAMES + 1 }, (_, i) => `T${i}`),
      }),
    ).rejects.toThrow(/Too many team names/);
  });

  test("refuses players and team names in ONE call (each cap is one job's read budget)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ name: "Anyone" }],
        teamNames: ["Reds"],
      }),
    ).rejects.toThrow(/players or team names in one call, not both/);
    // Either alone is served, and an empty list on the other side is no ask.
    await expect(
      t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ name: "Anyone" }],
        teamNames: [],
      }),
    ).resolves.toMatchObject({ teamNames: [] });
    await expect(
      t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [],
        teamNames: ["Reds"],
      }),
    ).resolves.toMatchObject({ players: [] });
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
      sportId: null,
      setLeagueId: null,
      players: [{ playerId: null, answer: null, candidates: [] }],
      teamNames: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Adversarial pass (NEO-335)
// ---------------------------------------------------------------------------

describe("teamSuggestionsForPreview — adversarial", () => {
  test("a same-name player in ANOTHER sport does not make a name ambiguous", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const footballId = await t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).find((r) => r.value === "Football")!._id,
    );
    await player(t, s.sportId, "Bo Jackson", [{ teamId: s.reds, fromYear: 1980 }]);
    await player(t, footballId, "Bo Jackson", [{ teamId: s.jets, fromYear: 1980 }]);

    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ name: "Bo Jackson" }],
    });
    expect(result.players[0].answer?.teams.map((x) => x.teamId)).toEqual([s.reds]);
  });

  test("a stored answer naming a deleted team is offered as candidates, never as a partial pre-fill", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gone = await t.run((ctx) =>
      ctx.db.insert("teams", {
        name: "Expos",
        nameNormalized: normalizeTeamName("Expos"),
        sportId: s.sportId,
        lastUpdated: Date.now(),
      }),
    );
    const combo = await player(t, s.sportId, "Combo Guy");
    await storedCard(t, s.sportId, s.insertId, [combo], [s.reds, gone]);
    await t.run((ctx) => ctx.db.delete(gone));

    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: combo }],
      })
    ).players;
    expect(result.answer).toBeNull();
    expect(result.candidates.map((c) => c.teamId)).toEqual([s.reds]);
  });

  test("two variantTypes flagged as the base: the base tier is skipped, never guessed", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const setId = await t.run(async (ctx) => (await ctx.db.get(s.baseId))!.parentId!);
    const secondBase = await t.run(async (ctx) => {
      const id = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Also Flagged",
        platformData: {},
        parentId: setId,
        children: [],
        lastUpdated: Date.now(),
        metadata: { isBase: true },
      });
      const set = (await ctx.db.get(setId))!;
      await ctx.db.patch(setId, { children: [...(set.children ?? []), id] });
      return id;
    });
    const b = await player(t, s.sportId, "Player B");
    await storedCard(t, s.sportId, s.baseId, [b], [s.phillies]);
    await storedCard(t, s.sportId, secondBase, [b], [s.phillies]);

    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ playerId: b }],
    });
    expect(result.players[0].answer).toBeNull();
  });

  test("a node merely NAMED \"Base\" without the flag is not the base", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // Drop the flag from the real base and call it "Base" instead.
    await t.run((ctx) => ctx.db.patch(s.baseId, { value: "Base", metadata: undefined }));
    const b = await player(t, s.sportId, "Player B");
    await storedCard(t, s.sportId, s.baseId, [b], [s.phillies]);

    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ playerId: b }],
    });
    expect(result.players[0].answer).toBeNull();
  });

  test("a deleted player id answers empty rather than throwing; a repeated one answers twice, identically", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gone = await player(t, s.sportId, "Gone Guy");
    await t.run((ctx) => ctx.db.delete(gone));
    const bench = await player(t, s.sportId, "Johnny Bench", [{ teamId: s.reds, fromYear: 1967 }]);

    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ playerId: gone }, { playerId: bench }, { name: "Johnny Bench" }],
    });
    expect(result.players[0]).toEqual({ playerId: gone, answer: null, candidates: [] });
    expect(result.players[2]).toEqual(result.players[1]);
    expect(result.players[1].answer?.teams.map((x) => x.teamId)).toEqual([s.reds]);
  });

  test("exactly the cap is answered", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const players = Array.from({ length: TEAM_SUGGESTION_MAX_PLAYERS }, (_, i) => ({
      name: `Player ${i}`,
    }));
    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players,
    });
    expect(result.players).toHaveLength(TEAM_SUGGESTION_MAX_PLAYERS);
  });

  test("evidence past the per-player link window costs the suggestion, never produces a wrong one", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const star = await player(t, s.sportId, "Star Guy", [
      { teamId: s.reds, fromYear: 1970, toYear: 1979 },
      { teamId: s.yankees, fromYear: 1990, toYear: 1995 },
    ]);
    // The sameNode card is written FIRST (oldest)…
    await storedCard(t, s.sportId, s.insertId, [star], [s.reds]);
    // …then 24 newer cards in an unrelated node fill the read window.
    for (let i = 0; i < 24; i++) {
      await storedCard(t, s.sportId, s.otherInsertId, [star], [s.yankees]);
    }
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: star }],
      })
    ).players;
    // Today the window hides the sameNode card and the career has two teams
    // with none in 1985, so nothing is pre-filled. A wider window may find
    // the Reds card instead; what may NEVER happen is the unrelated node's
    // team becoming the answer.
    expect([null, "sameNode"]).toContain(result.answer?.tier ?? null);
    expect(result.answer?.teams.map((x) => x.teamId) ?? []).not.toContain(s.yankees);
  });
});

// ---------------------------------------------------------------------------
// NEO-335 Phase 2 — the set's league (C2b) and team names as choices
// ---------------------------------------------------------------------------

/**
 * A baseball set whose sport carries `features.league: "MLB"` the way
 * `deriveSetLevelFeatures` writes it, with the two leagues a prospect plays
 * in, and an org + an affiliate + a college side.
 */
async function seedLeagues(t: T) {
  const s = await seed(t);
  return t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(s.sportId, { features: { league: "MLB" } });
    const league = (name: string, level: "major" | "minor" | "college", aliases?: string[]) =>
      ctx.db.insert("leagues", {
        name,
        nameNormalized: normalizeLeagueName(name),
        sportId: s.sportId,
        level,
        ...(aliases ? { aliases } : {}),
        lastUpdated: now,
      });
    const mlb = await league("Major League Baseball", "major", ["MLB"]);
    const npb = await league("Nippon Professional Baseball", "major");
    const il = await league("International League", "minor");
    const ncaa = await league("NCAA Division I", "college");
    const team = (name: string, leagueId: Id<"leagues">) =>
      ctx.db.insert("teams", {
        name,
        nameNormalized: normalizeTeamName(name),
        sportId: s.sportId,
        leagueId,
        lastUpdated: now,
      });
    const rays = await team("Tampa Bay Rays", mlb);
    const bulls = await team("Durham Bulls", il);
    const fighters = await team("Nippon-Ham Fighters", npb);
    const badgers = await team("Wisconsin Badgers", ncaa);
    return { ...s, mlb, npb, il, ncaa, rays, bulls, fighters, badgers };
  });
}

describe("teamSuggestionsForPreview — league preference (C2b)", () => {
  test("the set's league comes from features.league, resolved by its alias; the org is preferred over the affiliate", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeagues(t);
    const prospect = await player(t, s.sportId, "Prospect Guy", [
      { teamId: s.bulls, fromYear: 1984, toYear: 1985 },
      { teamId: s.rays, fromYear: 1983 },
    ]);
    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ playerId: prospect }],
    });
    expect(result.setLeagueId).toBe(s.mlb);
    expect(result.players[0].answer).toEqual({
      tier: "preferredInWindow",
      teams: [{ teamId: s.rays, name: "Tampa Bay Rays", rank: 0 }],
    });
    // Never hidden: the affiliate stays offered, ranked.
    expect(result.players[0].candidates).toEqual([
      { teamId: s.bulls, name: "Durham Bulls", rank: 2 },
    ]);
  });

  test("same league beats same level beats other in the candidate order", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeagues(t);
    const journeyman = await player(t, s.sportId, "Journeyman", [
      { teamId: s.bulls, fromYear: 1960, toYear: 1969 },
      { teamId: s.fighters, fromYear: 1970, toYear: 1971 },
      { teamId: s.rays, fromYear: 1972, toYear: 1972 },
    ]);
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: journeyman }],
      })
    ).players;
    expect(result.answer).toBeNull();
    expect(result.candidates.map((c) => [c.teamId, c.rank])).toEqual([
      [s.rays, 0],
      [s.fighters, 1],
      [s.bulls, 2],
    ]);
  });

  test("a college card in a pro set: a one-team window still pre-fills the college team", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeagues(t);
    const draftee = await player(t, s.sportId, "College Guy", [
      { teamId: s.badgers, fromYear: 1982, toYear: 1985 },
      { teamId: s.rays, fromYear: 1987 },
    ]);
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: draftee }],
      })
    ).players;
    expect(result.answer).toEqual({
      tier: "oneTeamInWindow",
      teams: [{ teamId: s.badgers, name: "Wisconsin Badgers", rank: 2 }],
    });
  });

  test("an operator's league on a nearer node wins over the sport's", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeagues(t);
    const setId = await t.run(async (ctx) => (await ctx.db.get(s.baseId))!.parentId!);
    await t.run((ctx) => ctx.db.patch(setId, { features: { league: "NCAA Division I" } }));
    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [],
    });
    expect(result.setLeagueId).toBe(s.ncaa);
  });

  test("no league row for the set's league → nothing is ranked, a tie stays a tie", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.sportId, { features: { league: "MLB" } }));
    const traded = await player(t, s.sportId, "Traded Guy", [
      { teamId: s.reds, fromYear: 1980, toYear: 1984 },
      { teamId: s.phillies, fromYear: 1985 },
    ]);
    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [{ playerId: traded }],
    });
    expect(result.setLeagueId).toBeNull();
    expect(result.players[0].answer).toBeNull();
    expect(result.players[0].candidates.every((c) => c.rank === undefined)).toBe(true);
  });
});

describe("teamSuggestionsForPreview — legends: a one-team career in the set's league", () => {
  const benchCareer = (s: { rays: Id<"teams"> }) => [{ teamId: s.rays, fromYear: 1960, toYear: 1975 }];

  test("a one-team legend whose team is in the set's league (MLB) is pre-filled", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeagues(t);
    const bench = await player(t, s.sportId, "Legend Guy", benchCareer(s));
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: bench }],
      })
    ).players;
    expect(result.answer).toEqual({
      tier: "oneTeamCareerInLeague",
      teams: [{ teamId: s.rays, name: "Tampa Bay Rays", rank: 0 }],
    });
  });

  test("the same legend on a college-league set is not pre-filled", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeagues(t);
    const setId = await t.run(async (ctx) => (await ctx.db.get(s.baseId))!.parentId!);
    await t.run((ctx) => ctx.db.patch(setId, { features: { league: "NCAA Division I" } }));
    const bench = await player(t, s.sportId, "Legend Guy", benchCareer(s));
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: bench }],
      })
    ).players;
    expect(result.answer).toBeNull();
    expect(result.candidates.map((c) => c.teamId)).toEqual([s.rays]);
  });

  test("the same legend on a set with no league is not pre-filled", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const bench = await player(t, s.sportId, "Legend Guy", [
      { teamId: s.reds, fromYear: 1960, toYear: 1975 },
    ]);
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: bench }],
      })
    ).players;
    expect(result.answer).toBeNull();
  });

  test("a multi-team legend stays unselected", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeagues(t);
    const legend = await player(t, s.sportId, "Journeyman Legend", [
      { teamId: s.rays, fromYear: 1960, toYear: 1965 },
      { teamId: s.bulls, fromYear: 1966, toYear: 1975 },
    ]);
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: legend }],
      })
    ).players;
    expect(result.answer).toBeNull();
    expect(result.candidates.map((c) => c.teamId)).toEqual([s.rays, s.bulls]);
  });

  test("an other-sport stint does not stop a one-team legend counting as one team", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeagues(t);
    const legend = await player(t, s.sportId, "Two Sport Legend", [
      { teamId: s.rays, fromYear: 1960, toYear: 1975 },
      { teamId: s.jets, fromYear: 1960, toYear: 1965 },
    ]);
    const [result] = (
      await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [{ playerId: legend }],
      })
    ).players;
    expect(result.answer?.tier).toBe("oneTeamCareerInLeague");
  });
});

describe("teamSuggestionsForPreview — teamNames (choices, never a pick)", () => {
  test("a name resolves to every row it names in this sport, the era covering the set year first", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeagues(t);
    const { oldJets, newJets } = await t.run(async (ctx) => {
      const make = (from: number, to?: number) =>
        ctx.db.insert("teams", {
          name: "Winnipeg Jets",
          nameNormalized: normalizeTeamName("Winnipeg Jets"),
          sportId: s.sportId,
          yearsActive: { from, ...(to !== undefined ? { to } : {}) },
          lastUpdated: Date.now(),
        });
      const newJets = await make(2011);
      const oldJets = await make(1972, 1996);
      return { oldJets, newJets };
    });
    const result = await t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, {
      selectorOptionId: s.insertId,
      players: [],
      teamNames: ["Winnipeg Jets", "Nobody FC", "Jets", "  tampa bay rays "],
    });
    expect(result.teamNames[0].teams.map((x) => x.teamId)).toEqual([oldJets, newJets]);
    expect(result.teamNames[1].teams).toEqual([]);
    // Another sport's "Jets" is never a choice.
    expect(result.teamNames[2].teams).toEqual([]);
    expect(result.teamNames[3].teams).toEqual([
      { teamId: s.rays, name: "Tampa Bay Rays", rank: 0 },
    ]);
  });
});
