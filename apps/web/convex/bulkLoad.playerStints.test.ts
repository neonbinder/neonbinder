/**
 * NEO-285 — the stints leg of the armed bulk loader (`upsertPlayerStints` /
 * `previewPlayerStints`): college stints onto players NB already holds. See
 * the "Player stints" section note in `bulkLoad.ts`; each `describe` below is
 * one of its rules.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";
import { stintAlreadyPresent } from "./bulkLoad";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const CONFIRM = "BULK_LOAD" as const;
const ADMIN_IDENTITY = {
  subject: "admin_stints_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_stints_001",
  name: "Admin User",
  role: "admin",
};
type T = ReturnType<typeof convexTest>;

afterEach(() => vi.unstubAllEnvs());

function armed() {
  vi.stubEnv("ALLOW_BULK_LOAD", "true");
}

async function seedSport(t: T, value = "Football") {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function seedLeague(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  level: "major" | "college",
) {
  return t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name,
      nameNormalized: name.trim().toLowerCase(),
      sportId,
      level,
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function seedTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  parts: {
    location?: string;
    name: string;
    years?: { from: number; to?: number };
    aliases?: string[];
    leagueId?: Id<"leagues">;
  },
) {
  const full = parts.location ? `${parts.location} ${parts.name}` : parts.name;
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("teams", {
      name: parts.name,
      ...(parts.location ? { location: parts.location } : {}),
      nameNormalized: normalizeTeamName(full),
      sportId,
      ...(parts.years ? { yearsActive: parts.years } : {}),
      ...(parts.aliases ? { aliases: parts.aliases } : {}),
      ...(parts.leagueId ? { leagueId: parts.leagueId } : {}),
      lastUpdated: 1_700_000_000_000,
    });
    for (const alias of parts.aliases ?? []) {
      await ctx.db.insert("teamAliases", {
        teamId: id,
        sportId,
        aliasNormalized: normalizeTeamName(alias),
      });
    }
    return id;
  });
}

async function seedPlayer(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  extra: {
    birthYear?: number;
    teamYears?: Array<{ teamId: Id<"teams">; fromYear?: number; toYear?: number }>;
  } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      ...(extra.birthYear !== undefined ? { birthYear: extra.birthYear } : {}),
      ...(extra.teamYears ? { teamYears: extra.teamYears } : {}),
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

const careerOf = (t: T, id: Id<"players">) =>
  t.run(async (ctx) => (await ctx.db.get(id))?.teamYears ?? []);

/** A Football sport with an NCAA league, WVU (aliased) and a pro club. */
async function footballFixture(t: T) {
  const sportId = await seedSport(t, "Football");
  const ncaa = await seedLeague(t, sportId, "NCAA", "college");
  const nfl = await seedLeague(t, sportId, "NFL", "major");
  const wvu = await seedTeam(t, sportId, {
    location: "West Virginia",
    name: "Mountaineers",
    aliases: ["WVU", "West Virginia University", "West Virginia"],
    leagueId: ncaa,
  });
  const wisconsin = await seedTeam(t, sportId, {
    location: "Wisconsin",
    name: "Badgers",
    aliases: ["Wisconsin"],
    leagueId: ncaa,
  });
  const steelers = await seedTeam(t, sportId, {
    location: "Pittsburgh",
    name: "Steelers",
    leagueId: nfl,
  });
  return { sportId, ncaa, nfl, wvu, wisconsin, steelers };
}

describe("the gate", () => {
  test("upsertPlayerStints unarmed refuses even with the right confirm", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t);
    await expect(
      t.mutation(internal.bulkLoad.upsertPlayerStints, {
        confirm: CONFIRM,
        sport: "Football",
        players: [],
      }),
    ).rejects.toThrow(/not armed/);
  });

  test("previewPlayerStints runs unarmed and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const f = await footballFixture(t);
    const pat = await seedPlayer(t, f.sportId, "Pat White");
    const out = await t.query(internal.bulkLoad.previewPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [{ key: "p1", name: "Pat White", stints: [{ school: "WVU" }] }],
    });
    expect(out.results[0]).toMatchObject({ status: "would-adopt", playerId: pat });
    expect(out.results[0].stints).toEqual([
      { outcome: "would-add", teamId: f.wvu, school: "WVU" },
    ]);
    expect(out.summary.stintsAdded).toBe(1);
    expect(await careerOf(t, pat)).toEqual([]);
  });

  test("a sport the deployment does not hold is refused by name, never created", async () => {
    const t = convexTest(schema, modules);
    armed();
    await expect(
      t.mutation(internal.bulkLoad.upsertPlayerStints, {
        confirm: CONFIRM,
        sport: "Curling",
        players: [],
      }),
    ).rejects.toThrow(/No sport row for "Curling"/);
  });
});

describe("school resolution through team aliases, and convergence", () => {
  test("WVU, the long name and the bare location all land on West Virginia / Mountaineers, undated", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    const a = await seedPlayer(t, f.sportId, "Pat White");
    const b = await seedPlayer(t, f.sportId, "Geno Smith");
    const c = await seedPlayer(t, f.sportId, "Tavon Austin");
    const run = () =>
      t.mutation(internal.bulkLoad.upsertPlayerStints, {
        confirm: CONFIRM,
        sport: "Football",
        players: [
          { key: "a", name: "Pat White", stints: [{ school: "WVU" }] },
          { key: "b", name: "Geno Smith", stints: [{ school: "West Virginia University" }] },
          { key: "c", name: "Tavon Austin", stints: [{ school: "West Virginia" }] },
        ],
      });
    const first = await run();
    expect(first.summary).toMatchObject({ adopted: 3, stintsAdded: 3, noMatch: 0 });
    for (const id of [a, b, c]) {
      expect(await careerOf(t, id)).toEqual([{ teamId: f.wvu }]);
    }

    // Acceptance: a second run of the load converges, 0 stints added.
    const second = await run();
    expect(second.summary).toMatchObject({ adopted: 3, stintsAdded: 0, stintsPresent: 3 });
    expect(await careerOf(t, a)).toEqual([{ teamId: f.wvu }]);
  });

  test("a school never resolves to a team in a known non-college league", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    const p = await seedPlayer(t, f.sportId, "Some Guy");
    const out = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [{ key: "p", name: "Some Guy", stints: [{ school: "Pittsburgh Steelers" }] }],
    });
    expect(out.results[0].stints[0]).toEqual({
      outcome: "unresolved",
      school: "Pittsburgh Steelers",
    });
    expect(await careerOf(t, p)).toEqual([]);
  });
});

describe("gap-fill: never remove, never re-date", () => {
  test("a pro career is kept and the college stint is added after it, sorted", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    const p = await seedPlayer(t, f.sportId, "Pat White", {
      teamYears: [{ teamId: f.steelers, fromYear: 2010, toYear: 2012 }],
    });
    await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [
        { key: "p", name: "Pat White", stints: [{ school: "WVU", fromYear: 2005, toYear: 2008 }] },
      ],
    });
    expect(await careerOf(t, p)).toEqual([
      { teamId: f.wvu, fromYear: 2005, toYear: 2008 },
      { teamId: f.steelers, fromYear: 2010, toYear: 2012 },
    ]);
  });

  test("a dated stint overlapping one already on that team is a no-op", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    const p = await seedPlayer(t, f.sportId, "Pat White", {
      teamYears: [{ teamId: f.wvu, fromYear: 2004, toYear: 2008 }],
    });
    const out = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [
        { key: "p", name: "Pat White", stints: [{ teamId: f.wvu, fromYear: 2005, toYear: 2008 }] },
      ],
    });
    expect(out.results[0].stints[0].outcome).toBe("present");
    expect(await careerOf(t, p)).toEqual([{ teamId: f.wvu, fromYear: 2004, toYear: 2008 }]);
  });

  test("an undated stint already there is never re-dated by a dated incoming one", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    const p = await seedPlayer(t, f.sportId, "Pat White", {
      teamYears: [{ teamId: f.wvu }],
    });
    const out = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [
        { key: "p", name: "Pat White", stints: [{ school: "WVU", fromYear: 2005, toYear: 2008 }] },
      ],
    });
    expect(out.results[0].stints[0].outcome).toBe("present");
    expect(await careerOf(t, p)).toEqual([{ teamId: f.wvu }]);
  });

  test("a two-school transfer lands both, and a non-overlapping return to one school is its own stint", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    const p = await seedPlayer(t, f.sportId, "Russell Wilson");
    await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [
        {
          key: "p",
          name: "Russell Wilson",
          stints: [
            { school: "WVU", fromYear: 2007, toYear: 2009 },
            { school: "Wisconsin", fromYear: 2011, toYear: 2011 },
            { teamId: f.wvu, fromYear: 2013, toYear: 2013 },
          ],
        },
      ],
    });
    expect(await careerOf(t, p)).toEqual([
      { teamId: f.wvu, fromYear: 2007, toYear: 2009 },
      { teamId: f.wisconsin, fromYear: 2011, toYear: 2011 },
      { teamId: f.wvu, fromYear: 2013, toYear: 2013 },
    ]);
  });

  test("stintAlreadyPresent: same team and (either side undated or the years overlap)", () => {
    const team = "t1" as Id<"teams">;
    const other = "t2" as Id<"teams">;
    expect(stintAlreadyPresent([{ teamId: team }], { teamId: team, fromYear: 2001 })).toBe(true);
    expect(stintAlreadyPresent([{ teamId: team, fromYear: 2001 }], { teamId: team })).toBe(true);
    expect(stintAlreadyPresent([{ teamId: other }], { teamId: team })).toBe(false);
    expect(
      stintAlreadyPresent([{ teamId: team, fromYear: 2001, toYear: 2003 }], {
        teamId: team,
        fromYear: 2004,
      }),
    ).toBe(false);
    // An open stint runs on, so anything after it overlaps.
    expect(
      stintAlreadyPresent([{ teamId: team, fromYear: 2001 }], {
        teamId: team,
        fromYear: 2010,
        toYear: 2011,
      }),
    ).toBe(true);
  });
});

describe("the sport filter holds (the Gwynn case)", () => {
  test("a teamId in another sport is refused per stint; the rest of the row lands", async () => {
    const t = convexTest(schema, modules);
    armed();
    const baseball = await seedSport(t, "Baseball");
    const basketball = await seedSport(t, "Basketball");
    const sdsuBaseball = await seedTeam(t, baseball, { location: "San Diego State", name: "Aztecs" });
    const sdsuHoops = await seedTeam(t, basketball, { location: "San Diego State", name: "Aztecs" });
    const gwynn = await seedPlayer(t, baseball, "Tony Gwynn", { birthYear: 1960 });
    const out = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [
        {
          key: "gwynn",
          name: "Tony Gwynn",
          birthYear: 1960,
          stints: [{ teamId: sdsuHoops }, { teamId: sdsuBaseball }],
        },
      ],
    });
    expect(out.results[0].stints.map((s) => s.outcome)).toEqual(["wrong-sport", "added"]);
    expect(out.summary.wrongSport).toBe(1);
    expect(await careerOf(t, gwynn)).toEqual([{ teamId: sdsuBaseball }]);
  });
});

describe("unresolved and ambiguous schools are reported, never dropped or invented", () => {
  test("an unknown school is reported with its count and nothing is written", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    await seedPlayer(t, f.sportId, "Juco One");
    await seedPlayer(t, f.sportId, "Juco Two");
    const before = await t.run(async (ctx) => (await ctx.db.query("teams").collect()).length);
    const out = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [
        { key: "1", name: "Juco One", stints: [{ school: "Butler CC" }] },
        { key: "2", name: "Juco Two", stints: [{ school: "Butler CC" }, { school: "WVU" }] },
      ],
    });
    expect(out.summary.unresolvedSchools).toEqual([{ school: "Butler CC", count: 2 }]);
    expect(out.summary.stintsAdded).toBe(1);
    const after = await t.run(async (ctx) => (await ctx.db.query("teams").collect()).length);
    expect(after).toBe(before);
  });

  test("a school matching two eras of a program is ambiguous undated, and narrowed by years when dated", async () => {
    const t = convexTest(schema, modules);
    armed();
    const sportId = await seedSport(t, "Football");
    const old = await seedTeam(t, sportId, {
      location: "Hawaii",
      name: "Rainbows",
      years: { from: 1960, to: 1999 },
      aliases: ["University of Hawaii"],
    });
    const current = await seedTeam(t, sportId, {
      location: "Hawaii",
      name: "Rainbow Warriors",
      years: { from: 2000 },
      aliases: ["University of Hawaii"],
    });
    const p = await seedPlayer(t, sportId, "Colt Brennan");
    const q = await seedPlayer(t, sportId, "Older Guy");
    const out = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [
        { key: "p", name: "Colt Brennan", stints: [{ school: "University of Hawaii" }] },
        {
          key: "q",
          name: "Older Guy",
          stints: [{ school: "University of Hawaii", fromYear: 1985, toYear: 1988 }],
        },
      ],
    });
    expect(out.results[0].stints[0].outcome).toBe("ambiguous-school");
    expect(out.summary.ambiguousSchools).toHaveLength(1);
    expect(out.summary.ambiguousSchools[0].candidates.map((c) => c.id).sort()).toEqual(
      [old, current].sort(),
    );
    expect(await careerOf(t, p)).toEqual([]);
    expect(await careerOf(t, q)).toEqual([{ teamId: old, fromYear: 1985, toYear: 1988 }]);
  });
});

describe("adopt-only player matching", () => {
  test("no such player: no-match, and no player is created", async () => {
    const t = convexTest(schema, modules);
    armed();
    await footballFixture(t);
    const out = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [{ key: "x", name: "Nobody Here", stints: [{ school: "WVU" }] }],
    });
    expect(out.results[0]).toMatchObject({ status: "no-match", playerId: null, stints: [] });
    expect(out.summary.noMatch).toBe(1);
    const players = await t.run(async (ctx) => ctx.db.query("players").collect());
    expect(players).toHaveLength(0);
  });

  test("a single same-name player with a contradicting birth year is no-match, not a merge", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    const p = await seedPlayer(t, f.sportId, "Adrian Peterson", { birthYear: 1985 });
    const out = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [
        { key: "ap", name: "Adrian Peterson", birthYear: 1979, stints: [{ school: "WVU" }] },
      ],
    });
    expect(out.results[0]).toMatchObject({ status: "no-match", birthYearMismatch: true });
    expect(await careerOf(t, p)).toEqual([]);
  });

  test("several same-name players: the birth year picks one, otherwise ambiguous; a decision replays", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    const older = await seedPlayer(t, f.sportId, "Adrian Peterson", { birthYear: 1979 });
    const younger = await t.run(async (ctx) =>
      // Same key, second row — two real people.
      ctx.db.insert("players", {
        name: "Adrian Peterson",
        nameNormalized: normalizePlayerName("Adrian Peterson"),
        sportId: f.sportId,
        lastUpdated: 1,
      }),
    );

    const byYear = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [
        { key: "ap", name: "Adrian Peterson", birthYear: 1979, stints: [{ school: "Wisconsin" }] },
      ],
    });
    expect(byYear.results[0]).toMatchObject({ status: "adopted", playerId: older });

    const asked = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [{ key: "ap2", name: "Adrian Peterson", stints: [{ school: "WVU" }] }],
    });
    expect(asked.results[0].status).toBe("ambiguous");
    expect(asked.results[0].candidates?.map((c) => c.id).sort()).toEqual([older, younger].sort());
    expect(await careerOf(t, younger)).toEqual([]);

    const answered = await t.mutation(internal.bulkLoad.upsertPlayerStints, {
      confirm: CONFIRM,
      sport: "Football",
      players: [
        {
          key: "ap2",
          name: "Adrian Peterson",
          stints: [{ school: "WVU" }],
          decision: { adopt: younger },
        },
      ],
    });
    expect(answered.results[0]).toMatchObject({ status: "adopted", matchedBy: "decision" });
    expect(await careerOf(t, younger)).toEqual([{ teamId: f.wvu }]);
  });

  test("a decision naming a different person is refused", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    const other = await seedPlayer(t, f.sportId, "Someone Else");
    await expect(
      t.mutation(internal.bulkLoad.upsertPlayerStints, {
        confirm: CONFIRM,
        sport: "Football",
        players: [
          { key: "k", name: "Pat White", stints: [], decision: { adopt: other } },
        ],
      }),
    ).rejects.toThrow(/different person/);
  });
});

describe("row validation", () => {
  test("a stint must name exactly one of teamId or school", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    await seedPlayer(t, f.sportId, "Pat White");
    await expect(
      t.mutation(internal.bulkLoad.upsertPlayerStints, {
        confirm: CONFIRM,
        sport: "Football",
        players: [{ key: "k", name: "Pat White", stints: [{ teamId: f.wvu, school: "WVU" }] }],
      }),
    ).rejects.toThrow(/exactly one of teamId or school/);
  });

  test("an end year with no start year is refused", async () => {
    const t = convexTest(schema, modules);
    armed();
    const f = await footballFixture(t);
    await seedPlayer(t, f.sportId, "Pat White");
    await expect(
      t.mutation(internal.bulkLoad.upsertPlayerStints, {
        confirm: CONFIRM,
        sport: "Football",
        players: [{ key: "k", name: "Pat White", stints: [{ school: "WVU", toYear: 2008 }] }],
      }),
    ).rejects.toThrow(/end year and no start year/);
  });
});

describe("the player editor round-trips an undated stint", () => {
  test("savePlayerFields keeps an undated college stint when another stint is removed", async () => {
    const t = convexTest(schema, modules);
    const f = await footballFixture(t);
    const p = await seedPlayer(t, f.sportId, "Pat White", {
      teamYears: [{ teamId: f.steelers, fromYear: 2010, toYear: 2012 }, { teamId: f.wvu }],
    });
    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: p,
      teamYears: [{ teamId: f.wvu }],
    });
    expect(await careerOf(t, p)).toEqual([{ teamId: f.wvu }]);
  });

  test("savePlayerFields refuses an end year with no start year", async () => {
    const t = convexTest(schema, modules);
    const f = await footballFixture(t);
    const p = await seedPlayer(t, f.sportId, "Pat White");
    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
        id: p,
        teamYears: [{ teamId: f.wvu, toYear: 2008 }],
      }),
    ).rejects.toThrow(/needs a start year/);
  });
});

describe("a forced Wikidata re-enrich keeps the college load's undated stints", () => {
  test("applyEnrichmentInternal replaces the dated career and keeps undated stints on other teams", async () => {
    const t = convexTest(schema, modules);
    const f = await footballFixture(t);
    const p = await seedPlayer(t, f.sportId, "Pat White", {
      teamYears: [{ teamId: f.steelers, fromYear: 2001, toYear: 2002 }, { teamId: f.wvu }],
    });
    await t.mutation(internal.players.applyEnrichmentInternal, {
      id: p,
      teamYears: [{ teamId: f.steelers, fromYear: 2010, toYear: 2012 }],
    });
    expect(await careerOf(t, p)).toEqual([
      { teamId: f.steelers, fromYear: 2010, toYear: 2012 },
      { teamId: f.wvu },
    ]);
  });
});
