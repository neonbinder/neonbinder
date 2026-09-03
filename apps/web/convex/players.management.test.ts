/**
 * NEO-212: unit tests for the Player Management backend —
 * `players.listForManagement`, `players.createByAdmin` and
 * `players.savePlayerFields`, the three functions backing `/admin/players`.
 *
 * Fixtures are raw `ctx.db.insert` rows, per the minimal-fixture convention in
 * convex/entityReviewQueue.test.ts: there is no need to route through a real
 * checklist fetch just to get players and teams into the tables.
 *
 * Every function under test is admin-gated via `requireAdmin`, so the happy
 * paths run through `t.withIdentity(ADMIN_IDENTITY)` (an identity carrying
 * `role: "admin"`) and each has a signed-in-but-not-admin counterpart. A
 * signed-in non-admin is the interesting negative here rather than an anonymous
 * caller: sign-up is open, so "signed in" is not a bound on who may edit
 * globally-shared reference rows.
 *
 * `createByAdmin`'s enrichment scheduling is asserted the way
 * convex/enrichmentCreationOnly.test.ts asserts the `teams.findOrCreate` twin —
 * by reading `_scheduled_functions` rather than draining it. The scheduled work
 * reaches `wikidataPool.enqueueAction`, and convex-test cannot mount the
 * workpool component; letting it run would test the pool, not this wiring.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizePlayerName, sortTeamYears } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "user_player_admin",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_player_admin",
  role: "admin",
};

/** Signed in, no admin role — the negative case that matters. */
const MEMBER_IDENTITY = {
  subject: "user_player_member",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_player_member",
};

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T, value = "Baseball"): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      sportConfig: {
        skuCode: value.slice(0, 2).toUpperCase(),
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

/** A non-sport selectorOptions row, to prove the level check is real. */
async function seedNonSportOption(t: T): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Refractor",
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertPlayer(
  t: T,
  opts: {
    name: string;
    sportId: Id<"selectorOptions">;
    createdByUserId?: string;
    wikidataId?: string;
  },
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name: opts.name,
      nameNormalized: normalizePlayerName(opts.name),
      sportId: opts.sportId,
      createdByUserId: opts.createdByUserId ?? "user_seed",
      externalIds: opts.wikidataId ? { wikidataId: opts.wikidataId } : undefined,
      lastUpdated: Date.now(),
    }),
  );
}

/**
 * `nameNormalized` is deliberately just a lowercase here rather than
 * `normalizeTeamName`: nothing under test reads a team's normalized name, and
 * not importing it keeps this file independent of teams.ts.
 */
async function insertTeam(
  t: T,
  opts: { name: string; sportId: Id<"selectorOptions"> },
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name: opts.name,
      nameNormalized: opts.name.toLowerCase(),
      sportId: opts.sportId,
      lastUpdated: Date.now(),
    }),
  );
}

const getPlayer = (t: T, id: Id<"players">) => t.run(async (ctx) => ctx.db.get(id));

/**
 * How many `enqueueEnrichment` calls are sitting on the scheduler. Same
 * technique as convex/enrichmentCreationOnly.test.ts — the scheduled work is
 * never run, only counted.
 */
async function scheduledEnrichmentCount(t: T): Promise<number> {
  const names = await t.run(async (ctx) => {
    const rows = await (
      ctx as unknown as {
        db: {
          system: {
            query: (n: string) => { collect: () => Promise<Array<{ name: string }>> };
          };
        };
      }
    ).db.system.query("_scheduled_functions").collect();
    return rows.map((r) => r.name);
  });
  return names.filter((n) => n.includes("enqueueEnrichment")).length;
}

/** Capture a rejection so the message itself can be asserted, not just its shape. */
async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to reject, but it resolved");
}

// ===========================================================================
// sortTeamYears — the exported pure helper
// ===========================================================================

describe("sortTeamYears", () => {
  test("orders by fromYear, then by toYear with open-ended last", () => {
    const a = { teamId: "t1" as Id<"teams">, fromYear: 2005, toYear: 2008 };
    const b = { teamId: "t2" as Id<"teams">, fromYear: 1999 };
    const c = { teamId: "t3" as Id<"teams">, fromYear: 2005 };
    const d = { teamId: "t4" as Id<"teams">, fromYear: 2005, toYear: 2006 };

    expect(sortTeamYears([a, b, c, d])).toEqual([b, d, a, c]);
  });

  test("does not mutate its input", () => {
    const input = [
      { teamId: "t1" as Id<"teams">, fromYear: 2010 },
      { teamId: "t2" as Id<"teams">, fromYear: 1990 },
    ];
    const snapshot = [...input];
    sortTeamYears(input);
    expect(input).toEqual(snapshot);
  });
});

// ===========================================================================
// listForManagement
// ===========================================================================

describe("listForManagement", () => {
  test("returns every player sorted by name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, { name: "Willie Mays", sportId });
    await insertPlayer(t, { name: "Hank Aaron", sportId });
    await insertPlayer(t, { name: "Mike Trout", sportId });

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.players.listForManagement, {});

    expect(result.players.map((p) => p.name)).toEqual([
      "Hank Aaron",
      "Mike Trout",
      "Willie Mays",
    ]);
    expect(result.totalCount).toBe(3);
    expect(result.truncated).toBe(false);
  });

  test("honours sportId, returning only that sport's players", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const basketball = await seedSport(t, "Basketball");
    await insertPlayer(t, { name: "Hank Aaron", sportId: baseball });
    await insertPlayer(t, { name: "Michael Jordan", sportId: basketball });

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.players.listForManagement, { sportId: basketball });

    expect(result.players.map((p) => p.name)).toEqual(["Michael Jordan"]);
    expect(result.totalCount).toBe(1);
  });

  test("reports truncated when there is a row past the limit", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, { name: "Alpha One", sportId });
    await insertPlayer(t, { name: "Bravo Two", sportId });
    await insertPlayer(t, { name: "Charlie Three", sportId });

    const truncatedResult = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.players.listForManagement, { limit: 2 });
    expect(truncatedResult.players).toHaveLength(2);
    expect(truncatedResult.totalCount).toBe(2);
    expect(truncatedResult.truncated).toBe(true);

    // Exactly at the limit is NOT truncated — the +1 probe is what distinguishes
    // "the last page happens to be full" from "there is more".
    const exactResult = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.players.listForManagement, { limit: 3 });
    expect(exactResult.players).toHaveLength(3);
    expect(exactResult.truncated).toBe(false);
  });

  test("clamps an over-large limit to the 500 cap and reports truncation", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        const name = `Player ${String(i).padStart(4, "0")}`;
        await ctx.db.insert("players", {
          name,
          nameNormalized: normalizePlayerName(name),
          sportId,
          createdByUserId: "user_seed",
          lastUpdated: Date.now(),
        });
      }
    });

    // A caller asking for 10_000 must not get 10_000 — the cap is a ceiling,
    // not a default, or this query quietly becomes an unbounded table scan.
    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.players.listForManagement, { limit: 10_000 });

    expect(result.players).toHaveLength(500);
    expect(result.totalCount).toBe(500);
    expect(result.truncated).toBe(true);
  });

  test("never returns createdByUserId", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, {
      name: "Hank Aaron",
      sportId,
      createdByUserId: "clerk_subject_that_must_not_leak",
    });

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.players.listForManagement, {});

    expect(result.players).toHaveLength(1);
    expect(result.players[0]).not.toHaveProperty("createdByUserId");
    expect(JSON.stringify(result)).not.toContain("clerk_subject_that_must_not_leak");
  });

  test("rejects a signed-in non-admin", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(
      t.withIdentity(MEMBER_IDENTITY).query(api.players.listForManagement, {}),
    ).rejects.toThrow(/Admin access required/);
  });

  test("rejects an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(t.query(api.players.listForManagement, {})).rejects.toThrow(
      /Not authenticated/,
    );
  });
});

// ===========================================================================
// createByAdmin
// ===========================================================================

describe("createByAdmin", () => {
  test("inserts the player once and reports created:true", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.players.createByAdmin, { name: "  Mike Trout  ", sportId });

    expect(result.created).toBe(true);

    const doc = await getPlayer(t, result.id);
    expect(doc?.name).toBe("Mike Trout");
    expect(doc?.nameNormalized).toBe(normalizePlayerName("Mike Trout"));
    expect(doc?.sportId).toBe(sportId);
    expect(doc?.createdByUserId).toBe(ADMIN_IDENTITY.subject);
    expect(doc?.lastUpdated).toBeGreaterThan(0);
  });

  test("a second call with the same name returns the same id and created:false", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const first = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Mike Trout",
      sportId,
    });
    // Token-sorted normalization: a different spelling of the same name is the
    // same row, which is the whole point of the dedup key.
    const second = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Trout, Mike",
      sportId,
    });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);

    const all = await t.run(async (ctx) => ctx.db.query("players").collect());
    expect(all).toHaveLength(1);
  });

  test("the same name under a different sport is a different player", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const basketball = await seedSport(t, "Basketball");
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const a = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Chris Johnson",
      sportId: baseball,
    });
    const b = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Chris Johnson",
      sportId: basketball,
    });

    expect(b.id).not.toBe(a.id);
    expect(b.created).toBe(true);
  });

  test("enqueues enrichment on the INSERT branch only", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await asAdmin.mutation(api.players.createByAdmin, { name: "Mike Trout", sportId });
    expect(await scheduledEnrichmentCount(t)).toBe(1);

    // The FOUND branch adds nothing — enqueueEnrichment's creation-only
    // contract (NEO-203) lives or dies on this early return.
    await asAdmin.mutation(api.players.createByAdmin, { name: "Mike Trout", sportId });
    expect(await scheduledEnrichmentCount(t)).toBe(1);
  });

  test("a player that already existed before this mutation is never enqueued", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, { name: "Hank Aaron", sportId });

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.players.createByAdmin, { name: "Hank Aaron", sportId });

    expect(result.created).toBe(false);
    expect(await scheduledEnrichmentCount(t)).toBe(0);
  });

  test("rejects an empty or whitespace-only name, and enqueues nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await expect(
      t
        .withIdentity(ADMIN_IDENTITY)
        .mutation(api.players.createByAdmin, { name: "   ", sportId }),
    ).rejects.toThrow(/player name is required/i);

    expect(await scheduledEnrichmentCount(t)).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.query("players").collect())).toHaveLength(0);
  });

  test("rejects a name past the 120-character cap without trimming it down", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const atCap = "a".repeat(120);
    await expect(
      asAdmin.mutation(api.players.createByAdmin, { name: atCap, sportId }),
    ).resolves.toMatchObject({ created: true });

    const overCap = "a".repeat(121);
    const message = await rejectionMessage(
      asAdmin.mutation(api.players.createByAdmin, { name: overCap, sportId }),
    );
    expect(message).toMatch(/121 characters/);
    // The LENGTH, never the name — this string reaches Sentry and the console.
    expect(message).not.toContain(overCap);
  });

  test("refuses a sportId that is not a sport row", async () => {
    const t = convexTest(schema, modules);
    const notASport = await seedNonSportOption(t);

    await expect(
      t
        .withIdentity(ADMIN_IDENTITY)
        .mutation(api.players.createByAdmin, { name: "Mike Trout", sportId: notASport }),
    ).rejects.toThrow(/must be created under a sport/);
  });

  test("rejects a signed-in non-admin and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await expect(
      t
        .withIdentity(MEMBER_IDENTITY)
        .mutation(api.players.createByAdmin, { name: "Mike Trout", sportId }),
    ).rejects.toThrow(/Admin access required/);

    expect(await t.run(async (ctx) => ctx.db.query("players").collect())).toHaveLength(0);
    expect(await scheduledEnrichmentCount(t)).toBe(0);
  });
});

// ===========================================================================
// savePlayerFields
// ===========================================================================

describe("savePlayerFields", () => {
  test("stores career stints sorted by fromYear", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Nolan Ryan", sportId });
    const mets = await insertTeam(t, { name: "New York Mets", sportId });
    const angels = await insertTeam(t, { name: "California Angels", sportId });
    const astros = await insertTeam(t, { name: "Houston Astros", sportId });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: playerId,
      teamYears: [
        { teamId: astros, fromYear: 1980, toYear: 1988 },
        { teamId: mets, fromYear: 1966, toYear: 1971 },
        { teamId: angels, fromYear: 1972, toYear: 1979 },
      ],
    });

    const doc = await getPlayer(t, playerId);
    expect(doc?.teamYears).toEqual([
      { teamId: mets, fromYear: 1966, toYear: 1971 },
      { teamId: angels, fromYear: 1972, toYear: 1979 },
      { teamId: astros, fromYear: 1980, toYear: 1988 },
    ]);
  });

  test("keeps TWO stints at the same team — a return is real history, not a duplicate", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Player Returned", sportId });
    const home = await insertTeam(t, { name: "Home Town Nine", sportId });
    const away = await insertTeam(t, { name: "Away Town Nine", sportId });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: playerId,
      teamYears: [
        { teamId: home, fromYear: 2015, toYear: 2018 },
        { teamId: home, fromYear: 2005, toYear: 2010 },
        { teamId: away, fromYear: 2011, toYear: 2014 },
      ],
    });

    const doc = await getPlayer(t, playerId);
    expect(doc?.teamYears).toEqual([
      { teamId: home, fromYear: 2005, toYear: 2010 },
      { teamId: away, fromYear: 2011, toYear: 2014 },
      { teamId: home, fromYear: 2015, toYear: 2018 },
    ]);
  });

  test("an open-ended stint sorts after a closed one that started the same year", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Two Way Player", sportId });
    const a = await insertTeam(t, { name: "Team A", sportId });
    const b = await insertTeam(t, { name: "Team B", sportId });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: playerId,
      teamYears: [
        { teamId: a, fromYear: 2020 },
        { teamId: b, fromYear: 2020, toYear: 2021 },
      ],
    });

    const doc = await getPlayer(t, playerId);
    expect(doc?.teamYears).toEqual([
      { teamId: b, fromYear: 2020, toYear: 2021 },
      { teamId: a, fromYear: 2020 },
    ]);
  });

  test("an empty teamYears array clears the history", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Cleared Player", sportId });
    const team = await insertTeam(t, { name: "Some Team", sportId });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await asAdmin.mutation(api.players.savePlayerFields, {
      id: playerId,
      teamYears: [{ teamId: team, fromYear: 1999 }],
    });
    await asAdmin.mutation(api.players.savePlayerFields, {
      id: playerId,
      teamYears: [],
    });

    expect((await getPlayer(t, playerId))?.teamYears).toEqual([]);
  });

  test("rejects a duplicate (teamId, fromYear) pair", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Dup Stint", sportId });
    const team = await insertTeam(t, { name: "Repeat Town", sportId });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
        id: playerId,
        teamYears: [
          { teamId: team, fromYear: 1990, toYear: 1992 },
          { teamId: team, fromYear: 1990 },
        ],
      }),
    ).rejects.toThrow(/listed twice starting in 1990/);

    expect((await getPlayer(t, playerId))?.teamYears).toBeUndefined();
  });

  test("rejects a team from another sport", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const basketball = await seedSport(t, "Basketball");
    const playerId = await insertPlayer(t, { name: "Bo Jackson", sportId: baseball });
    const hoops = await insertTeam(t, { name: "Chicago Bulls", sportId: basketball });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
        id: playerId,
        teamYears: [{ teamId: hoops, fromYear: 1990 }],
      }),
    ).rejects.toThrow(/team from another sport/);
  });

  test("rejects a teamId that no longer exists", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Orphan Stint", sportId });
    const ghost = await insertTeam(t, { name: "Deleted Town", sportId });
    await t.run(async (ctx) => ctx.db.delete(ghost));

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
        id: playerId,
        teamYears: [{ teamId: ghost, fromYear: 1990 }],
      }),
    ).rejects.toThrow(/team that no longer exists/);
  });

  test("rejects out-of-range and non-integer years, and an end before the start", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Bad Years", sportId });
    const team = await insertTeam(t, { name: "Any Town", sportId });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const nextYear = new Date().getFullYear() + 1;

    await expect(
      asAdmin.mutation(api.players.savePlayerFields, {
        id: playerId,
        teamYears: [{ teamId: team, fromYear: 1849 }],
      }),
    ).rejects.toThrow(/start year must be a whole year/);

    await expect(
      asAdmin.mutation(api.players.savePlayerFields, {
        id: playerId,
        teamYears: [{ teamId: team, fromYear: nextYear + 1 }],
      }),
    ).rejects.toThrow(/start year must be a whole year/);

    await expect(
      asAdmin.mutation(api.players.savePlayerFields, {
        id: playerId,
        teamYears: [{ teamId: team, fromYear: 1990.5 }],
      }),
    ).rejects.toThrow(/start year must be a whole year/);

    await expect(
      asAdmin.mutation(api.players.savePlayerFields, {
        id: playerId,
        teamYears: [{ teamId: team, fromYear: 1990, toYear: 1989 }],
      }),
    ).rejects.toThrow(/cannot end before it starts/);

    // Next year IS allowed — a card printed in the autumn carries the following
    // season, and refusing it would make the editor wrong every winter.
    await expect(
      asAdmin.mutation(api.players.savePlayerFields, {
        id: playerId,
        teamYears: [{ teamId: team, fromYear: nextYear }],
      }),
    ).resolves.toBeNull();
  });

  test("renames the player and recomputes nameNormalized", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Mike Trot", sportId });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: playerId,
      name: "  Mike Trout  ",
    });

    const doc = await getPlayer(t, playerId);
    expect(doc?.name).toBe("Mike Trout");
    expect(doc?.nameNormalized).toBe(normalizePlayerName("Mike Trout"));
  });

  test("renaming onto an existing (name, sport) throws NAME_TAKEN with the other id", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const keep = await insertPlayer(t, { name: "Mike Trout", sportId });
    const editing = await insertPlayer(t, { name: "Mike Trot", sportId });

    const message = await rejectionMessage(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
        id: editing,
        name: "Mike Trout",
      }),
    );

    expect(message.startsWith("NAME_TAKEN:")).toBe(true);
    expect(message).toBe(`NAME_TAKEN:${keep}`);
    // The colliding row's audit field must not ride along in the message.
    expect(message).not.toContain("user_seed");

    // Nothing was written on the rejected path.
    expect((await getPlayer(t, editing))?.name).toBe("Mike Trot");
  });

  test("re-saving a player under its own name is not a collision", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Mike Trout", sportId });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
        id: playerId,
        name: "Mike Trout",
        isHallOfFame: true,
      }),
    ).resolves.toBeNull();

    expect((await getPlayer(t, playerId))?.isHallOfFame).toBe(true);
  });

  test("the same name under another sport is not a collision", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const basketball = await seedSport(t, "Basketball");
    await insertPlayer(t, { name: "Chris Johnson", sportId: basketball });
    const editing = await insertPlayer(t, { name: "Chris Jonson", sportId: baseball });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
        id: editing,
        name: "Chris Johnson",
      }),
    ).resolves.toBeNull();
  });

  test("rejects an empty name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Keep Me", sportId });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
        id: playerId,
        name: "   ",
      }),
    ).rejects.toThrow(/player name is required/i);

    expect((await getPlayer(t, playerId))?.name).toBe("Keep Me");
  });

  test("wikidataId: null clears it, leaving no stale externalIds", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, {
      name: "Mike Trout",
      sportId,
      wikidataId: "Q1194380",
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: playerId,
      wikidataId: null,
    });

    const doc = await getPlayer(t, playerId);
    expect(doc?.externalIds?.wikidataId).toBeUndefined();
  });

  test("wikidataId: a valid QID is stored trimmed", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Mike Trout", sportId });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: playerId,
      wikidataId: "  Q42  ",
    });

    expect((await getPlayer(t, playerId))?.externalIds?.wikidataId).toBe("Q42");
  });

  test("rejects a malformed wikidataId", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, {
      name: "Mike Trout",
      sportId,
      wikidataId: "Q1194380",
    });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    for (const bad of ["42", "q42", "Q", "Q4 2", "https://www.wikidata.org/wiki/Q42", ""]) {
      await expect(
        asAdmin.mutation(api.players.savePlayerFields, { id: playerId, wikidataId: bad }),
      ).rejects.toThrow(/Not a Wikidata entity id/);
    }

    // The good value it already held is untouched by every rejected write.
    expect((await getPlayer(t, playerId))?.externalIds?.wikidataId).toBe("Q1194380");
  });

  test("never touches createdByUserId, and always bumps lastUpdated", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, {
      name: "Audited Player",
      sportId,
      createdByUserId: "clerk_original_creator",
    });
    const before = await getPlayer(t, playerId);

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: playerId,
      name: "Audited Player Renamed",
      isHallOfFame: true,
    });

    const after = await getPlayer(t, playerId);
    expect(after?.createdByUserId).toBe("clerk_original_creator");
    expect(after?.createdByUserId).not.toBe(ADMIN_IDENTITY.subject);
    expect(after?.lastUpdated).toBeGreaterThanOrEqual(before!.lastUpdated);
  });

  test("rejects an unknown player id", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const ghost = await insertPlayer(t, { name: "Gone", sportId });
    await t.run(async (ctx) => ctx.db.delete(ghost));

    await expect(
      t
        .withIdentity(ADMIN_IDENTITY)
        .mutation(api.players.savePlayerFields, { id: ghost, name: "Back" }),
    ).rejects.toThrow(/Player not found/);
  });

  test("rejects a signed-in non-admin and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, { name: "Keep Me", sportId });

    await expect(
      t.withIdentity(MEMBER_IDENTITY).mutation(api.players.savePlayerFields, {
        id: playerId,
        name: "Hijacked",
        isHallOfFame: true,
      }),
    ).rejects.toThrow(/Admin access required/);

    const doc = await getPlayer(t, playerId);
    expect(doc?.name).toBe("Keep Me");
    expect(doc?.isHallOfFame).toBeUndefined();
  });
});
