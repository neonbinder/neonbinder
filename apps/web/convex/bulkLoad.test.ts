/**
 * NEO-254 — the armed bulk upsert, pinned.
 *
 * ## What this file is defending
 *
 * `convex/bulkLoad.ts` is the widest write path in the codebase: four internal
 * mutations that a laptop script points at a deployment and that insert
 * leagues, franchises, teams and players in bulk. Three properties make that
 * safe, and all three are invisible in a type check:
 *
 *  1. **The arming gate.** A CLI run carries no identity, so
 *     `ALLOW_BULK_LOAD === "true"` plus the `confirm` literal is the whole
 *     defence. Asserted inside every mutation, and asserted here for every
 *     mutation — a gate that is only tested on one of four is a gate somebody
 *     copies without.
 *  2. **Never overwrites.** A row that already carries a birth year, a career
 *     or a Hall of Fame flag keeps exactly what it had. This is the product
 *     invariant applied to our own datasets — an initial input, never a source
 *     of truth — and it is the failure that would be quietest in production:
 *     nothing errors, an operator's hand-entered career is just gone.
 *  3. **Never guesses at an ambiguous name.** Two "Bob Allen"s in one sport
 *     must come back as a QUESTION with candidates, not as an arbitrary
 *     adoption. The whole reason the loader is interactive is this branch.
 *
 * Plus the convergence property the whole design rests on: a second identical
 * run creates nothing.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const CONFIRM = "BULK_LOAD" as const;

/** Arms the deployment for one test. Unstubbed in `afterEach`. */
function arm(): void {
  vi.stubEnv("ALLOW_BULK_LOAD", "true");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T, value = "Baseball"): Promise<Id<"selectorOptions">> {
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

const counts = (t: T) =>
  t.run(async (ctx) => ({
    leagues: (await ctx.db.query("leagues").collect()).length,
    franchises: (await ctx.db.query("franchises").collect()).length,
    teams: (await ctx.db.query("teams").collect()).length,
    players: (await ctx.db.query("players").collect()).length,
  }));

/** One created team, so player stints have somewhere real to point. */
async function seedTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  parts: { location?: string; name: string },
): Promise<Id<"teams">> {
  const full = parts.location ? `${parts.location} ${parts.name}` : parts.name;
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name: parts.name,
      ...(parts.location ? { location: parts.location } : {}),
      nameNormalized: normalizeTeamName(full),
      sportId,
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("the arming gate", () => {
  test.each([
    ["upsertLeagues", (t: T, sport: string) =>
      t.mutation(internal.bulkLoad.upsertLeagues, {
        confirm: CONFIRM,
        sport,
        leagues: [{ name: "Major League Baseball" }],
      })],
    ["upsertFranchises", (t: T, sport: string) =>
      t.mutation(internal.bulkLoad.upsertFranchises, {
        confirm: CONFIRM,
        sport,
        franchises: [{ key: "titans", name: "Titans / Oilers" }],
      })],
    ["upsertTeams", (t: T, sport: string) =>
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport,
        teams: [{ key: "sdp", location: "San Diego", name: "Padres" }],
      })],
    ["upsertPlayers", (t: T, sport: string) =>
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport,
        players: [{ key: "gwynnto01", name: "Tony Gwynn", stints: [] }],
      })],
  ])("%s refuses when ALLOW_BULK_LOAD is unset, and writes nothing", async (_name, call) => {
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(call(t, "Baseball")).rejects.toThrow(/ALLOW_BULK_LOAD/);
    expect(await counts(t)).toEqual({
      leagues: 0,
      franchises: 0,
      teams: 0,
      players: 0,
    });
  });

  test("a near-miss flag value is not armed", async () => {
    // The check is `!== "true"`, so "1" and "TRUE" are NOT armed. Arming is a
    // deliberate act; a truthy-looking value failing open is the worst outcome.
    vi.stubEnv("ALLOW_BULK_LOAD", "1");
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        teams: [{ key: "sdp", location: "San Diego", name: "Padres" }],
      }),
    ).rejects.toThrow(/ALLOW_BULK_LOAD/);
    expect((await counts(t)).teams).toBe(0);
  });

  test("a wrong confirm literal is refused by the validator", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        // Deliberately wrong. The `v.literal("BULK_LOAD")` validator is the
        // first line of the gate and this is what proves it is doing its job;
        // `assertBulkLoadArmed`'s own re-check is the belt behind it.
        confirm: "RESET" as unknown as typeof CONFIRM,
        sport: "Baseball",
        teams: [{ key: "sdp", location: "San Diego", name: "Padres" }],
      }),
    ).rejects.toThrow();
    expect((await counts(t)).teams).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sports are never invented
// ---------------------------------------------------------------------------

describe("sports are looked up, never created", () => {
  test("a missing sport is refused and NAMES the sport", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t, "Baseball");

    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Cricket",
        teams: [{ key: "x", name: "Warriors" }],
      }),
    ).rejects.toThrow(/Cricket/);

    // The refusal must not have minted the sport on the way past.
    const sports = await t.run(async (ctx) =>
      ctx.db.query("selectorOptions").collect(),
    );
    expect(sports).toHaveLength(1);
    expect((await counts(t)).teams).toBe(0);
  });

  test("the sport name matches case-insensitively", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t, "Baseball");

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "baseball",
      teams: [{ key: "sdp", location: "San Diego", name: "Padres" }],
    });
    expect(result.results[0].status).toBe("created");
  });
});

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

describe("upsertLeagues", () => {
  test("creates, then adopts on a re-run, and reports which", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    const first = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [
        {
          name: "Federal League",
          abbreviation: "FL",
          level: "major",
          yearsActive: { from: 1914, to: 1915 },
        },
      ],
    });
    expect(first.results[0].created).toBe(true);

    const second = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Federal League" }],
    });
    expect(second.results[0].created).toBe(false);
    expect(second.results[0].id).toBe(first.results[0].id);
    expect((await counts(t)).leagues).toBe(1);

    const row = await t.run(async (ctx) => ctx.db.get(first.results[0].id));
    expect(row?.yearsActive).toEqual({ from: 1914, to: 1915 });
  });

  test("a span already on the row is never overwritten", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    const created = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Federal League", yearsActive: { from: 1914, to: 1915 } }],
    });
    await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Federal League", yearsActive: { from: 1900, to: 2000 } }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(created.results[0].id));
    expect(row?.yearsActive).toEqual({ from: 1914, to: 1915 });
  });
});

// ---------------------------------------------------------------------------
// Franchises
// ---------------------------------------------------------------------------

describe("upsertFranchises", () => {
  test("creates once and adopts thereafter, keyed on the normalised name", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t, "Football");

    const first = await t.mutation(internal.bulkLoad.upsertFranchises, {
      confirm: CONFIRM,
      sport: "Football",
      franchises: [{ key: "TEN", name: "Titans Oilers" }],
    });
    expect(first.results[0]).toMatchObject({ key: "TEN", created: true });

    // A different key, the same name in a different word order. The normaliser
    // token-sorts, so this is the SAME franchise.
    const second = await t.mutation(internal.bulkLoad.upsertFranchises, {
      confirm: CONFIRM,
      sport: "Football",
      franchises: [{ key: "titans", name: "Oilers Titans" }],
    });
    expect(second.results[0].created).toBe(false);
    expect(second.results[0].id).toBe(first.results[0].id);
    expect((await counts(t)).franchises).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

describe("upsertTeams", () => {
  test("creates with a league by name and a franchise by key", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Football");

    const franchises = await t.mutation(internal.bulkLoad.upsertFranchises, {
      confirm: CONFIRM,
      sport: "Football",
      franchises: [{ key: "TEN", name: "Titans Oilers" }],
    });

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Football",
      teams: [
        {
          key: "hou-oilers",
          location: "Houston",
          name: "Oilers",
          league: "National Football League",
          franchiseKey: "Titans Oilers",
          yearsActive: { from: 1960, to: 1996 },
        },
      ],
    });

    expect(result.results[0].status).toBe("created");
    const team = await t.run(async (ctx) => ctx.db.get(result.results[0].id!));
    expect(team?.name).toBe("Oilers");
    expect(team?.location).toBe("Houston");
    expect(team?.sportId).toBe(sportId);
    expect(team?.franchiseId).toBe(franchises.results[0].id);
    expect(team?.yearsActive).toEqual({ from: 1960, to: 1996 });
    const league = await t.run(async (ctx) => ctx.db.get(team!.leagueId!));
    expect(league?.name).toBe("National Football League");
  });

  test("a franchiseKey that resolves to nothing is reported, not invented", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t, "Football");

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Football",
      teams: [{ key: "hou", location: "Houston", name: "Oilers", franchiseKey: "Nope" }],
    });

    expect(result.results[0]).toMatchObject({
      status: "created",
      franchiseMissing: true,
    });
    // The whole point: a franchise guessed from a team's spelling of it is the
    // linkage this table exists to keep an operator in charge of.
    expect((await counts(t)).franchises).toBe(0);
  });

  test("adopts an existing row by the NEO-236 composed key, and gap-fills only", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    // Split by hand, with a span already on it.
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: normalizeTeamName("San Diego Padres"),
        sportId,
        yearsActive: { from: 1969 },
        lastUpdated: 1_700_000_000_000,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      // The dataset's own spelling: unsplit, and with a different span.
      teams: [{ key: "SDN", name: "San Diego Padres", yearsActive: { from: 1900, to: 1901 } }],
    });

    expect(result.results[0]).toMatchObject({ id: teamId, status: "adopted" });
    expect((await counts(t)).teams).toBe(1);

    const row = await t.run(async (ctx) => ctx.db.get(teamId));
    // Neither the operator's split nor their span is touched.
    expect(row?.name).toBe("Padres");
    expect(row?.location).toBe("San Diego");
    expect(row?.yearsActive).toEqual({ from: 1969 });
  });

  test("two rows sharing the key come back ambiguous, with candidates and no write", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const key = normalizeTeamName("San Diego Padres");
    const a = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: key,
        sportId,
        yearsActive: { from: 1969 },
        lastUpdated: 1,
      }),
    );
    const b = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "San Diego Padres",
        nameNormalized: key,
        sportId,
        lastUpdated: 1,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "SDN", location: "San Diego", name: "Padres" }],
    });

    expect(result.results[0].status).toBe("ambiguous");
    expect(result.results[0].id).toBeNull();
    expect(result.results[0].candidates?.map((c) => c.id).sort()).toEqual(
      [a, b].sort(),
    );
    // Nothing written — the caller has a question to answer first.
    expect((await counts(t)).teams).toBe(2);
  });

  test("a resubmitted decision resolves it — adopt", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const key = normalizeTeamName("San Diego Padres");
    const chosen = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: key,
        sportId,
        lastUpdated: 1,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "San Diego Padres",
        nameNormalized: key,
        sportId,
        lastUpdated: 1,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        {
          key: "SDN",
          location: "San Diego",
          name: "Padres",
          decision: { adopt: chosen },
        },
      ],
    });

    expect(result.results[0]).toMatchObject({ id: chosen, status: "adopted" });
    expect((await counts(t)).teams).toBe(2);
  });

  test("a resubmitted decision resolves it — create", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedTeam(t, sportId, { location: "San Diego", name: "Padres" });

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        {
          key: "SDN",
          location: "San Diego",
          name: "Padres",
          decision: { create: true },
        },
      ],
    });

    expect(result.results[0].status).toBe("created");
    expect((await counts(t)).teams).toBe(2);
  });

  test("adopting a team from another sport is refused", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t, "Baseball");
    const footballId = await seedSport(t, "Football");
    const foreign = await seedTeam(t, footballId, { name: "Titans" });

    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        teams: [{ key: "x", name: "Padres", decision: { adopt: foreign } }],
      }),
    ).rejects.toThrow(/not a team in this sport/);
  });

  test("a chunk over the cap is refused before anything is written", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    const teams = Array.from({ length: 51 }, (_, i) => ({
      key: `t${i}`,
      name: `Team ${i}`,
    }));
    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        teams,
      }),
    ).rejects.toThrow(/limit is 50/);
    expect((await counts(t)).teams).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

describe("upsertPlayers", () => {
  test("creates with stints, sorted and stored", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await seedTeam(t, sportId, { location: "San Diego", name: "Padres" });
    const yankees = await seedTeam(t, sportId, { location: "New York", name: "Yankees" });

    const result = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [
        {
          key: "gwynnto01",
          name: "Tony Gwynn",
          birthYear: 1960,
          isHallOfFame: true,
          // Deliberately out of order — the writer sorts.
          stints: [
            { teamId: yankees, fromYear: 2003, toYear: 2004 },
            { teamId: padres, fromYear: 1982, toYear: 2001 },
          ],
        },
      ],
    });

    expect(result.results[0].status).toBe("created");
    const row = await t.run(async (ctx) => ctx.db.get(result.results[0].id!));
    expect(row?.birthYear).toBe(1960);
    expect(row?.isHallOfFame).toBe(true);
    expect(row?.nameNormalized).toBe(normalizePlayerName("Tony Gwynn"));
    expect(row?.teamYears?.map((s) => s.fromYear)).toEqual([1982, 2003]);
  });

  test("one candidate: adopts when neither side has a birth year", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const existing = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId,
        lastUpdated: 1,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [{ key: "g1", name: "Tony Gwynn", stints: [] }],
    });

    expect(result.results[0]).toMatchObject({ id: existing, status: "adopted" });
    expect((await counts(t)).players).toBe(1);
  });

  test("one candidate: adopts when the birth years are equal", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const existing = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId,
        birthYear: 1960,
        lastUpdated: 1,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [{ key: "g1", name: "Tony Gwynn", birthYear: 1960, stints: [] }],
    });

    expect(result.results[0]).toMatchObject({ id: existing, status: "adopted" });
    expect((await counts(t)).players).toBe(1);
  });

  test("one candidate: a DIFFERENT birth year creates a second person", async () => {
    // Both Tony Gwynns are real. A differing year is positive evidence of two
    // people, and merging a father into a son is the outcome this branch exists
    // to prevent.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const father = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId,
        birthYear: 1960,
        lastUpdated: 1,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [{ key: "g2", name: "Tony Gwynn", birthYear: 1982, stints: [] }],
    });

    expect(result.results[0].status).toBe("created");
    expect(result.results[0].id).not.toBe(father);
    expect((await counts(t)).players).toBe(2);
  });

  test("two candidates: exactly one matching birth year adopts it", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const normalized = normalizePlayerName("Bob Allen");
    const older = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Bob Allen",
        nameNormalized: normalized,
        sportId,
        birthYear: 1867,
        lastUpdated: 1,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Bob Allen",
        nameNormalized: normalized,
        sportId,
        birthYear: 1937,
        lastUpdated: 1,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [{ key: "allenbo01", name: "Bob Allen", birthYear: 1867, stints: [] }],
    });

    expect(result.results[0]).toMatchObject({ id: older, status: "adopted" });
    expect((await counts(t)).players).toBe(2);
  });

  test("two candidates and no decisive birth year: ambiguous, with candidates and no write", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await seedTeam(t, sportId, { location: "San Diego", name: "Padres" });
    const normalized = normalizePlayerName("Bob Allen");
    for (const birthYear of [1867, 1937]) {
      await t.run(async (ctx) =>
        ctx.db.insert("players", {
          name: "Bob Allen",
          nameNormalized: normalized,
          sportId,
          birthYear,
          teamYears: [{ teamId: padres, fromYear: 1890, toYear: 1894 }],
          lastUpdated: 1,
        }),
      );
    }

    const result = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      // No birth year at all: nothing can separate them.
      players: [{ key: "allenbo01", name: "Bob Allen", stints: [] }],
    });

    expect(result.results[0].status).toBe("ambiguous");
    expect(result.results[0].id).toBeNull();
    expect(result.results[0].candidates).toHaveLength(2);
    // The candidate list is what the operator reads to choose, so it has to
    // carry more than an id.
    expect(result.results[0].candidates?.[0].careerSummary).toContain("San Diego Padres");
    expect((await counts(t)).players).toBe(2);
  });

  test("a resubmitted decision resolves an ambiguous player — adopt and create", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const normalized = normalizePlayerName("Bob Allen");
    const chosen = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Bob Allen",
        nameNormalized: normalized,
        sportId,
        birthYear: 1867,
        lastUpdated: 1,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Bob Allen",
        nameNormalized: normalized,
        sportId,
        birthYear: 1937,
        lastUpdated: 1,
      }),
    );

    const adopted = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [
        { key: "a", name: "Bob Allen", stints: [], decision: { adopt: chosen } },
      ],
    });
    expect(adopted.results[0]).toMatchObject({ id: chosen, status: "adopted" });
    expect((await counts(t)).players).toBe(2);

    const created = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [
        { key: "b", name: "Bob Allen", stints: [], decision: { create: true } },
      ],
    });
    expect(created.results[0].status).toBe("created");
    expect((await counts(t)).players).toBe(3);
  });

  test("adoption never overwrites birthYear, isHallOfFame or teamYears", async () => {
    // The quietest possible failure: nothing errors, an operator's career data
    // is simply replaced by a dataset's.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await seedTeam(t, sportId, { location: "San Diego", name: "Padres" });
    const yankees = await seedTeam(t, sportId, { location: "New York", name: "Yankees" });
    const existing = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId,
        birthYear: 1960,
        isHallOfFame: false,
        teamYears: [{ teamId: padres, fromYear: 1982, toYear: 2001 }],
        lastUpdated: 1,
      }),
    );

    await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [
        {
          key: "g1",
          name: "Tony Gwynn",
          birthYear: 1960,
          isHallOfFame: true,
          stints: [{ teamId: yankees, fromYear: 1900, toYear: 1901 }],
        },
      ],
    });

    const row = await t.run(async (ctx) => ctx.db.get(existing));
    expect(row?.birthYear).toBe(1960);
    expect(row?.isHallOfFame).toBe(false);
    expect(row?.teamYears).toEqual([
      { teamId: padres, fromYear: 1982, toYear: 2001 },
    ]);
  });

  test("adoption DOES fill a gap the row does not have", async () => {
    // The other half of the rule: gap-filling is the whole point of adopting.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await seedTeam(t, sportId, { location: "San Diego", name: "Padres" });
    const existing = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId,
        lastUpdated: 1,
      }),
    );

    await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [
        {
          key: "g1",
          name: "Tony Gwynn",
          birthYear: 1960,
          isHallOfFame: true,
          stints: [{ teamId: padres, fromYear: 1982, toYear: 2001 }],
        },
      ],
    });

    const row = await t.run(async (ctx) => ctx.db.get(existing));
    expect(row?.birthYear).toBe(1960);
    expect(row?.isHallOfFame).toBe(true);
    expect(row?.teamYears).toHaveLength(1);
  });

  test("a stint on a team in another sport is refused", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t, "Baseball");
    const footballId = await seedSport(t, "Football");
    const titans = await seedTeam(t, footballId, {
      location: "Tennessee",
      name: "Titans",
    });

    await expect(
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport: "Baseball",
        players: [
          {
            key: "g1",
            name: "Tony Gwynn",
            stints: [{ teamId: titans, fromYear: 1982 }],
          },
        ],
      }),
    ).rejects.toThrow(/another sport/);
    expect((await counts(t)).players).toBe(0);
  });

  test("65 stints is refused with a message naming the row and the cap", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await seedTeam(t, sportId, { location: "San Diego", name: "Padres" });

    await expect(
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport: "Baseball",
        players: [
          {
            key: "g1",
            name: "Tony Gwynn",
            stints: Array.from({ length: 65 }, (_, i) => ({
              teamId: padres,
              fromYear: 1900 + i,
            })),
          },
        ],
      }),
    ).rejects.toThrow(/"g1" has 65 stints; the limit is 64/);
    expect((await counts(t)).players).toBe(0);
  });

  test("a repeated (team, fromYear) stint is refused", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await seedTeam(t, sportId, { location: "San Diego", name: "Padres" });

    await expect(
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport: "Baseball",
        players: [
          {
            key: "g1",
            name: "Tony Gwynn",
            stints: [
              { teamId: padres, fromYear: 1982, toYear: 1990 },
              { teamId: padres, fromYear: 1982, toYear: 2001 },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/two stints/);
  });
});

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

describe("a second identical run creates nothing", () => {
  test("leagues, franchises, teams and players all converge", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t, "Football");

    const run = async () => {
      await t.mutation(internal.bulkLoad.upsertLeagues, {
        confirm: CONFIRM,
        sport: "Football",
        leagues: [{ name: "National Football League", abbreviation: "NFL" }],
      });
      await t.mutation(internal.bulkLoad.upsertFranchises, {
        confirm: CONFIRM,
        sport: "Football",
        franchises: [{ key: "TEN", name: "Titans Oilers" }],
      });
      const teams = await t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Football",
        teams: [
          {
            key: "ten",
            location: "Tennessee",
            name: "Titans",
            league: "National Football League",
            franchiseKey: "Titans Oilers",
            yearsActive: { from: 1999 },
          },
        ],
      });
      await t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport: "Football",
        players: [
          {
            key: "mcnaist01",
            name: "Steve McNair",
            birthYear: 1973,
            stints: [{ teamId: teams.results[0].id!, fromYear: 1995, toYear: 2005 }],
          },
        ],
      });
    };

    await run();
    const after = await counts(t);
    await run();

    expect(await counts(t)).toEqual(after);
    expect(after).toEqual({ leagues: 1, franchises: 1, teams: 1, players: 1 });
  });
});
