/**
 * NEO-236 — the League the operator chose on the New Team dialog, and why the
 * sport default is no longer allowed over it.
 *
 * The defect: a college or club side created off a player's career list was
 * filed under the sport's top flight because nothing else was on offer, so
 * Travis Bazzana's "Sydney Blue Sox" landed in Major League Baseball. Jason,
 * 2026-09-05: "How does this dialog know which League the new team is in?"
 *
 * `teams.findOrCreate` now takes the answer, resolved through
 * `leagues.resolveOperatorLeagueId`, and the whole behaviour turns on THREE
 * states rather than two:
 *
 *   - an `Id<"leagues">` — that league, validated against this team's sport;
 *   - `null`             — "no league", said deliberately;
 *   - absent             — never asked, and only then does
 *                          `resolveDefaultLeagueId` apply.
 *
 * The `null` case is why the argument is a nullable union rather than merely
 * optional: without it, "no league" and "not asked" are the same value and the
 * sport default silently reasserts itself.
 *
 * `leagueName` is the other half — a league we hold no row for yet, accepted
 * off a "Create league X" button whose X is typically a Wikidata P118 label.
 * It goes through `findOrCreateLeague`, so it dedupes by name-or-alias like
 * every other league writer.
 *
 * The mutation is admin-gated (NEO-208) and its insert branch SCHEDULES a
 * pooled Wikidata enrichment, so these tests never drain the scheduler —
 * `wikidataPool.enqueueAction` reaches a component convex-test does not mount.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
// NEO-247: `teams.findOrCreate` schedules a `wikidataPool.enqueueEnrichment`
// on its INSERT branch only, so every test below that actually creates a team
// has to settle it before the test returns — see `drain-scheduled.ts` for the
// teardown race this prevents. The find-only and refusal tests take no drain,
// because the early `return existing._id` never reaches the scheduler.
import { drainScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_team_league_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_team_league_001",
  role: "admin",
};

/** A sport WITH a configured league, so the default has something to win with. */
async function seedBaseball(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: {
        skuCode: "BB",
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

async function seedBasketball(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Basketball",
      sportConfig: {
        skuCode: "BK",
        league: "NBA",
        espn: { path: "basketball/nba", leagueName: "National Basketball Association" },
      },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function seedLeague(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
  aliases?: string[],
): Promise<Id<"leagues">> {
  return t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name,
      nameNormalized: name.toLowerCase(),
      sportId,
      ...(aliases ? { aliases } : {}),
      lastUpdated: Date.now(),
    }),
  );
}

async function leagueOf(
  t: ReturnType<typeof convexTest>,
  teamId: Id<"teams">,
): Promise<{ id: Id<"leagues"> | undefined; name: string | undefined }> {
  return t.run(async (ctx) => {
    const team = await ctx.db.get(teamId);
    const leagueId = team?.leagueId;
    if (!leagueId) return { id: undefined, name: undefined };
    return { id: leagueId, name: (await ctx.db.get(leagueId))?.name };
  });
}

async function allLeagues(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.query("leagues").collect());
}

describe("teams.findOrCreate: the operator's League beats the sport default", () => {
  test("an operator-picked leagueId is what the team is filed under, not MLB", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedBaseball(t);
    const ablId = await seedLeague(t, sportId, "Australian Baseball League");

    const teamId = await asAdmin.mutation(api.teams.findOrCreate, {
      location: "Sydney",
      name: "Blue Sox",
      sportId,
      leagueId: ablId,
    });
    await drainScheduled(t);

    expect((await leagueOf(t, teamId)).id).toBe(ablId);
    // `resolveDefaultLeagueId` was never consulted, so it never minted MLB.
    expect((await allLeagues(t)).map((row) => row.name)).toEqual([
      "Australian Baseball League",
    ]);
  });

  test("leagueId: null means NO league, even though the sport has a default", async () => {
    // The state the nullable union exists for. "No league" writes nothing,
    // which is byte-identical to "not answered" unless the caller keeps them
    // apart — and here `resolveOperatorLeagueId` returns null rather than
    // undefined so that `findOrCreate` can.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedBaseball(t);

    const teamId = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Orix Buffaloes",
      sportId,
      leagueId: null,
    });
    await drainScheduled(t);

    expect(await leagueOf(t, teamId)).toEqual({ id: undefined, name: undefined });
    expect(await allLeagues(t)).toEqual([]);
  });

  test("a leagueName we hold no row for creates the league ONCE and reuses it the second time", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedBaseball(t);

    const beavers = await asAdmin.mutation(api.teams.findOrCreate, {
      location: "Oregon State",
      name: "Beavers",
      sportId,
      leagueName: "NCAA Division I baseball",
    });
    const ducks = await asAdmin.mutation(api.teams.findOrCreate, {
      location: "Oregon",
      name: "Ducks",
      sportId,
      leagueName: "NCAA Division I baseball",
    });
    await drainScheduled(t);

    const first = await leagueOf(t, beavers);
    const second = await leagueOf(t, ducks);
    expect(first.name).toBe("NCAA Division I baseball");
    // One league row, shared — `findOrCreateLeague` dedupes by name-or-alias
    // for every writer, this one included.
    expect(second.id).toBe(first.id);
    expect(await allLeagues(t)).toHaveLength(1);
  });

  test("a leagueName that answers to an existing league dedupes onto it rather than creating a twin", async () => {
    // NEO-240's name-OR-ALIAS key. "ABL" is the same league as the Australian
    // Baseball League, and a New Team dialog offering the abbreviation must
    // not split the row.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedBaseball(t);
    const ablId = await seedLeague(t, sportId, "Australian Baseball League", ["ABL"]);

    const teamId = await asAdmin.mutation(api.teams.findOrCreate, {
      location: "Sydney",
      name: "Blue Sox",
      sportId,
      leagueName: "ABL",
    });
    await drainScheduled(t);

    expect((await leagueOf(t, teamId)).id).toBe(ablId);
    expect(await allLeagues(t)).toHaveLength(1);
  });

  test("leagueId wins over leagueName when both arrive — an id is the more specific answer", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedBaseball(t);
    const ablId = await seedLeague(t, sportId, "Australian Baseball League");

    const teamId = await asAdmin.mutation(api.teams.findOrCreate, {
      location: "Sydney",
      name: "Blue Sox",
      sportId,
      leagueId: ablId,
      leagueName: "Some Other League",
    });
    await drainScheduled(t);

    expect((await leagueOf(t, teamId)).id).toBe(ablId);
    // The losing name was never resolved, so it never became a row.
    expect(await allLeagues(t)).toHaveLength(1);
  });

  test("a cross-sport leagueId is REFUSED, and no team is created", async () => {
    // The validator proves the id is in `leagues`, not that it belongs to this
    // team's sport. A cross-sport league on a team is a row no per-sport query
    // can explain, so it is refused rather than ignored — an operator who
    // picked a league and got a team without one would have no way to tell.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const baseballId = await seedBaseball(t);
    const basketballId = await seedBasketball(t);
    const nbaId = await seedLeague(t, basketballId, "National Basketball Association");

    await expect(
      asAdmin.mutation(api.teams.findOrCreate, {
        location: "Sydney",
        name: "Blue Sox",
        sportId: baseballId,
        leagueId: nbaId,
      }),
    ).rejects.toThrow(/another sport/);

    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toEqual([]);
  });

  test("a leagueId that no longer exists is refused rather than dropped", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedBaseball(t);
    const ghostId = await seedLeague(t, sportId, "Deleted League");
    await t.run(async (ctx) => ctx.db.delete(ghostId));

    await expect(
      asAdmin.mutation(api.teams.findOrCreate, {
        name: "Blue Sox",
        sportId,
        leagueId: ghostId,
      }),
    ).rejects.toThrow(/no longer exists/);

    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toEqual([]);
  });
});

describe("teams.findOrCreate: the pre-NEO-236 behaviour with no League answer is unchanged", () => {
  test("neither leagueId nor leagueName still files the team under the sport's default", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedBaseball(t);

    const teamId = await asAdmin.mutation(api.teams.findOrCreate, {
      location: "San Diego",
      name: "Padres",
      sportId,
    });
    await drainScheduled(t);

    expect((await leagueOf(t, teamId)).name).toBe("Major League Baseball");
  });

  test("a sport with no configured league still yields a team with no league", async () => {
    // Legitimate, not an error — assignable later in Team Management.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Pickleball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    const teamId = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Austin Pickles",
      sportId,
    });
    await drainScheduled(t);

    expect(await leagueOf(t, teamId)).toEqual({ id: undefined, name: undefined });
  });

  test("an EXISTING team is returned untouched — the operator's league does not re-file it", async () => {
    // find-or-create's contract. Re-filing a team we already hold is Team
    // Management's job, done deliberately and with a screen in front of it.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedBaseball(t);
    const mlbId = await seedLeague(t, sportId, "Major League Baseball");
    const existingId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        location: "San Diego",
        name: "Padres",
        // The composed full name, token-sorted — the key every writer derives.
        nameNormalized: "diego padres san",
        sportId,
        leagueId: mlbId,
        lastUpdated: Date.now(),
      }),
    );
    const ablId = await seedLeague(t, sportId, "Australian Baseball League");

    // Answered as the whole string, and with a different league. Both are
    // ignored: the row already exists under that key.
    const teamId = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "San Diego Padres",
      sportId,
      leagueId: ablId,
    });

    expect(teamId).toBe(existingId);
    expect((await leagueOf(t, teamId)).id).toBe(mlbId);
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
  });
});
