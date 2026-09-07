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
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});
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
    /**
     * Whether the team that RAISED the step also tapped a league pill on its
     * own step. False is the realistic shape behind a skip: the operator said
     * "no league" and never touched the team's pills, so nothing explicit
     * overrides the suggestion.
     */
    raiserAnsweredLeague = true,
  ) {
    const mk = async (
      kind: "team" | "league",
      name: string,
      decision: Record<string, unknown>,
      extra: Record<string, unknown> = {},
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
          ...extra,
        }),
      );
    // Both teams name the league by the SAME string the step was raised for,
    // which is what `create.leagueName` carries out of the New Team step.
    const canucks = await mk("team", "Vancouver Canucks", {
      action: "create",
      create: {
        location: "Vancouver",
        name: "Canucks",
        ...(raiserAnsweredLeague
          ? { leagueName: "National Hockey League" }
          : {}),
      },
    });
    const flames = await mk("team", "Calgary Flames", {
      action: "create",
      create: { location: "Calgary", name: "Flames", leagueName: "National Hockey League" },
    });
    // Staged for the Canucks — which is what scopes a skip to them.
    await mk("league", "National Hockey League", leagueDecision, {
      source: { kind: "leagueOf", teamRowId: canucks },
    });
    return { canucks, flames };
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

  test("a SKIP is scoped to the team that raised the step", async () => {
    /*
     * "Skip — this team has no league" is an answer about ONE team. Batch-wide
     * it would be a much larger claim than the button makes: a step raised by
     * the Canucks would silently strip the league from every other team that
     * happened to name it, none of which the operator was looking at.
     *
     * Here the Canucks raised the step and skipped it, so they get no league.
     * The Flames named the same league explicitly on their OWN step, and that
     * answer stands.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const variantTypeId = await seedSetUnder(t, sportId);
    await seedTwoTeamsOneLeague(
      t,
      sportId,
      variantTypeId,
      { action: "skip" },
      // The Canucks raised the step and skipped it; they never touched their
      // own league pills, which is what leaves the suggestion to be silenced.
      false,
    );

    const { leagues, teams } = await commitBoth(t, sportId, variantTypeId);

    const canucks = teams.find((x) => x.name === "Canucks")!;
    const flames = teams.find((x) => x.name === "Flames")!;
    expect(canucks.leagueId).toBeUndefined();
    expect(leagues).toHaveLength(1);
    expect(flames.leagueId).toBe(leagues[0]._id);

    // And NOT recorded as a suppressed name: `entityReviewSkips` means "never
    // ask me about this string again", which would hide the league on every
    // later fetch of the set.
    const skips = await t.run(async (ctx) =>
      ctx.db.query("entityReviewSkips").collect(),
    );
    expect(skips.map((x) => x.name)).not.toContain("National Hockey League");
  });

  test("a skipped step never overrules the team's own explicit answer", async () => {
    /*
     * The skip suppresses the SUGGESTION — that is all it was ever about. An
     * answer the operator then gave on the team's own step is later and more
     * specific, and discarding it would be the skip overruling the very
     * operator who made it.
     *
     * Both explicit shapes are covered: an existing league picked by id, and a
     * different league typed by name.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const variantTypeId = await seedSetUnder(t, sportId);
    const ahl = await insertLeague(t, sportId, "American Hockey League");

    const mk = async (
      kind: "team" | "league",
      name: string,
      decision: Record<string, unknown>,
      extra: Record<string, unknown> = {},
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
          enrichment: { league: "National Hockey League" } as never,
          ...extra,
        }),
      );

    // Picked an EXISTING league by id, after skipping the suggestion.
    const byId = await mk("team", "Vancouver Canucks", {
      action: "create",
      create: { location: "Vancouver", name: "Canucks", leagueId: ahl },
    });
    // Typed a DIFFERENT league by name, after skipping the suggestion.
    const byName = await mk("team", "Calgary Flames", {
      action: "create",
      create: {
        location: "Calgary",
        name: "Flames",
        leagueName: "World Hockey Association",
      },
    });
    await mk("league", "National Hockey League", { action: "skip" }, {
      source: { kind: "leagueOf", teamRowId: byId },
    });
    await mk("league", "National Hockey League", { action: "skip" }, {
      source: { kind: "leagueOf", teamRowId: byName },
    });

    const { leagues, teams } = await commitBoth(t, sportId, variantTypeId);

    const canucks = teams.find((x) => x.name === "Canucks")!;
    const flames = teams.find((x) => x.name === "Flames")!;
    expect(canucks.leagueId).toBe(ahl);
    const wha = leagues.find((l) => l.name === "World Hockey Association");
    expect(wha).toBeTruthy();
    expect(flames.leagueId).toBe(wha!._id);
    // The skipped suggestion itself was never created.
    expect(leagues.map((l) => l.name)).not.toContain("National Hockey League");
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

// ===========================================================================
// The pool's league lookup — the step arrives pre-filled
// ===========================================================================

describe("NEO-254: a staged league step is looked up like any other row", () => {
  const uriBinding = (qid: string) => ({
    type: "uri",
    value: `http://www.wikidata.org/entity/${qid}`,
  });
  const literalBinding = (value: string) => ({ type: "literal", value });
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  /**
   * Answers the ONE query a known-QID league lookup makes.
   *
   * `throwOnFetch` is the failure path: a lookup that dies must settle the row
   * to `error` rather than leave it `pending` forever (NEO-99's invariant), and
   * it must never block the wizard.
   */
  function stubLeagueDetail(opts: {
    abbreviation?: string;
    inception?: string;
    country?: string;
    throwOnFetch?: boolean;
  }): typeof fetch {
    return (async (url: string | URL) => {
      if (opts.throwOnFetch) throw new Error("wikidata unreachable");
      const u = String(url);
      if (!u.includes("query.wikidata.org")) {
        throw new Error(`unexpected fetch url: ${u}`);
      }
      const row: Record<string, unknown> = {};
      if (opts.abbreviation) row.shortName = literalBinding(opts.abbreviation);
      if (opts.inception) row.inception = literalBinding(opts.inception);
      if (opts.country) row.countryLabel = literalBinding(opts.country);
      return jsonResponse({ results: { bindings: [row] } });
    }) as unknown as typeof fetch;
  }

  test("the team's lookup carries the league QID onto the staged row", async () => {
    // Linkage, not a guess: the staged step's own lookup then READS that
    // record rather than searching EntitySearch for "National Hockey League",
    // which can land on a video game or a defunct namesake.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamRow = await insertRow(t, { sportId, kind: "team", name: "Vancouver Canucks" });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: teamRow,
      status: "ready",
      enrichment: {
        league: "National Hockey League",
        leagueWikidataId: "Q1215892",
      },
    });

    const staged = await leagueRows(t);
    expect(staged[0].source).toEqual({
      kind: "leagueOf",
      teamRowId: teamRow,
      wikidataId: "Q1215892",
    });
  });

  test("the lookup's result lands on the row, and country is DROPPED", async () => {
    /*
     * `enrichmentValidator` is a closed object: a field the lookup returns and
     * the row has no column for is a runtime refusal on every query that
     * returns the row — the wizard failing to open. `country` is exactly that
     * field (returned for context; `leagues` has no column for it), and this
     * pins that it never reaches the row.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      source: { kind: "leagueOf", teamRowId: await insertRow(t, {
        sportId, kind: "team", name: "Vancouver Canucks",
      }), wikidataId: "Q1215892" },
    });

    vi.stubGlobal(
      "fetch",
      stubLeagueDetail({
        abbreviation: "NHL",
        inception: "1917-11-26T00:00:00Z",
        country: "Canada",
      }),
    );
    await t.action(internal.adapters.wikidata.runEntityReviewLookup, {
      rowId: league,
    });

    const row = await t.run(async (ctx) => ctx.db.get(league));
    expect(row!.status).toBe("ready");
    expect(row!.enrichment).toEqual({
      wikidataId: "Q1215892",
      abbreviation: "NHL",
      yearsActive: { from: 1917, to: undefined },
    });
    expect("country" in (row!.enrichment ?? {})).toBe(false);
  });

  test("a failed lookup settles the row to error, never leaves it pending", async () => {
    // NEO-99's invariant: a review row can never be stranded on `pending`. The
    // step still opens — with the name only, and its details section open,
    // which is the New League form's "there is work to do" state.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "World Hockey Association",
    });

    vi.stubGlobal("fetch", stubLeagueDetail({ throwOnFetch: true }));
    await t.action(internal.adapters.wikidata.runEntityReviewLookup, {
      rowId: league,
    });

    const row = await t.run(async (ctx) => ctx.db.get(league));
    expect(row!.status).toBe("error");
    expect(row!.enrichment).toBeUndefined();
  });
});

// ===========================================================================
// One league, two names
// ===========================================================================

describe("NEO-254: the batch dedupes a league by QID as well as by name", () => {
  test("ESPN's 'NHL' and Wikidata's full name stage ONE step", async () => {
    /*
     * `normalizeLeagueName` does not token-sort and cannot know these are the
     * same competition, so keyed on the name alone this produced two steps —
     * and two `leagues` rows for one league, which is the duplication the
     * whole feature exists to prevent. The QID is the identity Wikidata itself
     * asserts, so a match on either key means the batch already holds it.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const first = await insertRow(t, { sportId, kind: "team", name: "Vancouver Canucks" });
    const second = await insertRow(t, { sportId, kind: "team", name: "Calgary Flames" });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: first,
      status: "ready",
      enrichment: { league: "NHL", leagueWikidataId: "Q1215892" },
    });
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: second,
      status: "ready",
      enrichment: {
        league: "National Hockey League",
        leagueWikidataId: "Q1215892",
      },
    });

    const staged = await leagueRows(t);
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe("NHL");
  });

  test("two DIFFERENT leagues still get a step each", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const first = await insertRow(t, { sportId, kind: "team", name: "Vancouver Canucks" });
    const second = await insertRow(t, { sportId, kind: "team", name: "Abbotsford Canucks" });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: first,
      status: "ready",
      enrichment: { league: "National Hockey League", leagueWikidataId: "Q1215892" },
    });
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: second,
      status: "ready",
      enrichment: { league: "American Hockey League", leagueWikidataId: "Q564289" },
    });

    expect(await leagueRows(t)).toHaveLength(2);
  });
});

// ===========================================================================
// Resume reconciliation, and a league typed on a team step
// ===========================================================================

describe("NEO-254: a resume drops an orphaned league step", () => {
  /** `startBatch` with an incoming set, which is what a resume looks like. */
  async function resume(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    incoming: { playerNames?: string[]; teamNames?: string[] },
  ) {
    return t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: incoming.playerNames ?? [],
      teamNames: incoming.teamNames ?? [],
    });
  }

  test("a league staged for a team that was reconciled away is dropped", async () => {
    /*
     * A staged row is never in `incoming` — no card carries its name — so it is
     * exempt from the ordinary drop test and has to be judged by its parent.
     * Left behind it is undecided, unowned, and blocks "all reviewed" forever.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const team = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Vancouver Canucks",
      status: "ready",
    });
    await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      status: "ready",
      source: { kind: "leagueOf", teamRowId: team },
    });

    // The Canucks are no longer on the checklist.
    await resume(t, sportId, { teamNames: ["Calgary Flames"] });

    expect(await leagueRows(t)).toHaveLength(0);
  });

  test("a league under a LIVE staged team survives — survivors are transitive", async () => {
    /*
     * The trap a naive `survivingRowIds` check falls into: the team here is
     * itself staged (off a player's career list), so it is not in `incoming`
     * either. Judged against that set directly, every league under a live
     * staged team would be deleted.
     */
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
    await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      status: "ready",
      source: { kind: "leagueOf", teamRowId: team },
    });

    // Gretzky is still on the checklist, so his whole chain stands.
    await resume(t, sportId, { playerNames: ["Wayne Gretzky"] });

    expect(await leagueRows(t)).toHaveLength(1);
  });

  test("a DECIDED league survives even when its team is gone", async () => {
    // Every decided row is kept — the operator ruled on it, and the prelude
    // will still honour that ruling.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const team = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Vancouver Canucks",
      status: "ready",
    });
    await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      status: "ready",
      source: { kind: "leagueOf", teamRowId: team },
      decision: { action: "create", createLeague: { name: "National Hockey League" } },
    });

    await resume(t, sportId, { teamNames: ["Calgary Flames"] });

    expect(await leagueRows(t)).toHaveLength(1);
  });
});

describe("NEO-254: a league typed on a team step gets a step of its own", () => {
  test("stageLeagueRows raises it, and a second call adds nothing", async () => {
    /*
     * Without this the commit resolved a typed league through a bare
     * `findOrCreateLeague(name)` — the name-only league this whole feature
     * exists to stop. Idempotent, because the wizard fires it on every patch.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const team = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Vancouver Canucks",
      status: "ready",
    });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    expect(
      await asAdmin.mutation(api.entityReviewQueue.stageLeagueRows, {
        reviewRowId: team,
        leagueName: "World Hockey Association",
      }),
    ).toBe(1);
    expect(
      await asAdmin.mutation(api.entityReviewQueue.stageLeagueRows, {
        reviewRowId: team,
        leagueName: "World Hockey Association",
      }),
    ).toBe(0);

    const staged = await leagueRows(t);
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe("World Hockey Association");
    expect(staged[0].source).toEqual({ kind: "leagueOf", teamRowId: team });
  });

  test("a league the sport already holds raises nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertLeague(t, sportId, "National Hockey League");
    const team = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Vancouver Canucks",
      status: "ready",
    });

    expect(
      await t.withIdentity(ADMIN_IDENTITY).mutation(
        api.entityReviewQueue.stageLeagueRows,
        { reviewRowId: team, leagueName: "National Hockey League" },
      ),
    ).toBe(0);
  });

  test("a blank name raises nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const team = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Vancouver Canucks",
      status: "ready",
    });
    expect(
      await t.withIdentity(ADMIN_IDENTITY).mutation(
        api.entityReviewQueue.stageLeagueRows,
        { reviewRowId: team, leagueName: "   " },
      ),
    ).toBe(0);
  });
});

describe("NEO-254: 'Skip remaining names' and an already-decided team", () => {
  test("a team that already answered 'Create NHL' keeps its league", async () => {
    /*
     * `skipRemaining` skips every UNDECIDED row, which includes an unanswered
     * league step — and through the team-scoped skip that would otherwise read
     * as "this team has no league". It must not reach a team that already gave
     * an explicit answer: the operator decided that row, and a bulk action on
     * the rows they had not reached is not a licence to revisit it.
     *
     * Two guards make it hold, and this pins both: `decideAllRemaining` steps
     * over a decided row, and an explicit `create.leagueName` outranks the
     * skip in the commit's own precedence.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const team = await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: sportId,
        batchId: BATCH,
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "team" as const,
        name: "Vancouver Canucks",
        nameNormalized: normalizeTeamName("Vancouver Canucks"),
        sportId,
        status: "ready" as const,
        decision: {
          action: "create" as const,
          create: {
            location: "Vancouver",
            name: "Canucks",
            leagueName: "National Hockey League",
          },
        },
      }),
    );
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "National Hockey League",
      status: "ready",
      source: { kind: "leagueOf", teamRowId: team },
    });

    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.recordAllRemainingAsSkip, {
        selectorOptionId: sportId,
        batchId: BATCH,
      });

    // The team's own decision is untouched…
    const teamRow = await t.run(async (ctx) => ctx.db.get(team));
    expect(teamRow!.decision).toMatchObject({ action: "create" });
    // …and the league step it raised was the undecided one, so it took the skip.
    const leagueRow = await t.run(async (ctx) => ctx.db.get(league));
    expect(leagueRow!.decision).toEqual({ action: "skip" });
  });
});

// ===========================================================================
// A league step is answerable immediately; the prefill arrives later
// ===========================================================================

describe("NEO-254: a staged league step never waits on its lookup", () => {
  test("it is staged READY, so the walk can present it at once", async () => {
    /*
     * CI run 34123557194 hit the 600s per-flow cap on the wizard drain. Marked
     * `pending`, a league was unpresentable until Wikidata answered, and
     * `waitingOnStagedLeagues` held its TEAM behind it — one network round trip
     * blocking two steps that were both ready to be answered.
     *
     * Nothing about the question needs the lookup: the name came off the P118
     * statement, and both reasons to skip the step (the sport already holds the
     * league by name or alias, the batch already staged it) are checked
     * synchronously in `stageLeagueRowsImpl`.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamRow = await insertRow(t, { sportId, kind: "team", name: "Vancouver Canucks" });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: teamRow,
      status: "ready",
      enrichment: { league: "National Hockey League" },
    });

    const staged = await leagueRows(t);
    expect(staged[0].status).toBe("ready");
    // The lookup is still enqueued — the prefill is not abandoned, only
    // un-blocked.
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.length).toBeGreaterThan(0);
  });

  test("the prefill lands on the row afterwards, without a decision", async () => {
    // `applyLookupResult` has no status guard, so the result patches a ready
    // row exactly as it patched a pending one — which is what lets the values
    // stream into a form the operator already has open.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamRow = await insertRow(t, { sportId, kind: "team", name: "Vancouver Canucks" });
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: teamRow,
      status: "ready",
      enrichment: { league: "National Hockey League" },
    });
    const staged = (await leagueRows(t))[0];

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: staged._id,
      status: "ready",
      enrichment: {
        wikidataId: "Q1215892",
        abbreviation: "NHL",
        yearsActive: { from: 1917 },
      },
    });

    const after = await t.run(async (ctx) => ctx.db.get(staged._id));
    expect(after!.enrichment).toMatchObject({
      wikidataId: "Q1215892",
      abbreviation: "NHL",
    });
    expect(after!.decision).toBeUndefined();
  });

  test("a DECIDED league is not re-patched by a late lookup", async () => {
    // NEO-189: writing to a row the commit prelude may be reading is what made
    // a seed job lose an OCC race on every retry. A step answered before its
    // prefill arrived keeps the operator's answer.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamRow = await insertRow(t, { sportId, kind: "team", name: "Vancouver Canucks" });
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: teamRow,
      status: "ready",
      enrichment: { league: "National Hockey League" },
    });
    const staged = (await leagueRows(t))[0];

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.entityReviewQueue.recordDecision,
      {
        reviewRowId: staged._id,
        action: "create",
        createLeague: { name: "National Hockey League", abbreviation: "N.H.L." },
      },
    );
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: staged._id,
      status: "ready",
      enrichment: { wikidataId: "Q1215892", abbreviation: "NHL" },
    });

    const after = await t.run(async (ctx) => ctx.db.get(staged._id));
    expect(after!.enrichment).toBeUndefined();
    expect(after!.decision).toMatchObject({ action: "create" });
  });
});
