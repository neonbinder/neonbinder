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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
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

/**
 * Wikidata enrichment jobs queued so far, read off `_scheduled_functions`.
 *
 * The same shape `enrichmentCreationOnly.test.ts` uses. Asserted rather than
 * commented because the file header's "nothing here schedules enrichment"
 * claim was WRONG when it was first written — `findOrCreateLeague`'s insert
 * branch queued a league lookup, and `resolveDefaultLeagueId` reached it on
 * the fallback path every bulk-created team takes. A prose claim about a
 * helper three modules away is exactly the thing that needs a test under it.
 */
async function enrichmentJobs(t: T): Promise<number> {
  const rows = await t.run(async (ctx) =>
    (
      ctx as unknown as {
        db: {
          system: {
            query: (n: string) => {
              collect: () => Promise<Array<{ name: string }>>;
            };
          };
        };
      }
    ).db.system
      .query("_scheduled_functions")
      .collect(),
  );
  return rows.filter((r) => r.name.includes("enqueueEnrichment")).length;
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
      // The dataset's own spelling: unsplit, and with a span that OVERLAPS the
      // stored one — so it is the same era, and adoption is the right answer.
      // A non-overlapping span is a different franchise; see the era block.
      teams: [{ key: "SDN", name: "San Diego Padres", yearsActive: { from: 1970, to: 1990 } }],
    });

    expect(result.results[0]).toMatchObject({ id: teamId, status: "adopted" });
    expect((await counts(t)).teams).toBe(1);

    const row = await t.run(async (ctx) => ctx.db.get(teamId));
    // Neither the operator's split nor their span is touched.
    expect(row?.name).toBe("Padres");
    expect(row?.location).toBe("San Diego");
    expect(row?.yearsActive).toEqual({ from: 1969 });
  });

  test("a same-name row whose era does NOT overlap is a second franchise", async () => {
    // The Winnipeg Jets case, which is the whole reason team identity gained
    // the era: 1972-1996 became the Coyotes and then Utah, and 2011- is the old
    // Atlanta Thrashers under a revived name. Matching on the name alone filed
    // every 1970s roster under the 2011 franchise.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Hockey");
    const oldJets = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: normalizeTeamName("Winnipeg Jets"),
        sportId,
        yearsActive: { from: 1972, to: 1996 },
        lastUpdated: 1,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Hockey",
      teams: [
        {
          key: "WPG",
          location: "Winnipeg",
          name: "Jets",
          yearsActive: { from: 2011 },
        },
      ],
    });

    expect(result.results[0].status).toBe("created");
    expect(result.results[0].id).not.toBe(oldJets);
    expect((await counts(t)).teams).toBe(2);

    // …and the older row is left exactly as it was.
    const older = await t.run(async (ctx) => ctx.db.get(oldJets));
    expect(older?.yearsActive).toEqual({ from: 1972, to: 1996 });
  });

  test("an era that DOES overlap is the same franchise, and adopts", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Hockey");
    const oldJets = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: normalizeTeamName("Winnipeg Jets"),
        sportId,
        yearsActive: { from: 1972, to: 1996 },
        lastUpdated: 1,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Hockey",
      teams: [
        {
          key: "WPG",
          location: "Winnipeg",
          name: "Jets",
          yearsActive: { from: 1979, to: 1996 },
        },
      ],
    });

    expect(result.results[0]).toMatchObject({ id: oldJets, status: "adopted" });
    expect((await counts(t)).teams).toBe(1);
    // Never overwritten: the row keeps the span it had, not the dataset's.
    const row = await t.run(async (ctx) => ctx.db.get(oldJets));
    expect(row?.yearsActive).toEqual({ from: 1972, to: 1996 });
  });

  test("an UNDATED row on file adopts rather than forking beside it", async () => {
    // `erasOverlap` counts an undated side as unknown, and unknown must not
    // become "different team" — that would mint a duplicate out of a gap. The
    // adoption gap-fills the years, which is the conservative direction.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Hockey");
    const undated = await seedTeam(t, sportId, {
      location: "Winnipeg",
      name: "Jets",
    });

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Hockey",
      teams: [
        {
          key: "WPG",
          location: "Winnipeg",
          name: "Jets",
          yearsActive: { from: 2011 },
        },
      ],
    });

    expect(result.results[0]).toMatchObject({ id: undated, status: "adopted" });
    expect((await counts(t)).teams).toBe(1);
    const row = await t.run(async (ctx) => ctx.db.get(undated));
    expect(row?.yearsActive).toEqual({ from: 2011 });
  });

  test("two overlapping same-name rows are ambiguous, with their years", async () => {
    // The loader does not rule between two eras that both fit. The candidate
    // list carries `yearsActive`, because the years are the only thing that
    // tells the operator which is which.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Hockey");
    for (const yearsActive of [{ from: 1972, to: 1996 }, { from: 1990 }]) {
      await t.run(async (ctx) =>
        ctx.db.insert("teams", {
          name: "Jets",
          location: "Winnipeg",
          nameNormalized: normalizeTeamName("Winnipeg Jets"),
          sportId,
          yearsActive,
          lastUpdated: 1,
        }),
      );
    }

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Hockey",
      teams: [
        {
          key: "WPG",
          location: "Winnipeg",
          name: "Jets",
          yearsActive: { from: 1993, to: 1995 },
        },
      ],
    });

    expect(result.results[0].status).toBe("ambiguous");
    expect(result.results[0].id).toBeNull();
    expect(
      result.results[0].candidates?.map((c) => c.yearsActive),
    ).toEqual([{ from: 1972, to: 1996 }, { from: 1990 }]);
    expect((await counts(t)).teams).toBe(2);
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

  test("two dated candidates, neither matching: a third person, created not asked about", async () => {
    // The first real baseball load hit this 138 times in 24,011 rows. Every
    // rival is dated and none of them is this year, so under the identity rule
    // none of them is this man — that is an answer, not a question, and making
    // an operator retype it 138 times is the defect.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const normalized = normalizePlayerName("Bob Allen");
    for (const birthYear of [1867, 1937]) {
      await t.run(async (ctx) =>
        ctx.db.insert("players", {
          name: "Bob Allen",
          nameNormalized: normalized,
          sportId,
          birthYear,
          lastUpdated: 1,
        }),
      );
    }

    const result = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [{ key: "allenbo03", name: "Bob Allen", birthYear: 1990, stints: [] }],
    });

    expect(result.results[0].status).toBe("created");
    expect(result.results[0].candidates).toBeUndefined();
    expect((await counts(t)).players).toBe(3);
  });

  test("…and a re-run adopts the row that fork created", async () => {
    // The fork converges because the row it inserts carries the birth year, so
    // the next run finds it as the exactly-one match. Without that, the loader
    // would mint a fourth Bob Allen every time it ran.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const normalized = normalizePlayerName("Bob Allen");
    for (const birthYear of [1867, 1937]) {
      await t.run(async (ctx) =>
        ctx.db.insert("players", {
          name: "Bob Allen",
          nameNormalized: normalized,
          sportId,
          birthYear,
          lastUpdated: 1,
        }),
      );
    }

    const row = { key: "allenbo03", name: "Bob Allen", birthYear: 1990, stints: [] };
    const first = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [row],
    });
    const second = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [row],
    });

    expect(second.results[0]).toMatchObject({
      id: first.results[0].id,
      status: "adopted",
    });
    expect((await counts(t)).players).toBe(3);
  });

  test("one UNDATED rival keeps it a question, however many others are dated", async () => {
    // The undated row could be the very man being loaded, and ruling him out
    // on a field nobody ever filled in is a guess. `adoptOrForkOnCreate`
    // refuses on the same condition, in the same words.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const normalized = normalizePlayerName("Bob Allen");
    await t.run(async (ctx) =>
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
        lastUpdated: 1,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [{ key: "allenbo03", name: "Bob Allen", birthYear: 1990, stints: [] }],
    });

    expect(result.results[0].status).toBe("ambiguous");
    expect(result.results[0].id).toBeNull();
    expect((await counts(t)).players).toBe(2);
  });

  test("no INCOMING birth year keeps it a question even when every rival is dated", async () => {
    // Nothing to reason from. Forking here would mint a second Bob Allen out
    // of a gap in the dataset rather than out of evidence.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const normalized = normalizePlayerName("Bob Allen");
    for (const birthYear of [1867, 1937]) {
      await t.run(async (ctx) =>
        ctx.db.insert("players", {
          name: "Bob Allen",
          nameNormalized: normalized,
          sportId,
          birthYear,
          lastUpdated: 1,
        }),
      );
    }

    const result = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [{ key: "allenbo03", name: "Bob Allen", stints: [] }],
    });

    expect(result.results[0].status).toBe("ambiguous");
    expect((await counts(t)).players).toBe(2);
  });

  test("several rivals sharing the incoming birth year stay a question", async () => {
    // `candidateForBirthYear` adopts only an EXACTLY-one match; two rows with
    // the same name and the same year mean the tiebreaker did not tie-break,
    // and forking would add a third indistinguishable row.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const normalized = normalizePlayerName("Bob Allen");
    for (let i = 0; i < 2; i += 1) {
      await t.run(async (ctx) =>
        ctx.db.insert("players", {
          name: "Bob Allen",
          nameNormalized: normalized,
          sportId,
          birthYear: 1867,
          lastUpdated: 1,
        }),
      );
    }

    const result = await t.mutation(internal.bulkLoad.upsertPlayers, {
      confirm: CONFIRM,
      sport: "Baseball",
      players: [{ key: "allenbo03", name: "Bob Allen", birthYear: 1867, stints: [] }],
    });

    expect(result.results[0].status).toBe("ambiguous");
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
// Nothing queues background work
// ---------------------------------------------------------------------------

describe("no path in this file schedules Wikidata enrichment", () => {
  test("neither a league it creates nor a team's default-league fallback queues one", async () => {
    arm();
    const t = convexTest(schema, modules);
    // A sport whose config names a league, so the team below takes the
    // `resolveDefaultLeagueId` fallback — the path that was queueing work.
    await seedSport(t, "Baseball");

    await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Federal League" }],
    });
    await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        // One naming its league, one falling back to the sport default.
        { key: "sdp", location: "San Diego", name: "Padres", league: "Federal League" },
        { key: "nyy", location: "New York", name: "Yankees" },
      ],
    });

    // Not vacuous on either half. The fallback really did mint a league (the
    // sport's configured one, beside the Federal League above), and the
    // detector really does see a job when one is queued — proved by the
    // positive control below.
    expect((await counts(t)).leagues).toBeGreaterThan(1);
    expect(await enrichmentJobs(t)).toBe(0);
  });

  test("positive control: the interactive path DOES queue one", async () => {
    // Without this the assertion above would pass just as happily if
    // `enrichmentJobs` had stopped matching anything at all.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");

    await t
      .withIdentity({ subject: "admin", role: "admin" })
      .mutation(api.teams.findOrCreate, { name: "Padres", location: "San Diego", sportId });

    expect(await enrichmentJobs(t)).toBeGreaterThan(0);
  });

  test("the whole chunk resolves one league name once", async () => {
    // `findLeagueByName`'s alias leg is a `by_sport_id` collect — an array
    // member cannot be indexed — so resolving per row would pay that scan once
    // per team. The observable half of the cache is that fifty teams in one
    // league still produce exactly one league row.
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t, "Football");

    await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Football",
      teams: Array.from({ length: 5 }, (_, i) => ({
        key: `t${i}`,
        name: `Team ${i}`,
        league: "National Football League",
      })),
    });

    expect((await counts(t)).leagues).toBe(1);
  });

  test("the league cache is keyed per chunk, not rebuilt per row", () => {
    // A source pin: the behaviour above passes either way, and the thing worth
    // protecting is the read count, which a convex-test assertion cannot see.
    const src = readFileSync(join(__dirname, "bulkLoad.ts"), "utf8");
    expect(src).toContain("const leagueByName = new Map<string, Id<\"leagues\"> | null>();");
    expect(src).toContain("DEFAULT_LEAGUE_CACHE_KEY");
  });
});

// ---------------------------------------------------------------------------
// A decision may pick between rows — never re-point at a different one
// ---------------------------------------------------------------------------

describe("decision.adopt is checked against the natural key", () => {
  test("a team in this sport under a DIFFERENT name is refused", async () => {
    // The failure this closes is silent: a stale id in the answers file writes
    // this dataset row's league, franchise and years onto an unrelated team.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const yankees = await seedTeam(t, sportId, {
      location: "New York",
      name: "Yankees",
    });

    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        teams: [
          {
            key: "SDN",
            location: "San Diego",
            name: "Padres",
            decision: { adopt: yankees },
          },
        ],
      }),
    ).rejects.toThrow(/share the name being loaded/);

    // Refused, not half-applied.
    const row = await t.run(async (ctx) => ctx.db.get(yankees));
    expect(row?.leagueId).toBeUndefined();
    expect((await counts(t)).teams).toBe(1);
  });

  test("a player in this sport under a DIFFERENT name is refused", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const other = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Babe Ruth",
        nameNormalized: normalizePlayerName("Babe Ruth"),
        sportId,
        lastUpdated: 1,
      }),
    );

    await expect(
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport: "Baseball",
        players: [
          {
            key: "g1",
            name: "Tony Gwynn",
            birthYear: 1960,
            stints: [],
            decision: { adopt: other },
          },
        ],
      }),
    ).rejects.toThrow(/share the name being loaded/);

    const row = await t.run(async (ctx) => ctx.db.get(other));
    expect(row?.birthYear).toBeUndefined();
    expect((await counts(t)).players).toBe(1);
  });

  test("a player from another sport is refused", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t, "Baseball");
    const footballId = await seedSport(t, "Football");
    const foreign = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Tony Gwynn",
        nameNormalized: normalizePlayerName("Tony Gwynn"),
        sportId: footballId,
        lastUpdated: 1,
      }),
    );

    await expect(
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport: "Baseball",
        players: [
          { key: "g1", name: "Tony Gwynn", stints: [], decision: { adopt: foreign } },
        ],
      }),
    ).rejects.toThrow(/not a player in this sport/);
  });

  test("`create` is documented as the one decision a replay must NOT repeat", () => {
    // There is no server-side fix — the row `create` inserts shares the key it
    // was told to ignore, so a replay inserts a second one. The contract is
    // that the caller records the id and replays `{ adopt: id }`, and the only
    // place that can live is the docs the loader is written against.
    const src = readFileSync(join(__dirname, "bulkLoad.ts"), "utf8");
    expect(src).toContain("is NOT idempotent, and cannot be made so");
    expect(src).toContain("replay that row as `{ adopt: id }`");
  });
});

// ---------------------------------------------------------------------------
// Input the loader can get wrong
// ---------------------------------------------------------------------------

describe("refusals a malformed dataset row earns", () => {
  test("a stint on a team id that no longer exists", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await seedTeam(t, sportId, { name: "Padres" });
    await t.run(async (ctx) => ctx.db.delete(teamId));

    await expect(
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport: "Baseball",
        players: [
          { key: "g1", name: "Tony Gwynn", stints: [{ teamId, fromYear: 1982 }] },
        ],
      }),
    ).rejects.toThrow(/does not exist/);
    expect((await counts(t)).players).toBe(0);
  });

  test("a stint that ends before it starts", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await seedTeam(t, sportId, { name: "Padres" });

    await expect(
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport: "Baseball",
        players: [
          {
            key: "g1",
            name: "Tony Gwynn",
            stints: [{ teamId: padres, fromYear: 2001, toYear: 1982 }],
          },
        ],
      }),
    ).rejects.toThrow(/ends before it starts/);
  });

  test.each([
    ["too early", 1799],
    ["in the future", new Date().getFullYear() + 2],
    ["not a whole year", 1960.5],
  ])("a birth year %s", async (_label, birthYear) => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport: "Baseball",
        players: [{ key: "g1", name: "Tony Gwynn", birthYear, stints: [] }],
      }),
    ).rejects.toThrow(/expected a whole year/);
    expect((await counts(t)).players).toBe(0);
  });

  test("a player chunk over the cap, before anything is written", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: CONFIRM,
        sport: "Baseball",
        players: Array.from({ length: 101 }, (_, i) => ({
          key: `p${i}`,
          name: `Player ${i}`,
          stints: [],
        })),
      }),
    ).rejects.toThrow(/limit is 100/);
    expect((await counts(t)).players).toBe(0);
  });

  test.each([
    ["empty", ""],
    ["whitespace only", "   "],
  ])("a %s row key", async (_label, key) => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        teams: [{ key, name: "Padres" }],
      }),
    ).rejects.toThrow(/key cannot be empty/);
  });

  test("an over-long row key", async () => {
    // Bounded because it is echoed back into every refusal message this file
    // can throw.
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        teams: [{ key: "k".repeat(121), name: "Padres" }],
      }),
    ).rejects.toThrow(/the limit is 120/);
  });

  test("a franchiseId from another sport is reported, not attached", async () => {
    // The `franchiseKey` twin of this is covered above; the direct-id path has
    // its own check, because the validator proves the id is a franchise and not
    // that it is a franchise in THIS sport.
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t, "Baseball");
    const footballId = await seedSport(t, "Football");
    const foreign = await t.run(async (ctx) =>
      ctx.db.insert("franchises", {
        name: "Titans Oilers",
        nameNormalized: normalizeTeamName("Titans Oilers"),
        sportId: footballId,
        lastUpdated: 1,
      }),
    );

    const result = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "sdp", name: "Padres", franchiseId: foreign }],
    });

    expect(result.results[0]).toMatchObject({
      status: "created",
      franchiseMissing: true,
    });
    const team = await t.run(async (ctx) => ctx.db.get(result.results[0].id!));
    expect(team?.franchiseId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Never overwrites — the cases the first pass missed
// ---------------------------------------------------------------------------

describe("upsertLeagues fills gaps and only gaps", () => {
  test("an abbreviation and level absent on the row are filled in", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    const first = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Federal League" }],
    });
    await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Federal League", abbreviation: "FL", level: "major" }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(first.results[0].id));
    expect(row?.abbreviation).toBe("FL");
    expect(row?.level).toBe("major");
  });

  test("an abbreviation and level ALREADY on the row are never replaced", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    const first = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Federal League", abbreviation: "FL", level: "major" }],
    });
    await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Federal League", abbreviation: "XX", level: "other" }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(first.results[0].id));
    expect(row?.abbreviation).toBe("FL");
    expect(row?.level).toBe("major");
  });

  test("aliases are written at creation and never merged afterwards", async () => {
    // Deliberate, and inherited from `findOrCreateLeague`: widening what an
    // existing league answers to is an operator decision made on League
    // Management, not something a dataset gets to do on its own.
    arm();
    const t = convexTest(schema, modules);
    await seedSport(t);

    const first = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Federal League", aliases: ["FL"] }],
    });
    await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Federal League", aliases: ["Feds", "Federals"] }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(first.results[0].id));
    expect(row?.aliases).toEqual(["FL"]);
  });
});

describe("upsertTeams adoption leaves the operator's row alone", () => {
  test("a stored SPLIT row is not rewritten by an unsplit dataset name", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await seedTeam(t, sportId, {
      location: "San Diego",
      name: "Padres",
    });

    await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "SDN", name: "San Diego Padres" }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(row?.name).toBe("Padres");
    expect(row?.location).toBe("San Diego");
  });

  test("a stored UNSPLIT row is not rewritten by a split dataset name", async () => {
    // The other direction, and the one that matters more: the dataset knows
    // the split and the row does not, and it is still not the dataset's call.
    // Splitting a row is `teams.saveTeamFields` with a human in front of it.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await seedTeam(t, sportId, { name: "San Diego Padres" });

    await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "SDN", location: "San Diego", name: "Padres" }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(row?.name).toBe("San Diego Padres");
    expect(row?.location).toBeUndefined();
    expect((await counts(t)).teams).toBe(1);
  });

  test("a row carrying only the legacy free-text league gets a real one, and the string goes", async () => {
    // `teams.league` is the deprecated predecessor of `leagueId`. Adoption
    // fills the gap, and clears the string as its replacement lands — the same
    // move `saveTeamFields` and `convertLegacyLeagueInternal` make, so the row
    // never carries two answers to one question.
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: normalizeTeamName("San Diego Padres"),
        sportId,
        league: "Major League Baseball",
        lastUpdated: 1,
      }),
    );

    await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        {
          key: "SDN",
          location: "San Diego",
          name: "Padres",
          league: "Major League Baseball",
        },
      ],
    });

    const row = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(row?.leagueId).toBeDefined();
    expect(row?.league).toBeUndefined();
    const league = await t.run(async (ctx) => ctx.db.get(row!.leagueId!));
    expect(league?.name).toBe("Major League Baseball");
  });

  test("a leagueId ALREADY on the row is never replaced", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "Pacific Coast League",
        nameNormalized: "pacific coast league",
        sportId,
        lastUpdated: 1,
      }),
    );
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: normalizeTeamName("San Diego Padres"),
        sportId,
        leagueId,
        lastUpdated: 1,
      }),
    );

    await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        {
          key: "SDN",
          location: "San Diego",
          name: "Padres",
          league: "Major League Baseball",
        },
      ],
    });

    const row = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(row?.leagueId).toBe(leagueId);
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
