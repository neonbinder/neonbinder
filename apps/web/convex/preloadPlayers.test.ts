/**
 * NEO-254 — the bulk preload loader.
 *
 * The properties that matter are all about what this must NOT do. It writes
 * tens of thousands of globally-shared reference rows from a dataset that is
 * initial input rather than truth, so:
 *
 *  - it must refuse entirely unless the deployment is armed,
 *  - a dry run must write nothing at all,
 *  - a second run must create nothing,
 *  - it must never overwrite a value already on a row, and
 *  - where it cannot tell which existing player is the same person it must
 *    write nothing and say so.
 *
 * Tested against the CHUNK mutations with small synthetic rows rather than
 * through the action with the real 21,000-player file: the action is a loop
 * with a time budget, and running the committed dataset through convex-test
 * would turn a two-second suite into a several-minute one while testing the
 * same three lines. The action's own behaviours that are worth pinning — the
 * gate and the unsynced-sport early exit — are covered directly at the end.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { matchExistingPlayer } from "./preloadPlayers";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const NOW = 1_700_000_000_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

function arm() {
  vi.stubEnv("ALLOW_PRELOAD_PLAYERS", "true");
}

/** Sport rows come from the marketplace sync; the preload never invents one. */
async function seedSport(
  t: ReturnType<typeof convexTest>,
  value = "Baseball",
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: NOW,
    }),
  );
}

const LEAGUES = [
  {
    code: "MLB",
    name: "Major League Baseball",
    abbreviation: "MLB",
    from: 1876,
    default: true,
  },
  {
    code: "FL",
    name: "Federal League",
    abbreviation: "FL",
    from: 1914,
    to: 1915,
  },
];

const TEAMS = [
  {
    key: "boston-red-sox",
    name: "Boston Red Sox",
    location: "Boston",
    nickname: "Red Sox",
    league: "MLB",
    from: 1908,
    franchise: "boston-red-sox-bos",
  },
  {
    key: "montreal-expos",
    name: "Montreal Expos",
    location: "Montreal",
    nickname: "Expos",
    league: "MLB",
    from: 1969,
    to: 2004,
    franchise: "washington-nationals-wsn",
  },
  {
    key: "st-louis-terriers",
    name: "St. Louis Terriers",
    location: "St. Louis",
    nickname: "Terriers",
    league: "FL",
    from: 1914,
    to: 1915,
    franchise: "st-louis-terriers-sli",
  },
];

const TEAM_NAMES = TEAMS.map((t) => t.name);

const PLAYERS = [
  {
    id: "gwynnto01",
    name: "Tony Gwynn",
    birthYear: 1960,
    hof: true,
    stints: [
      [0, 1990, 1991],
      [1, 1993, 1995],
    ],
  },
  { id: "smithjo01", name: "John Smith", birthYear: 1965, stints: [[0, 1990, 1990]] },
  { id: "oldtimer01", name: "Germany Smith", stints: [[2, 1914, 1915]] },
];

const teams = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("teams").collect());
const players = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("players").collect());
const leagues = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("leagues").collect());

const loadTeams = (t: ReturnType<typeof convexTest>, dryRun = false) =>
  t.mutation(internal.preloadPlayers.loadTeamsChunk, {
    sport: "baseball" as const,
    leagues: LEAGUES,
    teams: TEAMS,
    dryRun,
  });

const loadPlayers = (
  t: ReturnType<typeof convexTest>,
  rows: typeof PLAYERS = PLAYERS,
  dryRun = false,
) =>
  t.mutation(internal.preloadPlayers.loadPlayersChunk, {
    sport: "baseball" as const,
    teamNames: TEAM_NAMES,
    players: rows,
    dryRun,
  });

// ---------------------------------------------------------------------------

describe("the arming gate", () => {
  test("every entry point refuses when ALLOW_PRELOAD_PLAYERS is unset", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(loadTeams(t)).rejects.toThrow(/ALLOW_PRELOAD_PLAYERS/);
    await expect(loadPlayers(t)).rejects.toThrow(/ALLOW_PRELOAD_PLAYERS/);
    await expect(
      t.action(internal.preloadPlayers.run, {
        sport: "baseball",
        confirm: "PRELOAD",
      }),
    ).rejects.toThrow(/ALLOW_PRELOAD_PLAYERS/);

    expect(await teams(t)).toHaveLength(0);
    expect(await players(t)).toHaveLength(0);
  });

  test("a truthy-but-wrong flag value is still refused", async () => {
    // "1" is not "true". The check is exact so half-armed is not a state.
    vi.stubEnv("ALLOW_PRELOAD_PLAYERS", "1");
    const t = convexTest(schema, modules);
    await seedSport(t);
    await expect(loadTeams(t)).rejects.toThrow(/ALLOW_PRELOAD_PLAYERS/);
  });

  test("the batch mutations gate INDEPENDENTLY of the action", async () => {
    // Defence in depth: a future internal caller reaching a chunk mutation
    // directly must not be able to write rows on an unarmed deployment.
    const t = convexTest(schema, modules);
    await seedSport(t);
    await expect(
      t.mutation(internal.preloadPlayers.loadPlayersChunk, {
        sport: "baseball",
        teamNames: TEAM_NAMES,
        players: PLAYERS,
        dryRun: false,
      }),
    ).rejects.toThrow(/ALLOW_PRELOAD_PLAYERS/);
    expect(await players(t)).toHaveLength(0);
  });
});

describe("dry run", () => {
  test("reports what it would do and writes nothing", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    const teamResult = await loadTeams(t, true);
    const playerResult = await loadPlayers(t, PLAYERS, true);

    expect(teamResult.teamsCreated).toBe(3);
    expect(teamResult.teamsAdopted).toBe(0);
    expect(teamResult.leaguesCreated).toBe(2);
    expect(playerResult.playersCreated).toBe(3);

    expect(await teams(t)).toHaveLength(0);
    expect(await players(t)).toHaveLength(0);
    expect(await leagues(t)).toHaveLength(0);
  });
});

describe("phase 1 — leagues and teams", () => {
  test("creates a team per historical name, with a league and its years", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    const result = await loadTeams(t);

    expect(result.teamsCreated).toBe(3);
    const rows = await teams(t);
    expect(rows).toHaveLength(3);
    // NEO-156: every created team gets a league.
    expect(rows.every((r) => r.leagueId !== undefined)).toBe(true);

    const expos = rows.find((r) => r.name === "Montreal Expos")!;
    expect(expos.yearsActive).toEqual({ from: 1969, to: 2004 });
    // Still active → no end year at all, rather than a frozen one.
    const sox = rows.find((r) => r.name === "Boston Red Sox")!;
    expect(sox.yearsActive).toEqual({ from: 1908 });
  });

  test("the sport's own league is the existing row, not a rival one", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    await loadTeams(t);

    const rows = await leagues(t);
    // Major League Baseball (through resolveDefaultLeagueId) + the Federal
    // League. Not three, and not two Major League Baseballs.
    expect(rows.map((l) => l.name).sort()).toEqual([
      "Federal League",
      "Major League Baseball",
    ]);
    expect(rows.find((l) => l.name === "Federal League")!.level).toBe("major");
  });

  test("is idempotent — a second run adopts and creates nothing", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    await loadTeams(t);
    const second = await loadTeams(t);

    expect(second.teamsCreated).toBe(0);
    expect(second.teamsAdopted).toBe(3);
    expect(second.leaguesCreated).toBe(0);
    expect(await teams(t)).toHaveLength(3);
    expect(await leagues(t)).toHaveLength(2);
  });

  test("adopts an existing team and NEVER overwrites its yearsActive", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "Operator's League",
        nameNormalized: "operators league",
        sportId,
        lastUpdated: NOW,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("teams", {
        name: "Montreal Expos",
        nameNormalized: normalizeTeamName("Montreal Expos"),
        sportId,
        leagueId,
        // A human corrected these. The dataset does not get to disagree.
        yearsActive: { from: 1969, to: 2005 },
        lastUpdated: NOW,
      });
    });

    const result = await loadTeams(t);

    expect(result.teamsAdopted).toBe(1);
    expect(result.teamsCreated).toBe(2);
    const expos = (await teams(t)).filter((r) => r.name === "Montreal Expos");
    expect(expos).toHaveLength(1);
    expect(expos[0].yearsActive).toEqual({ from: 1969, to: 2005 });
    expect(expos[0].leagueId).toBe(leagueId);
  });

  test("gap-fills a league and years an adopted team is missing", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) => {
      // The shape the checklist flow leaves behind: a bare name.
      await ctx.db.insert("teams", {
        name: "Boston Red Sox",
        nameNormalized: normalizeTeamName("Boston Red Sox"),
        sportId,
        lastUpdated: NOW,
      });
    });

    await loadTeams(t);

    const sox = (await teams(t)).find((r) => r.name === "Boston Red Sox")!;
    expect(sox.leagueId).toBeDefined();
    expect(sox.yearsActive).toEqual({ from: 1908 });
  });

  test("reports the unsynced sport rather than inventing a sport row", async () => {
    arm();
    const t = convexTest(schema, modules);
    // No sport seeded.
    const result = await loadTeams(t);

    expect(result.skippedNoSport).toBe(3);
    expect(result.teamsCreated).toBe(0);
    expect(await teams(t)).toHaveLength(0);
    expect(
      await t.run(async (ctx) => ctx.db.query("selectorOptions").collect()),
    ).toHaveLength(0);
  });
});

describe("phase 2 — players", () => {
  async function loaded() {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await loadTeams(t);
    return { t, sportId };
  }

  test("creates a player with the source spelling, career and Hall of Fame flag", async () => {
    const { t } = await loaded();

    const result = await loadPlayers(t);

    expect(result.playersCreated).toBe(3);
    expect(result.droppedStints).toBe(0);
    const rows = await players(t);
    expect(rows).toHaveLength(3);

    const gwynn = rows.find((p) => p.name === "Tony Gwynn")!;
    expect(gwynn.birthYear).toBe(1960);
    expect(gwynn.isHallOfFame).toBe(true);
    expect(gwynn.externalIds?.lahmanId).toBe("gwynnto01");
    expect(gwynn.teamYears).toHaveLength(2);
    // Earliest stint first (NEO-212's canonical order).
    expect(gwynn.teamYears![0].fromYear).toBe(1990);
    expect(gwynn.teamYears![1].fromYear).toBe(1993);

    // Absent, not `false` — `false` is an enrichment marker meaning "we looked".
    const smith = rows.find((p) => p.name === "John Smith")!;
    expect(smith.isHallOfFame).toBeUndefined();
    expect("isHallOfFame" in smith).toBe(false);
  });

  test("stints point at the team rows phase 1 created", async () => {
    const { t } = await loaded();
    await loadPlayers(t);

    const teamRows = await teams(t);
    const sox = teamRows.find((r) => r.name === "Boston Red Sox")!;
    const gwynn = (await players(t)).find((p) => p.name === "Tony Gwynn")!;
    expect(gwynn.teamYears![0].teamId).toBe(sox._id);
    expect(gwynn.teamYears![0].toYear).toBe(1991);
  });

  test("is idempotent — a second run finds its own rows by source id", async () => {
    const { t } = await loaded();
    await loadPlayers(t);

    const second = await loadPlayers(t);

    expect(second.playersCreated).toBe(0);
    expect(second.playersAdopted).toBe(3);
    expect(second.playersSkippedAmbiguous).toBe(0);
    expect(await players(t)).toHaveLength(3);
  });

  test("adopts a single bare existing row and gap-fills it", async () => {
    const { t, sportId } = await loaded();
    const existingId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        // What the checklist flow creates from a card: a name and nothing else.
        name: "Tony  Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId,
        lastUpdated: NOW,
      }),
    );

    const result = await loadPlayers(t, [PLAYERS[0]]);

    expect(result.playersAdopted).toBe(1);
    expect(result.playersCreated).toBe(0);
    const rows = await players(t);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row._id).toBe(existingId);
    // The existing NAME is left alone — the dataset is input, not truth.
    expect(row.name).toBe("Tony  Gwynn");
    // …and the facts it had none of are filled in.
    expect(row.birthYear).toBe(1960);
    expect(row.isHallOfFame).toBe(true);
    expect(row.teamYears).toHaveLength(2);
    expect(row.externalIds?.lahmanId).toBe("gwynnto01");
  });

  test("NEVER overwrites a career, birth year or Hall of Fame flag it finds", async () => {
    const { t, sportId } = await loaded();
    const teamId = (await teams(t))[0]._id;
    await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId,
        birthYear: 1960,
        teamYears: [{ teamId, fromYear: 1982, toYear: 2001 }],
        isHallOfFame: false,
        lastUpdated: NOW,
      }),
    );

    await loadPlayers(t, [PLAYERS[0]]);

    const row = (await players(t))[0];
    expect(row.teamYears).toEqual([{ teamId, fromYear: 1982, toYear: 2001 }]);
    expect(row.isHallOfFame).toBe(false);
    expect(row.birthYear).toBe(1960);
    // Only the linkage is added.
    expect(row.externalIds?.lahmanId).toBe("gwynnto01");
  });

  test("a different birth year is a different person, so a new row is created", async () => {
    const { t, sportId } = await loaded();
    await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId,
        birthYear: 1962, // Tony Gwynn Jr., in effect.
        lastUpdated: NOW,
      }),
    );

    const result = await loadPlayers(t, [PLAYERS[0]]);

    expect(result.playersCreated).toBe(1);
    expect(result.playersSkippedAmbiguous).toBe(0);
    const rows = await players(t);
    expect(rows).toHaveLength(2);
    expect(rows.find((p) => p.birthYear === 1962)!.externalIds).toBeUndefined();
  });

  test("SKIPS and reports a name it cannot resolve to one person", async () => {
    const { t, sportId } = await loaded();
    const teamId = (await teams(t))[0]._id;
    await t.run(async (ctx) => {
      // Two rows, neither with a birth year, one carrying a career. Nothing
      // here says which is the dataset's Tony Gwynn.
      await ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId,
        teamYears: [{ teamId, fromYear: 1982 }],
        lastUpdated: NOW,
      });
      await ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId,
        lastUpdated: NOW,
      });
    });

    const result = await loadPlayers(t, [PLAYERS[0]]);

    expect(result.playersSkippedAmbiguous).toBe(1);
    expect(result.playersCreated).toBe(0);
    expect(result.playersAdopted).toBe(0);
    // Nothing was written to either candidate.
    const rows = await players(t);
    expect(rows).toHaveLength(2);
    expect(rows.every((p) => p.externalIds === undefined)).toBe(true);
  });

  test("two same-named players in the dataset both land", async () => {
    // The case that would deadlock a naive "exactly one match" rule: by the
    // time the second Bob Allen is considered, the first one is already a row.
    const { t } = await loaded();

    const result = await loadPlayers(t, [
      { id: "allenbo01", name: "Bob Allen", birthYear: 1867, stints: [[0, 1890, 1890]] },
      { id: "allenbo02", name: "Bob Allen", birthYear: 1904, stints: [[0, 1930, 1930]] },
    ]);

    expect(result.playersCreated).toBe(2);
    expect(result.playersSkippedAmbiguous).toBe(0);
    const rows = await players(t);
    expect(rows.map((p) => p.externalIds?.lahmanId).sort()).toEqual([
      "allenbo01",
      "allenbo02",
    ]);
  });

  test("drops a stint whose team row does not exist, and reports it", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);
    // Phase 1 deliberately skipped.

    const result = await loadPlayers(t, [PLAYERS[0]]);

    expect(result.playersCreated).toBe(1);
    expect(result.droppedStints).toBe(2);
    expect((await players(t))[0].teamYears).toBeUndefined();
  });

  test("caps a runaway career at 64 stints, keeping the EARLIEST, and reports it", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    // 70 teams, one season each, so the cap is the only thing that can trim it.
    const manyTeams = Array.from({ length: 70 }, (_, i) => ({
      key: `club-${i}`,
      name: `Springfield Club${i}`,
      location: "Springfield",
      nickname: `Club${i}`,
      league: "MLB",
      from: 1900 + i,
      to: 1900 + i,
      franchise: `club-${i}`,
    }));
    await t.mutation(internal.preloadPlayers.loadTeamsChunk, {
      sport: "baseball",
      leagues: LEAGUES,
      teams: manyTeams,
      dryRun: false,
    });

    const result = await t.mutation(internal.preloadPlayers.loadPlayersChunk, {
      sport: "baseball",
      teamNames: manyTeams.map((x) => x.name),
      players: [
        {
          id: "journeyman01",
          name: "Journey Man",
          stints: manyTeams.map((_, i) => [i, 1900 + i, 1900 + i]),
        },
      ],
      dryRun: false,
    });

    expect(result.truncatedStints).toBe(1);
    const row = (await players(t))[0];
    expect(row.teamYears).toHaveLength(64);
    expect(row.teamYears![0].fromYear).toBe(1900);
    expect(row.teamYears![63].fromYear).toBe(1963);
  });

  test("reports the unsynced sport rather than creating players without one", async () => {
    arm();
    const t = convexTest(schema, modules);

    const result = await loadPlayers(t);

    expect(result.playersSkippedNoSport).toBe(3);
    expect(result.playersCreated).toBe(0);
    expect(await players(t)).toHaveLength(0);
  });
});

describe("matchExistingPlayer", () => {
  const row = (over: Partial<Doc<"players">> = {}) =>
    ({
      _id: "x" as unknown as Id<"players">,
      _creationTime: NOW,
      name: "Bob Allen",
      nameNormalized: "allen bob",
      sportId: "s" as unknown as Id<"selectorOptions">,
      lastUpdated: NOW,
      ...over,
    }) as Doc<"players">;

  test("no candidate is a new row", () => {
    expect(matchExistingPlayer([], 1970)).toEqual({ kind: "create" });
  });

  test("exactly one candidate on the birth year is them", () => {
    const hit = row({ birthYear: 1970 });
    expect(matchExistingPlayer([hit, row({ birthYear: 1980 })], 1970)).toEqual({
      kind: "adopt",
      row: hit,
    });
  });

  test("two candidates on the birth year is ambiguous", () => {
    const result = matchExistingPlayer(
      [row({ birthYear: 1970 }), row({ birthYear: 1970 })],
      1970,
    );
    expect(result.kind).toBe("ambiguous");
  });

  test("every candidate dated differently means this is somebody new", () => {
    expect(
      matchExistingPlayer([row({ birthYear: 1965 }), row({ birthYear: 1980 })], 1970),
    ).toEqual({ kind: "create" });
  });

  test("a single bare row is adopted", () => {
    const bare = row();
    expect(matchExistingPlayer([bare], 1970)).toEqual({ kind: "adopt", row: bare });
    // …and so is one with an empty career array, which is the same thing.
    const empty = row({ teamYears: [] });
    expect(matchExistingPlayer([empty], undefined)).toEqual({
      kind: "adopt",
      row: empty,
    });
  });

  test("a single undated row that already has a career or a Wikidata id is not", () => {
    const withCareer = row({
      teamYears: [{ teamId: "t" as unknown as Id<"teams">, fromYear: 1990 }],
    });
    expect(matchExistingPlayer([withCareer], 1970).kind).toBe("ambiguous");

    const withQid = row({ externalIds: { wikidataId: "Q1" } });
    expect(matchExistingPlayer([withQid], 1970).kind).toBe("ambiguous");
  });

  test("several undated candidates are ambiguous", () => {
    expect(matchExistingPlayer([row(), row()], 1970).kind).toBe("ambiguous");
  });
});

describe("the action entry point", () => {
  test("reports every player as skipped when the sport is not synced", async () => {
    // The one failure mode that looks like success. It must not walk 21,000
    // players to discover it, and it must say so in the summary.
    arm();
    const t = convexTest(schema, modules);

    const summary = await t.action(internal.preloadPlayers.run, {
      sport: "baseball",
      confirm: "PRELOAD",
      dryRun: true,
    });

    expect(summary.teamsCreated).toBe(0);
    expect(summary.playersCreated).toBe(0);
    expect(summary.playersSkippedNoSport).toBeGreaterThan(20_000);
    expect(summary.nextStart).toBeNull();
    expect(await teams(t)).toHaveLength(0);
  });
});
