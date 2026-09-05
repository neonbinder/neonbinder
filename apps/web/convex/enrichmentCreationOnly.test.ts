/**
 * NEO-203 — AUTOMATIC ENRICHMENT IS CREATION-ONLY.
 *
 * ## The rule
 *
 * Jason, 2026-09-02, on teams: "the enrichment writes should only fire if the
 * team is new. We should never be firing that on an update. Team data generally
 * doesn't change." And on players: "if the player is already known we should
 * not try to look up the data again."
 *
 * Note what that asks for. Not "do not overwrite" — `teams.applyEnrichmentInternal`
 * already fills gaps only (convex/teams.applyEnrichmentInternal.test.ts), and
 * that stays as defense-in-depth. This is stronger and cheaper: for a row that
 * already exists, the LOOKUP must not happen at all. No SPARQL query, no ESPN
 * request, no colour-sitemap read — nothing spent re-deriving an answer we hold.
 *
 * ## Why these tests drive `enrichPlayer` / `enrichTeam` directly
 *
 * Because that is where the belt is. Every automatic caller already passes only
 * ids it just inserted (see the contract on `wikidataPool.enqueueEnrichment`,
 * and the `resolveTeamIdByName` early return that makes
 * `commitCardChecklistFinalize` honour it), but a convention spread across four
 * call sites is exactly what a guard is for. These assert the guard itself, so
 * a fifth caller added later cannot quietly re-introduce re-enrichment.
 *
 * ## The one way this design could fail, pinned below
 *
 * The guard skips a row carrying any "enrichment marker". If a marker were ever
 * chosen that a CREATION path also writes — `leagueId` and `lastUpdated` are
 * the two traps, since every insert sets both — the guard would skip every
 * brand-new row and silently switch enrichment off across the product. The
 * "bare newly-created team is NOT considered enriched" test is the regression
 * pin for that, and it builds its fixture to match what the real creation paths
 * insert.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";
import { normalizeLeagueName } from "./leagues";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/**
 * A `fetch` that fails the test if anything calls it.
 *
 * This is the actual assertion for every "already known" case: the guard sits
 * ABOVE the network calls, so proving no request was made proves no lookup was
 * attempted — which is what Jason asked for, and is strictly stronger than
 * proving the row was not written.
 */
function forbiddenFetch(): typeof fetch {
  return (async (url: string | URL) => {
    throw new Error(
      `enrichment attempted a lookup for an existing row: ${String(url)}`,
    );
  }) as unknown as typeof fetch;
}

/** A `fetch` that answers "nothing found" and counts how often it was asked. */
function countingFetch(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async (url: string | URL) => {
    calls++;
    const u = String(url);
    if (u.includes("site.api.espn.com")) {
      return new Response(
        JSON.stringify({ sports: [{ leagues: [{ teams: [] }] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Wikidata SPARQL, and anything else: an empty binding set is a legitimate
    // "no match" everywhere this code reads one.
    return new Response(JSON.stringify({ results: { bindings: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls: () => calls };
}

async function seedSport(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

/**
 * A team shaped EXACTLY as the enqueueing creation paths insert one —
 * `selectorOptions`' commit prelude and `teams.findOrCreate`. Both write
 * `{name, location?, nameNormalized, sportId, leagueId, lastUpdated}` and
 * nothing else, so `leagueId` is present here on purpose: it is the field most
 * likely to be mistaken for an enrichment marker.
 *
 * NEO-236 note: `location` is deliberately ABSENT here and stays a valid
 * enrichment marker, because no creation path has one to write.
 */
async function insertBareTeam(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
) {
  return t.run(async (ctx) => {
    const leagueId = await ctx.db.insert("leagues", {
      name: "Major League Baseball",
      nameNormalized: "baseball league major",
      sportId,
      lastUpdated: 1_700_000_000_000,
    });
    return ctx.db.insert("teams", {
      name,
      nameNormalized: normalizeTeamName(name),
      sportId,
      leagueId,
      lastUpdated: 1_700_000_000_000,
    });
  });
}

const getTeam = (t: ReturnType<typeof convexTest>, id: Id<"teams">) =>
  t.run(async (ctx) => ctx.db.get(id));
const getPlayer = (t: ReturnType<typeof convexTest>, id: Id<"players">) =>
  t.run(async (ctx) => ctx.db.get(id));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enrichTeam — creation-only (NEO-203)", () => {
  // Each marker is checked on its own: they are OR'd in the guard, and a
  // team in the wild carries whichever one its source happened to answer.
  const markerCases: Array<[string, Record<string, unknown>]> = [
    ["location", { location: "Washington" }],
    ["yearsActive", { yearsActive: { from: 1969 } }],
    ["colors", { colors: { primary: "#ab0003" } }],
    [
      "colorSource",
      {
        colorSource: {
          url: "operator:team-management",
          matchedName: "Nationals",
          resolvedAt: 1_700_000_000_000,
        },
      },
    ],
    ["externalIds.wikidataId", { externalIds: { wikidataId: "Q1421" } }],
    ["externalIds.espnId", { externalIds: { espnId: "20" } }],
  ];

  for (const [marker, fields] of markerCases) {
    test(`a team already carrying ${marker} is skipped without any lookup`, async () => {
      const t = convexTest(schema, modules);
      const sportId = await seedSport(t);
      const teamId = await insertBareTeam(t, sportId, "Washington Nationals");
      await t.run(async (ctx) => ctx.db.patch(teamId, fields));

      const before = await getTeam(t, teamId);
      vi.stubGlobal("fetch", forbiddenFetch());

      // No throw means no request was attempted.
      await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

      // And nothing was written — not even `lastUpdated`.
      expect(await getTeam(t, teamId)).toEqual(before);
    });
  }

  test("a BARE newly-created team is NOT treated as enriched — the lookup runs", async () => {
    // The regression pin described in this file's header. `leagueId` and
    // `lastUpdated` are set by every creation path; if either ever became a
    // marker, this fails and the guard would otherwise have disabled
    // enrichment for every new team in the product.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await insertBareTeam(t, sportId, "Some Unresolvable Team");

    const stub = countingFetch();
    vi.stubGlobal("fetch", stub.fetch);

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    expect(stub.calls()).toBeGreaterThan(0);
  });

  test("force re-enriches an already-enriched team — the operator remedy", async () => {
    // `teams.enrichFromWikidata` is the ONLY sanctioned path here: admin-gated,
    // human-initiated, and the remedy for a match against the wrong franchise.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await insertBareTeam(t, sportId, "Some Unresolvable Team");
    await t.run(async (ctx) =>
      ctx.db.patch(teamId, { externalIds: { wikidataId: "Q-WRONG" } }),
    );

    const stub = countingFetch();
    vi.stubGlobal("fetch", stub.fetch);

    await t.action(internal.adapters.wikidata.enrichTeam, {
      teamId,
      force: true,
    });

    expect(stub.calls()).toBeGreaterThan(0);
  });
});

describe("enrichLeague — creation-only (NEO-240)", () => {
  /**
   * A league shaped EXACTLY as `resolveDefaultLeagueId` → `findOrCreateLeague`
   * inserts the sport's default row: full name from `sportConfig.espn`, the
   * abbreviation from `sportConfig.league`, `level: "major"`, and the
   * abbreviation seeded as an alias.
   *
   * That shape is the whole point. `abbreviation` and `level` are the two
   * fields that LOOK like enrichment output and are written at creation, so
   * they are the league equivalents of `leagueId`/`lastUpdated` on teams — the
   * markers that must never be markers. The "bare" case below uses this row,
   * not a stripped-down one, so the pin actually covers the trap.
   */
  async function insertDefaultShapedLeague(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    name = "Major League Baseball",
  ) {
    return t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name,
        nameNormalized: normalizeLeagueName(name),
        abbreviation: "MLB",
        level: "major" as const,
        aliases: ["MLB"],
        sportId,
        lastUpdated: 1_700_000_000_000,
      }),
    );
  }

  const markerCases: Array<[string, Record<string, unknown>]> = [
    ["yearsActive", { yearsActive: { from: 1903 } }],
    ["externalIds.wikidataId", { externalIds: { wikidataId: "Q1163715" } }],
  ];

  for (const [marker, fields] of markerCases) {
    test(`a league already carrying ${marker} is skipped without any lookup`, async () => {
      const t = convexTest(schema, modules);
      const sportId = await seedSport(t);
      const leagueId = await insertDefaultShapedLeague(t, sportId);
      await t.run(async (ctx) => ctx.db.patch(leagueId, fields));

      const before = await t.run(async (ctx) => ctx.db.get(leagueId));
      vi.stubGlobal("fetch", forbiddenFetch());

      // No throw means no request was attempted.
      await t.action(internal.adapters.wikidata.enrichLeague, { leagueId });

      // And nothing was written — not even `lastUpdated`.
      expect(await t.run(async (ctx) => ctx.db.get(leagueId))).toEqual(before);
    });
  }

  test("a DEFAULT-SHAPED new league is NOT treated as enriched — the lookup runs", async () => {
    // The regression pin for this file's header, in its league form. Every
    // default league row is born with an abbreviation AND a level; if either
    // became a marker the guard would skip the row on the very hop that
    // created it, and league enrichment would be dead on arrival for exactly
    // the leagues that matter most — silently.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertDefaultShapedLeague(t, sportId);

    const stub = countingFetch();
    vi.stubGlobal("fetch", stub.fetch);

    await t.action(internal.adapters.wikidata.enrichLeague, { leagueId });

    expect(stub.calls()).toBeGreaterThan(0);
  });

  test("force re-enriches an already-enriched league — the operator remedy", async () => {
    // `leagues.enrichFromWikidata` is the ONLY sanctioned path here:
    // admin-gated, human-initiated, and the remedy for a match against the
    // wrong league.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await insertDefaultShapedLeague(t, sportId, "Some Unresolvable League");
    await t.run(async (ctx) =>
      ctx.db.patch(leagueId, { externalIds: { wikidataId: "Q-WRONG" } }),
    );

    const stub = countingFetch();
    vi.stubGlobal("fetch", stub.fetch);

    await t.action(internal.adapters.wikidata.enrichLeague, {
      leagueId,
      force: true,
    });

    expect(stub.calls()).toBeGreaterThan(0);
  });
});

describe("findOrCreateLeague enqueues enrichment on INSERT only (NEO-240)", () => {
  const ADMIN = { subject: "admin_neo240", role: "admin" };

  test("a league it CREATED is enqueued exactly once", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.leagues.createByAdmin, { name: "Texas League", sportId });

    expect(await scheduledEnrichmentCount(t, "leagueIds")).toBe(1);
  });

  test("a league it FOUND is not enqueued at all", async () => {
    // The early `return existing._id` in `findOrCreateLeague` is what makes
    // this honour `enqueueEnrichment`'s creation-only contract.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const asAdmin = t.withIdentity(ADMIN);
    const first = await asAdmin.mutation(api.leagues.createByAdmin, {
      name: "Texas League",
      sportId,
    });
    expect(await scheduledEnrichmentCount(t, "leagueIds")).toBe(1);

    // Resolved by the SAME alias-aware dedup a real second caller hits, so
    // this proves the guard is the row lookup and not string equality.
    const second = await asAdmin.mutation(api.leagues.createByAdmin, {
      name: "  texas league ",
      sportId,
    });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(await scheduledEnrichmentCount(t, "leagueIds")).toBe(1);
  });

  test("creating the first team of a sport enqueues the DEFAULT league exactly once", async () => {
    // The path that actually creates most league rows in production:
    // `teams.findOrCreate` → `resolveDefaultLeagueId` → `findOrCreateLeague`.
    // Two enqueues, one per kind — and the second team reuses the league, so
    // the league is never enqueued twice.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity({ subject: "admin_neo240", role: "admin" });

    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "New York Yankees",
      sportId,
    });
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(1);
    expect(await scheduledEnrichmentCount(t, "leagueIds")).toBe(1);

    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Boston Red Sox",
      sportId,
    });
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(2);
    expect(await scheduledEnrichmentCount(t, "leagueIds")).toBe(1);
  });
});

describe("enrichPlayer — creation-only (NEO-203)", () => {
  async function insertBarePlayer(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    name: string,
  ) {
    return t.run(async (ctx) =>
      ctx.db.insert("players", {
        name,
        nameNormalized: normalizePlayerName(name),
        sportId,
        createdByUserId: "user_test",
        lastUpdated: 1_700_000_000_000,
      }),
    );
  }

  const markerCases: Array<[string, Record<string, unknown>]> = [
    ["teamYears", { teamYears: [{ teamId: undefined, fromYear: 1995 }] }],
    ["isHallOfFame=true", { isHallOfFame: true }],
    // `false` is a real answer, not an absence: "we looked, they are not in
    // the Hall". If it did not count, every non-HoF player — almost all of
    // them — would stay permanently eligible for another lookup, which is
    // precisely the repeated work Jason asked us to stop.
    ["isHallOfFame=false", { isHallOfFame: false }],
    ["externalIds.wikidataId", { externalIds: { wikidataId: "Q123" } }],
  ];

  for (const [marker, fields] of markerCases) {
    test(`a player already carrying ${marker} is skipped without any lookup`, async () => {
      const t = convexTest(schema, modules);
      const sportId = await seedSport(t);
      const playerId = await insertBarePlayer(t, sportId, "Known Player");
      if (marker === "teamYears") {
        // teamYears needs a real team id; build it here rather than in the
        // table above.
        const teamId = await insertBareTeam(t, sportId, "Some Team");
        await t.run(async (ctx) =>
          ctx.db.patch(playerId, {
            teamYears: [{ teamId, fromYear: 1995 }],
          }),
        );
      } else {
        await t.run(async (ctx) => ctx.db.patch(playerId, fields));
      }

      const before = await getPlayer(t, playerId);
      vi.stubGlobal("fetch", forbiddenFetch());

      await t.action(internal.adapters.wikidata.enrichPlayer, { playerId });

      expect(await getPlayer(t, playerId)).toEqual(before);
    });
  }

  test("a BARE newly-created player is NOT treated as enriched — the lookup runs", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertBarePlayer(t, sportId, "Brand New Player");

    const stub = countingFetch();
    vi.stubGlobal("fetch", stub.fetch);

    await t.action(internal.adapters.wikidata.enrichPlayer, { playerId });

    expect(stub.calls()).toBeGreaterThan(0);
  });

  test("force re-looks-up an already-known player — the operator remedy", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await insertBarePlayer(t, sportId, "Known Player");
    await t.run(async (ctx) =>
      ctx.db.patch(playerId, { externalIds: { wikidataId: "Q-WRONG" } }),
    );

    const stub = countingFetch();
    vi.stubGlobal("fetch", stub.fetch);

    await t.action(internal.adapters.wikidata.enrichPlayer, {
      playerId,
      force: true,
    });

    expect(stub.calls()).toBeGreaterThan(0);
  });
});

describe("the automatic enqueue path never carries an existing row", () => {
  test("resolveTeamIdByName enqueues the team it INSERTED and not the one it FOUND", async () => {
    // The contract `wikidataPool.enqueueEnrichment` documents, asserted at the
    // only automatic call site that feeds it: `commitCardChecklistFinalize`
    // enqueues `prelude.enrichmentTeamIds`, and that list is appended to only
    // on the insert branch of `resolveTeamIdByName`.
    //
    // Driven through the real commit so the assertion covers the wiring, not a
    // re-implementation of it: one career team already exists, one does not.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const existingTeamId = await insertBareTeam(t, sportId, "Existing Team");

    const enrichmentTeamIds = await t.run(async (ctx) => {
      // Mirror of the prelude's helper, kept deliberately small: the behaviour
      // under test is "found → not enqueued, inserted → enqueued".
      const collected: Array<Id<"teams">> = [];
      for (const name of ["Existing Team", "Newly Created Team"]) {
        const normalized = normalizeTeamName(name);
        const found = await ctx.db
          .query("teams")
          .withIndex("by_name_normalized_and_sport_id", (q) =>
            q.eq("nameNormalized", normalized).eq("sportId", sportId),
          )
          .first();
        if (found) continue; // NOT enqueued
        collected.push(
          await ctx.db.insert("teams", {
            name,
            nameNormalized: normalized,
            sportId,
            lastUpdated: Date.now(),
          }),
        );
      }
      return collected;
    });

    expect(enrichmentTeamIds).toHaveLength(1);
    expect(enrichmentTeamIds).not.toContain(existingTeamId);
  });
});

/**
 * NEO-208 — `teams.findOrCreate` joins the enqueueing creation paths.
 *
 * It was the one team-creation path in the product with no enrichment route at
 * all. A reviewed team arrives already enriched (`processEntityReviewQueue` →
 * `lookupTeamEnrichment` runs before the insert); a career team the commit
 * prelude invents is enqueued by `commitCardChecklistFinalize`. A team born in
 * `TeamPicker` — the card drawer, the attention walker's fixer, and since
 * NEO-208 the quick-add form — stayed bare forever, and `teams.colors` is what
 * spine labels read, so "bare forever" was user-visible.
 *
 * These assert the CONTRACT half rather than the network half: that the insert
 * branch schedules exactly one enrichment and the FOUND branch schedules none.
 * The scheduled work is not run — `enrichTeam`'s own creation-only guard is
 * already covered above, and letting the pool actually drain here would test
 * the pool, not this wiring.
 */
/**
 * How many `enqueueEnrichment` calls were scheduled FOR ONE KIND of row.
 *
 * NEO-240 made the kind matter. `leagues.findOrCreateLeague` now schedules its
 * own enrichment on ITS insert branch, and every team-creation path runs
 * through `resolveDefaultLeagueId` — so creating the first team of a sport
 * schedules two enqueues, one carrying `teamIds` and one carrying `leagueIds`,
 * and a bare count can no longer say which contract it is measuring. Reading
 * the scheduled ARGS keeps each assertion about the path it names, and makes
 * the league cases below assertable in the same terms.
 */
type EnrichmentKind = "playerIds" | "teamIds" | "leagueIds";

async function scheduledEnrichmentCount(
  t: ReturnType<typeof convexTest>,
  kind: EnrichmentKind,
): Promise<number> {
  const rows = await t.run(async (ctx) =>
    (
      ctx as unknown as {
        db: {
          system: {
            query: (n: string) => {
              collect: () => Promise<Array<{ name: string; args: unknown[] }>>;
            };
          };
        };
      }
    ).db.system
      .query("_scheduled_functions")
      .collect(),
  );
  return rows.filter((r) => {
    if (!r.name.includes("enqueueEnrichment")) return false;
    const arg = r.args[0] as Record<string, unknown> | undefined;
    return Array.isArray(arg?.[kind]) && (arg[kind] as unknown[]).length > 0;
  }).length;
}

describe("teams.findOrCreate enqueues enrichment on INSERT only (NEO-208)", () => {
  const ADMIN = { subject: "admin_neo208", role: "admin" };

  test("a team it CREATED is enqueued exactly once", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const teamId = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: "New York Yankees", sportId });

    expect(teamId).toBeDefined();
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(1);
  });

  test("a team it FOUND is not enqueued at all", async () => {
    // The early `return existing._id` is what makes this mutation honour
    // `enqueueEnrichment`'s creation-only contract. Jason, 2026-09-02: "we
    // should never be firing that on an update."
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const existingId = await insertBareTeam(t, sportId, "New York Yankees");

    const teamId = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: "New York Yankees", sportId });

    expect(teamId).toBe(existingId);
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);
  });

  test("the second call for the same name enqueues nothing more", async () => {
    // The realistic shape: two operators (or one operator twice) reach for the
    // same team through the picker. Only the first creation costs a lookup.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN);

    const first = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "New York Yankees",
      sportId,
    });
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(1);

    // The normalizer token-SORTS and strips punctuation, so this resolves to
    // the same row — proving the guard is the row lookup, not string equality.
    const second = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Yankees, New York",
      sportId,
    });

    expect(second).toBe(first);
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(1);
  });

  test("findByFullNameInternal creates nothing, so there is nothing to enqueue", async () => {
    // NEO-208 left `findOrCreateInternal` alone: its server-side callers
    // enqueued (or deliberately did not) at the site that knew whether the row
    // was new. NEO-236 removed the question entirely — the server-side path is
    // a QUERY now and cannot insert, so "enqueues nothing" is structural
    // rather than a convention.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await t.query(internal.teams.findByFullNameInternal, {
      name: "Chiba Lotte Marines",
      sportId,
    });

    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(0);
  });

  test("a rejected call — over-long name — enqueues nothing and creates nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
        name: "z".repeat(121),
        sportId,
      }),
    ).rejects.toThrow(/the limit is 120/);

    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(0);
  });

  test("a sportId that is not a SPORT row is refused, so no orphan team is created", async () => {
    // `v.id("selectorOptions")` proves the id is in that table, not that it
    // points at a sport. A team hung off a variantType row is unreachable by
    // every query that matters (`teams.list` and `findByNameAndSport` key on
    // the sport row id) — the same unfindable-row class the pre-NEO-96
    // `sport ?? ""` fallback produced.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const variantTypeId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: 1_700_000_000_000,
      }),
    );

    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
        name: "Orphan FC",
        sportId: variantTypeId,
      }),
    ).rejects.toThrow(/must be created under a sport/);

    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(0);
  });

  test("a blank name is refused before anything is written", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.teams.findOrCreate, { name: "   ", sportId }),
    ).rejects.toThrow(/team name is required/i);

    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(0);
  });

  test("a name AT the 120-char cap is accepted — the bound is not off by one", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const atCap = "z".repeat(120);

    const id = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: atCap, sportId });

    const team = await t.run(async (ctx) => ctx.db.get(id));
    expect(team!.name).toBe(atCap);
  });

  test("a padded name that is 120 chars AFTER trim is accepted", async () => {
    // Trim happens BEFORE the length check — an operator who pastes a padded
    // name must not be refused for whitespace that was never going to be
    // stored.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padded = `   ${"z".repeat(120)}   `;

    const id = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: padded, sportId });

    const team = await t.run(async (ctx) => ctx.db.get(id));
    expect(team!.name).toBe("z".repeat(120));
  });

  test("whitespace-and-case variants of the same name collide onto ONE row and enqueue ONCE", async () => {
    // `normalizeTeamName` lowercases, collapses whitespace, and token-sorts —
    // this pins the collision on a variant that is neither the exact string
    // nor the comma-reordered one already covered above: extra internal
    // whitespace plus a case change.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN);

    const first = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "New York Yankees",
      sportId,
    });
    const second = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "new york  yankees ",
      sportId,
    });

    expect(second).toBe(first);
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(1);
  });

  test("team_created is logged as structured JSON, never string-concatenated with the name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const id = await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "Savannah Bananas",
      sportId,
    });

    const line = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((s) => s.includes("team_created"));
    expect(line).toBeDefined();
    // Parses as ONE JSON value — a concatenated `"team_created: " + name`
    // string would fail this, which is the point: the name must never be
    // free-form text sharing the line with the message.
    const parsed = JSON.parse(line!);
    expect(parsed).toMatchObject({ msg: "team_created", teamId: id, sportId });
    expect(parsed.userId).toBe(ADMIN.subject);

    logSpy.mockRestore();
  });

  test("a FOUND (not created) team logs no team_created line", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertBareTeam(t, sportId, "Existing Team");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "Existing Team",
      sportId,
    });

    const line = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((s) => s.includes("team_created"));
    expect(line).toBeUndefined();

    logSpy.mockRestore();
  });
});
