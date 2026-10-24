/**
 * NEO-335 Phase 2 — adversarial pass over `teamSuggestionsForPreview`:
 * argument caps at exactly the cap, stints that can never be offered (another
 * sport's team, a deleted team), duplicate team ids, the admin gate with
 * every argument shape, and name lookups that should come back empty.
 *
 * The sibling file (cardChecklist.teamSuggestionsForPreview.test.ts) proves
 * the wiring and the happy paths; this one only attacks.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";
import {
  TEAM_SUGGESTION_MAX_PLAYERS,
  TEAM_SUGGESTION_MAX_TEAM_NAMES,
} from "./cardChecklist";
import { insertTestCard } from "../lib/testing/card-row";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_team_suggest_adv",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_team_suggest_adv",
  role: "admin",
};
const SIGNED_IN = {
  subject: "user_team_suggest_adv",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_team_suggest_adv",
};

type T = ReturnType<typeof convexTest>;
type Stint = { teamId: Id<"teams">; fromYear: number; toYear?: number };

async function seed(t: T, yearValue = "1985") {
  return t.run(async (ctx) => {
    const now = Date.now();
    const node = (
      level: "sport" | "year" | "setName" | "variantType",
      value: string,
      parentId?: Id<"selectorOptions">,
    ) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        platformData: {},
        ...(parentId ? { parentId } : {}),
        children: [],
        lastUpdated: now,
      });
    const sportId = await node("sport", "Baseball");
    const footballId = await node("sport", "Football");
    const yearId = await node("year", yearValue, sportId);
    const setId = await node("setName", "Test Set", yearId);
    const insertId = await node("variantType", "Inserts", setId);
    await ctx.db.patch(setId, { children: [insertId] });
    // A node whose chain never reaches a sport row.
    const orphanId = await node("variantType", "Orphan");

    const team = (name: string, sport = sportId) =>
      ctx.db.insert("teams", {
        name,
        nameNormalized: normalizeTeamName(name),
        sportId: sport,
        lastUpdated: now,
      });
    const reds = await team("Reds");
    const phillies = await team("Phillies");
    const jets = await team("Jets", footballId);
    return { sportId, footballId, insertId, orphanId, reds, phillies, jets };
  });
}

async function player(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  teamYears: Stint[] = [],
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

const suggest = (
  t: T,
  args: {
    selectorOptionId: Id<"selectorOptions">;
    players: Array<{ playerId?: Id<"players">; name?: string }>;
    teamNames?: string[];
  },
) => t.withIdentity(ADMIN).query(api.cardChecklist.teamSuggestionsForPreview, args);

describe("teamSuggestionsForPreview — caps at exactly the cap", () => {
  test("exactly 32 team names is answered; 33 is refused", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const names = Array.from({ length: TEAM_SUGGESTION_MAX_TEAM_NAMES }, (_, i) =>
      i === 0 ? "Reds" : `Nobody ${i}`,
    );
    const ok = await suggest(t, { selectorOptionId: s.insertId, players: [], teamNames: names });
    expect(ok.teamNames).toHaveLength(TEAM_SUGGESTION_MAX_TEAM_NAMES);
    expect(ok.teamNames[0].teams.map((x) => x.teamId)).toEqual([s.reds]);
    await expect(
      suggest(t, {
        selectorOptionId: s.insertId,
        players: [],
        teamNames: [...names, "One too many"],
      }),
    ).rejects.toThrow(/Too many team names/);
  });

  test("the cap counts duplicates: 33 copies of one name is still refused", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      suggest(t, {
        selectorOptionId: s.insertId,
        players: [],
        teamNames: Array.from({ length: TEAM_SUGGESTION_MAX_TEAM_NAMES + 1 }, () => "Reds"),
      }),
    ).rejects.toThrow(/Too many team names/);
  });

  test("the player cap counts the entries, not the distinct players", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const p = await player(t, s.sportId, "Same Guy");
    await expect(
      suggest(t, {
        selectorOptionId: s.insertId,
        players: Array.from({ length: TEAM_SUGGESTION_MAX_PLAYERS + 1 }, () => ({ playerId: p })),
      }),
    ).rejects.toThrow(/Too many players/);
  });

  test("a refused call writes nothing and the cap is checked before the node is read", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.delete(s.insertId));
    await expect(
      suggest(t, {
        selectorOptionId: s.insertId,
        players: Array.from({ length: TEAM_SUGGESTION_MAX_PLAYERS + 1 }, () => ({ name: "x" })),
      }),
    ).rejects.toThrow(/Too many players/);
  });
});

describe("teamSuggestionsForPreview — the gate holds for every argument shape", () => {
  test("signed-out and non-admin are refused even with no players and no names, and with the cap blown", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tooMany = Array.from({ length: TEAM_SUGGESTION_MAX_PLAYERS + 1 }, () => ({ name: "x" }));
    for (const args of [
      { selectorOptionId: s.insertId, players: [] },
      { selectorOptionId: s.insertId, players: [], teamNames: ["Reds"] },
      { selectorOptionId: s.insertId, players: tooMany },
    ]) {
      await expect(t.query(api.cardChecklist.teamSuggestionsForPreview, args)).rejects.toThrow();
      await expect(
        t.withIdentity(SIGNED_IN).query(api.cardChecklist.teamSuggestionsForPreview, args),
      ).rejects.toThrow();
    }
  });

  test("a non-admin cannot learn a team's id by name", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      t.withIdentity(SIGNED_IN).query(api.cardChecklist.teamSuggestionsForPreview, {
        selectorOptionId: s.insertId,
        players: [],
        teamNames: ["Reds"],
      }),
    ).rejects.toThrow();
  });
});

describe("teamSuggestionsForPreview — stints that can never be offered", () => {
  test("a deleted team's stint does not make the window a tie", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert("teams", {
        name: "Expos",
        nameNormalized: normalizeTeamName("Expos"),
        sportId: s.sportId,
        lastUpdated: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    const p = await player(t, s.sportId, "Traded Guy", [
      { teamId: s.reds, fromYear: 1984, toYear: 1990 },
      { teamId: ghost, fromYear: 1984, toYear: 1990 },
    ]);
    const { players } = await suggest(t, { selectorOptionId: s.insertId, players: [{ playerId: p }] });
    expect(players[0].answer?.teams.map((x) => x.teamId)).toEqual([s.reds]);
  });

  test("a career made only of another sport's teams answers nothing and offers nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const p = await player(t, s.sportId, "Football Only", [
      { teamId: s.jets, fromYear: 1980 },
      { teamId: s.jets, fromYear: 1970, toYear: 1979 },
    ]);
    const { players } = await suggest(t, { selectorOptionId: s.insertId, players: [{ playerId: p }] });
    expect(players[0]).toEqual({ playerId: p, answer: null, candidates: [] });
  });

  test("the same team listed twice in the career is one answer, not a tie", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const p = await player(t, s.sportId, "Repeat Guy", [
      { teamId: s.reds, fromYear: 1984, toYear: 1985 },
      { teamId: s.reds, fromYear: 1985, toYear: 1990 },
    ]);
    const { players } = await suggest(t, { selectorOptionId: s.insertId, players: [{ playerId: p }] });
    expect(players[0].answer?.teams.map((x) => x.teamId)).toEqual([s.reds]);
    expect(players[0].candidates).toEqual([]);
  });

  test("a stored answer that names another sport's team is never offered", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const p = await player(t, s.sportId, "Stored Cross");
    await t.run(async (ctx) => {
      const cardId = await insertTestCard(ctx, {
        selectorOptionId: s.insertId,
        cardNumber: "1",
        cardName: "Card",
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
        playerIds: [p],
        teamOnCardIds: [s.jets],
      });
      await ctx.db.insert("cardPlayerLinks", {
        cardChecklistId: cardId,
        playerId: p,
        sportId: s.sportId,
      });
    });
    const { players } = await suggest(t, { selectorOptionId: s.insertId, players: [{ playerId: p }] });
    expect(players[0]).toEqual({ playerId: p, answer: null, candidates: [] });
  });

  test("a node with no sport above it ranks and offers no team at all", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const p = await player(t, s.sportId, "Lost", [{ teamId: s.reds, fromYear: 1984 }]);
    const result = await suggest(t, {
      selectorOptionId: s.orphanId,
      players: [{ playerId: p }, { name: "Lost" }],
    });
    const names = await suggest(t, {
      selectorOptionId: s.orphanId,
      players: [],
      teamNames: ["Reds"],
    });
    expect(result.sportId).toBeNull();
    expect(result.players[0].answer).toBeNull();
    expect(result.players[0].candidates).toEqual([]);
    // A name needs a sport to be resolved in.
    expect(result.players[1]).toEqual({ playerId: null, answer: null, candidates: [] });
    expect(names.teamNames).toEqual([{ teams: [] }]);
  });
});

describe("teamSuggestionsForPreview — the set year", () => {
  test("a year row with no number leaves the window blind: no pre-fill, the career offered", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "Unknown");
    const p = await player(t, s.sportId, "Yearless", [{ teamId: s.reds, fromYear: 1984 }]);
    const result = await suggest(t, { selectorOptionId: s.insertId, players: [{ playerId: p }] });
    expect(result.setYear).toBeNull();
    expect(result.players[0].answer).toBeNull();
    expect(result.players[0].candidates.map((x) => x.teamId)).toEqual([s.reds]);
  });

  test("the window edge through the whole query: a stint ending the year before is a tie, two years before is not", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "2000");
    const tie = await player(t, s.sportId, "Winter Trade", [
      { teamId: s.reds, fromYear: 1990, toYear: 1999 },
      { teamId: s.phillies, fromYear: 2000 },
    ]);
    const clear = await player(t, s.sportId, "Clean Move", [
      { teamId: s.reds, fromYear: 1990, toYear: 1998 },
      { teamId: s.phillies, fromYear: 1999 },
    ]);
    const { players } = await suggest(t, {
      selectorOptionId: s.insertId,
      players: [{ playerId: tie }, { playerId: clear }],
    });
    expect(players[0].answer).toBeNull();
    expect(players[0].candidates).toHaveLength(2);
    expect(players[1].answer?.teams.map((x) => x.teamId)).toEqual([s.phillies]);
  });
});

describe("teamSuggestionsForPreview — names", () => {
  test("an entry with both a playerId and a name is answered by the id", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const byId = await player(t, s.sportId, "Id Guy", [{ teamId: s.reds, fromYear: 1984 }]);
    await player(t, s.sportId, "Name Guy", [{ teamId: s.phillies, fromYear: 1984 }]);
    const { players } = await suggest(t, {
      selectorOptionId: s.insertId,
      players: [{ playerId: byId, name: "Name Guy" }],
    });
    expect(players[0].playerId).toBe(byId);
    expect(players[0].answer?.teams.map((x) => x.teamId)).toEqual([s.reds]);
  });

  test("blank, whitespace-only and over-long names are no evidence, never an error", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { players } = await suggest(t, {
      selectorOptionId: s.insertId,
      players: [{}, { name: "" }, { name: "   \t " }, { name: "x".repeat(201) }],
    });
    for (const result of players) {
      expect(result).toEqual({ playerId: null, answer: null, candidates: [] });
    }
  });

  test("a name with odd case, padding and accents still finds its one player", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await player(t, s.sportId, "José Ramírez", [{ teamId: s.reds, fromYear: 1984 }]);
    const { players } = await suggest(t, {
      selectorOptionId: s.insertId,
      players: [{ name: "  JOSE   ramirez " }],
    });
    expect(players[0].answer?.teams.map((x) => x.teamId)).toEqual([s.reds]);
  });

  test("team names: blank and over-long come back empty in place, the rest keep their position", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { teamNames } = await suggest(t, {
      selectorOptionId: s.insertId,
      players: [],
      teamNames: ["", "Reds", "   ", "y".repeat(201), "  REDS  "],
    });
    expect(teamNames.map((entry) => entry.teams.map((x) => x.teamId))).toEqual([
      [],
      [s.reds],
      [],
      [],
      [s.reds],
    ]);
  });

  test("a team name that exists only in another sport comes back empty", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { teamNames } = await suggest(t, {
      selectorOptionId: s.insertId,
      players: [],
      teamNames: ["Jets"],
    });
    expect(teamNames).toEqual([{ teams: [] }]);
  });
});
