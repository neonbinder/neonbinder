/**
 * NEO-254 — the production data repair, pinned.
 *
 * Three properties per function, none of which a type check can see:
 *
 *  1. **Unarmed means untouched.** `ALLOW_NEO254_REPAIR` unset — or set to
 *     anything but `"true"` — is a refusal that names the flag and writes
 *     nothing, from the entry point AND from the batch a caller could reach
 *     directly.
 *  2. **Exactly one, or nothing.** Zero matches and several matches are both
 *     refusals; a repair that picked `.first()` is how a 1985 card ended up
 *     on a 2011 franchise.
 *  3. **A second run is a no-op.** Same call, same deployment, no change and
 *     the result says so.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { teamRowFields } from "../lib/teamRow";
import { normalizeEntityName } from "../lib/entityNearMatch";
import { normalizeLeagueName } from "../leagues";
import { moveStintsInCareer } from "./neo254ProdData";

// This file lives one level down, so the glob climbs to `convex/` and
// convex-test finds the module root from the `_generated` entry (`../`).
// Vite keys files in the importer's OWN directory as `./name.ts` rather than
// `../repairs/name.ts`, so those are re-prefixed or the module under test is
// the one file convex-test cannot find.
const rawModules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("../**/*.*s");
const modules = Object.fromEntries(
  Object.entries(rawModules).map(([path, module]) => [
    path.startsWith("./") ? `../repairs/${path.slice(2)}` : path,
    module,
  ]),
);

const CONFIRM = "NEO254_REPAIR" as const;
const fns = internal.repairs.neo254ProdData;

beforeEach(() => {
  vi.stubEnv("ALLOW_NEO254_REPAIR", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type T = ReturnType<typeof convexTest>;
type Era = { from: number; to?: number };

const NOW = 1_700_000_000_000;

async function seedSport(t: T, value = "Baseball"): Promise<Id<"selectorOptions">> {
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

/** A split team row, derived through `teamRowFields` like every real insert. */
async function seedTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  parts: { location?: string; name: string },
  yearsActive?: Era,
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      ...teamRowFields(parts),
      sportId,
      ...(yearsActive ? { yearsActive } : {}),
      lastUpdated: NOW,
    }),
  );
}

/** The pre-NEO-236 shape: the whole name in `name`, no `location`. */
async function seedUnsplitTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  fullName: string,
  yearsActive?: Era,
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name: fullName,
      nameNormalized: normalizeEntityName(fullName),
      sportId,
      ...(yearsActive ? { yearsActive } : {}),
      lastUpdated: NOW,
    }),
  );
}

async function seedFranchise(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
): Promise<Id<"franchises">> {
  return t.run(async (ctx) =>
    ctx.db.insert("franchises", {
      name,
      nameNormalized: normalizeEntityName(name),
      sportId,
      lastUpdated: NOW,
    }),
  );
}

async function seedLeague(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  aliases?: string[],
): Promise<Id<"leagues">> {
  return t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name,
      nameNormalized: normalizeLeagueName(name),
      sportId,
      ...(aliases ? { aliases } : {}),
      lastUpdated: NOW,
    }),
  );
}

type Stint = { teamId: Id<"teams">; fromYear: number; toYear?: number };

async function seedPlayer(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  teamYears: Stint[],
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizeEntityName(name),
      sportId,
      teamYears,
      lastUpdated: NOW,
    }),
  );
}

const getTeam = (t: T, id: Id<"teams">) => t.run(async (ctx) => ctx.db.get(id));
const getPlayer = (t: T, id: Id<"players">) => t.run(async (ctx) => ctx.db.get(id));
const getLeague = (t: T, id: Id<"leagues">) => t.run(async (ctx) => ctx.db.get(id));
const getFranchise = (t: T, id: Id<"franchises">) =>
  t.run(async (ctx) => ctx.db.get(id));

/** Every row in the four tables, for "wrote nothing" assertions. */
async function snapshot(t: T): Promise<unknown> {
  return t.run(async (ctx) => ({
    teams: await ctx.db.query("teams").collect(),
    players: await ctx.db.query("players").collect(),
    leagues: await ctx.db.query("leagues").collect(),
    franchises: await ctx.db.query("franchises").collect(),
  }));
}

// ---------------------------------------------------------------------------
// The incident's shape, as a fixture every suite can reuse
// ---------------------------------------------------------------------------

async function angelsFixture(t: T) {
  const sportId = await seedSport(t, "Baseball");
  // Both eras of the franchise, dated the way the load left them.
  const angels = await seedTeam(
    t,
    sportId,
    { location: "Los Angeles", name: "Angels" },
    { from: 1961, to: 2004 },
  );
  const anaheim = await seedTeam(
    t,
    sportId,
    { location: "Los Angeles", name: "Angels of Anaheim" },
    { from: 2005 },
  );
  return { sportId, angels, anaheim };
}

// ---------------------------------------------------------------------------
// The gate — every entry point, and the batch a caller could reach directly
// ---------------------------------------------------------------------------

describe("arming gate", () => {
  test("every function refuses when ALLOW_NEO254_REPAIR is unset, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, angels, anaheim } = await angelsFixture(t);
    await seedFranchise(t, sportId, "Los Angeles Angels of Anaheim");
    await seedLeague(t, sportId, "Major League Baseball");
    await seedPlayer(t, sportId, "Mike Trout", [{ teamId: anaheim, fromYear: 2016 }]);
    await seedUnsplitTeam(t, sportId, "Milwaukee Brewers");
    const before = await snapshot(t);

    vi.unstubAllEnvs();

    await expect(
      t.mutation(fns.setTeamEra, {
        confirm: CONFIRM,
        sport: "Baseball",
        location: "Los Angeles",
        name: "Angels",
        fromYear: 1961,
        yearsActive: { from: 1961 },
      }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
    await expect(
      t.mutation(fns.renameFranchise, {
        confirm: CONFIRM,
        sport: "Baseball",
        from: "Los Angeles Angels of Anaheim",
        to: "Los Angeles Angels",
      }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
    await expect(
      t.action(fns.moveStints, {
        confirm: CONFIRM,
        sport: "Baseball",
        fromTeam: { location: "Los Angeles", name: "Angels of Anaheim", fromYear: 2005 },
        toTeam: { location: "Los Angeles", name: "Angels", fromYear: 1961 },
        seasonFrom: 2016,
      }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
    await expect(
      t.mutation(fns.moveStintsBatch, {
        confirm: CONFIRM,
        sportId,
        fromTeamId: anaheim,
        toTeamId: angels,
        seasonFrom: 2016,
        cursor: null,
      }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
    await expect(
      t.query(fns.resolveMoveStintsTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        fromTeam: { location: "Los Angeles", name: "Angels of Anaheim", fromYear: 2005 },
        toTeam: { location: "Los Angeles", name: "Angels", fromYear: 1961 },
      }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
    await expect(
      t.mutation(fns.setLeagueAliases, {
        confirm: CONFIRM,
        sport: "Baseball",
        name: "Major League Baseball",
        aliases: ["AL"],
      }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
    await expect(
      t.mutation(fns.resplitSeedTeams, { confirm: CONFIRM }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
    await expect(
      t.mutation(fns.splitTeam, {
        confirm: CONFIRM,
        sport: "Baseball",
        currentName: "Milwaukee Brewers",
        location: "Milwaukee",
        name: "Brewers",
      }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);

    expect(await snapshot(t)).toEqual(before);
  });

  test("refuses when the flag is any value other than \"true\"", async () => {
    vi.stubEnv("ALLOW_NEO254_REPAIR", "1");
    const t = convexTest(schema, modules);
    await seedSport(t, "Baseball");
    await expect(
      t.mutation(fns.resplitSeedTeams, { confirm: CONFIRM }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
  });
});

// ---------------------------------------------------------------------------
// 1. setTeamEra
// ---------------------------------------------------------------------------

describe("setTeamEra", () => {
  const call = (t: T, yearsActive: Era | null, ref = { location: "Los Angeles", name: "Angels", fromYear: 1961 }) =>
    t.mutation(fns.setTeamEra, { confirm: CONFIRM, sport: "Baseball", ...ref, yearsActive });

  test("re-dates the one row under that name and start year", async () => {
    const t = convexTest(schema, modules);
    const { angels, anaheim } = await angelsFixture(t);

    // First the Anaheim era has to close, or the reopened Angels era
    // overlaps it — the same refusal `saveTeamFields` gives.
    const closed = await call(t, { from: 2005, to: 2015 }, {
      location: "Los Angeles",
      name: "Angels of Anaheim",
      fromYear: 2005,
    });
    expect(closed).toEqual({
      teamId: anaheim,
      before: { from: 2005 },
      after: { from: 2005, to: 2015 },
      changed: true,
    });

    const result = await call(t, { from: 1961 });
    expect(result).toEqual({
      teamId: angels,
      before: { from: 1961, to: 2004 },
      after: { from: 1961 },
      changed: true,
    });
    expect((await getTeam(t, angels))?.yearsActive).toEqual({ from: 1961 });
    // The other era was not touched.
    expect((await getTeam(t, anaheim))?.yearsActive).toEqual({ from: 2005, to: 2015 });
  });

  test("null clears the era", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const id = await seedTeam(t, sportId, { name: "Athletics" }, { from: 1901, to: 1950 });
    const result = await t.mutation(fns.setTeamEra, {
      confirm: CONFIRM,
      sport: "Baseball",
      name: "Athletics",
      fromYear: 1901,
      yearsActive: null,
    });
    expect(result).toEqual({ teamId: id, before: { from: 1901, to: 1950 }, after: null, changed: true });
    expect((await getTeam(t, id))?.yearsActive).toBeUndefined();
  });

  test("refuses when no row under that name starts that year", async () => {
    const t = convexTest(schema, modules);
    await angelsFixture(t);
    await expect(
      call(t, { from: 1961 }, { location: "Los Angeles", name: "Angels", fromYear: 1966 }),
    ).rejects.toThrow(/found 0/);
    await expect(
      call(t, { from: 1961 }, { location: "Anaheim", name: "Angels", fromYear: 1961 }),
    ).rejects.toThrow(/found 0/);
  });

  test("refuses when several rows under that name start that year", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    await seedTeam(t, sportId, { location: "Los Angeles", name: "Angels" }, { from: 1961, to: 1964 });
    await seedTeam(t, sportId, { location: "Los Angeles", name: "Angels" }, { from: 1961, to: 2004 });
    await expect(call(t, { from: 1961 })).rejects.toThrow(/found 2/);
  });

  test("refuses when the new era would overlap another row of the same name", async () => {
    const t = convexTest(schema, modules);
    const { angels } = await angelsFixture(t);
    const sportId = (await getTeam(t, angels))!.sportId;
    await seedTeam(t, sportId, { location: "Los Angeles", name: "Angels" }, { from: 2016 });
    await expect(call(t, { from: 1961 })).rejects.toThrow(/overlap/);
    expect((await getTeam(t, angels))?.yearsActive).toEqual({ from: 1961, to: 2004 });
  });

  test("refuses an unknown sport", async () => {
    const t = convexTest(schema, modules);
    await angelsFixture(t);
    await expect(
      t.mutation(fns.setTeamEra, {
        confirm: CONFIRM,
        sport: "Curling",
        location: "Los Angeles",
        name: "Angels",
        fromYear: 1961,
        yearsActive: null,
      }),
    ).rejects.toThrow(/exactly one sport/);
  });

  test("a second identical call changes nothing", async () => {
    const t = convexTest(schema, modules);
    const { angels } = await angelsFixture(t);
    await call(t, { from: 1961, to: 2010 });
    const rowAfterFirst = await getTeam(t, angels);
    const second = await call(t, { from: 1961, to: 2010 });
    expect(second).toEqual({
      teamId: angels,
      before: { from: 1961, to: 2010 },
      after: { from: 1961, to: 2010 },
      changed: false,
    });
    expect(await getTeam(t, angels)).toEqual(rowAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 2. renameFranchise
// ---------------------------------------------------------------------------

describe("renameFranchise", () => {
  const call = (t: T, from = "Los Angeles Angels of Anaheim", to = "Los Angeles Angels") =>
    t.mutation(fns.renameFranchise, { confirm: CONFIRM, sport: "Baseball", from, to });

  test("renames the one franchise and rewrites its dedup key", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const id = await seedFranchise(t, sportId, "Los Angeles Angels of Anaheim");

    const result = await call(t);
    expect(result).toEqual({
      franchiseId: id,
      before: "Los Angeles Angels of Anaheim",
      after: "Los Angeles Angels",
      changed: true,
    });
    const row = await getFranchise(t, id);
    expect(row?.name).toBe("Los Angeles Angels");
    expect(row?.nameNormalized).toBe(normalizeEntityName("Los Angeles Angels"));
  });

  test("refuses when a franchise named `to` already exists in the sport", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const id = await seedFranchise(t, sportId, "Los Angeles Angels of Anaheim");
    await seedFranchise(t, sportId, "Los Angeles Angels");
    await expect(call(t)).rejects.toThrow(/already called Los Angeles Angels/);
    expect((await getFranchise(t, id))?.name).toBe("Los Angeles Angels of Anaheim");
  });

  test("refuses when neither `from` nor `to` exists", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t, "Baseball");
    await expect(call(t)).rejects.toThrow(/No franchise named/);
  });

  test("refuses when several franchises answer to `from`", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    await seedFranchise(t, sportId, "Los Angeles Angels of Anaheim");
    await seedFranchise(t, sportId, "Angels of Anaheim Los Angeles");
    await expect(call(t)).rejects.toThrow(/found several/);
  });

  test("does not cross sports", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t, "Baseball");
    const hockey = await seedSport(t, "Hockey");
    await seedFranchise(t, hockey, "Los Angeles Angels of Anaheim");
    await expect(call(t)).rejects.toThrow(/No franchise named/);
  });

  test("a second identical call reports done and changes nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const id = await seedFranchise(t, sportId, "Los Angeles Angels of Anaheim");
    await call(t);
    const rowAfterFirst = await getFranchise(t, id);

    const second = await call(t);
    expect(second).toEqual({
      franchiseId: id,
      before: "Los Angeles Angels",
      after: "Los Angeles Angels",
      changed: false,
    });
    expect(await getFranchise(t, id)).toEqual(rowAfterFirst);
    expect(await t.run(async (ctx) => ctx.db.query("franchises").collect())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. moveStints
// ---------------------------------------------------------------------------

describe("moveStintsInCareer (pure)", () => {
  const from = "from" as Id<"teams">;
  const to = "to" as Id<"teams">;
  const other = "other" as Id<"teams">;

  test("moves only stints at fromTeam starting in or after seasonFrom", () => {
    const result = moveStintsInCareer(
      [
        { teamId: from, fromYear: 2010, toYear: 2015 },
        { teamId: from, fromYear: 2016, toYear: 2018 },
        { teamId: other, fromYear: 2019 },
      ],
      from,
      to,
      2016,
    );
    expect(result.moved).toBe(1);
    expect(result.stints).toEqual([
      { teamId: from, fromYear: 2010, toYear: 2015 },
      { teamId: to, fromYear: 2016, toYear: 2018 },
      { teamId: other, fromYear: 2019 },
    ]);
  });

  test("merges into an existing stint with the same start; the later end wins, open beats closed", () => {
    const closed = moveStintsInCareer(
      [
        { teamId: to, fromYear: 2016, toYear: 2017 },
        { teamId: from, fromYear: 2016, toYear: 2019 },
      ],
      from,
      to,
      2016,
    );
    expect(closed.stints).toEqual([{ teamId: to, fromYear: 2016, toYear: 2019 }]);

    const open = moveStintsInCareer(
      [
        { teamId: to, fromYear: 2016, toYear: 2017 },
        { teamId: from, fromYear: 2016 },
      ],
      from,
      to,
      2016,
    );
    expect(open.stints).toEqual([{ teamId: to, fromYear: 2016 }]);
  });
});

describe("moveStints", () => {
  const call = (t: T, batchSize?: number) =>
    t.action(fns.moveStints, {
      confirm: CONFIRM,
      sport: "Baseball",
      fromTeam: { location: "Los Angeles", name: "Angels of Anaheim", fromYear: 2005 },
      toTeam: { location: "Los Angeles", name: "Angels", fromYear: 1961 },
      seasonFrom: 2016,
      ...(batchSize !== undefined ? { batchSize } : {}),
    });

  test("re-points post-seasonFrom stints, merges duplicates, leaves earlier seasons alone", async () => {
    const t = convexTest(schema, modules);
    const { sportId, angels, anaheim } = await angelsFixture(t);
    const trout = await seedPlayer(t, sportId, "Mike Trout", [
      { teamId: anaheim, fromYear: 2011, toYear: 2015 },
      { teamId: anaheim, fromYear: 2016 },
    ]);
    // Traded away and back: the moved 2016 stint lands on a row that already
    // holds a 2016 Angels stint, and the two become one.
    const returner = await seedPlayer(t, sportId, "Returning Player", [
      { teamId: anaheim, fromYear: 2016, toYear: 2017 },
      { teamId: angels, fromYear: 2016, toYear: 2018 },
    ]);
    const veteran = await seedPlayer(t, sportId, "Old Timer", [
      { teamId: anaheim, fromYear: 2005, toYear: 2009 },
    ]);
    const hockey = await seedSport(t, "Hockey");
    const hockeyAnaheim = await seedTeam(t, hockey, { location: "Anaheim", name: "Ducks" }, { from: 1993 });
    const skater = await seedPlayer(t, hockey, "Skater", [{ teamId: hockeyAnaheim, fromYear: 2016 }]);

    const result = await call(t);
    expect(result).toEqual({
      fromTeamId: anaheim,
      toTeamId: angels,
      playersScanned: 3,
      playersChanged: 2,
      stintsMoved: 2,
      isComplete: true,
    });
    expect((await getPlayer(t, trout))?.teamYears).toEqual([
      { teamId: anaheim, fromYear: 2011, toYear: 2015 },
      { teamId: angels, fromYear: 2016 },
    ]);
    expect((await getPlayer(t, returner))?.teamYears).toEqual([
      { teamId: angels, fromYear: 2016, toYear: 2018 },
    ]);
    expect((await getPlayer(t, veteran))?.teamYears).toEqual([
      { teamId: anaheim, fromYear: 2005, toYear: 2009 },
    ]);
    expect((await getPlayer(t, skater))?.teamYears).toEqual([
      { teamId: hockeyAnaheim, fromYear: 2016 },
    ]);
  });

  test("pages through the sport in batches", async () => {
    const t = convexTest(schema, modules);
    const { sportId, anaheim } = await angelsFixture(t);
    for (let i = 0; i < 5; i += 1) {
      await seedPlayer(t, sportId, `Player ${i}`, [{ teamId: anaheim, fromYear: 2016 + i }]);
    }
    const result = await call(t, 2);
    expect(result.playersScanned).toBe(5);
    expect(result.playersChanged).toBe(5);
    expect(result.stintsMoved).toBe(5);
    expect(result.isComplete).toBe(true);
  });

  test("refuses when either end is not exactly one row, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, anaheim } = await angelsFixture(t);
    await seedPlayer(t, sportId, "Mike Trout", [{ teamId: anaheim, fromYear: 2016 }]);
    const before = await snapshot(t);

    await expect(
      t.action(fns.moveStints, {
        confirm: CONFIRM,
        sport: "Baseball",
        fromTeam: { location: "Los Angeles", name: "Angels of Anaheim", fromYear: 2005 },
        toTeam: { location: "Los Angeles", name: "Angels", fromYear: 1966 },
        seasonFrom: 2016,
      }),
    ).rejects.toThrow(/found 0/);
    await expect(
      t.action(fns.moveStints, {
        confirm: CONFIRM,
        sport: "Baseball",
        fromTeam: { location: "Los Angeles", name: "Angels", fromYear: 1961 },
        toTeam: { location: "Los Angeles", name: "Angels", fromYear: 1961 },
        seasonFrom: 2016,
      }),
    ).rejects.toThrow(/same row/);
    expect(await snapshot(t)).toEqual(before);
  });

  test("a second run moves nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, anaheim } = await angelsFixture(t);
    const trout = await seedPlayer(t, sportId, "Mike Trout", [
      { teamId: anaheim, fromYear: 2011, toYear: 2015 },
      { teamId: anaheim, fromYear: 2016 },
    ]);
    await call(t);
    const rowAfterFirst = await getPlayer(t, trout);

    const second = await call(t);
    expect(second.playersChanged).toBe(0);
    expect(second.stintsMoved).toBe(0);
    expect(second.isComplete).toBe(true);
    expect(await getPlayer(t, trout)).toEqual(rowAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 4. setLeagueAliases
// ---------------------------------------------------------------------------

describe("setLeagueAliases", () => {
  const call = (t: T, aliases: string[], name = "Major League Baseball") =>
    t.mutation(fns.setLeagueAliases, { confirm: CONFIRM, sport: "Baseball", name, aliases });

  test("unions the aliases onto the one league and reports before/after", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const id = await seedLeague(t, sportId, "Major League Baseball", ["MLB"]);

    const result = await call(t, ["American League", "National League", "AL", "NL", "mlb"]);
    expect(result).toEqual({
      leagueId: id,
      before: ["MLB"],
      after: ["MLB", "American League", "National League", "AL", "NL"],
      added: ["American League", "National League", "AL", "NL"],
      changed: true,
    });
    expect((await getLeague(t, id))?.aliases).toEqual([
      "MLB",
      "American League",
      "National League",
      "AL",
      "NL",
    ]);
  });

  test("finds the league by an alias it already answers to", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const id = await seedLeague(t, sportId, "Major League Baseball", ["MLB"]);
    const result = await call(t, ["AL"], "mlb");
    expect(result.leagueId).toBe(id);
    expect(result.after).toEqual(["MLB", "AL"]);
  });

  test("refuses on zero or several matches", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    await expect(call(t, ["AL"])).rejects.toThrow(/found 0/);
    await seedLeague(t, sportId, "Major League Baseball");
    await seedLeague(t, sportId, "Big League", ["Major League Baseball"]);
    await expect(call(t, ["AL"])).rejects.toThrow(/found 2/);
  });

  test("refuses an alias another league in the sport already answers to", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const id = await seedLeague(t, sportId, "Major League Baseball");
    await seedLeague(t, sportId, "American League", ["AL"]);
    await expect(call(t, ["National League", "al"])).rejects.toThrow(/American League/);
    expect((await getLeague(t, id))?.aliases).toBeUndefined();
  });

  test("a second identical call adds nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const id = await seedLeague(t, sportId, "Major League Baseball");
    await call(t, ["AL", "NL"]);
    const rowAfterFirst = await getLeague(t, id);

    const second = await call(t, ["AL", "NL"]);
    expect(second).toEqual({
      leagueId: id,
      before: ["AL", "NL"],
      after: ["AL", "NL"],
      added: [],
      changed: false,
    });
    expect(await getLeague(t, id)).toEqual(rowAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 5. resplitSeedTeams
// ---------------------------------------------------------------------------

describe("resplitSeedTeams", () => {
  const call = (t: T) => t.mutation(fns.resplitSeedTeams, { confirm: CONFIRM });

  test("splits an unsplit row the seed knows the parts of, keeping its dedup key", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const brewers = await seedUnsplitTeam(t, sportId, "Milwaukee Brewers", { from: 1970 });
    // A renamed franchise's CURRENT name is split too.
    const angels = await seedUnsplitTeam(t, sportId, "Los Angeles Angels", { from: 1961 });
    // A row with no seed entry is left whole.
    const lions = await seedUnsplitTeam(t, sportId, "Saitama Seibu Lions");

    const result = await call(t);
    expect(result.resplit.sort()).toEqual(["Los Angeles Angels", "Milwaukee Brewers"]);
    expect(result.skipped).toEqual([]);
    expect(result.noSport).toBeGreaterThan(0);

    const brewersRow = await getTeam(t, brewers);
    expect(brewersRow).toMatchObject({
      location: "Milwaukee",
      name: "Brewers",
      nameNormalized: normalizeEntityName("Milwaukee Brewers"),
      yearsActive: { from: 1970 },
    });
    expect(await getTeam(t, angels)).toMatchObject({ location: "Los Angeles", name: "Angels" });
    expect(await getTeam(t, lions)).toMatchObject({ name: "Saitama Seibu Lions" });
    expect((await getTeam(t, lions))?.location).toBeUndefined();
  });

  test("skips when the split row already exists with an overlapping era", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const unsplit = await seedUnsplitTeam(t, sportId, "Milwaukee Brewers");
    await seedTeam(t, sportId, { location: "Milwaukee", name: "Brewers" });

    const result = await call(t);
    expect(result.resplit).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "Milwaukee Brewers", sport: "Baseball", reason: "colliding" },
    ]);
    expect((await getTeam(t, unsplit))?.name).toBe("Milwaukee Brewers");
  });

  test("splits when the split row exists but in a disjoint era", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Hockey");
    const unsplit = await seedUnsplitTeam(t, sportId, "Winnipeg Jets", { from: 2011 });
    await seedTeam(t, sportId, { location: "Winnipeg", name: "Jets" }, { from: 1972, to: 1996 });

    const result = await call(t);
    expect(result.resplit).toEqual(["Winnipeg Jets"]);
    expect(await getTeam(t, unsplit)).toMatchObject({ location: "Winnipeg", name: "Jets" });
  });

  test("skips when two unsplit candidates match", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const a = await seedUnsplitTeam(t, sportId, "Milwaukee Brewers", { from: 1970, to: 1997 });
    const b = await seedUnsplitTeam(t, sportId, "Milwaukee Brewers", { from: 1998 });

    const result = await call(t);
    expect(result.resplit).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "Milwaukee Brewers", sport: "Baseball", reason: "ambiguous" },
    ]);
    expect((await getTeam(t, a))?.location).toBeUndefined();
    expect((await getTeam(t, b))?.location).toBeUndefined();
  });

  test("skips a row whose stored key disagrees with its own name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    // Stored under the seed's key but NAMED something else — the shape a
    // hand-edited row takes. Re-deriving the key would repoint its cards.
    const id = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Milwaukee Brewers Baseball Club",
        nameNormalized: normalizeEntityName("Milwaukee Brewers"),
        sportId,
        lastUpdated: NOW,
      }),
    );
    const result = await call(t);
    expect(result.resplit).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect((await getTeam(t, id))?.location).toBeUndefined();
  });

  test("seed entries without a location have nothing to do", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Soccer");
    const arsenal = await seedTeam(t, sportId, { name: "Arsenal" });
    const result = await call(t);
    expect(result.resplit).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(await getTeam(t, arsenal)).toMatchObject({ name: "Arsenal" });
  });

  test("a second run splits nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const brewers = await seedUnsplitTeam(t, sportId, "Milwaukee Brewers");
    await call(t);
    const rowAfterFirst = await getTeam(t, brewers);

    const second = await call(t);
    expect(second.resplit).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(await getTeam(t, brewers)).toEqual(rowAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 6. splitTeam — the rows the loader adopted and the seed cannot name
// ---------------------------------------------------------------------------

describe("splitTeam", () => {
  const call = (
    t: T,
    sport: string,
    currentName: string,
    location: string,
    name: string,
  ) => t.mutation(fns.splitTeam, { confirm: CONFIRM, sport, currentName, location, name });

  test("splits an adopted row, keeping its era, stints and dedup key", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Basketball");
    // Prod, 2026-09-10: the Clippers row the loader adopted — 1984-, 422
    // stints, no split sibling, and no seed entry naming it.
    const clippers = await seedUnsplitTeam(t, sportId, "Los Angeles Clippers", { from: 1984 });
    const player = await seedPlayer(t, sportId, "Player", [
      { teamId: clippers, fromYear: 2014, toYear: 2019 },
    ]);

    const result = await call(t, "Basketball", "Los Angeles Clippers", "Los Angeles", "Clippers");
    expect(result).toMatchObject({
      teamId: clippers,
      before: { location: null, name: "Los Angeles Clippers" },
      after: { location: "Los Angeles", name: "Clippers" },
      changed: true,
    });

    const row = await getTeam(t, clippers);
    expect(row).toMatchObject({
      location: "Los Angeles",
      name: "Clippers",
      nameNormalized: normalizeEntityName("Los Angeles Clippers"),
      yearsActive: { from: 1984 },
    });
    // The stint still points at the same row — a split is a rewrite of the
    // row's own fields, never a new row.
    expect((await getPlayer(t, player))?.teamYears).toEqual([
      { teamId: clippers, fromYear: 2014, toYear: 2019 },
    ]);
  });

  test("splits each of the four adopted prod rows in its own sport", async () => {
    const t = convexTest(schema, modules);
    const cases: Array<[string, string, string, string]> = [
      ["Basketball", "Los Angeles Clippers", "Los Angeles", "Clippers"],
      ["Football", "Oakland Raiders", "Oakland", "Raiders"],
      ["Hockey", "Arizona Coyotes", "Arizona", "Coyotes"],
      ["Baseball", "Oakland Athletics", "Oakland", "Athletics"],
    ];
    const eras: Record<string, Era> = {
      "Los Angeles Clippers": { from: 1984 },
      "Oakland Raiders": { from: 1960, to: 2019 },
      "Arizona Coyotes": { from: 2014, to: 2023 },
      "Oakland Athletics": { from: 1968, to: 2024 },
    };
    for (const [sport, currentName, location, name] of cases) {
      const sportId = await seedSport(t, sport);
      const id = await seedUnsplitTeam(t, sportId, currentName, eras[currentName]);
      const result = await call(t, sport, currentName, location, name);
      expect(result.changed).toBe(true);
      expect(await getTeam(t, id)).toMatchObject({
        location,
        name,
        nameNormalized: normalizeEntityName(currentName),
        yearsActive: eras[currentName],
      });
    }
  });

  test("refuses when no row in the sport carries that whole name", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t, "Basketball");
    await expect(
      call(t, "Basketball", "Los Angeles Clippers", "Los Angeles", "Clippers"),
    ).rejects.toThrow(/found 0/);
  });

  test("refuses when two unsplit rows carry that name, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Hockey");
    const a = await seedUnsplitTeam(t, sportId, "Arizona Coyotes", { from: 2014, to: 2023 });
    const b = await seedUnsplitTeam(t, sportId, "Arizona Coyotes", { from: 1996, to: 2013 });
    const before = await snapshot(t);

    await expect(
      call(t, "Hockey", "Arizona Coyotes", "Arizona", "Coyotes"),
    ).rejects.toThrow(/found 2/);
    expect(await snapshot(t)).toEqual(before);
    expect((await getTeam(t, a))?.location).toBeUndefined();
    expect((await getTeam(t, b))?.location).toBeUndefined();
  });

  test("refuses when a split sibling already holds an overlapping era", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Basketball");
    // The Hawks/Celtics shape: a nickname-only legacy row shadowed by the
    // proper split row. Splitting it would collide, so it is refused rather
    // than merged — merging has no code path and is the owner's decision.
    const legacy = await seedUnsplitTeam(t, sportId, "Atlanta Hawks");
    await seedTeam(t, sportId, { location: "Atlanta", name: "Hawks" }, { from: 1968 });

    await expect(
      call(t, "Basketball", "Atlanta Hawks", "Atlanta", "Hawks"),
    ).rejects.toThrow(/overlapping era/);
    expect((await getTeam(t, legacy))?.location).toBeUndefined();
  });

  test("splits when the sibling's era is disjoint", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Hockey");
    const unsplit = await seedUnsplitTeam(t, sportId, "Winnipeg Jets", { from: 2011 });
    await seedTeam(t, sportId, { location: "Winnipeg", name: "Jets" }, { from: 1972, to: 1996 });

    const result = await call(t, "Hockey", "Winnipeg Jets", "Winnipeg", "Jets");
    expect(result.changed).toBe(true);
    expect(await getTeam(t, unsplit)).toMatchObject({ location: "Winnipeg", name: "Jets" });
  });

  test("refuses parts that do not compose back to the same dedup key", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Football");
    const raiders = await seedUnsplitTeam(t, sportId, "Oakland Raiders", { from: 1960, to: 2019 });

    await expect(
      call(t, "Football", "Oakland Raiders", "Las Vegas", "Raiders"),
    ).rejects.toThrow(/does not compose back/);
    expect((await getTeam(t, raiders))?.location).toBeUndefined();
  });

  test("refuses an empty location", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t, "Football");
    await expect(
      call(t, "Football", "Oakland Raiders", "   ", "Oakland Raiders"),
    ).rejects.toThrow(/location cannot be empty/);
  });

  test("does not cross sports", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t, "Football");
    const hockeyId = await seedSport(t, "Hockey");
    const coyotes = await seedUnsplitTeam(t, hockeyId, "Arizona Coyotes", { from: 2014 });

    await expect(
      call(t, "Football", "Arizona Coyotes", "Arizona", "Coyotes"),
    ).rejects.toThrow(/found 0/);
    expect((await getTeam(t, coyotes))?.location).toBeUndefined();
  });

  test("a second identical call reports done and changes nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const athletics = await seedUnsplitTeam(t, sportId, "Oakland Athletics", { from: 1968, to: 2024 });
    await call(t, "Baseball", "Oakland Athletics", "Oakland", "Athletics");
    const rowAfterFirst = await getTeam(t, athletics);

    const second = await call(t, "Baseball", "Oakland Athletics", "Oakland", "Athletics");
    expect(second).toEqual({
      teamId: athletics,
      before: { location: "Oakland", name: "Athletics" },
      after: { location: "Oakland", name: "Athletics" },
      changed: false,
    });
    expect(await getTeam(t, athletics)).toEqual(rowAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 7. deleteTeam — the unreachable legacy rows
// ---------------------------------------------------------------------------

/** A checklist row that prints `teamOnCardIds`. */
async function seedCard(
  t: T,
  teamOnCardIds: Id<"teams">[],
  cardNumber = "1",
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) => {
    const selectorOptionId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      children: [],
      lastUpdated: NOW,
    });
    return ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber,
      cardName: "A Card",
      teamOnCardIds,
      platformData: {},
      sortOrder: 0,
      lastUpdated: NOW,
    });
  });
}

/** A review row whose `link` decision points at a team. */
async function seedReviewLinkingTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  teamId: Id<"teams">,
  name = "Hawks",
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) => {
    const selectorOptionId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      children: [],
      lastUpdated: NOW,
    });
    return ctx.db.insert("entityReviewQueue", {
      selectorOptionId,
      batchId: "batch-1",
      createdByUserId: "user-1",
      kind: "team",
      name,
      sportId,
      status: "ready",
      decision: { action: "link", linkedTeamId: teamId },
    });
  });
}

describe("deleteTeam", () => {
  /** The prod shape: a nickname-only legacy row shadowed by the proper one. */
  async function hawksFixture(t: T) {
    const sportId = await seedSport(t, "Basketball");
    const legacy = await seedUnsplitTeam(t, sportId, "Hawks");
    const proper = await seedTeam(
      t,
      sportId,
      { location: "Atlanta", name: "Hawks" },
      { from: 1968 },
    );
    return { sportId, legacy, proper };
  }

  const del = (
    t: T,
    args: {
      sport: string;
      name: string;
      location?: string;
      fromYear?: number;
      stints?:
        | { kind: "refuse" }
        | { kind: "drop" }
        | { kind: "move"; to: { location?: string; name: string; fromYear?: number } };
      batchSize?: number;
    },
  ) => t.action(fns.deleteTeam, { confirm: CONFIRM, ...args });

  test("refuses when unarmed, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { legacy } = await hawksFixture(t);
    const before = await snapshot(t);

    vi.unstubAllEnvs();
    await expect(
      del(t, { sport: "Basketball", name: "Hawks", stints: { kind: "drop" } }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
    await expect(
      t.mutation(fns.deleteTeamStintsBatch, {
        confirm: CONFIRM,
        sportId: (await getTeam(t, legacy))!.sportId,
        teamId: legacy,
        toTeamId: null,
        policy: "drop",
        cursor: null,
      }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
    await expect(
      t.mutation(fns.finalizeDeleteTeam, {
        confirm: CONFIRM,
        sportId: (await getTeam(t, legacy))!.sportId,
        teamId: legacy,
      }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);

    expect(await snapshot(t)).toEqual(before);
  });

  test("refuses when the flag is any value other than \"true\"", async () => {
    vi.stubEnv("ALLOW_NEO254_REPAIR", "TRUE");
    const t = convexTest(schema, modules);
    const { legacy } = await hawksFixture(t);
    await expect(
      del(t, { sport: "Basketball", name: "Hawks", stints: { kind: "drop" } }),
    ).rejects.toThrow(/ALLOW_NEO254_REPAIR/);
    expect(await getTeam(t, legacy)).not.toBeNull();
  });

  test("deletes the stintless legacy row, leaving the proper row alone", async () => {
    const t = convexTest(schema, modules);
    const { legacy, proper } = await hawksFixture(t);

    const result = await del(t, {
      sport: "Basketball",
      name: "Hawks",
      stints: { kind: "move", to: { location: "Atlanta", name: "Hawks" } },
    });
    expect(result).toMatchObject({
      teamId: legacy,
      outcome: "deleted",
      stintsMoved: 0,
      playersChanged: 0,
      isComplete: true,
      changed: true,
    });
    expect(await getTeam(t, legacy)).toBeNull();
    expect(await getTeam(t, proper)).toMatchObject({
      location: "Atlanta",
      name: "Hawks",
    });
  });

  test("an omitted location means an EMPTY location, never the split row", async () => {
    const t = convexTest(schema, modules);
    const { proper } = await hawksFixture(t);
    // Deleting `{name: "Hawks"}` must never resolve to `Atlanta / Hawks`:
    // their normalised keys differ, which is the whole reason the legacy row
    // is unreachable in the first place.
    await del(t, {
      sport: "Basketball",
      name: "Hawks",
      stints: { kind: "move", to: { location: "Atlanta", name: "Hawks" } },
    });
    expect(await getTeam(t, proper)).not.toBeNull();
  });

  test("moves every stint regardless of year, merging into the destination", async () => {
    const t = convexTest(schema, modules);
    const { sportId, legacy, proper } = await hawksFixture(t);
    const early = await seedPlayer(t, sportId, "Early", [
      { teamId: legacy, fromYear: 1955, toYear: 1960 },
    ]);
    const merging = await seedPlayer(t, sportId, "Merging", [
      { teamId: legacy, fromYear: 1970, toYear: 1974 },
      { teamId: proper, fromYear: 1970, toYear: 1972 },
    ]);

    const result = await del(t, {
      sport: "Basketball",
      name: "Hawks",
      stints: { kind: "move", to: { location: "Atlanta", name: "Hawks" } },
    });
    expect(result).toMatchObject({
      outcome: "deleted",
      playersChanged: 2,
      stintsMoved: 2,
      stintsDropped: 0,
    });
    // 1955 is far before the destination's era and still moves — a delete
    // takes the whole career, unlike `moveStints`.
    expect((await getPlayer(t, early))?.teamYears).toEqual([
      { teamId: proper, fromYear: 1955, toYear: 1960 },
    ]);
    // Same start year on both sides collapses to one, later end winning.
    expect((await getPlayer(t, merging))?.teamYears).toEqual([
      { teamId: proper, fromYear: 1970, toYear: 1974 },
    ]);
    expect(await getTeam(t, legacy)).toBeNull();
  });

  test("drops the stints when told to, and deletes", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    // The prod shape: a basketball team old cross-sport Wikidata enrichment
    // created under Baseball, holding one stint no baseball row can absorb.
    const aztecs = await seedUnsplitTeam(t, sportId, "San Diego State Aztecs men's basketball");
    const padres = await seedTeam(t, sportId, { location: "San Diego", name: "Padres" }, { from: 1969 });
    const gwynn = await seedPlayer(t, sportId, "Tony Gwynn", [
      { teamId: aztecs, fromYear: 1977 },
      { teamId: padres, fromYear: 1982, toYear: 2001 },
    ]);

    const result = await del(t, {
      sport: "Baseball",
      name: "San Diego State Aztecs men's basketball",
      stints: { kind: "drop" },
    });
    expect(result).toMatchObject({
      outcome: "deleted",
      playersChanged: 1,
      stintsDropped: 1,
      stintsMoved: 0,
    });
    expect((await getPlayer(t, gwynn))?.teamYears).toEqual([
      { teamId: padres, fromYear: 1982, toYear: 2001 },
    ]);
    expect(await getTeam(t, aztecs)).toBeNull();
  });

  test("refuses by default when a player still has a stint, naming them", async () => {
    const t = convexTest(schema, modules);
    const { sportId, legacy } = await hawksFixture(t);
    await seedPlayer(t, sportId, "Bob Pettit", [{ teamId: legacy, fromYear: 1954 }]);
    const before = await snapshot(t);

    await expect(del(t, { sport: "Basketball", name: "Hawks" })).rejects.toThrow(
      /Bob Pettit/,
    );
    expect(await snapshot(t)).toEqual(before);
  });

  test("refuses when a cardChecklist row prints the team, even with a stint policy", async () => {
    const t = convexTest(schema, modules);
    const { legacy } = await hawksFixture(t);
    await seedCard(t, [legacy], "42");
    const before = await snapshot(t);

    await expect(
      del(t, {
        sport: "Basketball",
        name: "Hawks",
        stints: { kind: "drop" },
      }),
    ).rejects.toThrow(/cardChecklist row\(s\) still reference it/);
    expect(await snapshot(t)).toEqual(before);
    expect(await getTeam(t, legacy)).not.toBeNull();
  });

  test("refuses when an entityReviewQueue decision links the team", async () => {
    const t = convexTest(schema, modules);
    const { sportId, legacy } = await hawksFixture(t);
    await seedReviewLinkingTeam(t, sportId, legacy);

    await expect(
      del(t, {
        sport: "Basketball",
        name: "Hawks",
        stints: { kind: "drop" },
      }),
    ).rejects.toThrow(/entityReviewQueue row\(s\) still reference it/);
    expect(await getTeam(t, legacy)).not.toBeNull();
  });

  test("a card or review pointing at ANOTHER team does not block", async () => {
    const t = convexTest(schema, modules);
    const { sportId, legacy, proper } = await hawksFixture(t);
    await seedCard(t, [proper], "42");
    await seedReviewLinkingTeam(t, sportId, proper);

    const result = await del(t, {
      sport: "Basketball",
      name: "Hawks",
      stints: { kind: "drop" },
    });
    expect(result.outcome).toBe("deleted");
  });

  test("refuses when two rows answer to the name and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Basketball");
    const a = await seedUnsplitTeam(t, sportId, "Hawks", { from: 1949, to: 1967 });
    const b = await seedUnsplitTeam(t, sportId, "Hawks", { from: 1968 });
    const before = await snapshot(t);

    await expect(
      del(t, { sport: "Basketball", name: "Hawks", stints: { kind: "drop" } }),
    ).rejects.toThrow(/found 2/);
    expect(await snapshot(t)).toEqual(before);

    // fromYear is the narrowing the refusal asks for.
    const result = await del(t, {
      sport: "Basketball",
      name: "Hawks",
      fromYear: 1949,
      stints: { kind: "drop" },
    });
    expect(result.teamId).toBe(a);
    expect(await getTeam(t, b)).not.toBeNull();
  });

  test("refuses when the move destination is not exactly one row", async () => {
    const t = convexTest(schema, modules);
    const { legacy } = await hawksFixture(t);
    await expect(
      del(t, {
        sport: "Basketball",
        name: "Hawks",
        stints: { kind: "move", to: { location: "Milwaukee", name: "Hawks" } },
      }),
    ).rejects.toThrow(/exactly one destination team/);
    expect(await getTeam(t, legacy)).not.toBeNull();
  });

  test("refuses when the destination resolves to the row being deleted", async () => {
    const t = convexTest(schema, modules);
    await hawksFixture(t);
    await expect(
      del(t, {
        sport: "Basketball",
        name: "Hawks",
        stints: { kind: "move", to: { name: "Hawks" } },
      }),
    ).rejects.toThrow(/same row/);
  });

  test("pages the player walk across batches", async () => {
    const t = convexTest(schema, modules);
    const { sportId, legacy, proper } = await hawksFixture(t);
    const ids: Id<"players">[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await seedPlayer(t, sportId, `Player${i}`, [{ teamId: legacy, fromYear: 1960 + i }]),
      );
    }

    const result = await del(t, {
      sport: "Basketball",
      name: "Hawks",
      stints: { kind: "move", to: { location: "Atlanta", name: "Hawks" } },
      batchSize: 2,
    });
    expect(result).toMatchObject({
      outcome: "deleted",
      playersScanned: 5,
      playersChanged: 5,
      stintsMoved: 5,
      isComplete: true,
    });
    for (const id of ids) {
      expect((await getPlayer(t, id))?.teamYears?.[0]?.teamId).toBe(proper);
    }
  });

  test("a second run reports already_absent instead of throwing", async () => {
    const t = convexTest(schema, modules);
    const { legacy } = await hawksFixture(t);
    await del(t, {
      sport: "Basketball",
      name: "Hawks",
      stints: { kind: "move", to: { location: "Atlanta", name: "Hawks" } },
    });
    expect(await getTeam(t, legacy)).toBeNull();
    const before = await snapshot(t);

    const second = await del(t, {
      sport: "Basketball",
      name: "Hawks",
      stints: { kind: "move", to: { location: "Atlanta", name: "Hawks" } },
    });
    expect(second).toMatchObject({
      teamId: null,
      outcome: "already_absent",
      changed: false,
      stintsMoved: 0,
      playersChanged: 0,
    });
    expect(await snapshot(t)).toEqual(before);
  });

  test("does not cross sports", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t, "Baseball");
    const { legacy } = await hawksFixture(t);
    const result = await del(t, {
      sport: "Baseball",
      name: "Hawks",
      stints: { kind: "drop" },
    });
    expect(result.outcome).toBe("already_absent");
    expect(await getTeam(t, legacy)).not.toBeNull();
  });
});
