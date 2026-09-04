/**
 * NEO-240: unit tests for the League Management backend — the seven functions
 * backing `/admin/leagues`, plus the alias-aware dedup in `findOrCreateLeague`
 * that the page depends on and every OTHER league writer inherits.
 *
 * Setup mirrors convex/players.management.test.ts: raw `ctx.db.insert` fixtures
 * (there is no need to route through a real checklist fetch to get leagues and
 * teams into the tables), an admin identity for the happy paths, and a
 * signed-in-but-not-admin identity for the negatives. A signed-in non-admin is
 * the interesting negative rather than an anonymous caller: sign-up is open, so
 * "signed in" is not a bound on who may edit globally-shared reference rows.
 *
 * convex/leagues.test.ts (NEO-156) stays the home of the "every team-creation
 * path attaches a league" guarantee and of `normalizeLeagueName`'s no-token-sort
 * property. This file does not restate either.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeLeagueName } from "./leagues";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "user_league_admin",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_league_admin",
  role: "admin",
};

/** Signed in, no admin role — the negative case that matters. */
const MEMBER = {
  subject: "user_league_member",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_league_member",
};

type T = ReturnType<typeof convexTest>;

async function seedSport(
  t: T,
  opts: { value?: string; withConfig?: boolean } = {},
): Promise<Id<"selectorOptions">> {
  const { value = "Baseball", withConfig = true } = opts;
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
              espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
            },
          }
        : {}),
      lastUpdated: 1_700_000_000_000,
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
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function insertLeague(
  t: T,
  opts: {
    name: string;
    sportId: Id<"selectorOptions">;
    abbreviation?: string;
    level?:
      | "major"
      | "minor"
      | "college"
      | "international"
      | "independent"
      | "other";
    aliases?: string[];
    wikidataId?: string;
    yearsActive?: { from: number; to?: number };
  },
): Promise<Id<"leagues">> {
  return t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name: opts.name,
      nameNormalized: normalizeLeagueName(opts.name),
      sportId: opts.sportId,
      ...(opts.abbreviation ? { abbreviation: opts.abbreviation } : {}),
      ...(opts.level ? { level: opts.level } : {}),
      ...(opts.aliases ? { aliases: opts.aliases } : {}),
      ...(opts.wikidataId ? { externalIds: { wikidataId: opts.wikidataId } } : {}),
      ...(opts.yearsActive ? { yearsActive: opts.yearsActive } : {}),
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function insertTeam(
  t: T,
  opts: {
    name: string;
    sportId: Id<"selectorOptions">;
    leagueId?: Id<"leagues">;
    city?: string;
    colors?: { primary?: string; secondary?: string };
  },
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name: opts.name,
      // Just a lowercase: nothing under test reads a team's normalized name,
      // and not importing `normalizeTeamName` keeps this file independent of
      // teams.ts.
      nameNormalized: opts.name.toLowerCase(),
      sportId: opts.sportId,
      ...(opts.leagueId ? { leagueId: opts.leagueId } : {}),
      ...(opts.city ? { city: opts.city } : {}),
      ...(opts.colors ? { colors: opts.colors } : {}),
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

const allLeagues = (t: T) => t.run(async (ctx) => ctx.db.query("leagues").collect());

// ===========================================================================
// Alias-aware dedup — the property every league writer inherits
// ===========================================================================

describe("NEO-240: findOrCreateLeague matches on aliases, not just the name", () => {
  test("the sport's default league row carries level 'major' and its abbreviation as an alias", async () => {
    // `resolveDefaultLeagueId` is the one place a level and an alias can be
    // asserted without an operator: `sportConfig.league` is the sport's top
    // flight by definition, and its abbreviation is what people type.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: "New York Yankees", sportId });

    const rows = await allLeagues(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Major League Baseball");
    expect(rows[0].abbreviation).toBe("MLB");
    expect(rows[0].level).toBe("major");
    expect(rows[0].aliases).toEqual(["MLB"]);
  });

  test('"MLB" typed anywhere resolves to the default row rather than minting a second', async () => {
    // The whole point of the alias leg. Before it, an operator adding "MLB" by
    // hand created a second league that no team pointed at and that every
    // future writer had to guess between.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: "New York Yankees", sportId });
    const defaultRow = (await allLeagues(t))[0];

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.createByAdmin, { name: "MLB", sportId });

    expect(result.created).toBe(false);
    expect(result.id).toBe(defaultRow._id);
    expect(await allLeagues(t)).toHaveLength(1);
  });

  test("an alias added later starts resolving immediately", async () => {
    // The NEO-240 decision, stated as a test: American League and National
    // League are ALIASES on the MLB row, not leagues of their own. An operator
    // records that once and every writer inherits it.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const mlb = await insertLeague(t, {
      name: "Major League Baseball",
      abbreviation: "MLB",
      sportId,
      level: "major",
      aliases: ["MLB"],
    });

    await t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, {
      id: mlb,
      aliases: ["MLB", "American League", "National League"],
    });

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.createByAdmin, { name: "  american league  ", sportId });

    expect(result).toEqual({ id: mlb, created: false });
    expect(await allLeagues(t)).toHaveLength(1);
  });

  test("aliases do not leak across sports", async () => {
    // A league is per-sport, and so is everything it answers to. "MLB" in
    // basketball is not Major League Baseball.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, { value: "Baseball" });
    const basketball = await seedSport(t, { value: "Basketball", withConfig: false });
    await insertLeague(t, {
      name: "Major League Baseball",
      sportId: baseball,
      aliases: ["MLB"],
    });

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.createByAdmin, { name: "MLB", sportId: basketball });

    expect(result.created).toBe(true);
    expect(await allLeagues(t)).toHaveLength(2);
  });

  test("a found row is gap-filled, never overwritten", async () => {
    // Same rule as `teams.applyEnrichmentInternal` (NEO-203): a later caller
    // may supply a fact the first did not, but may not replace one it did.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await insertLeague(t, {
      name: "Pacific Coast League",
      abbreviation: "PCL",
      sportId,
      level: "minor",
    });

    await t.withIdentity(ADMIN).mutation(api.leagues.createByAdmin, {
      name: "Pacific Coast League",
      abbreviation: "WRONG",
      level: "major" as const,
      sportId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.abbreviation).toBe("PCL");
    expect(row!.level).toBe("minor");
  });

  test("a found row DOES gain a level the first writer did not know", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await insertLeague(t, { name: "Texas League", sportId });

    await t.withIdentity(ADMIN).mutation(api.leagues.createByAdmin, {
      name: "Texas League",
      level: "minor" as const,
      sportId,
    });

    expect((await t.run(async (ctx) => ctx.db.get(id)))!.level).toBe("minor");
  });
});

describe("NEO-240: the creation-only enrichment hook", () => {
  /**
   * WP1 wired `scheduleLeagueEnrichment` up, so both halves are now
   * observable and both are asserted.
   *
   * The PLACEMENT is asserted on the SOURCE, the same way
   * publicFunctionAuth.test.ts asserts a declaration keyword: the hook must be
   * called exactly once and only after the insert, because "on the insert
   * branch and nowhere else" is what makes enrichment creation-only by
   * construction rather than by every caller remembering. A behavioural test
   * cannot see that — a hook moved above the early `return existing._id`
   * would still schedule exactly one item for a brand-new league.
   *
   * The BEHAVIOUR is asserted by running a real creation and reading
   * `_scheduled_functions`. The pool is not drained: `enqueueEnrichment`
   * reaches `Workpool.enqueueAction` and convex-test cannot register the
   * workpool component, so letting it run would test the pool rather than this
   * wiring — the same reason players.management.test.ts gives.
   */
  const source = readFileSync(join(__dirname, "leagues.ts"), "utf8");

  test("is called exactly once, on the insert branch of findOrCreateLeague", () => {
    const calls = source.match(/await scheduleLeagueEnrichment\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const insertAt = source.indexOf('ctx.db.insert("leagues"');
    const hookAt = source.indexOf("await scheduleLeagueEnrichment(");
    expect(insertAt).toBeGreaterThan(-1);
    // After the insert, so it can only ever run for a row that was created.
    expect(hookAt).toBeGreaterThan(insertAt);
    // And there is only ONE insert site in the module, so "after the insert"
    // cannot silently come to mean "after a different insert".
    expect(source.match(/ctx\.db\.insert\("leagues"/g) ?? []).toHaveLength(1);
  });

  test("the hook enqueues leagueIds onto the shared pool, and never with force", () => {
    const hook = source.slice(
      source.indexOf("async function scheduleLeagueEnrichment"),
      source.indexOf("export async function findOrCreateLeague"),
    );
    expect(hook).toContain("internal.wikidataPool.enqueueEnrichment");
    expect(hook).toContain("leagueIds: [id]");
    // `force` belongs to `enrichFromWikidata`, the human "look again" remedy.
    // An automatic caller setting it would defeat the creation-only guard in
    // `adapters/wikidata.enrichLeague` for every league in the product.
    expect(hook).not.toContain("force");
  });

  test("a CREATED league schedules exactly one enrichment", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.createByAdmin, { name: "Eastern League", sportId });

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("enqueueEnrichment");
    expect((scheduled[0].args[0] as { leagueIds?: unknown[] }).leagueIds).toHaveLength(1);
  });

  test("a FOUND league schedules nothing more", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN);

    await asAdmin.mutation(api.leagues.createByAdmin, {
      name: "Eastern League",
      sportId,
    });
    await asAdmin.mutation(api.leagues.createByAdmin, {
      name: "  eastern league ",
      sportId,
    });

    expect(
      await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect()),
    ).toHaveLength(1);
  });
});

// ===========================================================================
// createByAdmin
// ===========================================================================

describe("leagues.createByAdmin", () => {
  test("reports created:true the first time and created:false the second", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const first = await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.createByAdmin, { name: "Texas League", sportId });
    const second = await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.createByAdmin, { name: "  texas league ", sportId });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await allLeagues(t)).toHaveLength(1);
  });

  test("stores the level and a trimmed abbreviation", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const { id } = await t.withIdentity(ADMIN).mutation(api.leagues.createByAdmin, {
      name: "  International League  ",
      abbreviation: "  IL  ",
      level: "minor" as const,
      sportId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.name).toBe("International League");
    expect(row!.abbreviation).toBe("IL");
    expect(row!.level).toBe("minor");
    expect(row!.nameNormalized).toBe("international league");
  });

  test("refuses an empty name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.createByAdmin, { name: "   ", sportId }),
    ).rejects.toThrow(/league name is required/i);
  });

  test("refuses an over-long name, reporting the length and not the name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const name = "L".repeat(121);
    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.createByAdmin, { name, sportId }),
    ).rejects.toThrow(/121 characters; the limit is 120/);
  });

  test("refuses an over-long abbreviation", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.createByAdmin, {
        name: "Some League",
        abbreviation: "A".repeat(17),
        sportId,
      }),
    ).rejects.toThrow(/17 characters; the limit is 16/);
  });

  test("refuses a selectorOptions row that is not a sport", async () => {
    // The validator proves the id names that table, not that it names a SPORT.
    // A league hung off a variantType row is unreachable by every query that
    // matters, so it would be an orphan.
    const t = convexTest(schema, modules);
    const notASport = await seedNonSportOption(t);
    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.createByAdmin, {
        name: "Orphan League",
        sportId: notASport,
      }),
    ).rejects.toThrow(/must be created under a sport/i);
    expect(await allLeagues(t)).toHaveLength(0);
  });

  test("refuses a signed-in non-admin and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t
        .withIdentity(MEMBER)
        .mutation(api.leagues.createByAdmin, { name: "Ghost League", sportId }),
    ).rejects.toThrow(/admin access required/i);
    expect(await allLeagues(t)).toHaveLength(0);
  });
});

// ===========================================================================
// listForManagement
// ===========================================================================

describe("leagues.listForManagement", () => {
  async function seedLevels(t: T, sportId: Id<"selectorOptions">) {
    // Inserted in a deliberately scrambled order so the assertion is about the
    // sort and not about insertion order.
    await insertLeague(t, { name: "Zed Other League", sportId, level: "other" });
    await insertLeague(t, { name: "Unclassified League", sportId });
    await insertLeague(t, { name: "Atlantic League", sportId, level: "independent" });
    await insertLeague(t, { name: "Nippon Professional Baseball", sportId, level: "international" });
    await insertLeague(t, { name: "SEC", sportId, level: "college" });
    await insertLeague(t, { name: "Texas League", sportId, level: "minor" });
    await insertLeague(t, { name: "Pacific Coast League", sportId, level: "minor" });
    await insertLeague(t, { name: "Major League Baseball", sportId, level: "major" });
  }

  test("orders by the professional pyramid, then by name, with unset LAST", async () => {
    // The level order is a property of the taxonomy, not of the strings: sorted
    // alphabetically these would read college, independent, international,
    // major, minor — which looks like an ordering and is not one. Unset sorts
    // last because it is the operator's to-do pile, and no backfill was run.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedLevels(t, sportId);

    const result = await t.withIdentity(ADMIN).query(api.leagues.listForManagement, {});

    expect(result.leagues.map((l) => l.name)).toEqual([
      "Major League Baseball",
      "Pacific Coast League",
      "Texas League",
      "SEC",
      "Nippon Professional Baseball",
      "Atlantic League",
      "Zed Other League",
      "Unclassified League",
    ]);
    expect(result.totalCount).toBe(8);
    // Present for shape parity with players/teams; leagues are a small enough
    // set that the query collects them all.
    expect(result.truncated).toBe(false);
  });

  test("filters by sport", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, { value: "Baseball" });
    const hockey = await seedSport(t, { value: "Hockey", withConfig: false });
    await insertLeague(t, { name: "Major League Baseball", sportId: baseball, level: "major" });
    await insertLeague(t, { name: "National Hockey League", sportId: hockey, level: "major" });

    const result = await t
      .withIdentity(ADMIN)
      .query(api.leagues.listForManagement, { sportId: hockey });

    expect(result.leagues.map((l) => l.name)).toEqual(["National Hockey League"]);
    expect(result.totalCount).toBe(1);
  });

  test("returns the new fields, so the strict validator covers them", async () => {
    // `leagueDocValidator` is a returns validator, which Convex enforces
    // against the real document — a field added to the table but not to the
    // validator makes this (and `leagues.list`) throw.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertLeague(t, {
      name: "Federal League",
      sportId,
      level: "major",
      aliases: ["FL"],
      wikidataId: "Q1163715",
      yearsActive: { from: 1913, to: 1915 },
    });

    const { leagues } = await t
      .withIdentity(ADMIN)
      .query(api.leagues.listForManagement, {});

    expect(leagues[0]).toMatchObject({
      level: "major",
      aliases: ["FL"],
      externalIds: { wikidataId: "Q1163715" },
      yearsActive: { from: 1913, to: 1915 },
    });
  });
});

// ===========================================================================
// getByIdParam
// ===========================================================================

describe("leagues.getByIdParam", () => {
  test("resolves a real id", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await insertLeague(t, { name: "Texas League", sportId });

    const doc = await t.withIdentity(ADMIN).query(api.leagues.getByIdParam, { id });
    expect(doc?.name).toBe("Texas League");
  });

  test("answers null for a malformed id rather than throwing", async () => {
    // The NEO-235 property, for leagues: `/admin/leagues?league=<id>` puts an
    // id somewhere anybody can retype, and a hand-mangled query string must not
    // reach the app-level error boundary.
    const t = convexTest(schema, modules);
    await seedSport(t);

    expect(
      await t.withIdentity(ADMIN).query(api.leagues.getByIdParam, { id: "not-an-id" }),
    ).toBeNull();
  });

  test("answers null for a well-formed id from ANOTHER table", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await insertTeam(t, { name: "Yankees", sportId });

    expect(
      await t.withIdentity(ADMIN).query(api.leagues.getByIdParam, { id: teamId }),
    ).toBeNull();
  });

  test("answers null for a deleted league — the same branch as a bad id", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await insertLeague(t, { name: "Gone League", sportId });
    await t.run(async (ctx) => ctx.db.delete(id));

    expect(
      await t.withIdentity(ADMIN).query(api.leagues.getByIdParam, { id }),
    ).toBeNull();
  });
});

// ===========================================================================
// nearMatches
// ===========================================================================

describe("leagues.nearMatches", () => {
  test("reports an ALIAS hit as exact, naming the canonical row", async () => {
    // The operator typed a name the row already answers to, so creating would
    // reuse it. The result names the canonical league because that is the row
    // they would be reusing.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const mlb = await insertLeague(t, {
      name: "Major League Baseball",
      sportId,
      level: "major",
      aliases: ["MLB", "American League"],
    });

    const hits = await t
      .withIdentity(ADMIN)
      .query(api.leagues.nearMatches, { name: "american league", sportId });

    expect(hits).toEqual([
      { _id: mlb, name: "Major League Baseball", confidence: "exact" },
    ]);
  });

  test("reports a partial name as close", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const pcl = await insertLeague(t, { name: "Pacific Coast League", sportId });

    const hits = await t
      .withIdentity(ADMIN)
      .query(api.leagues.nearMatches, { name: "Pacific Coast", sportId });

    expect(hits).toHaveLength(1);
    expect(hits[0]._id).toBe(pcl);
    expect(hits[0].confidence).toBe("close");
  });

  test("does NOT call a token-reordered name exact", async () => {
    // `rankTeamCandidates` normalises with a token SORT, which would call these
    // the same league. `normalizeLeagueName` exists precisely because they are
    // not, so this function computes `exact` itself and only borrows `close`.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertLeague(t, { name: "National League", sportId });

    const hits = await t
      .withIdentity(ADMIN)
      .query(api.leagues.nearMatches, { name: "League National", sportId });

    expect(hits.every((h) => h.confidence === "close")).toBe(true);
  });

  test("collapses a row matched through both its name and an alias", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertLeague(t, {
      name: "Pacific Coast League",
      sportId,
      aliases: ["Pacific Coast Baseball League"],
    });

    const hits = await t
      .withIdentity(ADMIN)
      .query(api.leagues.nearMatches, { name: "Pacific Coast League", sportId });

    expect(hits).toHaveLength(1);
    expect(hits[0].confidence).toBe("exact");
  });

  test("returns nothing when nothing is close", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertLeague(t, { name: "Pacific Coast League", sportId });

    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.leagues.nearMatches, { name: "Nippon Professional Baseball", sportId }),
    ).toEqual([]);
  });

  test("returns nothing for an empty query, and refuses an over-long one", async () => {
    // An empty query would otherwise match everything through containment. The
    // length bound is the one the WRITE paths apply, put on the search term:
    // nothing longer than a storable name could ever match a stored row.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertLeague(t, { name: "Pacific Coast League", sportId });

    expect(
      await t.withIdentity(ADMIN).query(api.leagues.nearMatches, { name: "  ", sportId }),
    ).toEqual([]);
    await expect(
      t
        .withIdentity(ADMIN)
        .query(api.leagues.nearMatches, { name: "L".repeat(121), sportId }),
    ).rejects.toThrow(/121 characters; the limit is 120/);
  });

  test("refuses a signed-in non-admin", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t.withIdentity(MEMBER).query(api.leagues.nearMatches, { name: "MLB", sportId }),
    ).rejects.toThrow(/admin access required/i);
  });
});

// ===========================================================================
// saveLeagueFields
// ===========================================================================

describe("leagues.saveLeagueFields", () => {
  async function seedEditable(t: T) {
    const sportId = await seedSport(t);
    const id = await insertLeague(t, {
      name: "Pacific Coast League",
      abbreviation: "PCL",
      sportId,
      level: "minor",
      aliases: ["PCL"],
      wikidataId: "Q1163715",
      yearsActive: { from: 1903 },
    });
    return { sportId, id };
  }

  test("a rename recomputes nameNormalized", async () => {
    // Or the row becomes invisible to every lookup that resolves a league name
    // onto it — silently, and only discovered later as a duplicate league.
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.saveLeagueFields, { id, name: "  Coast League  " });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.name).toBe("Coast League");
    expect(row!.nameNormalized).toBe("coast league");
  });

  test("refuses an empty or over-long rename", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, { id, name: " " }),
    ).rejects.toThrow(/league name is required/i);
    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.leagues.saveLeagueFields, { id, name: "L".repeat(121) }),
    ).rejects.toThrow(/121 characters; the limit is 120/);
  });

  test("every optional field is clearable with null, and an empty abbreviation clears too", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, {
      id,
      abbreviation: null,
      level: null,
      yearsActive: null,
      wikidataId: null,
      aliases: [],
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.abbreviation).toBeUndefined();
    expect(row!.level).toBeUndefined();
    expect(row!.yearsActive).toBeUndefined();
    // The whole container goes, so a cleared row is indistinguishable from one
    // that never carried an id.
    expect(row!.externalIds).toBeUndefined();
    expect(row!.aliases).toBeUndefined();
  });

  test("an emptied abbreviation text box clears the field", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.saveLeagueFields, { id, abbreviation: "   " });

    expect((await t.run(async (ctx) => ctx.db.get(id)))!.abbreviation).toBeUndefined();
  });

  test("sets each field when given", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, {
      id,
      abbreviation: "PCL2",
      level: "independent" as const,
      yearsActive: { from: 1903, to: 1957 },
      wikidataId: "Q42",
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.abbreviation).toBe("PCL2");
    expect(row!.level).toBe("independent");
    expect(row!.yearsActive).toEqual({ from: 1903, to: 1957 });
    expect(row!.externalIds?.wikidataId).toBe("Q42");
  });

  test("normalises the alias list: trims, drops empties, dedupes case-insensitively", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, {
      id,
      aliases: ["  PCL  ", "pcl", "P.C.L.", "", "   ", "Coast League"],
    });

    // "PCL", "pcl" and "P.C.L." all normalise to the same key, so the FIRST
    // spelling the operator typed is the one kept.
    expect((await t.run(async (ctx) => ctx.db.get(id)))!.aliases).toEqual([
      "PCL",
      "Coast League",
    ]);
  });

  test("drops an alias equal to the row's own name, silently", async () => {
    // A redundancy, not an error: the row already answers to its own name.
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, {
      id,
      aliases: ["pacific coast league", "PCL"],
    });

    expect((await t.run(async (ctx) => ctx.db.get(id)))!.aliases).toEqual(["PCL"]);
  });

  test("a rename drops an alias that has become the new name", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.saveLeagueFields, { id, name: "PCL" });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.name).toBe("PCL");
    expect(row!.aliases).toBeUndefined();
  });

  test("refuses more than 32 aliases, reporting the count and not the values", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, {
        id,
        aliases: Array.from({ length: 33 }, (_, i) => `Alias ${i}`),
      }),
    ).rejects.toThrow(/33 aliases; the limit is 32/);
  });

  test("refuses an over-long alias", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.leagues.saveLeagueFields, { id, aliases: ["A".repeat(65)] }),
    ).rejects.toThrow(/65 characters; the limit is 64/);
  });

  test("NAME_TAKEN on a rename onto another row's name, carrying that row's id", async () => {
    // The message is load-bearing UI data — the page turns it into a link to
    // the colliding league — so it has to survive Convex's error path, which
    // is why it is a ConvexError rather than a bare Error.
    const t = convexTest(schema, modules);
    const { sportId, id } = await seedEditable(t);
    const other = await insertLeague(t, { name: "Texas League", sportId });

    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.leagues.saveLeagueFields, { id, name: "texas league" }),
    ).rejects.toThrow(new RegExp(`NAME_TAKEN:${other}`));

    // Refused means nothing was written on the way to the refusal.
    expect((await t.run(async (ctx) => ctx.db.get(id)))!.name).toBe(
      "Pacific Coast League",
    );
  });

  test("NAME_TAKEN on a rename onto another row's ALIAS", async () => {
    const t = convexTest(schema, modules);
    const { sportId, id } = await seedEditable(t);
    const other = await insertLeague(t, {
      name: "Texas League",
      sportId,
      aliases: ["TL"],
    });

    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, { id, name: "TL" }),
    ).rejects.toThrow(new RegExp(`NAME_TAKEN:${other}`));
  });

  test("NAME_TAKEN on an alias that collides with another row", async () => {
    // The ambiguity this refuses is concrete: with both rows answering to
    // "Texas League", `findOrCreateLeague` would resolve that name to whichever
    // row it scanned first.
    const t = convexTest(schema, modules);
    const { sportId, id } = await seedEditable(t);
    const other = await insertLeague(t, { name: "Texas League", sportId });

    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.leagues.saveLeagueFields, { id, aliases: ["Texas League"] }),
    ).rejects.toThrow(new RegExp(`NAME_TAKEN:${other}`));
  });

  test("a league in ANOTHER sport is not a collision", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);
    const hockey = await seedSport(t, { value: "Hockey", withConfig: false });
    await insertLeague(t, { name: "Texas League", sportId: hockey });

    await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.saveLeagueFields, { id, name: "Texas League" });

    expect((await t.run(async (ctx) => ctx.db.get(id)))!.name).toBe("Texas League");
  });

  test("keeping its own name is not a self-collision", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, {
      id,
      name: "Pacific Coast League",
      aliases: ["PCL", "Coast"],
    });

    expect((await t.run(async (ctx) => ctx.db.get(id)))!.aliases).toEqual([
      "PCL",
      "Coast",
    ]);
  });

  test.each([
    ["a start year before 1850", { from: 1849 }],
    ["a fractional start year", { from: 1903.5 }],
    ["an end year in the far future", { from: 1903, to: new Date().getFullYear() + 5 }],
  ])("refuses %s", async (_label, yearsActive) => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);
    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, { id, yearsActive }),
    ).rejects.toThrow(/whole year between 1850 and/);
  });

  test("refuses an end year before the start year", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);
    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, {
        id,
        yearsActive: { from: 1957, to: 1903 },
      }),
    ).rejects.toThrow(/cannot end before it starts/i);
  });

  test("accepts next year as an end year", async () => {
    // A league announced for the coming season is a real row; refusing it would
    // make the editor wrong every winter.
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);
    const nextYear = new Date().getFullYear() + 1;

    await t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, {
      id,
      yearsActive: { from: 1903, to: nextYear },
    });

    expect((await t.run(async (ctx) => ctx.db.get(id)))!.yearsActive).toEqual({
      from: 1903,
      to: nextYear,
    });
  });

  test("refuses a malformed Wikidata id and leaves the stored one alone", async () => {
    // A malformed id is worse than a missing one: enrichment treats ANY stored
    // `wikidataId` as "already enriched" and skips the row forever.
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);

    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.leagues.saveLeagueFields, { id, wikidataId: "not-a-qid" }),
    ).rejects.toThrow(/Not a Wikidata entity id: not-a-qid/);

    expect(
      (await t.run(async (ctx) => ctx.db.get(id)))!.externalIds?.wikidataId,
    ).toBe("Q1163715");
  });

  test("the sport is not editable", async () => {
    // A league's sport is its identity here, and every team in it was filed
    // under that sport. Moving it would strand them, so the argument does not
    // exist and Convex refuses it before the handler runs.
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);
    const hockey = await seedSport(t, { value: "Hockey", withConfig: false });

    await expect(
      t.withIdentity(ADMIN).mutation(
        api.leagues.saveLeagueFields,
        { id, sportId: hockey } as unknown as { id: Id<"leagues"> },
      ),
    ).rejects.toThrow();
  });

  test("always bumps lastUpdated", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);
    const before = (await t.run(async (ctx) => ctx.db.get(id)))!.lastUpdated;

    await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.saveLeagueFields, { id, level: "other" as const });

    expect(
      (await t.run(async (ctx) => ctx.db.get(id)))!.lastUpdated,
    ).toBeGreaterThan(before);
  });

  test("refuses a league that does not exist", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedEditable(t);
    await t.run(async (ctx) => ctx.db.delete(id));

    await expect(
      t.withIdentity(ADMIN).mutation(api.leagues.saveLeagueFields, { id, level: null }),
    ).rejects.toThrow(/league not found/i);
  });
});

// ===========================================================================
// teamsIn
// ===========================================================================

describe("leagues.teamsIn", () => {
  test("returns only that league's teams, sorted by name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const pcl = await insertLeague(t, { name: "Pacific Coast League", sportId });
    const tl = await insertLeague(t, { name: "Texas League", sportId });

    await insertTeam(t, { name: "Tacoma Rainiers", sportId, leagueId: pcl });
    await insertTeam(t, {
      name: "Albuquerque Isotopes",
      sportId,
      leagueId: pcl,
      city: "Albuquerque",
      colors: { primary: "#00D558", secondary: "#FF2EB3" },
    });
    await insertTeam(t, { name: "Amarillo Sod Poodles", sportId, leagueId: tl });
    // Unassigned — a team whose sport has no configured league, or a
    // pre-NEO-156 row. It belongs to no league and must not appear in one.
    await insertTeam(t, { name: "Unaffiliated Club", sportId });

    const rows = await t.withIdentity(ADMIN).query(api.leagues.teamsIn, { leagueId: pcl });

    expect(rows.map((r) => r.name)).toEqual([
      "Albuquerque Isotopes",
      "Tacoma Rainiers",
    ]);
    expect(rows[0]).toEqual({
      _id: expect.anything(),
      name: "Albuquerque Isotopes",
      city: "Albuquerque",
      colors: { primary: "#00D558", secondary: "#FF2EB3" },
    });
    // The projection is deliberate: everything else about a team belongs to
    // Team Management, which owns editing it.
    expect(rows[1]).not.toHaveProperty("sportId");
  });

  test("answers empty for a league with no teams", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertLeague(t, { name: "Empty League", sportId });

    expect(await t.withIdentity(ADMIN).query(api.leagues.teamsIn, { leagueId })).toEqual([]);
  });
});

// ===========================================================================
// enrichFromWikidata / getInternal / applyEnrichmentInternal
// ===========================================================================

describe("leagues.enrichFromWikidata", () => {
  /**
   * The pool itself is not exercised here: `wikidataPool.enqueueEnrichment`
   * reaches `Workpool.enqueueAction`, and convex-test cannot register the
   * workpool component — letting it run would test the pool, not this wiring.
   * The same reason convex/players.management.test.ts gives for reading
   * `_scheduled_functions` instead of draining it.
   *
   * So two things are asserted. Behaviourally: the action RESOLVES for an
   * admin, which is the fire-and-forget contract — an enqueue failure is
   * logged, not thrown, because an un-enriched league is a valid end state and
   * the operator's click must not surface as a broken screen. Structurally:
   * the enqueue passes `force`, which is what separates this human "look
   * again" remedy from every automatic caller, none of which may set it.
   */
  test("resolves for an admin even though the pool cannot run here", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await insertLeague(t, { name: "Texas League", sportId });

    await expect(
      t.withIdentity(ADMIN).action(api.leagues.enrichFromWikidata, { id }),
    ).resolves.toBeNull();
  });

  test("enqueues with force — the operator exception", async () => {
    const source = readFileSync(join(__dirname, "leagues.ts"), "utf8");
    const enqueue = source.slice(source.indexOf("export const enrichFromWikidata"));
    expect(enqueue).toContain("leagueIds: [args.id]");
    expect(enqueue).toContain("force: true");
  });

  test("wikidataPool.enqueueEnrichment accepts leagueIds", async () => {
    // The arg this ticket added to the shared 5-wide lane. Asserted on the
    // source for the same reason as above — the pool component cannot be
    // mounted, so calling the mutation would prove nothing about the argument.
    const source = readFileSync(join(__dirname, "wikidataPool.ts"), "utf8");
    expect(source).toContain('leagueIds: v.optional(v.array(v.id("leagues")))');
    expect(source).toContain("internal.adapters.wikidata.enrichLeague");
  });
});

describe("leagues.getInternal and applyEnrichmentInternal", () => {
  test("getInternal returns the row, and null for a deleted one", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await insertLeague(t, { name: "Texas League", sportId });

    expect((await t.query(internal.leagues.getInternal, { id }))?.name).toBe(
      "Texas League",
    );

    await t.run(async (ctx) => ctx.db.delete(id));
    expect(await t.query(internal.leagues.getInternal, { id })).toBeNull();
  });

  test("fills gaps on a bare row", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await insertLeague(t, { name: "Federal League", sportId });

    await t.mutation(internal.leagues.applyEnrichmentInternal, {
      id,
      abbreviation: "FL",
      yearsActive: { from: 1913, to: 1915 },
      wikidataId: "Q1163715",
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.abbreviation).toBe("FL");
    expect(row!.yearsActive).toEqual({ from: 1913, to: 1915 });
    expect(row!.externalIds?.wikidataId).toBe("Q1163715");
  });

  test("never overwrites a value an operator already put there", async () => {
    // NEO-203, applied to leagues: background enrichment must not restamp a
    // field that is editable by hand. A corrected abbreviation that survives
    // only until the next lookup is worse than one never applied.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await insertLeague(t, {
      name: "Federal League",
      abbreviation: "FEDL",
      sportId,
      wikidataId: "Q42",
      yearsActive: { from: 1914 },
    });

    await t.mutation(internal.leagues.applyEnrichmentInternal, {
      id,
      abbreviation: "FL",
      yearsActive: { from: 1913, to: 1915 },
      wikidataId: "Q1163715",
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.abbreviation).toBe("FEDL");
    expect(row!.yearsActive).toEqual({ from: 1914 });
    expect(row!.externalIds?.wikidataId).toBe("Q42");
  });

  test("drops a malformed Wikidata id rather than storing it", async () => {
    // The value arrives from query.wikidata.org with no operator in the path,
    // and a stored id is what a creation-only guard reads to decide the row is
    // done — so persisting a malformed one would opt the league out forever.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await insertLeague(t, { name: "Federal League", sportId });

    await t.mutation(internal.leagues.applyEnrichmentInternal, {
      id,
      wikidataId: "https://www.wikidata.org/entity/Q1163715",
    });

    expect(
      (await t.run(async (ctx) => ctx.db.get(id)))!.externalIds,
    ).toBeUndefined();
  });

  test("is a no-op for a league that no longer exists", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await insertLeague(t, { name: "Gone League", sportId });
    await t.run(async (ctx) => ctx.db.delete(id));

    await expect(
      t.mutation(internal.leagues.applyEnrichmentInternal, { id, abbreviation: "GL" }),
    ).resolves.toBeNull();
  });
});
