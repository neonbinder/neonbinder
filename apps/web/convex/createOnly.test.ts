/**
 * NEO-339 — the server guards behind "Create" and the card-write gates the
 * set-building tool used to hold on its own.
 *
 *  - `players.findOrCreate` / `teams.findOrCreate` with `createOnly: true`
 *    never return an existing row: a name on file is refused with a
 *    structured PLAYER_EXISTS / TEAM_EXISTS naming the rows (so the pickers
 *    can offer "Use …"). Without the flag, find-or-create is unchanged.
 *  - `selectorOptions.updateCard` refuses a blank title, and refuses retiring
 *    a side's typed names without linking that side.
 *  - `commitCardChecklist` refuses a card still carrying a NAME conflict, as
 *    it already did a players conflict.
 */

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { entityExistsRefusal } from "../lib/entities/entity-exists";
import { BLANK_LISTING_TITLE_MESSAGE } from "../lib/cards/listing-title-gate";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_create_only_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_create_only_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertPlayer(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  birthYear?: number,
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      ...(birthYear !== undefined ? { birthYear } : {}),
      lastUpdated: Date.now(),
    }),
  );
}

async function insertTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  fields: { name: string; location?: string; yearsActive?: { from: number; to?: number }; aliases?: string[] },
): Promise<Id<"teams">> {
  const fullName = fields.location ? `${fields.location} ${fields.name}` : fields.name;
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("teams", {
      name: fields.name,
      ...(fields.location ? { location: fields.location } : {}),
      nameNormalized: normalizeTeamName(fullName),
      sportId,
      ...(fields.yearsActive ? { yearsActive: fields.yearsActive } : {}),
      lastUpdated: Date.now(),
    });
    return id;
  });
}

/** The structured refusal a rejected call carried. */
async function refusalOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ConvexError);
    return entityExistsRefusal(err);
  }
  throw new Error("expected the call to be refused");
}

async function playerCount(t: T): Promise<number> {
  return t.run(async (ctx) => (await ctx.db.query("players").collect()).length);
}

// ===========================================================================
// players.findOrCreate { createOnly }
// ===========================================================================

describe("players.findOrCreate with createOnly never links (NEO-339)", () => {
  test("nothing on file: it creates", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await t
      .withIdentity(ADMIN)
      .mutation(api.players.findOrCreate, { name: "Wyatt Langford", sportId, createOnly: true });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.name).toBe("Wyatt Langford");
    await drainScheduled(t);
  });

  test("one same-name player: refused naming it, whatever birthYear says, and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const trout = await insertPlayer(t, sportId, "Mike Trout", 1991);
    for (const birthYear of [undefined, 1991, 1975]) {
      const refusal = await refusalOf(
        t.withIdentity(ADMIN).mutation(api.players.findOrCreate, {
          name: "Mike Trout",
          sportId,
          createOnly: true,
          ...(birthYear !== undefined ? { birthYear } : {}),
        }),
      );
      expect(refusal).toMatchObject({
        code: "PLAYER_EXISTS",
        reason: "sameName",
        name: "Mike Trout",
        count: 1,
        players: [{ id: trout, name: "Mike Trout", birthYear: 1991 }],
      });
    }
    expect(await playerCount(t)).toBe(1);
  });

  test("the default (no createOnly) still adopts the one same-name player", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const trout = await insertPlayer(t, sportId, "Mike Trout");
    const id = await t.withIdentity(ADMIN).mutation(api.players.findOrCreate, { name: "Mike Trout", sportId });
    expect(id).toBe(trout);
  });

  test("a player who answers to the name as an alias counts as on file", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { id: metta } = await t
      .withIdentity(ADMIN)
      .mutation(api.players.createByAdmin, { name: "Metta World Peace", sportId, aliases: ["Ron Artest"] });
    await drainScheduled(t);
    const refusal = await refusalOf(
      t.withIdentity(ADMIN).mutation(api.players.findOrCreate, { name: "Ron Artest", sportId, createOnly: true }),
    );
    expect(refusal).toMatchObject({ code: "PLAYER_EXISTS", reason: "sameName", players: [{ id: metta }] });
  });

  test("several on file and no birthYear: refused", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Bob Allen", 1867);
    await insertPlayer(t, sportId, "Bob Allen", 1937);
    const refusal = await refusalOf(
      t.withIdentity(ADMIN).mutation(api.players.findOrCreate, { name: "Bob Allen", sportId, createOnly: true }),
    );
    expect(refusal).toMatchObject({ code: "PLAYER_EXISTS", reason: "noBirthYear", count: 2 });
    expect(refusal?.code === "PLAYER_EXISTS" && refusal.players).toHaveLength(2);
  });

  test("several on file and the birthYear collides: refused, never adopted", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Bob Allen", 1867);
    await insertPlayer(t, sportId, "Bob Allen", 1937);
    const refusal = await refusalOf(
      t.withIdentity(ADMIN).mutation(api.players.findOrCreate, {
        name: "Bob Allen",
        sportId,
        birthYear: 1937,
        createOnly: true,
      }),
    );
    expect(refusal).toMatchObject({ code: "PLAYER_EXISTS", reason: "sameBirthYear", birthYear: 1937 });
    expect(await playerCount(t)).toBe(2);
  });

  test("several on file and one has no birth year: refused", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Bob Allen", 1867);
    await insertPlayer(t, sportId, "Bob Allen");
    const refusal = await refusalOf(
      t.withIdentity(ADMIN).mutation(api.players.findOrCreate, {
        name: "Bob Allen",
        sportId,
        birthYear: 2001,
        createOnly: true,
      }),
    );
    expect(refusal).toMatchObject({ code: "PLAYER_EXISTS", reason: "undatedRival" });
  });

  test("several on file, all dated, none born that year: a NEW player is created", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const a = await insertPlayer(t, sportId, "Bob Allen", 1867);
    const b = await insertPlayer(t, sportId, "Bob Allen", 1937);
    const id = await t.withIdentity(ADMIN).mutation(api.players.findOrCreate, {
      name: "Bob Allen",
      sportId,
      birthYear: 2001,
      createOnly: true,
    });
    expect([a, b]).not.toContain(id);
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ name: "Bob Allen", birthYear: 2001 });
    await drainScheduled(t);
  });
});

// ===========================================================================
// teams.findOrCreate { createOnly }
// ===========================================================================

describe("teams.findOrCreate with createOnly never links (NEO-339)", () => {
  test("nothing on file: it creates", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "Monarchs",
      location: "Kansas City",
      sportId,
      createOnly: true,
    });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ name: "Monarchs", location: "Kansas City" });
  });

  test("an undated team under the full name: refused naming it (the default would link it)", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await insertTeam(t, sportId, { name: "Padres", location: "San Diego" });
    const refusal = await refusalOf(
      t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
        name: "Padres",
        location: "San Diego",
        sportId,
        createOnly: true,
      }),
    );
    expect(refusal).toEqual({
      code: "TEAM_EXISTS",
      name: "San Diego Padres",
      teams: [{ id: padres, name: "San Diego Padres", years: "" }],
    });
    // The default still finds it.
    const found = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: "Padres", location: "San Diego", sportId });
    expect(found).toBe(padres);
    expect(await t.run(async (ctx) => (await ctx.db.query("teams").collect()).length)).toBe(1);
  });

  test("an overlapping era is refused with its years", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const jets = await insertTeam(t, sportId, { name: "Jets", location: "Winnipeg", yearsActive: { from: 2011 } });
    const refusal = await refusalOf(
      t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
        name: "Jets",
        location: "Winnipeg",
        sportId,
        yearsActive: { from: 2015 },
        createOnly: true,
      }),
    );
    expect(refusal).toMatchObject({ code: "TEAM_EXISTS", teams: [{ id: jets, years: "2011–present" }] });
  });

  test("a disjoint era still takes the confirmed second-era path (newEra), not TEAM_EXISTS", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertTeam(t, sportId, { name: "Jets", location: "Winnipeg", yearsActive: { from: 1972, to: 1996 } });
    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
        name: "Jets",
        location: "Winnipeg",
        sportId,
        yearsActive: { from: 2011 },
        createOnly: true,
      }),
    ).rejects.toMatchObject({ data: { code: "TEAM_ERA_EXISTS" } });
    const id = await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "Jets",
      location: "Winnipeg",
      sportId,
      yearsActive: { from: 2011 },
      newEra: true,
      createOnly: true,
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(id))?.yearsActive)).toEqual({ from: 2011 });
  });

  test("a team answering to the name as an alias counts as on file", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const lsu = await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "Tigers",
      location: "LSU",
      sportId,
      aliases: ["Louisiana State Tigers"],
    });
    const refusal = await refusalOf(
      t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
        name: "Tigers",
        location: "Louisiana State",
        sportId,
        createOnly: true,
      }),
    );
    expect(refusal).toMatchObject({ code: "TEAM_EXISTS", teams: [{ id: lsu, name: "LSU Tigers" }] });
  });
});

// ===========================================================================
// updateCard: blank title, retiring typed names without a link
// ===========================================================================

async function seedCard(t: T, fields: Record<string, unknown> = {}) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const baseId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: setId,
      children: [],
      lastUpdated: Date.now(),
    });
    const playerId = await ctx.db.insert("players", {
      name: "Shohei Ohtani",
      nameNormalized: normalizePlayerName("Shohei Ohtani"),
      sportId,
      lastUpdated: Date.now(),
    });
    const teamId = await ctx.db.insert("teams", {
      name: "Dodgers",
      nameNormalized: "dodgers",
      sportId,
      lastUpdated: Date.now(),
    });
    const cardId = await ctx.db.insert("cardChecklist", {
      selectorOptionId: baseId,
      cardNumber: "17",
      cardName: "Shohei Ohtani",
      listingTitle: "2024 Topps #17 Shohei Ohtani",
      platformData: {},
      sortOrder: 0,
      lastUpdated: Date.now(),
      ...fields,
    });
    return { playerId, teamId, cardId };
  });
}

describe("updateCard refuses a blank title (NEO-339)", () => {
  test("blank and whitespace-only titles are refused and the stored title stands", async () => {
    const t = convexTest(schema, modules);
    const { cardId } = await seedCard(t);
    for (const listingTitle of ["", "   "]) {
      await expect(
        t.withIdentity(ADMIN).mutation(api.selectorOptions.updateCard, { id: cardId, listingTitle }),
      ).rejects.toThrow(BLANK_LISTING_TITLE_MESSAGE);
    }
    expect((await t.run(async (ctx) => ctx.db.get(cardId)))?.listingTitle).toBe("2024 Topps #17 Shohei Ohtani");
  });

  test("a real title still saves, trimmed", async () => {
    const t = convexTest(schema, modules);
    const { cardId } = await seedCard(t);
    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.updateCard, { id: cardId, listingTitle: "  2024 Topps #17 Ohtani  " });
    expect((await t.run(async (ctx) => ctx.db.get(cardId)))?.listingTitle).toBe("2024 Topps #17 Ohtani");
  });
});

describe("updateCard retires typed names only by linking that side (NEO-339)", () => {
  test("clearing typed player names with no player linked is refused", async () => {
    const t = convexTest(schema, modules);
    const { cardId } = await seedCard(t, { pendingPlayerNames: ["Shohei Ohtani"] });
    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.updateCard, {
        id: cardId,
        playerIds: [],
        pendingPlayerNames: [],
      }),
    ).rejects.toThrow(/Link a player to this card before clearing/);
    expect((await t.run(async (ctx) => ctx.db.get(cardId)))?.pendingPlayerNames).toEqual(["Shohei Ohtani"]);
  });

  test("clearing typed team names with no team linked is refused", async () => {
    const t = convexTest(schema, modules);
    const { cardId } = await seedCard(t, { pendingTeamNames: ["Dodgers"] });
    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.updateCard, { id: cardId, pendingTeamNames: [] }),
    ).rejects.toThrow(/Link a team to this card before clearing/);
  });

  test("linking the side in the same write retires its names", async () => {
    const t = convexTest(schema, modules);
    const { cardId, playerId, teamId } = await seedCard(t, {
      pendingPlayerNames: ["Shohei Ohtani"],
      pendingTeamNames: ["Dodgers"],
    });
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.updateCard, {
      id: cardId,
      playerIds: [playerId],
      teamOnCardIds: [teamId],
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });
    const row = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(row?.pendingPlayerNames).toBeUndefined();
    expect(row?.pendingTeamNames).toBeUndefined();
    expect(row?.playerIds).toEqual([playerId]);
  });

  test("a card already linked on that side may retire a leftover typed name", async () => {
    const t = convexTest(schema, modules);
    const { cardId, playerId } = await seedCard(t);
    await t.run(async (ctx) => ctx.db.patch(cardId, { pendingPlayerNames: ["S. Ohtani"] }));
    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.updateCard, { id: cardId, playerIds: [playerId], pendingPlayerNames: [] });
    expect((await t.run(async (ctx) => ctx.db.get(cardId)))?.pendingPlayerNames).toBeUndefined();
  });

  test("writing the names back unchanged on the unlinked side is allowed", async () => {
    const t = convexTest(schema, modules);
    const { cardId, teamId } = await seedCard(t, {
      pendingPlayerNames: ["Shohei Ohtani"],
      pendingTeamNames: ["Dodgers"],
    });
    // UnreviewedNameFixer linking only the team: the player side goes back as it was.
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.updateCard, {
      id: cardId,
      playerIds: [],
      teamOnCardIds: [teamId],
      pendingPlayerNames: ["Shohei Ohtani"],
      pendingTeamNames: [],
    });
    const row = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(row?.pendingPlayerNames).toEqual(["Shohei Ohtani"]);
    expect(row?.teamOnCardIds).toEqual([teamId]);
  });
});
