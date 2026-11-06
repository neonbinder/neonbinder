/**
 * NEO-426 — the "No teams in this sport" flag: the admin write, the admin
 * read the wizard subscribes to, and the two internal reads the fetch and the
 * commit use. The flag is a default, never a block: setting it touches no
 * card.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { TEAMLESS_PLAYER_LOOKUP_PAGE, teamlessSportIdSet } from "./sportTeamless";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin_teamless_001", role: "admin" };
const USER = { subject: "user_teamless_001" };
const SEEDED_AT = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;

async function seedRow(
  t: T,
  level: "sport" | "year" | "setName",
  value: string,
  extra: { hasNoTeams?: boolean; parentId?: Id<"selectorOptions"> } = {},
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level,
      value,
      platformData: {},
      children: [],
      lastUpdated: SEEDED_AT,
      ...extra,
    }),
  );
}

async function seedPlayer(t: T, sportId: Id<"selectorOptions">, name: string): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: name.toLowerCase(),
      sportId,
      lastUpdated: SEEDED_AT,
    }),
  );
}

describe("sportTeamless.setHasNoTeams", () => {
  test("refuses a signed-out caller and a non-admin, and the row is untouched", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedRow(t, "sport", "Pokemon");
    const args = { sportId, hasNoTeams: true };
    await expect(t.mutation(api.sportTeamless.setHasNoTeams, args)).rejects.toThrow();
    await expect(t.withIdentity(USER).mutation(api.sportTeamless.setHasNoTeams, args)).rejects.toThrow();
    const row = await t.run(async (ctx) => ctx.db.get(sportId));
    expect(row!.hasNoTeams).toBeUndefined();
    expect(row!.lastUpdated).toBe(SEEDED_AT);
  });

  test("refuses a row that is not a sport, whichever way it is called", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedRow(t, "sport", "Baseball");
    const yearId = await seedRow(t, "year", "2024", { parentId: sportId });
    for (const hasNoTeams of [true, false]) {
      await expect(
        t.withIdentity(ADMIN).mutation(api.sportTeamless.setHasNoTeams, { sportId: yearId, hasNoTeams }),
      ).rejects.toThrow(/Only a sport/);
    }
    expect((await t.run(async (ctx) => ctx.db.get(yearId)))!.hasNoTeams).toBeUndefined();
  });

  test("a deleted row is refused with a message, not a crash", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedRow(t, "sport", "Gone");
    await t.run(async (ctx) => ctx.db.delete(sportId));
    await expect(
      t.withIdentity(ADMIN).mutation(api.sportTeamless.setHasNoTeams, { sportId, hasNoTeams: true }),
    ).rejects.toThrow(/gone/);
  });

  test("true stores the flag; false removes the field rather than storing false", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedRow(t, "sport", "Pokemon");
    const as = t.withIdentity(ADMIN);

    await as.mutation(api.sportTeamless.setHasNoTeams, { sportId, hasNoTeams: true });
    let row = await t.run(async (ctx) => ctx.db.get(sportId));
    expect(row!.hasNoTeams).toBe(true);
    expect(row!.lastUpdated).toBeGreaterThan(SEEDED_AT);

    await as.mutation(api.sportTeamless.setHasNoTeams, { sportId, hasNoTeams: false });
    row = await t.run(async (ctx) => ctx.db.get(sportId));
    expect("hasNoTeams" in row!).toBe(false);
  });

  test("clearing a sport that was never flagged stays unflagged and does not bump lastUpdated", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedRow(t, "sport", "Baseball");
    await t.withIdentity(ADMIN).mutation(api.sportTeamless.setHasNoTeams, { sportId, hasNoTeams: false });
    const row = await t.run(async (ctx) => ctx.db.get(sportId));
    expect("hasNoTeams" in row!).toBe(false);
    expect(row!.lastUpdated).toBe(SEEDED_AT);
  });

  test("touches no card: the flag only moves what a later save defaults to", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedRow(t, "sport", "Pokemon");
    await t.withIdentity(ADMIN).mutation(api.sportTeamless.setHasNoTeams, { sportId, hasNoTeams: true });
    expect(await t.run(async (ctx) => ctx.db.query("cardChecklist").collect())).toEqual([]);
    expect(await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  });
});

describe("sportTeamless.listTeamlessSportIds", () => {
  test("refuses a signed-out caller and a non-admin", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.sportTeamless.listTeamlessSportIds, {})).rejects.toThrow();
    await expect(t.withIdentity(USER).query(api.sportTeamless.listTeamlessSportIds, {})).rejects.toThrow();
  });

  test("returns only flagged sport rows: not unflagged sports, not a flagged non-sport", async () => {
    const t = convexTest(schema, modules);
    const pokemon = await seedRow(t, "sport", "Pokemon", { hasNoTeams: true });
    const magic = await seedRow(t, "sport", "Magic", { hasNoTeams: true });
    await seedRow(t, "sport", "Baseball");
    const stored = await seedRow(t, "sport", "Football");
    await t.run(async (ctx) => ctx.db.patch(stored, { hasNoTeams: false }));
    await seedRow(t, "year", "2024", { parentId: pokemon, hasNoTeams: true });

    const ids = await t.withIdentity(ADMIN).query(api.sportTeamless.listTeamlessSportIds, {});
    expect([...ids].sort()).toEqual([pokemon, magic].sort());
  });

  test("is empty when nothing is flagged", async () => {
    const t = convexTest(schema, modules);
    await seedRow(t, "sport", "Baseball");
    expect(await t.withIdentity(ADMIN).query(api.sportTeamless.listTeamlessSportIds, {})).toEqual([]);
  });

  test("follows a clear: flagged, then cleared, then gone from the list", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedRow(t, "sport", "Pokemon");
    const as = t.withIdentity(ADMIN);
    await as.mutation(api.sportTeamless.setHasNoTeams, { sportId, hasNoTeams: true });
    expect(await as.query(api.sportTeamless.listTeamlessSportIds, {})).toEqual([sportId]);
    await as.mutation(api.sportTeamless.setHasNoTeams, { sportId, hasNoTeams: false });
    expect(await as.query(api.sportTeamless.listTeamlessSportIds, {})).toEqual([]);
  });
});

describe("teamlessSportIdSet and the internal reads", () => {
  test("teamlessSportIdSet matches the public list", async () => {
    const t = convexTest(schema, modules);
    const pokemon = await seedRow(t, "sport", "Pokemon", { hasNoTeams: true });
    await seedRow(t, "sport", "Baseball");
    const ids = await t.run(async (ctx) => [...(await teamlessSportIdSet(ctx))]);
    expect(ids).toEqual([pokemon]);
  });

  test("playersWithTeamlessHomeSport answers by HOME sport only; extra sports never count", async () => {
    const t = convexTest(schema, modules);
    const pokemon = await seedRow(t, "sport", "Pokemon", { hasNoTeams: true });
    const baseball = await seedRow(t, "sport", "Baseball");
    const home = await seedPlayer(t, pokemon, "Pika Chu");
    const bench = await seedPlayer(t, baseball, "Johnny Bench");
    // Bench also plays the flagged sport as an extra: it must not count.
    await t.run(async (ctx) =>
      ctx.db.insert("playerSports", { playerId: bench, sportId: pokemon, nameNormalized: "johnny bench" }),
    );
    const missing = await seedPlayer(t, pokemon, "Deleted Guy");
    await t.run(async (ctx) => ctx.db.delete(missing));

    const out = await t.query(internal.sportTeamless.playersWithTeamlessHomeSport, {
      candidatePlayerIds: [home, bench, missing, home],
      teamlessSportIds: [pokemon],
    });
    expect(out).toEqual([home]);
  });

  test("with no flagged sport it answers empty, and a slice over the cap is refused", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedRow(t, "sport", "Baseball");
    const p = await seedPlayer(t, baseball, "Johnny Bench");
    expect(
      await t.query(internal.sportTeamless.playersWithTeamlessHomeSport, {
        candidatePlayerIds: [p],
        teamlessSportIds: [],
      }),
    ).toEqual([]);
    await expect(
      t.query(internal.sportTeamless.playersWithTeamlessHomeSport, {
        candidatePlayerIds: Array.from({ length: TEAMLESS_PLAYER_LOOKUP_PAGE + 1 }, () => p),
        teamlessSportIds: [baseball],
      }),
    ).rejects.toThrow(/exceeds/);
  });

  test("teamlessSportIdList is the flagged ids", async () => {
    const t = convexTest(schema, modules);
    const pokemon = await seedRow(t, "sport", "Pokemon", { hasNoTeams: true });
    await seedRow(t, "sport", "Baseball");
    expect(await t.query(internal.sportTeamless.teamlessSportIdList, {})).toEqual([pokemon]);
  });
});
