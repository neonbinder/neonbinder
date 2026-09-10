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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { __resetEspnTeamListCache } from "./adapters/espn";
import { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";
import { normalizeLeagueName } from "./leagues";
import { drainScheduled } from "../lib/testing/drain-scheduled";

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
    if (u.includes("site.web.api.espn.com")) {
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
 * `selectorOptions`' commit prelude `createTeamFromOperatorInput` and
 * `teams.findOrCreate` behind TeamPicker / MissingTeamFixer / Team
 * Management. All of them write `{name, location?, nameNormalized, sportId,
 * leagueId, lastUpdated}` and nothing else, so `leagueId` is present here on
 * purpose: it is the field most likely to be mistaken for an enrichment
 * marker.
 *
 * NEO-236: `location` joined that list. It is the first half of the creation
 * form ("Location & Team Name should be the input"), so a team created for any
 * real franchise arrives carrying one — which is why it is passable here, and
 * why it MUST NOT be an enrichment marker. See the location case below.
 */
async function insertBareTeam(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
  location?: string,
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
      ...(location ? { location } : {}),
      nameNormalized: normalizeTeamName(
        location ? `${location} ${name}` : name,
      ),
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

// NEO-236: `fetchEspnTeamList` memoises per league path for the life of the
// module, and these cases stub different ESPN bodies for the same league.
// Without this, one test's roster is served to the next.
beforeEach(() => {
  __resetEspnTeamListCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetEspnTeamListCache();
});

describe("enrichTeam — creation-only (NEO-203)", () => {
  // Each marker is checked on its own: they are OR'd in the guard, and a
  // team in the wild carries whichever one its source happened to answer.
  const markerCases: Array<[string, Record<string, unknown>]> = [
    // NOT `location` — NEO-236 made it a CREATION input, so it is asserted
    // below to be a non-marker rather than listed here.
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

  /**
   * NEO-236 — `location` is a CREATION input, so it must not be a marker.
   *
   * The security review caught this as HIGH, and the failure it describes is
   * the same one the header warns about, reached through the front door: an
   * operator types "San Diego" + "Padres" into the create form, the row is
   * born with a `location`, and the guard reads that as "already enriched".
   * The team then never gets colours, years, `wikidataId` or `espnId` — with
   * nothing on screen and nothing in the logs to say so. Every team created
   * for a real franchise takes that path, so it would have been most of them.
   *
   * Sibling of the bare-team pin above, and it belongs beside it: `location`
   * is now in the same category as `leagueId` and `lastUpdated`.
   */
  test("a team created WITH a location is still enriched — location is a creation input, not a marker", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await insertBareTeam(t, sportId, "Padres", "San Diego");

    const stub = countingFetch();
    vi.stubGlobal("fetch", stub.fetch);

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    expect(stub.calls()).toBeGreaterThan(0);
  });

  /**
   * The other half of the trade. Dropping the marker means the LOOKUP runs for
   * a team that has a location; it must not mean the lookup is allowed to
   * overwrite the operator's answer. That guarantee lives in
   * `applyEnrichmentInternal`'s gap-fill (and is pinned directly in
   * `teams.applyEnrichmentInternal.test.ts`) — asserted here too, because the
   * two halves are what make dropping the marker safe rather than a trade.
   */
  test("...and the operator's location survives the enrichment that now runs", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await insertBareTeam(t, sportId, "Angels", "Los Angeles");

    // ESPN answers "Anaheim" for this franchise. The row already has a
    // location, so the gap-fill declines it and the name is untouched.
    vi.stubGlobal("fetch", (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("site.web.api.espn.com")) {
        return new Response(
          JSON.stringify({
            sports: [
              {
                leagues: [
                  {
                    teams: [
                      {
                        team: {
                          id: "3",
                          displayName: "Los Angeles Angels",
                          location: "Anaheim",
                          color: "ba0021",
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ results: { bindings: [] } }), {
        status: 200,
      });
    }) as unknown as typeof fetch);

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const team = await getTeam(t, teamId);
    expect(team!.location).toBe("Los Angeles");
    expect(team!.name).toBe("Angels");
    // But the enrichment that DID have something new to say still landed.
    expect(team!.externalIds?.espnId).toBe("3");
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
    // The second team reuses the league, so the league is never enqueued twice.
    //
    // NEO-254: the `teamIds` counts here used to be 1 and 2 alongside these.
    // Team enrichment no longer fires at creation, so they are 0 — and they
    // stay in this test deliberately rather than moving out of it, because
    // this is the case that could most easily restore one by accident: the
    // team path and the league path run in the same mutation, and the league
    // half must keep firing while the team half does not.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity({ subject: "admin_neo240", role: "admin" });

    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "New York Yankees",
      sportId,
    });
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);
    expect(await scheduledEnrichmentCount(t, "leagueIds")).toBe(1);

    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Boston Red Sox",
      sportId,
    });
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);
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

/**
 * NEO-254 — NO TEAM CREATION PATH ENRICHES, AND THAT IS THE ASSERTION.
 *
 * These tests are the inverse of what they were, and the inversion is the
 * point. Jason, 2026-09-10: "we do not need to enrich anymore on team creation
 * because all major teams are created already; if at some point there is a
 * rare case of needing to create a team it will need to be manual."
 *
 * The block used to pin NEO-208's claim — that `teams.findOrCreate` schedules
 * exactly one `enqueueEnrichment` on its insert branch and none on its found
 * branch — alongside a hand-rolled mirror of the commit prelude's
 * insert-vs-found bookkeeping for `prelude.enrichmentTeamIds`. Neither claim
 * has a subject any more: the enqueue is gone from `teams.findOrCreate` and
 * the list is gone from the prelude, so asserting "1 on insert" would assert a
 * behaviour the product deliberately dropped.
 *
 * What replaces them is stronger than a deletion, because the cost of
 * regressing is concrete rather than stylistic. `enrichTeam` ends in
 * `teamColorSources.resolveTeamColors`, a live ~1.5MB read of
 * teamcolorcodes.com's sitemap, and it shares one 5-wide lane
 * (`convex/wikidataPool.ts`) with the review wizard's own Wikidata lookups.
 * Put back behind a creation path it is a bulk loop in front of that lane —
 * which is what left the wizard sitting on "N still looking up" and cost eight
 * E2E flows. So every creation path is pinned at ZERO scheduled team
 * enrichments, and the operator's Discover button is pinned at one.
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

describe("no team-creation path enqueues enrichment (NEO-254)", () => {
  const ADMIN = { subject: "admin_neo208", role: "admin" };

  test("a team `findOrCreate` CREATED is not enqueued", async () => {
    // The row is still created — that half is unchanged and asserted here so
    // "0 enqueues" cannot pass by the mutation having quietly stopped working.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const teamId = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: "New York Yankees", sportId });

    expect(teamId).toBeDefined();
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);
    // And it leaves BARE, which is the product decision made visible: colours,
    // an ESPN location and Wikidata years now arrive only via Discover.
    const created = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(created?.colors).toBeUndefined();
    expect(created?.location).toBeUndefined();
    expect(created?.yearsActive).toBeUndefined();
    expect(created?.externalIds).toBeUndefined();
  });

  test("a team it FOUND is not enqueued either", async () => {
    // Unchanged by NEO-254 and kept deliberately: the found branch has always
    // been the one that must not fire, and it is the assertion that survives
    // if the creation leg is ever restored.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const existingId = await insertBareTeam(t, sportId, "New York Yankees");

    const teamId = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: "New York Yankees", sportId });

    expect(teamId).toBe(existingId);
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);
  });

  test("two calls for the same name still resolve to one row, and still enqueue nothing", async () => {
    // The realistic shape: two operators (or one operator twice) reach for the
    // same team through the picker. The dedupe claim is what this test is for;
    // the enqueue count rides along as the regression pin.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN);

    const first = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "New York Yankees",
      sportId,
    });
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);

    // The normalizer token-SORTS and strips punctuation, so this resolves to
    // the same row — proving the guard is the row lookup, not string equality.
    const second = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Yankees, New York",
      sportId,
    });

    expect(second).toBe(first);
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);
  });

  test("findByFullNameInternal creates nothing, so there is nothing to enqueue", async () => {
    // NEO-236 made the server-side path a QUERY, so "creates nothing" is
    // structural rather than a convention — which is the half of this that
    // still matters now that no creation path enqueues either.
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

  test("whitespace-and-case variants of the same name collide onto ONE row", async () => {
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
    expect(await scheduledEnrichmentCount(t, "teamIds")).toBe(0);
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

  test("the ONLY remaining `teamIds` enqueue in the codebase is the operator's Discover", async () => {
    /*
     * Structural, and on purpose. The behavioural half cannot be asserted here
     * — `wikidataPool.enqueueEnrichment` reaches `Workpool.enqueueAction` and
     * convex-test cannot register the workpool component, the same reason
     * convex/leagues.management.test.ts reads source for its own force
     * assertion.
     *
     * What this pins is the invariant the counting tests above can only pin
     * one call site at a time: that `teams.findOrCreate` carries no enqueue,
     * that `commitCardChecklistFinalize` carries no team enqueue, and that
     * `teams.enrichFromWikidata` still does. A future creation path that
     * enqueues would slip past a per-site count; it cannot slip past a scan of
     * both files.
     */
    const teamsSrc = readFileSync(join(__dirname, "teams.ts"), "utf8");
    const findOrCreate = teamsSrc.slice(
      teamsSrc.indexOf("export const findOrCreate"),
      teamsSrc.indexOf("export const list"),
    );
    expect(findOrCreate).not.toContain("internal.wikidataPool.enqueueEnrichment");

    const discover = teamsSrc.slice(
      teamsSrc.indexOf("export const enrichFromWikidata"),
    );
    expect(discover).toContain("teamIds: [args.id]");
    expect(discover).toContain("force: true");

    // The commit path: no `teamIds` enqueue and no list feeding one.
    const selectorSrc = readFileSync(
      join(__dirname, "selectorOptions.ts"),
      "utf8",
    );
    expect(selectorSrc).not.toContain("enrichmentTeamIds:");
    expect(selectorSrc).not.toContain("internal.wikidataPool.enqueueEnrichment");
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

/**
 * NEO-220 — `players.findOrCreate` joins the enqueueing creation paths.
 *
 * The exact shape of the block above, one table over, and for the same reason:
 * this was the LAST player-creation path with no enrichment route at all. A
 * reviewed player arrives already enriched (`processEntityReviewQueue` →
 * `lookupPlayerEnrichment`), the commit prelude inserts already-enriched rows,
 * and `createByAdmin` enqueues. A player born in `PlayerPicker` — the card
 * drawer, the attention walker's fixer, and since NEO-220 the quick-add form —
 * stayed bare forever: no career teams, no Hall of Fame flag, no Wikidata id,
 * and no route back, because enrichment fires only at creation and an explicit
 * admin force is the sole re-enrich path.
 *
 * The CONTRACT half, again: the insert branch schedules exactly one enrichment
 * and the FOUND branch schedules none. `enrichPlayer`'s own creation-only
 * guard is covered above; draining the pool here would test the pool.
 */
describe("players.findOrCreate enqueues enrichment on INSERT only (NEO-220)", () => {
  const ADMIN = { subject: "admin_neo220", role: "admin" };

  test("a player it CREATED is enqueued exactly once", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const playerId = await t
      .withIdentity(ADMIN)
      .mutation(api.players.findOrCreate, { name: "Shohei Ohtani", sportId });

    expect(playerId).toBeDefined();
    expect(await scheduledEnrichmentCount(t, "playerIds")).toBe(1);
    // And it carries the id it just inserted, not some other row.
    const rows = await t.run(async (ctx) => ctx.db.query("players").collect());
    expect(rows.map((r) => r._id)).toEqual([playerId]);

    // Read the queue FIRST, then settle it. See drain-scheduled.ts: an
    // undrained scheduled function keeps running into worker teardown, and the
    // console log it emits there races the shutdown and fails the whole job
    // while every test still reports green.
    await drainScheduled(t);
  });

  test("a player it FOUND is not enqueued at all", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Shohei Ohtani",
        nameNormalized: normalizePlayerName("Shohei Ohtani"),
        sportId,
        lastUpdated: 1_700_000_000_000,
      }),
    );

    await t
      .withIdentity(ADMIN)
      .mutation(api.players.findOrCreate, { name: "Shohei Ohtani", sportId });

    expect(await scheduledEnrichmentCount(t, "playerIds")).toBe(0);
    await drainScheduled(t);
  });

  test("the second call for the same name enqueues nothing more", async () => {
    // The idempotency the picker relies on: an operator who types the same
    // rookie into two cards must not queue two lookups for one player.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN);

    const first = await asAdmin.mutation(api.players.findOrCreate, {
      name: "Shohei Ohtani",
      sportId,
    });
    expect(await scheduledEnrichmentCount(t, "playerIds")).toBe(1);

    // Normalization folds the punctuation and the reordering, so this is the
    // SAME row — see `normalizePlayerName`.
    const second = await asAdmin.mutation(api.players.findOrCreate, {
      name: "  Ohtani, Shohei  ",
      sportId,
    });
    expect(second).toBe(first);
    expect(await scheduledEnrichmentCount(t, "playerIds")).toBe(1);
    await drainScheduled(t);
  });

  test("a rejected call — over-long name — enqueues nothing and creates nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await expect(
      t.withIdentity(ADMIN).mutation(api.players.findOrCreate, {
        name: "z".repeat(121),
        sportId,
      }),
    ).rejects.toThrow(/the limit is 120/);

    expect(await scheduledEnrichmentCount(t, "playerIds")).toBe(0);
    expect(
      await t.run(async (ctx) => ctx.db.query("players").collect()),
    ).toHaveLength(0);
    await drainScheduled(t);
  });

  test("a sportId that is not a SPORT row is refused, so no orphan player is created", async () => {
    // Same class of unfindable row the team twin refuses: `list`, `search` and
    // `findByNameAndSport` all key on the sport row id, so a player hung off a
    // variantType row is unreachable by every query that matters.
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
      t.withIdentity(ADMIN).mutation(api.players.findOrCreate, {
        name: "Orphan Guy",
        sportId: variantTypeId,
      }),
    ).rejects.toThrow(/must be created under a sport/);

    expect(await scheduledEnrichmentCount(t, "playerIds")).toBe(0);
    expect(
      await t.run(async (ctx) => ctx.db.query("players").collect()),
    ).toHaveLength(0);
    await drainScheduled(t);
  });

  test("a non-admin caller enqueues nothing — the gate runs before the insert", async () => {
    // The cost vector this gate exists for: pooled Wikidata work bounded by
    // concurrency, not by total queued volume.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await expect(
      t
        .withIdentity({ subject: "member_neo220" })
        .mutation(api.players.findOrCreate, { name: "Shohei Ohtani", sportId }),
    ).rejects.toThrow(/Admin access required/);

    expect(await scheduledEnrichmentCount(t, "playerIds")).toBe(0);
    await drainScheduled(t);
  });
});
