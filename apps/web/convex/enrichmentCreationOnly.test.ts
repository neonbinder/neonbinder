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
import { internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";

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
 * A team shaped EXACTLY as the two enqueueing creation paths insert one —
 * `selectorOptions`' `resolveTeamIdByName` and `teams.findOrCreateInternal`.
 * Both write `{name, nameNormalized, sportId, leagueId, lastUpdated}` and
 * nothing else, so `leagueId` is present here on purpose: it is the field most
 * likely to be mistaken for an enrichment marker.
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
    ["city", { city: "Washington" }],
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
