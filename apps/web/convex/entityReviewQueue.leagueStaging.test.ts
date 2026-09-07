/**
 * NEO-254 — a league the batch would have to CREATE becomes its own review
 * step, walked before the TEAM that needs it.
 *
 * Jason, preview test 2026-09-06: on a fresh deployment every hockey team row
 * offered `Create National Hockey League` — nothing is written until commit,
 * so each team re-asked the same question — and whichever pill was finally
 * pressed created a league carrying a name and nothing else. "The proper fix
 * is pulling league up before team as we'll need to fill in the rest of the
 * year information too … I'm ok putting extra steps in the user's face."
 *
 * This is NEO-236's career-team staging one level up, and the tests mirror
 * `entityReviewQueue.careerTeamStaging.test.ts` deliberately: the two
 * mechanisms are the same mechanism, and they must not drift.
 *
 *   1. **Staging** (`stageLeagueRowsImpl`, reached from `applyLookupResult`
 *      when a team's enrichment lands). A league we do not already hold gets a
 *      `league` row in the SAME batch carrying `source.kind === "leagueOf"`.
 *   2. **Ordering** (`walkOrder`, applied by `getBatch`). Insertion order puts
 *      the staged row AFTER its team — the team's own lookup created it — so
 *      the walk order is composed rather than stored, and the chain is
 *      league → team → player.
 *
 * Fixture conventions follow the career-team file: raw inserts rather than the
 * real fetch action, `ADMIN_IDENTITY` for the public surface, and the pool
 * enqueue asserted off `_scheduled_functions` rather than drained.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeLeagueName } from "./leagues";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "user_league_stage_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_league_stage_001",
  role: "admin",
};

const BATCH = "batch-league-stage";

async function seedSport(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      sportConfig: { skuCode: "HK", league: "NHL" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    sportId: Id<"selectorOptions">;
    kind: "player" | "team" | "league";
    name: string;
    status?: "pending" | "ready" | "error";
    enrichment?: Record<string, unknown>;
    decision?: Record<string, unknown>;
    source?: Record<string, unknown>;
  },
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.sportId,
      batchId: BATCH,
      createdByUserId: ADMIN_IDENTITY.subject,
      kind: opts.kind,
      name: opts.name,
      nameNormalized:
        opts.kind === "league"
          ? normalizeLeagueName(opts.name)
          : normalizeTeamName(opts.name),
      sportId: opts.sportId,
      status: opts.status ?? "pending",
      ...(opts.enrichment ? { enrichment: opts.enrichment as never } : {}),
      ...(opts.decision ? { decision: opts.decision as never } : {}),
      ...(opts.source ? { source: opts.source as never } : {}),
    }),
  );
}

async function insertLeague(
  t: ReturnType<typeof convexTest>,
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
      lastUpdated: Date.now(),
    }),
  );
}

/** Every league row this batch holds. */
async function leagueRows(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    (await ctx.db.query("entityReviewQueue").collect()).filter(
      (r) => r.kind === "league",
    ),
  );
}

// ===========================================================================
// Staging
// ===========================================================================

describe("NEO-254: a league the batch must create gets its own step", () => {
  test("a team's league suggestion stages ONE league row, linked to that team", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamRow = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Vancouver Canucks",
    });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: teamRow,
      status: "ready",
      enrichment: { league: "National Hockey League" },
    });

    const staged = await leagueRows(t);
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe("National Hockey League");
    expect(staged[0].source).toEqual({
      kind: "leagueOf",
      teamRowId: teamRow,
    });
    // Its own lookup is queued, so the step arrives pre-filled.
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.length).toBeGreaterThan(0);
  });

  test("a SECOND team naming the same league stages nothing more", async () => {
    // The whole point: the question is asked once for the batch, not once per
    // team. Thirty NHL teams produce one step.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const first = await insertRow(t, { sportId, kind: "team", name: "Vancouver Canucks" });
    const second = await insertRow(t, { sportId, kind: "team", name: "Calgary Flames" });

    for (const id of [first, second]) {
      await t.mutation(internal.entityReviewQueue.applyLookupResult, {
        id,
        status: "ready",
        enrichment: { league: "National Hockey League" },
      });
    }

    expect(await leagueRows(t)).toHaveLength(1);
  });

  test("a league we already hold stages nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertLeague(t, sportId, "National Hockey League");
    const teamRow = await insertRow(t, { sportId, kind: "team", name: "Vancouver Canucks" });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: teamRow,
      status: "ready",
      enrichment: { league: "National Hockey League" },
    });

    expect(await leagueRows(t)).toHaveLength(0);
  });

  test("a league we hold under an ALIAS stages nothing either", async () => {
    // The case that makes this worth `findLeagueByName` rather than an index
    // read: a sport that already answers to "NHL" must not be asked to create
    // it as a second league.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertLeague(t, sportId, "National Hockey League", ["NHL"]);
    const teamRow = await insertRow(t, { sportId, kind: "team", name: "Vancouver Canucks" });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: teamRow,
      status: "ready",
      enrichment: { league: "NHL" },
    });

    expect(await leagueRows(t)).toHaveLength(0);
  });

  test("a PLAYER row's enrichment never stages a league", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRow = await insertRow(t, { sportId, kind: "player", name: "Wayne Gretzky" });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: playerRow,
      status: "ready",
      enrichment: { league: "National Hockey League" },
    });

    expect(await leagueRows(t)).toHaveLength(0);
  });
});

// ===========================================================================
// Walk order — league, then team, then player
// ===========================================================================

describe("NEO-254: getBatch walks league before team before player", () => {
  test("the three-level chain comes back in order", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Wayne Gretzky",
      status: "ready",
    });
    const team = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Edmonton Oilers",
      status: "ready",
      source: { kind: "careerTeamOf", playerRowId: player },
    });
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      status: "ready",
      source: { kind: "leagueOf", teamRowId: team },
    });

    const rows = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.entityReviewQueue.getBatch, {
        selectorOptionId: sportId,
        batchId: BATCH,
      });
    // Insertion order was player, team, league — the reverse of the walk.
    expect(rows.map((r) => r._id)).toEqual([league, team, player]);
  });

  test("a staged row whose parent is gone keeps its own position", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    // A real parent, then deleted — the shape reconciliation can leave behind.
    const team = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Winnipeg Jets",
      status: "ready",
    });
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "World Hockey Association",
      status: "ready",
      source: { kind: "leagueOf", teamRowId: team },
    });
    await t.run(async (ctx) => ctx.db.delete(team));

    const rows = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.entityReviewQueue.getBatch, {
        selectorOptionId: sportId,
        batchId: BATCH,
      });
    expect(rows.map((r) => r._id)).toEqual([league]);
  });
});

// ===========================================================================
// Decisions
// ===========================================================================

describe("NEO-254: the New League step's decisions", () => {
  test("create stores the WHOLE record, not just a name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      status: "ready",
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.entityReviewQueue.recordDecision,
      {
        reviewRowId: league,
        action: "create",
        createLeague: {
          name: "National Hockey League",
          abbreviation: "NHL",
          level: "major",
          yearsActive: { from: 1917 },
          aliases: ["NHL", "National Hockey Lg"],
          wikidataId: "Q1215892",
        },
      },
    );

    const row = await t.run(async (ctx) => ctx.db.get(league));
    expect(row!.decision).toEqual({
      action: "create",
      createLeague: {
        name: "National Hockey League",
        abbreviation: "NHL",
        level: "major",
        yearsActive: { from: 1917 },
        // "NHL" survives; the alias equal to the row's own name would not.
        aliases: ["NHL", "National Hockey Lg"],
        wikidataId: "Q1215892",
      },
    });
  });

  test("the bounds are the SAME ones convex/leagues.ts enforces", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      status: "ready",
    });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: league,
        action: "create",
        createLeague: { name: "x".repeat(121) },
      }),
    ).rejects.toThrow(/121 characters/);

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: league,
        action: "create",
        createLeague: { name: "NHL", abbreviation: "x".repeat(17) },
      }),
    ).rejects.toThrow(/17 characters/);

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: league,
        action: "create",
        createLeague: { name: "NHL", yearsActive: { from: 1700 } },
      }),
    ).rejects.toThrow(/whole year between 1850/);

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: league,
        action: "create",
        createLeague: { name: "NHL", yearsActive: { from: 2000, to: 1999 } },
      }),
    ).rejects.toThrow(/cannot end before it starts/);
  });

  test("a malformed Wikidata id is DROPPED, not stored and not thrown on", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      status: "ready",
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.entityReviewQueue.recordDecision,
      {
        reviewRowId: league,
        action: "create",
        createLeague: { name: "NHL", wikidataId: "javascript:alert(1)" },
      },
    );

    const row = await t.run(async (ctx) => ctx.db.get(league));
    expect(
      (row!.decision as { createLeague?: { wikidataId?: string } }).createLeague
        ?.wikidataId,
    ).toBeUndefined();
  });

  test("link records the existing league, and refuses another sport's", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const otherSport = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const nhl = await insertLeague(t, sportId, "National Hockey League");
    const mlb = await insertLeague(t, otherSport, "Major League Baseball");
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      status: "ready",
    });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: league,
        action: "link",
        linkedLeagueId: mlb,
      }),
    ).rejects.toThrow(/doesn't match/);

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: league,
      action: "link",
      linkedLeagueId: nhl,
    });
    const row = await t.run(async (ctx) => ctx.db.get(league));
    expect(row!.decision).toEqual({ action: "link", linkedLeagueId: nhl });
  });

  test("bulk 'add remaining players as new' never decides a league row", async () => {
    /*
     * The rule Jason set for teams, applied to leagues, and it matters more:
     * a team's step is the only place its League is answered, and a league's
     * step is the only place its abbreviation, level, years and aliases are.
     * Bulk-creating leagues would reintroduce the name-only league this whole
     * feature exists to remove, through the one door still open.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Wayne Gretzky",
      status: "ready",
    });
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      status: "ready",
    });

    const decided = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
        selectorOptionId: sportId,
        batchId: BATCH,
      });

    expect(decided).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(player)))!.decision).toEqual({
      action: "create",
    });
    expect((await t.run(async (ctx) => ctx.db.get(league)))!.decision).toBeUndefined();
  });
});

// ===========================================================================
// Commit — the league is created ONCE, with everything the step collected
// ===========================================================================

describe("NEO-254: the commit prelude creates a staged league once", () => {
  /** sport → year → setName → variantType, so the commit has somewhere to land. */
  async function seedSetUnder(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
  ): Promise<Id<"selectorOptions">> {
    return t.run(async (ctx) => {
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Upper Deck",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        parentId: setNameId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(setNameId, { children: [variantTypeId] });
      await ctx.db.patch(sportId, { children: [setNameId] });
      return variantTypeId;
    });
  }

  function card(overrides: { cardNumber: string; teams: string[] }) {
    return {
      cardNumber: overrides.cardNumber,
      cardName: "Card",
      team: undefined,
      teams: overrides.teams,
      players: [],
      attributes: [],
      isRookie: false,
      isRelic: false,
      printRun: undefined,
      autographType: undefined,
      cardVariation: undefined,
      platformData: {},
      unmatched: undefined,
    };
  }

  /**
   * Two teams, one league step, all three decided — the exact shape Jason's
   * hockey batch produces once the New League step is answered.
   */
  async function seedTwoTeamsOneLeague(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    variantTypeId: Id<"selectorOptions">,
    leagueDecision: Record<string, unknown>,
  ) {
    const mk = async (
      kind: "team" | "league",
      name: string,
      decision: Record<string, unknown>,
    ) =>
      t.run(async (ctx) =>
        ctx.db.insert("entityReviewQueue", {
          selectorOptionId: variantTypeId,
          batchId: BATCH,
          createdByUserId: ADMIN_IDENTITY.subject,
          kind,
          name,
          nameNormalized:
            kind === "league" ? normalizeLeagueName(name) : normalizeTeamName(name),
          sportId,
          status: "ready" as const,
          decision: decision as never,
        }),
      );
    await mk("league", "National Hockey League", leagueDecision);
    // Both teams name the league by the SAME string the step was raised for,
    // which is what `create.leagueName` carries out of the New Team step.
    await mk("team", "Vancouver Canucks", {
      action: "create",
      create: { location: "Vancouver", name: "Canucks", leagueName: "National Hockey League" },
    });
    await mk("team", "Calgary Flames", {
      action: "create",
      create: { location: "Calgary", name: "Flames", leagueName: "National Hockey League" },
    });
  }

  async function commitBoth(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    variantTypeId: Id<"selectorOptions">,
  ) {
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [
          card({ cardNumber: "1", teams: ["Vancouver Canucks"] }),
          card({ cardNumber: "2", teams: ["Calgary Flames"] }),
        ],
        batchId: BATCH,
      });
    return t.run(async (ctx) => ({
      leagues: await ctx.db.query("leagues").collect(),
      teams: await ctx.db.query("teams").collect(),
    }));
  }

  test("one league row, carrying the whole record, and BOTH teams on it", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const variantTypeId = await seedSetUnder(t, sportId);
    await seedTwoTeamsOneLeague(t, sportId, variantTypeId, {
      action: "create",
      createLeague: {
        name: "National Hockey League",
        abbreviation: "NHL",
        level: "major",
        yearsActive: { from: 1917 },
        aliases: ["NHL"],
        wikidataId: "Q1215892",
      },
    });

    const { leagues, teams } = await commitBoth(t, sportId, variantTypeId);

    expect(leagues).toHaveLength(1);
    expect(leagues[0]).toMatchObject({
      name: "National Hockey League",
      abbreviation: "NHL",
      level: "major",
      yearsActive: { from: 1917 },
      aliases: ["NHL"],
      externalIds: { wikidataId: "Q1215892" },
    });
    expect(teams).toHaveLength(2);
    for (const team of teams) {
      expect(team.leagueId).toBe(leagues[0]._id);
    }
  });

  test("a LINKED league is used as is — nothing is created", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const variantTypeId = await seedSetUnder(t, sportId);
    const existing = await insertLeague(t, sportId, "National Hockey League");
    await seedTwoTeamsOneLeague(t, sportId, variantTypeId, {
      action: "link",
      linkedLeagueId: existing,
    });

    const { leagues, teams } = await commitBoth(t, sportId, variantTypeId);

    expect(leagues.map((l) => l._id)).toEqual([existing]);
    for (const team of teams) expect(team.leagueId).toBe(existing);
  });

  test("a SKIPPED league leaves the teams with no league at all", async () => {
    /*
     * "Skip — no league" is an answer about the team, not a judgement about
     * the name: these teams belong to no league, and the sport default must
     * not reassert itself. It is also NOT recorded in `entityReviewSkips` —
     * that table means "never ask me about this string again", which would
     * suppress the league on every later fetch of the set.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const variantTypeId = await seedSetUnder(t, sportId);
    await seedTwoTeamsOneLeague(t, sportId, variantTypeId, { action: "skip" });

    const { leagues, teams } = await commitBoth(t, sportId, variantTypeId);

    expect(leagues).toHaveLength(0);
    for (const team of teams) expect(team.leagueId).toBeUndefined();
    const skips = await t.run(async (ctx) =>
      ctx.db.query("entityReviewSkips").collect(),
    );
    expect(skips.map((s) => s.name)).not.toContain("National Hockey League");
  });

  test("an existing league keeps ITS values — the step only fills gaps", async () => {
    // `findOrCreateLeague` gap-fills, so a second batch naming the same league
    // cannot re-flatten what the first operator answered.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const variantTypeId = await seedSetUnder(t, sportId);
    const existing = await t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "National Hockey League",
        nameNormalized: normalizeLeagueName("National Hockey League"),
        sportId,
        abbreviation: "NHL",
        yearsActive: { from: 1917, to: 2026 },
        lastUpdated: Date.now(),
      }),
    );
    await seedTwoTeamsOneLeague(t, sportId, variantTypeId, {
      action: "create",
      createLeague: {
        name: "National Hockey League",
        abbreviation: "N.H.L.",
        level: "major",
        yearsActive: { from: 1800 },
      },
    });

    const { leagues } = await commitBoth(t, sportId, variantTypeId);

    expect(leagues).toHaveLength(1);
    expect(leagues[0]._id).toBe(existing);
    // Held values survive…
    expect(leagues[0].abbreviation).toBe("NHL");
    expect(leagues[0].yearsActive).toEqual({ from: 1917, to: 2026 });
    // …and the blank one is filled.
    expect(leagues[0].level).toBe("major");
  });
});
