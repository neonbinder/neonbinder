/**
 * NEO-313 — multi-sport players (`playerSports`) as they hit the
 * automated-lookup and picker surfaces: `sameNamePlayers`'s member leg,
 * `players.list`/`players.search`'s clamp and shape, and
 * `setAdditionalSports`'s cap and removal guards.
 *
 * Binding rule (Linear NEO-313): nothing automated looks ACROSS sports. Every
 * candidate-widening leg here reads only rows for the sport it was asked
 * about; a football-only player is invisible to a baseball lookup until an
 * operator explicitly adds baseball to his sports.
 *
 * Fixtures follow players.management.test.ts's shape (raw `ctx.db.insert`,
 * `normalizePlayerName` for the denormalised field).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName, sameNamePlayers, MAX_PLAYER_EXTRA_SPORTS } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const ADMIN_IDENTITY = {
  subject: "user_cross_sport_admin",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_cross_sport_admin",
  role: "admin",
};

const MEMBER_IDENTITY = {
  subject: "user_cross_sport_member",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_cross_sport_member",
};

async function seedSport(t: T, value: string): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertPlayer(
  t: T,
  opts: { name: string; sportId: Id<"selectorOptions">; aliases?: string[] },
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name: opts.name,
      nameNormalized: normalizePlayerName(opts.name),
      sportId: opts.sportId,
      aliases: opts.aliases,
      createdByUserId: "user_seed",
      lastUpdated: Date.now(),
    }),
  );
}

// ===========================================================================
// sameNamePlayers — the playerSports (member) leg
// ===========================================================================

describe("sameNamePlayers: the multi-sport member leg", () => {
  test("a football-only player is invisible to a baseball lookup", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    await insertPlayer(t, { name: "Bo Jackson", sportId: football });

    const found = await t.run((ctx) =>
      sameNamePlayers(ctx, normalizePlayerName("Bo Jackson"), baseball),
    );
    expect(found).toHaveLength(0);
  });

  test("once added to baseball, he resolves there by exactly one candidate", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await asAdmin.mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball],
    });

    const found = await t.run((ctx) =>
      sameNamePlayers(ctx, normalizePlayerName("Bo Jackson"), baseball),
    );
    expect(found.map((p) => p._id)).toEqual([bo]);
    // The home sport still finds him too, untouched by the addition.
    const homeFound = await t.run((ctx) =>
      sameNamePlayers(ctx, normalizePlayerName("Bo Jackson"), football),
    );
    expect(homeFound.map((p) => p._id)).toEqual([bo]);
  });

  test("a per-sport alias also resolves through the member leg", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, {
      name: "Bo Jackson",
      sportId: football,
      aliases: ["Vincent Jackson"],
    });
    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball],
    });

    const found = await t.run((ctx) =>
      sameNamePlayers(ctx, normalizePlayerName("Vincent Jackson"), baseball),
    );
    expect(found.map((p) => p._id)).toEqual([bo]);
  });

  test("a member row does not leak into an unrelated third sport", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const basketball = await seedSport(t, "Basketball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball],
    });

    const found = await t.run((ctx) =>
      sameNamePlayers(ctx, normalizePlayerName("Bo Jackson"), basketball),
    );
    expect(found).toHaveLength(0);
  });
});

// ===========================================================================
// players.list — clamp and multi-sport membership
// ===========================================================================

describe("players.list", () => {
  test("clamps a huge limit to the 500 cap", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        const name = `Player ${String(i).padStart(4, "0")}`;
        await ctx.db.insert("players", {
          name,
          nameNormalized: normalizePlayerName(name),
          sportId,
          lastUpdated: Date.now(),
        });
      }
    });

    const result = await t
      .withIdentity(MEMBER_IDENTITY)
      .query(api.players.list, { sportId, limit: 10_000 });
    expect(result).toHaveLength(500);
  });

  test("clamps 0 to a floor of one row rather than erroring or listing none", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    await insertPlayer(t, { name: "Hank Aaron", sportId });
    await insertPlayer(t, { name: "Willie Mays", sportId });

    await expect(
      t.withIdentity(MEMBER_IDENTITY).query(api.players.list, { sportId, limit: 0 }),
    ).resolves.toHaveLength(1);
  });

  test("a non-finite limit (NaN) falls back to the default rather than erroring", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    await insertPlayer(t, { name: "Hank Aaron", sportId });
    await insertPlayer(t, { name: "Willie Mays", sportId });

    await expect(
      t.withIdentity(MEMBER_IDENTITY).query(api.players.list, { sportId, limit: Number.NaN }),
    ).resolves.toHaveLength(2);
  });

  test("includes a multi-sport member even when home players already fill the page", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball],
    });
    // Fill the baseball page to its limit with HOME players.
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        const name = `Home Player ${i}`;
        await ctx.db.insert("players", {
          name,
          nameNormalized: normalizePlayerName(name),
          sportId: baseball,
          lastUpdated: Date.now(),
        });
      }
    });

    const result = await t
      .withIdentity(MEMBER_IDENTITY)
      .query(api.players.list, { sportId: baseball, limit: 2 });
    // Members are read first and unconditionally, so Bo is not pushed off the
    // page by home players filling it — see the doc comment on `playersInSport`.
    expect(result.map((p) => p.name)).toContain("Bo Jackson");
  });
});

// ===========================================================================
// players.search — clamp and shape
// ===========================================================================

describe("players.search", () => {
  test("clamps limit to the 25-row cap", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        const name = `Bowman Bob ${String(i).padStart(2, "0")}`;
        await ctx.db.insert("players", {
          name,
          nameNormalized: normalizePlayerName(name),
          sportId,
          lastUpdated: Date.now(),
        });
      }
    });

    const result = await t
      .withIdentity(MEMBER_IDENTITY)
      .query(api.players.search, { query: "Bowman", sportId, limit: 1000 });
    expect(result.length).toBeLessThanOrEqual(25);
  });

  test("a typed search under a sport merges in that sport's multi-sport members", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball],
    });

    const result = await t
      .withIdentity(MEMBER_IDENTITY)
      .query(api.players.search, { query: "Bo Jack", sportId: baseball });
    expect(result).toHaveLength(1);
    // sportValue reports the player's HOME sport, not the sport searched
    // under — this is a guest membership, not a home change.
    expect(result[0]).toMatchObject({ name: "Bo Jackson", sportValue: "Football" });
  });

  test("does not surface a member of another sport with no membership here", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    await insertPlayer(t, { name: "Bo Jackson", sportId: football });

    const result = await t
      .withIdentity(MEMBER_IDENTITY)
      .query(api.players.search, { query: "Bo Jack", sportId: baseball });
    expect(result).toHaveLength(0);
  });

  test("returns stints and alsoSportIds via listForManagement even at the home-count limit", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball],
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        const name = `Home Player ${i}`;
        await ctx.db.insert("players", {
          name,
          nameNormalized: normalizePlayerName(name),
          sportId: baseball,
          lastUpdated: Date.now(),
        });
      }
    });

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.players.listForManagement, { sportId: baseball, limit: 2 });
    const boRow = result.players.find((p) => p.name === "Bo Jackson");
    expect(boRow?.alsoSportIds).toEqual([baseball]);
  });
});

// ===========================================================================
// setAdditionalSports — cap, home exclusion, and removal guards
// ===========================================================================

describe("setAdditionalSports", () => {
  test("excludes the home sport even when the caller sends it", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [football, baseball],
    });

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.players.listForManagement, { sportId: baseball });
    expect(result.players.map((p) => p.alsoSportIds)).toEqual([[baseball]]);
  });

  test("refuses more than MAX_PLAYER_EXTRA_SPORTS distinct sports", async () => {
    const t = convexTest(schema, modules);
    const home = await seedSport(t, "Football");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: home });
    const extras = await Promise.all(
      Array.from({ length: MAX_PLAYER_EXTRA_SPORTS + 1 }, (_, i) => seedSport(t, `Sport ${i}`)),
    );

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
        playerId: bo,
        sportIds: extras,
      }),
    ).rejects.toThrow(new RegExp(`at most ${MAX_PLAYER_EXTRA_SPORTS} sports`));
  });

  test("SPORT_HAS_CARDS refuses removing a sport a card still uses", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [baseball] });

    const variantType = await t.run(async (ctx) => {
      const setName = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Set",
        parentId: baseball,
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      });
      return ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        parentId: setName,
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      });
    });
    await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantType,
      cardNumber: "1",
      cardName: "Bo",
      playerIds: [bo],
    });

    const message = await asAdmin
      .mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [] })
      .catch((e) => (e instanceof Error ? e.message : String(e)));
    expect(message).toMatch(/SPORT_HAS_CARDS/);
  });

  test("SPORT_HAS_STINTS refuses removing a sport a career stint uses", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [baseball] });
    const royals = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Kansas City Royals",
        nameNormalized: "kansas city royals",
        sportId: baseball,
        lastUpdated: Date.now(),
      }),
    );
    await asAdmin.mutation(api.players.savePlayerFields, {
      id: bo,
      teamYears: [{ teamId: royals, fromYear: 1986, toYear: 1990 }],
    });

    const message = await asAdmin
      .mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [] })
      .catch((e) => (e instanceof Error ? e.message : String(e)));
    expect(message).toMatch(/SPORT_HAS_STINTS/);
  });

  test("rejects a signed-in non-admin", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });

    await expect(
      t.withIdentity(MEMBER_IDENTITY).mutation(api.players.setAdditionalSports, {
        playerId: bo,
        sportIds: [baseball],
      }),
    ).rejects.toThrow(/Admin access required/);
  });

  test("refuses a sportId that is not a sport-level row", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    const notASport = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Refractor",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
        playerId: bo,
        sportIds: [notASport],
      }),
    ).rejects.toThrow(/Only a sport can be added/);
  });
});

// ===========================================================================
// NEO-318 — players.alsoSportIds, the derived copy of playerSports
// ===========================================================================

describe("NEO-318: setAdditionalSports keeps players.alsoSportIds in step", () => {
  const rawPlayer = (t: T, id: Id<"players">) => t.run((ctx) => ctx.db.get(id));
  const memberRows = (t: T, id: Id<"players">) =>
    t.run((ctx) =>
      ctx.db
        .query("playerSports")
        .withIndex("by_player_id", (q) => q.eq("playerId", id))
        .collect(),
    );

  test("writes the copy for the sports it adds", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball],
    });

    expect((await rawPlayer(t, bo))?.alsoSportIds).toEqual([baseball]);
  });

  test("clearing to [] leaves the field absent, never an empty array", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [baseball] });

    await asAdmin.mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [] });

    const row = await rawPlayer(t, bo);
    expect(row).not.toBeNull();
    expect("alsoSportIds" in (row as object)).toBe(false);
  });

  test("a planted wrong copy is healed by a call with the same list", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const hockey = await seedSport(t, "Hockey");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [baseball] });
    await t.run((ctx) => ctx.db.patch(bo, { alsoSportIds: [hockey] }));

    await asAdmin.mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [baseball] });

    expect((await rawPlayer(t, bo))?.alsoSportIds).toEqual([baseball]);
  });

  test("a stale copy on a player with no memberships is removed by an empty call", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const hockey = await seedSport(t, "Hockey");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    await t.run((ctx) => ctx.db.patch(bo, { alsoSportIds: [hockey] }));

    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [] });

    expect("alsoSportIds" in ((await rawPlayer(t, bo)) as object)).toBe(false);
  });

  test("the copy's order is by_player_id order: kept rows first, then new ones as requested", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const hockey = await seedSport(t, "Hockey");
    const golf = await seedSport(t, "Golf");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [baseball] });

    // Requested order puts the new sports BEFORE the one already held.
    await asAdmin.mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [golf, baseball, hockey],
    });

    const rows = await memberRows(t, bo);
    expect(rows.map((r) => r.sportId)).toEqual([baseball, golf, hockey]);
    expect((await rawPlayer(t, bo))?.alsoSportIds).toEqual(rows.map((r) => r.sportId));
  });

  test("the home sport is never copied", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [football, baseball],
    });

    expect((await rawPlayer(t, bo))?.alsoSportIds).toEqual([baseball]);
  });

  test("writing the copy does not bump lastUpdated", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    await t.run((ctx) => ctx.db.patch(bo, { lastUpdated: 1234 }));

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball],
    });

    expect((await rawPlayer(t, bo))?.lastUpdated).toBe(1234);
  });

  test("a rename through savePlayerFields keeps the copy", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const bo = await insertPlayer(t, { name: "Bo Jackson", sportId: football });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.players.setAdditionalSports, { playerId: bo, sportIds: [baseball] });

    await asAdmin.mutation(api.players.savePlayerFields, { id: bo, name: "Vincent Jackson" });

    const row = await rawPlayer(t, bo);
    expect(row?.name).toBe("Vincent Jackson");
    expect(row?.alsoSportIds).toEqual([baseball]);
  });
});

