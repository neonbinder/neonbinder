/**
 * NEO-330 — every team reachable from Team Management and the spine-label
 * picker, not only the ones inside the list's window.
 *
 * `teams.listForManagement` and `teams.listForPicker` return at most 2000 rows.
 * They used to walk the table in insertion order, so the window held the OLDEST
 * 2000 teams, and both screens filtered that window in the browser and looked
 * `?team=` ids up in it. With the reference catalogue loaded the table is
 * several times the cap, so any team created after the first 2000 — including
 * every team an operator or an E2E flow had just made — could never be found
 * or opened.
 *
 * Three fixes, pinned here:
 *   1. the windows are NEWEST first, so a fresh team is in them;
 *   2. `searchForManagement` answers a typed filter from the whole table, by the
 *      every-word rule `lib/teams/team-filter.ts` defines;
 *   3. `getByIdParam` reads a linked team by id, wherever it is.
 *
 * convex-test's search index is an approximation (see the header of
 * `teams.search.test.ts`): OR over the words like production, but no BM25
 * ranking. Nothing below asserts an order the index decides.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin_330", role: "admin" };
const MEMBER = { subject: "member_330", role: "user" };

/** `TEAM_MANAGEMENT_CAP` in convex/teams.ts. */
const CAP = 2000;

async function seedSport(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function seedLeague(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name,
      nameNormalized: name.toLowerCase(),
      sportId,
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function seedTeam(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  fullName: string,
  extra: { leagueId?: Id<"leagues">; aliases?: string[] } = {},
) {
  return t.run(async (ctx) => {
    const teamId = await ctx.db.insert("teams", {
      name: fullName,
      nameNormalized: normalizeTeamName(fullName),
      sportId,
      lastUpdated: 1_700_000_000_000,
      ...extra,
    });
    for (const alias of extra.aliases ?? []) {
      await ctx.db.insert("teamAliases", {
        teamId,
        sportId,
        aliasNormalized: normalizeTeamName(alias),
      });
    }
    return teamId;
  });
}

/** `count` filler teams, then one named team created after all of them. */
async function seedPastTheCap(t: ReturnType<typeof convexTest>, count: number) {
  const sportId = await seedSport(t);
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i += 1) {
      await ctx.db.insert("teams", {
        name: `Filler ${i}`,
        nameNormalized: normalizeTeamName(`Filler ${i}`),
        sportId,
        lastUpdated: 1_700_000_000_000,
      });
    }
  });
  const fresh = await seedTeam(t, sportId, "Montreal Expos");
  return { sportId, fresh };
}

describe("the capped windows are newest first (NEO-330)", () => {
  test("listForManagement holds a team created after CAP others, and drops the oldest", async () => {
    const t = convexTest(schema, modules);
    const { fresh } = await seedPastTheCap(t, CAP);

    const result = await t.withIdentity(ADMIN).query(api.teams.listForManagement, {});

    expect(result.truncated).toBe(true);
    expect(result.teams).toHaveLength(CAP);
    const ids = new Set(result.teams.map((team) => team._id));
    expect(ids.has(fresh)).toBe(true);
    // The first filler is the oldest row, and the one the window gives up.
    expect(result.teams.some((team) => team.name === "Filler 0")).toBe(false);
  }, 60_000);

  test("the sport-scoped window is newest first too", async () => {
    const t = convexTest(schema, modules);
    const { sportId, fresh } = await seedPastTheCap(t, CAP);

    const result = await t
      .withIdentity(ADMIN)
      .query(api.teams.listForManagement, { sportId });

    expect(result.teams.some((team) => team._id === fresh)).toBe(true);
  }, 60_000);

  test("listForPicker holds the fresh team as well", async () => {
    const t = convexTest(schema, modules);
    const { fresh } = await seedPastTheCap(t, CAP);

    const rows = await t.withIdentity(MEMBER).query(api.teams.listForPicker, {});

    expect(rows).toHaveLength(CAP);
    expect(rows.some((team) => team._id === fresh)).toBe(true);
  }, 60_000);

  test("is still sorted by full name for display", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedTeam(t, sportId, "Seattle Mariners");
    await seedTeam(t, sportId, "Boston Red Sox");
    await seedTeam(t, sportId, "Montreal Expos");

    const result = await t.withIdentity(ADMIN).query(api.teams.listForManagement, {});

    expect(result.teams.map((team) => team.name)).toEqual([
      "Boston Red Sox",
      "Montreal Expos",
      "Seattle Mariners",
    ]);
  });
});

describe("teams.searchForManagement (NEO-330)", () => {
  test("finds a team the list's window leaves out", async () => {
    const t = convexTest(schema, modules);
    // Oldest first this time: the named team is the one an oldest-first window
    // would have kept, so put it BEFORE the filler and prove search does not
    // care where it sits.
    const sportId = await seedSport(t);
    const expos = await seedTeam(t, sportId, "Montreal Expos");
    await t.run(async (ctx) => {
      for (let i = 0; i < CAP; i += 1) {
        await ctx.db.insert("teams", {
          name: `Filler ${i}`,
          nameNormalized: normalizeTeamName(`Filler ${i}`),
          sportId,
          lastUpdated: 1_700_000_000_000,
        });
      }
    });

    const asAdmin = t.withIdentity(ADMIN);
    const list = await asAdmin.query(api.teams.listForManagement, {});
    expect(list.teams.some((team) => team._id === expos)).toBe(false);

    const result = await asAdmin.query(api.teams.searchForManagement, {
      query: "Expos",
    });
    expect(result.teams.map((team) => team._id)).toEqual([expos]);
    expect(result.truncated).toBe(false);
  }, 60_000);

  test("keeps only teams carrying EVERY typed word, not every team sharing one", async () => {
    // The index alone is OR over the words: "pittsburgh crawfords" would come
    // back with every Pittsburgh team. The E2E flows assert "1 of N teams"
    // after typing a full name, so this rule is what keeps that count honest.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const crawfords = await seedTeam(t, sportId, "Pittsburgh Crawfords");
    await seedTeam(t, sportId, "Pittsburgh Pirates");
    await seedTeam(t, sportId, "Pittsburgh Steelers");

    const result = await t
      .withIdentity(ADMIN)
      .query(api.teams.searchForManagement, { query: "Pittsburgh Crawfords" });

    expect(result.teams.map((team) => team._id)).toEqual([crawfords]);
  });

  test("matches a word by its start, on the composed name, in any order", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await seedTeam(t, sportId, "San Diego Padres");
    await seedTeam(t, sportId, "San Francisco Giants");

    const asAdmin = t.withIdentity(ADMIN);
    for (const query of ["san die", "padres san", "Padres"]) {
      const result = await asAdmin.query(api.teams.searchForManagement, { query });
      expect(result.teams.map((team) => team._id), query).toEqual([padres]);
    }
  });

  test("finds a team by an exact alias", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const tigers = await seedTeam(t, sportId, "Louisiana State Tigers", {
      aliases: ["LSU"],
    });

    const result = await t
      .withIdentity(ADMIN)
      .query(api.teams.searchForManagement, { query: "LSU" });

    expect(result.teams.map((team) => team._id)).toEqual([tigers]);
  });

  test("applies the league filter before the limit, including 'none'", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const mlb = await seedLeague(t, sportId, "Major League Baseball");
    const nfl = await seedLeague(t, sportId, "National Football League");
    const yankees = await seedTeam(t, sportId, "New York Yankees", { leagueId: mlb });
    const giants = await seedTeam(t, sportId, "New York Giants", { leagueId: nfl });
    const cubans = await seedTeam(t, sportId, "New York Cubans");

    const asAdmin = t.withIdentity(ADMIN);
    const inMlb = await asAdmin.query(api.teams.searchForManagement, {
      query: "new york",
      leagueId: mlb,
    });
    expect(inMlb.teams.map((team) => team._id)).toEqual([yankees]);

    const inNone = await asAdmin.query(api.teams.searchForManagement, {
      query: "new york",
      leagueId: "none",
    });
    expect(inNone.teams.map((team) => team._id)).toEqual([cubans]);

    const everywhere = await asAdmin.query(api.teams.searchForManagement, {
      query: "new york",
    });
    expect(new Set(everywhere.teams.map((team) => team._id))).toEqual(
      new Set([yankees, giants, cubans]),
    );
  });

  test("returns at most 50 and says it was truncated", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 51; i += 1) {
        await ctx.db.insert("teams", {
          name: `Giants ${i}`,
          nameNormalized: normalizeTeamName(`Giants ${i}`),
          sportId,
          lastUpdated: 1_700_000_000_000,
        });
      }
    });

    const result = await t
      .withIdentity(ADMIN)
      .query(api.teams.searchForManagement, { query: "giants" });

    expect(result.teams).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  test("answers an empty or punctuation-only filter with nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedTeam(t, sportId, "Montreal Expos");

    const asAdmin = t.withIdentity(ADMIN);
    for (const query of ["", "   ", "..."]) {
      expect(
        await asAdmin.query(api.teams.searchForManagement, { query }),
      ).toEqual({ teams: [], truncated: false });
    }
  });

  test("reads only the first 16 words of what it is sent (security clamp)", async () => {
    // Sixteen words that all start "San Diego Padres", then a word no team
    // carries. Every typed word must match, so the team is found only if the
    // seventeenth word never reached the matcher.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await seedTeam(t, sportId, "San Diego Padres");
    const sixteen = Array.from({ length: 16 }, (_, i) =>
      ["san", "diego", "padres"][i % 3],
    ).join(" ");

    const asAdmin = t.withIdentity(ADMIN);
    const result = await asAdmin.query(api.teams.searchForManagement, {
      query: `${sixteen} zzzzzz`,
    });
    expect(result.teams.map((team) => team._id)).toEqual([padres]);

    // …and a flood of text is an answer, not a thrown query.
    const flood = await asAdmin.query(api.teams.searchForManagement, {
      query: "padres ".repeat(5000),
    });
    expect(flood.teams.map((team) => team._id)).toEqual([padres]);
    expect(
      await t
        .withIdentity(MEMBER)
        .query(api.teams.search, { query: `${sixteen} zzzzzz ${"x".repeat(9000)}` }),
    ).toEqual([expect.objectContaining({ _id: padres })]);
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.withIdentity(MEMBER).query(api.teams.searchForManagement, { query: "Expos" }),
    ).rejects.toThrow(/admin/i);
  });
});

describe("teams.getByIdParam (NEO-330)", () => {
  test("reads a team by the id a URL carried", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const expos = await seedTeam(t, sportId, "Montreal Expos");

    const row = await t.withIdentity(MEMBER).query(api.teams.getByIdParam, { id: expos });
    expect(row?._id).toBe(expos);
  });

  test("answers null, never throws, for an id that is malformed, foreign or gone", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const gone = await seedTeam(t, sportId, "Montreal Expos");
    await t.run(async (ctx) => ctx.db.delete(gone));

    const asMember = t.withIdentity(MEMBER);
    expect(await asMember.query(api.teams.getByIdParam, { id: "not-an-id" })).toBeNull();
    // A real id of ANOTHER table does not normalize as a team id.
    expect(await asMember.query(api.teams.getByIdParam, { id: sportId })).toBeNull();
    expect(await asMember.query(api.teams.getByIdParam, { id: gone })).toBeNull();
  });
});
