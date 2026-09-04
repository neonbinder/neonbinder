/**
 * NEO-156 — leagues as an entity, and the guarantee that every team-creation
 * path attaches one.
 *
 * The last describe block is the one that matters most: it asserts the
 * guarantee at each real creation site rather than trusting that seven
 * `insert("teams", …)` calls stayed in step with one another.
 */

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeLeagueName } from "./leagues";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin", role: "admin" };
// NEO-154 gave `teams.findOrCreate` the signed-in guard its `players`
// counterpart always had; NEO-208 raised it to ADMIN, because its insert
// branch now schedules a pooled Wikidata enrichment and the pool bounds
// concurrency rather than total queued work (see the mutation, and
// publicFunctionAuth.test.ts, for the whole reasoning). So the league-
// attachment tests below call it as ADMIN. There is no longer a signed-in-but-
// not-admin caller in this file at all — the one it used to have was here to
// avoid implying an admin-only path, and the path IS admin-only now.

async function seedSport(
  t: ReturnType<typeof convexTest>,
  opts: { withConfig?: boolean; value?: string } = {},
): Promise<Id<"selectorOptions">> {
  const { withConfig = true, value = "Baseball" } = opts;
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      ...(withConfig
        ? {
            sportConfig: {
              skuCode: "BB",
              league: "MLB",
              espn: {
                path: "baseball/mlb",
                leagueName: "Major League Baseball",
              },
            },
          }
        : {}),
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

const leagues = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("leagues").collect());

describe("normalizeLeagueName", () => {
  test("does NOT token-sort, unlike the team normalizer", () => {
    // teams.normalizeTeamName sorts to dedup "Yankees, New York". League names
    // never arrive reversed, and sorting would collapse these two into one row.
    expect(normalizeLeagueName("National League")).not.toBe(
      normalizeLeagueName("League National"),
    );
    expect(normalizeTeamName("National League")).toBe(
      normalizeTeamName("League National"),
    );
  });

  test("ignores case and punctuation", () => {
    expect(normalizeLeagueName("  Major League Baseball ")).toBe(
      "major league baseball",
    );
    expect(normalizeLeagueName("Nippon Professional Baseball")).toBe(
      "nippon professional baseball",
    );
  });
});

describe("league creation", () => {
  test("is idempotent per (name, sport)", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const a = await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.create, { name: "Pacific Coast League", sportId });
    const b = await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.create, { name: "pacific coast league  ", sportId });

    expect(a).toBe(b);
    expect(await leagues(t)).toHaveLength(1);
  });

  test("keeps same-named leagues in different sports apart", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, { value: "Baseball" });
    const football = await seedSport(t, { value: "Football", withConfig: false });

    const a = await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.create, { name: "National League", sportId: baseball });
    const b = await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.create, { name: "National League", sportId: football });

    expect(a).not.toBe(b);
  });

  test("fills in an abbreviation a later caller knows", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.create, { name: "Nippon Professional Baseball", sportId });
    await t.withIdentity(ADMIN).mutation(api.leagues.create, {
      name: "Nippon Professional Baseball",
      abbreviation: "NPB",
      sportId,
    });

    const rows = await leagues(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].abbreviation).toBe("NPB");
  });

  // ── NEO-240 security review: `create` shares `createByAdmin`'s bounds ────
  //
  // This is Team Management's inline add, and two things moved under it: the
  // insert branch it reaches now schedules a Wikidata lookup, and the caller
  // now sends an abbreviation. It had no bound on either field. These three
  // tests are what keep it from drifting away from `createByAdmin` again —
  // the limits themselves are covered against that mutation in
  // leagues.management.test.ts, so what is asserted here is that THIS door
  // has them at all.

  test("refuses an empty name, as a ConvexError rather than a bare Error", async () => {
    // A deployed Convex backend rewrites a plain `Error`'s message to "Server
    // Error", so the operator standing in front of the inline add would be
    // told nothing about what they typed. The message has to survive.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.create, { name: "   ", sportId }),
    ).rejects.toThrow(ConvexError);
    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.create, { name: "   ", sportId }),
    ).rejects.toThrow(/A league name is required/);
    expect(await leagues(t)).toHaveLength(0);
  });

  test("refuses an over-long name, reporting the length and not the name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.create, {
        name: "L".repeat(121),
        sportId,
      }),
    ).rejects.toThrow(/121 characters; the limit is 120/);
    expect(await leagues(t)).toHaveLength(0);
  });

  test("refuses an over-long abbreviation", async () => {
    // The field Team Management's inline add started sending, and the one
    // this mutation used to store unbounded.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.create, {
        name: "Pacific Coast League",
        abbreviation: "A".repeat(17),
        sportId,
      }),
    ).rejects.toThrow(/17 characters; the limit is 16/);
    expect(await leagues(t)).toHaveLength(0);
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t
        .withIdentity({ subject: "u", role: "user" })
        .mutation(api.leagues.create, { name: "MLB", sportId }),
    ).rejects.toThrow(/admin/i);
  });
});

describe("every team-creation path attaches a league", () => {
  // The point of routing all seven insert sites through one resolver. Each
  // case exercises a REAL entry point, so a new path that forgets the resolver
  // fails here rather than silently producing league-less rows.

  test("teams.findOrCreate", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const teamId = await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "New York Yankees",
      sportId,
    });

    const team = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(team!.leagueId).toBeDefined();
    const league = await t.run(async (ctx) => ctx.db.get(team!.leagueId!));
    // Full name from sportConfig.espn.leagueName, abbreviation from .league —
    // neither invented here.
    expect(league!.name).toBe("Major League Baseball");
    expect(league!.abbreviation).toBe("MLB");
  });

  test("teams.findOrCreateInternal", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const teamId = await t.mutation(internal.teams.findOrCreateInternal, {
      name: "Chiba Lotte Marines",
      sportId,
    });

    const team = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(team!.leagueId).toBeDefined();
  });

  test("a sport with no configured league yields a team without one", async () => {
    // A legitimate outcome, not an error — a custom sport has no config to
    // read. The team is created and an operator assigns the league later.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, { withConfig: false, value: "Pickleball" });

    const teamId = await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "Some Club",
      sportId,
    });

    const team = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(team!.leagueId).toBeUndefined();
    expect(await leagues(t)).toHaveLength(0);
  });

  test("reuses one league row across many teams", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    for (const name of ["Yankees", "Mets", "Red Sox"]) {
      await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, { name, sportId });
    }

    expect(await leagues(t)).toHaveLength(1);
  });
});

describe("legacy league conversion", () => {
  // NEO-156 replaced the bulk `backfillLeagueIds` button with a per-team
  // conversion that rides along with "Discover". A migration nobody has to
  // remember to run beats a button that becomes useless the moment it works.

  async function seedLegacyTeam(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    name: string,
    league: string | undefined,
  ) {
    return t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name,
        nameNormalized: normalizeTeamName(name),
        sportId,
        ...(league ? { league } : {}),
        lastUpdated: 1_700_000_000_000,
      }),
    );
  }

  test("converts a legacy string to a reference and clears the string", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await seedLegacyTeam(t, sportId, "Montreal Expos", "National League");

    await t.mutation(internal.teams.convertLegacyLeagueInternal, { id: teamId });

    const team = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(team!.leagueId).toBeDefined();
    const league = await t.run(async (ctx) => ctx.db.get(team!.leagueId!));
    expect(league!.name).toBe("National League");
    // Never leave both — a row carrying two answers to the same question is
    // how the drift starts again.
    expect(team!.league).toBeUndefined();
  });

  test("dedupes teams sharing a legacy league name into one row", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const a = await seedLegacyTeam(t, sportId, "Expos", "National League");
    const b = await seedLegacyTeam(t, sportId, "Cubs", "National League");

    await t.mutation(internal.teams.convertLegacyLeagueInternal, { id: a });
    await t.mutation(internal.teams.convertLegacyLeagueInternal, { id: b });

    expect(await leagues(t)).toHaveLength(1);
  });

  test("never overwrites a league an operator assigned by hand", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const assigned = await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.create, { name: "Pacific Coast League", sportId });
    const teamId = await seedLegacyTeam(t, sportId, "Expos", "National League");
    await t.run(async (ctx) => ctx.db.patch(teamId, { leagueId: assigned }));

    await t.mutation(internal.teams.convertLegacyLeagueInternal, { id: teamId });

    const team = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(team!.leagueId).toBe(assigned);
  });

  test("is a no-op for a team with no legacy string", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await seedLegacyTeam(t, sportId, "Bare Team", undefined);

    await t.mutation(internal.teams.convertLegacyLeagueInternal, { id: teamId });

    const team = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(team!.leagueId).toBeUndefined();
    expect(await leagues(t)).toHaveLength(0);
  });

  test("is re-runnable", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await seedLegacyTeam(t, sportId, "Expos", "National League");

    await t.mutation(internal.teams.convertLegacyLeagueInternal, { id: teamId });
    const first = await t.run(async (ctx) => ctx.db.get(teamId));
    await t.mutation(internal.teams.convertLegacyLeagueInternal, { id: teamId });
    const second = await t.run(async (ctx) => ctx.db.get(teamId));

    expect(second!.leagueId).toBe(first!.leagueId);
    expect(await leagues(t)).toHaveLength(1);
  });
});

describe("leagues.list", () => {
  test("returns leagues for one sport, sorted by name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const other = await seedSport(t, { value: "Hockey", withConfig: false });

    for (const name of ["Pacific Coast League", "American League"]) {
      await t.withIdentity(ADMIN).mutation(api.leagues.create, { name, sportId });
    }
    await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.create, { name: "NHL", sportId: other });

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.leagues.list, { sportId });

    expect(rows.map((r) => r.name)).toEqual([
      "American League",
      "Pacific Coast League",
    ]);
  });

  test("is readable by any signed-in user, not just admins", async () => {
    // NEO-156: the spine-label designer's team picker filters by league, and
    // that is a collector-facing screen. Leagues carry no user content.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.withIdentity(ADMIN).mutation(api.leagues.create, { name: "MLB", sportId });

    const rows = await t
      .withIdentity({ subject: "u", role: "user" })
      .query(api.leagues.list, {});

    expect(rows.map((r) => r.name)).toEqual(["MLB"]);
  });

  test("returns nothing to a signed-out caller", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.leagues.list, {})).resolves.toEqual([]);
  });
});
