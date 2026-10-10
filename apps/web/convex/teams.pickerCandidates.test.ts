/**
 * NEO-331 — `teams.pickerCandidates`: the team picker's ranked candidates.
 *
 * The pure ordering is `lib/teams/team-rank.test.ts`; this file is everything
 * the SERVER adds to it: reading the set context off the selectorOptions tree
 * (the League feature, resolved by name OR alias, and the year from the year
 * ancestor), the three candidate legs, the browse window, and the gates.
 *
 * **convex-test's search is not the backend.** Its `withSearchIndex` returns
 * rows in insertion order (the backend is BM25, ties toward NEWER rows),
 * prefix-matches every term, and never checks that a filter field is declared
 * (that gate is `npm run typecheck`). So a "window" fixture is built so the
 * expected row is OUTSIDE the sport leg's 25-row window in the harness (last
 * inserted is dropped) and the assertion that matters — it still leads — is
 * also run with that row inserted FIRST, which is the end the backend drops.
 * In the first-inserted ordering the harness itself keeps the row in the sport
 * leg, so only the first ordering proves the league leg is load-bearing here;
 * the second guards the result, not the leg.
 *
 * Nothing here asserts an order that depends on search relevance: every
 * expectation is a tier, an alias lead, a prefix, or A–Z, all of which the
 * server computes itself.
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

// An ADMIN: the set context is only honoured for an admin (the tiers are the
// admin set builder's), so every tier assertion below is made as one.
const USER = {
  subject: "user_picker_331",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_picker_331",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;
type SelId = Id<"selectorOptions">;
type Level = "major" | "minor" | "college" | "international" | "independent" | "other";

async function seedSport(t: T, value = "Baseball", skuCode = "BB"): Promise<SelId> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      sportConfig: { skuCode, league: value.toUpperCase() },
      lastUpdated: 1,
    }),
  );
}

async function seedLeague(
  t: T,
  sportId: SelId,
  name: string,
  level: Level,
  aliases?: string[],
): Promise<Id<"leagues">> {
  return t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name,
      nameNormalized: name.toLowerCase(),
      sportId,
      level,
      ...(aliases ? { aliases } : {}),
      lastUpdated: 1,
    }),
  );
}

async function seedTeam(
  t: T,
  sportId: SelId,
  name: string,
  extra: {
    leagueId?: Id<"leagues">;
    yearsActive?: { from: number; to?: number };
    location?: string;
  } = {},
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name,
      nameNormalized: normalizeTeamName(name),
      sportId,
      lastUpdated: 1,
      ...extra,
    }),
  );
}

/**
 * sport → year → manufacturer → setName. The set carries the League feature;
 * `year` is the year row's label verbatim ("2024", "2025-26").
 */
async function seedSet(
  t: T,
  sportId: SelId,
  year: string | null,
  league: string | null,
): Promise<{ yearId?: SelId; setId: SelId }> {
  return t.run(async (ctx) => {
    let parent: SelId = sportId;
    let yearId: SelId | undefined;
    if (year !== null) {
      yearId = await ctx.db.insert("selectorOptions", {
        level: "year",
        value: year,
        parentId: sportId,
        platformData: {},
        children: [],
        lastUpdated: 1,
      });
      parent = yearId;
    }
    const manufacturerId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      parentId: parent,
      platformData: {},
      children: [],
      lastUpdated: 1,
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Series One",
      parentId: manufacturerId,
      platformData: {},
      children: [],
      ...(league ? { features: { league } } : {}),
      lastUpdated: 1,
    });
    return { yearId, setId };
  });
}

async function pick(
  t: T,
  args: {
    query: string;
    sportId?: SelId;
    contextOptionId?: SelId;
    limit?: number;
  },
) {
  return t.withIdentity(USER).query(api.teams.pickerCandidates, args);
}

const summary = (rows: Array<{ team: { name: string }; tier: number }>) =>
  rows.map((r) => `${r.team.name}:${r.tier}`);

/** The four-tier fixture: alphabetical order is the REVERSE of tier order. */
async function seedFourTiers(t: T, sportId: SelId) {
  const mlb = await seedLeague(t, sportId, "Major League Baseball", "major", ["MLB"]);
  const aaa = await seedLeague(t, sportId, "International League", "minor");
  await seedTeam(t, sportId, "RK Z", { leagueId: mlb, yearsActive: { from: 1958 } });
  await seedTeam(t, sportId, "RK Y", { leagueId: aaa, yearsActive: { from: 2000 } });
  await seedTeam(t, sportId, "RK X", { leagueId: mlb, yearsActive: { from: 1900, to: 1957 } });
  await seedTeam(t, sportId, "RK W", { yearsActive: { from: 1958 } });
  return { mlb, aaa };
}

describe("teams.pickerCandidates — the set context", () => {
  test("resolves features.league 'MLB' through an ALIAS and reads the year off the year ancestor", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedFourTiers(t, baseball);
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK Z:1", "RK Y:2", "RK X:3", "RK W:4"]);
  });

  test("reads the year from the year ancestor of a DEEPER context row too", async () => {
    // Callers pass whichever row they have; the year walks up from it.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    await seedTeam(t, baseball, "RK Old", { leagueId: mlb, yearsActive: { from: 1900, to: 1957 } });
    const { setId } = await seedSet(t, baseball, "2024", "MLB");
    const variantId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        parentId: setId,
        platformData: {},
        children: [],
        lastUpdated: 1,
      }),
    );

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: variantId });

    // The year resolved (the closed era is tier 3, not tier 1). The league is
    // NOT inherited from the set: only the context row's own feature counts, so
    // with none there is no league and the row is tier 4.
    expect(summary(rows)).toEqual(["RK Old:4"]);
  });

  test("a year label like '2025-26' reads as 2025", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    await seedTeam(t, baseball, "RK Starts2025", { leagueId: mlb, yearsActive: { from: 2025 } });
    await seedTeam(t, baseball, "RK Starts2026", { leagueId: mlb, yearsActive: { from: 2026 } });
    await seedTeam(t, baseball, "RK Ended2024", { leagueId: mlb, yearsActive: { from: 1990, to: 2024 } });
    const { setId } = await seedSet(t, baseball, "2025-26", "MLB");

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK Starts2025:1", "RK Ended2024:3", "RK Starts2026:3"]);
  });

  test("no year ancestor: every team in the league is tier 1, closed eras and undated included", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    const aaa = await seedLeague(t, baseball, "International League", "minor");
    await seedTeam(t, baseball, "RK Closed", { leagueId: mlb, yearsActive: { from: 1900, to: 1910 } });
    await seedTeam(t, baseball, "RK Undated", { leagueId: mlb });
    await seedTeam(t, baseball, "RK Minor", { leagueId: aaa, yearsActive: { from: 2000 } });
    const { setId } = await seedSet(t, baseball, null, "MLB");

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK Closed:1", "RK Undated:1", "RK Minor:4"]);
  });

  test("an unparseable year row degrades to 'no year' rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    await seedTeam(t, baseball, "RK Closed", { leagueId: mlb, yearsActive: { from: 1900, to: 1910 } });
    const { setId } = await seedSet(t, baseball, "Vintage", "MLB");

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK Closed:1"]);
  });

  test("a League feature that names no league leaves tiers 1 and 3 empty", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major");
    const aaa = await seedLeague(t, baseball, "International League", "minor");
    await seedTeam(t, baseball, "RK Mlb", { leagueId: mlb, yearsActive: { from: 1958 } });
    await seedTeam(t, baseball, "RK Aaa", { leagueId: aaa, yearsActive: { from: 2000 } });
    const { setId } = await seedSet(t, baseball, "2024", "Imaginary Circuit");

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: setId });

    // Tier 2 still works off the team's own league, with no set league needed.
    expect(summary(rows)).toEqual(["RK Aaa:2", "RK Mlb:4"]);
  });

  test("a context row that no longer exists is no context, not an error", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedTeam(t, baseball, "RK One");
    const { setId } = await seedSet(t, baseball, "2024", "MLB");
    await t.run(async (ctx) => ctx.db.delete(setId));

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK One:4"]);
  });

  test("no sportId: the league cannot be resolved, so nothing is tier 1 or 3", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    await seedTeam(t, baseball, "RK Mlb", { leagueId: mlb, yearsActive: { from: 1958 } });
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "RK", contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK Mlb:4"]);
  });
});

describe("teams.pickerCandidates — what the league leg guarantees", () => {
  // Thirty teams share the typed token across the sport; the set's own club
  // is one more. The sport leg reads 25.
  async function seedCrowd(t: T, sportId: SelId, mlbFirst: boolean) {
    const mlb = await seedLeague(t, sportId, "Major League Baseball", "major", ["MLB"]);
    const crowd = async () => {
      for (let i = 0; i < 30; i++) {
        await seedTeam(t, sportId, `Rangers ${String(i).padStart(2, "0")}`);
      }
    };
    const club = () =>
      seedTeam(t, sportId, "Rangers Zulu", { leagueId: mlb, yearsActive: { from: 1972 } });
    if (mlbFirst) {
      await club();
      await crowd();
    } else {
      await crowd();
      await club();
    }
  }

  test.each([
    ["inserted last (the end the harness's 25-row window drops)", false],
    ["inserted first (the end the real backend's window drops)", true],
  ])("the set's league club leads the crowd when it is %s", async (_label, mlbFirst) => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedCrowd(t, baseball, mlbFirst);
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "Rangers", sportId: baseball, contextOptionId: setId });

    expect(rows[0].team.name).toBe("Rangers Zulu");
    expect(rows[0].tier).toBe(1);
  });

  test("control: without a resolvable league the 25-row sport window can drop the club", async () => {
    // Proves the fixture really overflows the window in the harness (the club
    // is inserted last, and the harness returns insertion order). If this ever
    // fails, the test above no longer proves the league leg is needed.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedCrowd(t, baseball, false);

    const rows = await pick(t, { query: "Rangers", sportId: baseball });

    expect(rows.map((r) => r.team.name)).not.toContain("Rangers Zulu");
  });

  test("a search never returns more than 25 rows, however many match", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedCrowd(t, baseball, false);
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, {
      query: "Rangers",
      sportId: baseball,
      contextOptionId: setId,
      limit: 1000,
    });

    expect(rows.length).toBeLessThanOrEqual(25);
  });
});

describe("teams.pickerCandidates — browse", () => {
  test("an empty query ranks by the same tiers", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedFourTiers(t, baseball);
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK Z:1", "RK Y:2", "RK X:3", "RK W:4"]);
  });

  test("a whitespace-only query browses too", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedFourTiers(t, baseball);

    const rows = await pick(t, { query: "   ", sportId: baseball });

    expect(rows).toHaveLength(4);
  });

  test("with no context the order is alphabetical on the full name and every row is tier 4", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedTeam(t, baseball, "Padres", { location: "San Diego" });
    await seedTeam(t, baseball, "Yankees", { location: "New York" });
    await seedTeam(t, baseball, "Athletics");

    const rows = await pick(t, { query: "", sportId: baseball });

    expect(rows.map((r) => r.team.name)).toEqual(["Athletics", "Yankees", "Padres"]);
    expect(rows.every((r) => r.tier === 4)).toBe(true);
  });

  test("the set's league is read by index, so its club leads however many teams precede it", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    for (let i = 0; i < 120; i++) {
      await seedTeam(t, baseball, `Aaa ${String(i).padStart(3, "0")}`);
    }
    await seedTeam(t, baseball, "Zzz Club", { leagueId: mlb, yearsActive: { from: 1950 } });
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "", sportId: baseball, contextOptionId: setId });

    expect(rows[0]).toMatchObject({ tier: 1, team: { name: "Zzz Club" } });
  });

  test.each([
    ["the default", undefined, 100],
    ["above the cap", 10_000, 100],
    ["inside the cap", 3, 3],
    ["zero", 0, 1],
    ["negative", -5, 1],
  ])("limit %s returns %i rows at most", async (_label, limit, expected) => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    for (let i = 0; i < 120; i++) {
      await seedTeam(t, baseball, `Club ${String(i).padStart(3, "0")}`);
    }

    const rows = await pick(t, { query: "", sportId: baseball, limit });

    expect(rows).toHaveLength(expected);
  });
});

describe("teams.pickerCandidates — across sports", () => {
  test("a picker switched to another sport ranks without the set's league", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const football = await seedSport(t, "Football", "FB");
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    const nfl = await seedLeague(t, football, "National Football League", "major", ["NFL"]);
    await seedTeam(t, baseball, "Rangers Baseball", { leagueId: mlb, yearsActive: { from: 1972 } });
    await seedTeam(t, football, "Rangers Football", { leagueId: nfl, yearsActive: { from: 1920 } });
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "Rangers", sportId: football, contextOptionId: setId });

    // The baseball club is never a candidate here, and nothing in football can
    // be tier 1 or 3 off a baseball league name.
    expect(summary(rows)).toEqual(["Rangers Football:4"]);
  });

  test("a minor league of the searched sport still earns tier 2 across sports", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const hockey = await seedSport(t, "Hockey", "HK");
    const ahl = await seedLeague(t, hockey, "American Hockey League", "minor");
    await seedTeam(t, hockey, "Rangers Farm", { leagueId: ahl, yearsActive: { from: 2000 } });
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "Rangers", sportId: hockey, contextOptionId: setId });

    expect(summary(rows)).toEqual(["Rangers Farm:2"]);
  });
});

describe("teams.pickerCandidates — the minor-league tier", () => {
  test("needs the team to be active in the year: a closed or undated minor-league club is tier 4", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const aaa = await seedLeague(t, baseball, "International League", "minor");
    await seedTeam(t, baseball, "RK Active", { leagueId: aaa, yearsActive: { from: 2000 } });
    await seedTeam(t, baseball, "RK Closed", { leagueId: aaa, yearsActive: { from: 1900, to: 1950 } });
    await seedTeam(t, baseball, "RK Undated", { leagueId: aaa });
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK Active:2", "RK Closed:4", "RK Undated:4"]);
  });

  test("only level 'minor' counts: an active college club is tier 4", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const ncaa = await seedLeague(t, baseball, "NCAA Division I", "college");
    await seedTeam(t, baseball, "RK College", { leagueId: ncaa, yearsActive: { from: 1900 } });
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK College:4"]);
  });
});

describe("teams.pickerCandidates — ordering inside a tier", () => {
  test("an undated team in the set's league is tier 3; in another league it is tier 4", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    const jpn = await seedLeague(t, baseball, "Nippon Professional Baseball", "international");
    await seedTeam(t, baseball, "RK Same", { leagueId: mlb });
    await seedTeam(t, baseball, "RK Other", { leagueId: jpn });
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK Same:3", "RK Other:4"]);
  });

  test("an exact alias hit leads its tier, ahead of a prefix match and the alphabet", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedTeam(t, baseball, "Aardvarks Fan Club");
    const aliasOwner = await seedTeam(t, baseball, "Zzz Club");
    await t.run(async (ctx) =>
      ctx.db.insert("teamAliases", {
        teamId: aliasOwner,
        sportId: baseball,
        aliasNormalized: normalizeTeamName("Aardvarks"),
      }),
    );

    const rows = await pick(t, { query: "Aardvarks", sportId: baseball });

    expect(rows.map((r) => r.team.name)).toEqual(["Zzz Club", "Aardvarks Fan Club"]);
  });

  test("an alias hit does not jump a better tier", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    await seedTeam(t, baseball, "Aardvarks Current", { leagueId: mlb, yearsActive: { from: 1950 } });
    const aliasOwner = await seedTeam(t, baseball, "Zzz Club");
    await t.run(async (ctx) =>
      ctx.db.insert("teamAliases", {
        teamId: aliasOwner,
        sportId: baseball,
        aliasNormalized: normalizeTeamName("Aardvarks"),
      }),
    );
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "Aardvarks", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["Aardvarks Current:1", "Zzz Club:4"]);
  });

  test("an alias hit that is also tier 1 is returned once, in tier 1", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    const owner = await seedTeam(t, baseball, "Aardvarks Current", {
      leagueId: mlb,
      yearsActive: { from: 1950 },
    });
    await t.run(async (ctx) =>
      ctx.db.insert("teamAliases", {
        teamId: owner,
        sportId: baseball,
        aliasNormalized: normalizeTeamName("Aardvarks Current"),
      }),
    );
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, {
      query: "Aardvarks Current",
      sportId: baseball,
      contextOptionId: setId,
    });

    expect(summary(rows)).toEqual(["Aardvarks Current:1"]);
  });

  test("a stale alias row whose team moved sport is skipped", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const football = await seedSport(t, "Football", "FB");
    const owner = await seedTeam(t, football, "Wanderers");
    await t.run(async (ctx) =>
      ctx.db.insert("teamAliases", {
        teamId: owner,
        sportId: baseball, // residue: the alias row still says baseball
        aliasNormalized: normalizeTeamName("Wanderers"),
      }),
    );

    expect(await pick(t, { query: "Wanderers", sportId: baseball })).toEqual([]);
  });
});

describe("teams.pickerCandidates — rows that point at nothing", () => {
  test("a team whose league row was deleted is ranked tier 4 and does not throw", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const gone = await seedLeague(t, baseball, "Defunct League", "minor");
    await seedTeam(t, baseball, "RK Orphan", { leagueId: gone, yearsActive: { from: 2000 } });
    await t.run(async (ctx) => ctx.db.delete(gone));
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    const rows = await pick(t, { query: "RK", sportId: baseball, contextOptionId: setId });

    expect(summary(rows)).toEqual(["RK Orphan:4"]);
  });

  test("a row in another sport is never a candidate, whichever leg finds it", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const football = await seedSport(t, "Football", "FB");
    await seedTeam(t, football, "RK Gridiron");

    expect(await pick(t, { query: "RK", sportId: baseball })).toEqual([]);
    expect(await pick(t, { query: "", sportId: baseball })).toEqual([]);
  });

  test("a query that normalises to nothing answers empty", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedTeam(t, baseball, "RK One");

    expect(await pick(t, { query: "!!!", sportId: baseball })).toEqual([]);
  });
});

describe("teams.pickerCandidates — the sport filter holds on every leg", () => {
  test("an alias-leg hit whose team is in ANOTHER sport is dropped (sport given)", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const football = await seedSport(t, "Football", "FB");
    const foreign = await seedTeam(t, football, "Zzz Gridiron");
    await t.run(async (ctx) =>
      ctx.db.insert("teamAliases", {
        teamId: foreign,
        sportId: football,
        aliasNormalized: normalizeTeamName("Aardvarks"),
      }),
    );

    // The alias index is keyed by sport, so this also proves the index scoping.
    expect(await pick(t, { query: "Aardvarks", sportId: baseball })).toEqual([]);
  });

  test("an alias row whose OWN sportId is the searched sport but whose team moved is dropped", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const football = await seedSport(t, "Football", "FB");
    const moved = await seedTeam(t, football, "Zzz Gridiron");
    await t.run(async (ctx) =>
      ctx.db.insert("teamAliases", {
        teamId: moved,
        sportId: baseball,
        aliasNormalized: normalizeTeamName("Aardvarks"),
      }),
    );

    expect(await pick(t, { query: "Aardvarks", sportId: baseball })).toEqual([]);
  });

  test("without a sport the alias leg is unscoped, and the rows come back whole", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football", "FB");
    const owner = await seedTeam(t, football, "Zzz Gridiron");
    await t.run(async (ctx) =>
      ctx.db.insert("teamAliases", {
        teamId: owner,
        sportId: football,
        aliasNormalized: normalizeTeamName("Aardvarks"),
      }),
    );

    expect((await pick(t, { query: "Aardvarks" })).map((r) => r.team.name)).toEqual([
      "Zzz Gridiron",
    ]);
  });

  test("the league leg never returns another sport's team that shares the league id's name", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const football = await seedSport(t, "Football", "FB");
    const mlb = await seedLeague(t, baseball, "Major League Baseball", "major", ["MLB"]);
    // A (corrupt) football team pointing at the baseball league.
    await seedTeam(t, football, "Rangers Corrupt", { leagueId: mlb, yearsActive: { from: 1900 } });
    const { setId } = await seedSet(t, baseball, "2024", "MLB");

    expect(
      await pick(t, { query: "Rangers", sportId: baseball, contextOptionId: setId }),
    ).toEqual([]);
    expect(
      await pick(t, { query: "", sportId: baseball, contextOptionId: setId }),
    ).toEqual([]);
  });
});

describe("teams.pickerCandidates — limit clamp", () => {
  async function seedMany(t: T, sportId: SelId, n: number) {
    for (let i = 0; i < n; i++) {
      await seedTeam(t, sportId, `Club ${String(i).padStart(3, "0")}`);
    }
  }

  test.each([
    ["-5", -5, 1],
    ["0", 0, 1],
    ["1e9", 1e9, 25],
    ["Infinity", Infinity, 25],
    ["3", 3, 3],
  ])("search: limit %s returns %i row(s)", async (_l, limit, expected) => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedMany(t, baseball, 30);

    const rows = await pick(t, { query: "Club", sportId: baseball, limit });

    expect(rows).toHaveLength(expected);
  });

  test.each([
    ["-5", -5, 1],
    ["0", 0, 1],
    ["1e9", 1e9, 100],
    ["Infinity", Infinity, 100],
  ])("browse: limit %s returns %i row(s)", async (_l, limit, expected) => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedMany(t, baseball, 120);

    const rows = await pick(t, { query: "", sportId: baseball, limit });

    expect(rows).toHaveLength(expected);
  });

  // KNOWN GAP, pinned rather than hidden: `v.number()` admits NaN, and
  // Math.max(1, Math.min(n, cap)) of NaN is NaN, so `.slice(0, NaN)` is `[]`.
  // The picker never sends NaN (25 or undefined), so nothing user-facing hits
  // it; but the clamp does not do what its comment says. When the query
  // coerces NaN to the default, flip these two to expect the default size.
  test("NaN limit currently returns NOTHING in search mode (gap, see comment)", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedMany(t, baseball, 5);
    expect(await pick(t, { query: "Club", sportId: baseball, limit: NaN })).toEqual([]);
  });

  test("NaN limit currently returns NOTHING in browse mode (gap, see comment)", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedMany(t, baseball, 5);
    expect(await pick(t, { query: "", sportId: baseball, limit: NaN })).toEqual([]);
  });
});

describe("teams.pickerCandidates — an unusable context gives no tier 1 or 3", () => {
  async function seedLeagueAndClub(t: T, sportId: SelId) {
    const mlb = await seedLeague(t, sportId, "Major League Baseball", "major", ["MLB"]);
    await seedTeam(t, sportId, "RK Current", { leagueId: mlb, yearsActive: { from: 1958 } });
    await seedTeam(t, sportId, "RK Closed", { leagueId: mlb, yearsActive: { from: 1900, to: 1950 } });
  }

  test.each(["search", "browse"])("a context id that resolves to nothing (%s)", async (mode) => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    await seedLeagueAndClub(t, baseball);
    const { setId } = await seedSet(t, baseball, "2024", "MLB");
    await t.run(async (ctx) => ctx.db.delete(setId));

    const rows = await pick(t, {
      query: mode === "search" ? "RK" : "",
      sportId: baseball,
      contextOptionId: setId,
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tier === 4)).toBe(true);
  });

  test.each(["search", "browse"])("a context from another sport (%s)", async (mode) => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t);
    const hockey = await seedSport(t, "Hockey", "HK");
    await seedLeagueAndClub(t, baseball);
    // A hockey club that happens to share the typed token.
    await seedTeam(t, hockey, "RK Sticks");
    await seedLeague(t, hockey, "National Hockey League", "major", ["NHL"]);
    const { setId } = await seedSet(t, hockey, "2024", "NHL");

    const rows = await pick(t, {
      query: mode === "search" ? "RK" : "",
      sportId: baseball,
      contextOptionId: setId,
    });

    // The league is looked up in the SEARCHED sport by the set's own name, so
    // a hockey set's "NHL" resolves to nothing in baseball: no tier 1 or 3.
    expect(rows.map((r) => r.tier)).not.toContain(1);
    expect(rows.map((r) => r.tier)).not.toContain(3);
  });
});
