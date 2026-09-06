/**
 * NEO-236 — the commit prelude's staged-career-team pass.
 *
 * A career team the batch has to create is no longer three inline inputs on
 * the player's step; it is a `team` review row of its own carrying
 * `source.kind === "careerTeamOf"`, answered with the same New Team step a
 * checklist team gets — Location, Name, and the League that previously had no
 * way of being asked about at all. This file covers what
 * `commitCardChecklistPrelude` does with those answers.
 *
 * Two things about the prelude changed, and both are load-bearing:
 *
 *   1. **Loop order.** It is now skips → staged `careerTeamOf` rows → the
 *      checklist TEAM loop → the PLAYER loop. Player used to come before team.
 *      Nothing hands an id across: the player loop resolves each stint by
 *      `findTeamByFullName`, so a team created in the staged pass is simply
 *      FOUND there. That is why the pass has to run first.
 *   2. **League precedence** (`reviewedTeamFields`). The operator's answer
 *      wins — an id, a name, or `null` for "no league" — and the sport default
 *      is never allowed back over it. `createTeamFromOperatorInput`'s
 *      `leagueChosen` flag is what makes the `null` case survive: "no league"
 *      writes no `leagueId`, which is byte-identical to "not answered" unless
 *      something else carries the distinction.
 *
 * Fixture conventions mirror convex/commitCardChecklist.entityReview.test.ts:
 * the same sport → setName → variantType tree, review rows inserted raw so
 * each test controls the exact decision shape, and the commit driven through
 * the real `api.selectorOptions.commitCardChecklist` action.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_career_team_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_career_team_001",
  name: "Admin User",
  role: "admin",
};

const BATCH = "batch-career";

async function seedTree(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      // Configured league — so "the sport default did NOT win" is a claim with
      // something to lose to.
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Chrome",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    return { sportId, setNameId, variantTypeId };
  });
}

function makeCard(
  overrides: Partial<{
    cardNumber: string;
    cardName: string;
    players: string[];
    teams: string[];
  }> = {},
) {
  return {
    cardNumber: overrides.cardNumber ?? "1",
    cardName: overrides.cardName ?? "Card",
    team: undefined,
    teams: overrides.teams ?? [],
    players: overrides.players ?? [],
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

type TeamCreate = {
  location?: string;
  name: string;
  leagueId?: Id<"leagues"> | null;
  leagueName?: string;
};

async function insertReviewRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    sportId: Id<"selectorOptions">;
    kind: "player" | "team";
    name: string;
    decision?: Record<string, unknown>;
    enrichment?: Record<string, unknown>;
    source?: { kind: "careerTeamOf"; playerRowId: Id<"entityReviewQueue"> };
  },
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.selectorOptionId,
      batchId: BATCH,
      createdByUserId: "user_review_001",
      kind: opts.kind,
      name: opts.name,
      nameNormalized: normalizeTeamName(opts.name),
      sportId: opts.sportId,
      status: "ready",
      ...(opts.decision ? { decision: opts.decision as never } : {}),
      ...(opts.enrichment ? { enrichment: opts.enrichment as never } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    }),
  );
}

/** Every `teams` row, by its composed identity key, for whole-table claims. */
async function allTeams(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.query("teams").collect());
}

async function leagueNameOf(
  t: ReturnType<typeof convexTest>,
  leagueId: Id<"leagues"> | undefined,
): Promise<string | undefined> {
  if (!leagueId) return undefined;
  return t.run(async (ctx) => (await ctx.db.get(leagueId))?.name);
}

/**
 * The `players` row with this display name.
 *
 * Looked up by `name` rather than by `nameNormalized`, because the prelude's
 * normaliser TOKEN-SORTS: "Travis Bazzana" is stored under "bazzana travis",
 * and a fixture that hard-coded the readable order would silently find
 * nothing.
 */
async function playerNamed(t: ReturnType<typeof convexTest>, name: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("players").collect();
    return rows.find((row) => row.name === name) ?? null;
  });
}

// ===========================================================================
// The sequence Jason asked for, end to end
// ===========================================================================

describe("commit prelude: staged career-team rows become teams BEFORE the player who needs them", () => {
  test("creates both clubs with the OPERATOR's leagues and points the player's teamYears at them", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedTree(t);

    // A league we already hold — the operator picked it off the New Team
    // step's list, so the decision carries its id.
    const ablId = await t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "Australian Baseball League",
        nameNormalized: "australian baseball league",
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    const playerRowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      // No `createTeams`: the wizard no longer produces it. The stints resolve
      // by NAME against the rows the staged pass creates.
      decision: { action: "create" },
      enrichment: {
        wikidataId: "Q112233",
        careerTeams: [
          { name: "Sydney Blue Sox", fromYear: 2019, toYear: 2021, wikidataId: "Q1" },
          { name: "Oregon State Beavers", fromYear: 2022, wikidataId: "Q2" },
        ],
      },
    });

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      source: { kind: "careerTeamOf", playerRowId },
      decision: {
        action: "create",
        create: { location: "Sydney", name: "Blue Sox", leagueId: ablId },
      },
    });
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "Oregon State Beavers",
      source: { kind: "careerTeamOf", playerRowId },
      decision: {
        action: "create",
        // A league we hold no row for — the "Create league X" answer.
        create: {
          location: "Oregon State",
          name: "Beavers",
          leagueName: "NCAA Division I baseball",
        },
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardName: "Travis Bazzana", players: ["Travis Bazzana"] }),
      ],
      batchId: BATCH,
    });

    const teams = await allTeams(t);
    expect(teams).toHaveLength(2);
    const byName = new Map(teams.map((row) => [row.name, row]));

    // Stored as Location + Name, never as the raw Wikidata label.
    expect(byName.get("Blue Sox")!.location).toBe("Sydney");
    expect(byName.get("Beavers")!.location).toBe("Oregon State");

    // THE POINT OF THE TICKET: neither club is filed under Major League
    // Baseball, which is what the sport default would have given them.
    expect(byName.get("Blue Sox")!.leagueId).toBe(ablId);
    expect(await leagueNameOf(t, byName.get("Beavers")!.leagueId)).toBe(
      "NCAA Division I baseball",
    );

    const player = await playerNamed(t, "Travis Bazzana");
    expect(player).not.toBeNull();
    expect(player!.teamYears).toHaveLength(2);
    // Resolved by name against the rows the staged pass just created — the
    // whole reason that pass runs ahead of the player loop.
    const stintTeamIds = player!.teamYears!.map((ty) => ty.teamId);
    expect(new Set(stintTeamIds)).toEqual(
      new Set([byName.get("Blue Sox")!._id, byName.get("Beavers")!._id]),
    );
    expect(player!.teamYears![0]).toMatchObject({ fromYear: 2019, toYear: 2021 });
    expect(player!.teamYears![1]).toMatchObject({ fromYear: 2022 });
  });

  test("leagueId: null produces a team with NO league even though the sport has a default", async () => {
    // The state the nullable union exists for. "No league", said deliberately,
    // writes no `leagueId` — which is byte-identical to "not answered" unless
    // `leagueChosen` carries the distinction down to the insert.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedTree(t);

    const playerRowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      decision: { action: "create" },
      enrichment: {
        careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }],
      },
    });
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      source: { kind: "careerTeamOf", playerRowId },
      decision: {
        action: "create",
        create: {
          location: "Sydney",
          name: "Blue Sox",
          leagueId: null,
        } satisfies TeamCreate,
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardName: "Travis Bazzana", players: ["Travis Bazzana"] }),
      ],
      batchId: BATCH,
    });

    const teams = await allTeams(t);
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("Blue Sox");
    expect(teams[0].leagueId).toBeUndefined();
    // And no MLB row was invented on the way past — `resolveDefaultLeagueId`
    // was never consulted, so it never created one.
    const leagues = await t.run(async (ctx) => ctx.db.query("leagues").collect());
    expect(leagues).toEqual([]);
  });

  test("an unanswered staged row still lets the sport default apply to a team it does answer for", async () => {
    // `leagueChosen` is false when the League question was never put, so the
    // pre-NEO-236 behaviour is exactly preserved for those rows.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedTree(t);

    const playerRowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "player",
      name: "Tony Gwynn",
      decision: { action: "create" },
      enrichment: { careerTeams: [{ name: "San Diego Padres", fromYear: 1982 }] },
    });
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "San Diego Padres",
      source: { kind: "careerTeamOf", playerRowId },
      // No league half at all — a decision recorded before this shipped.
      decision: {
        action: "create",
        create: { location: "San Diego", name: "Padres" },
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardName: "Tony Gwynn", players: ["Tony Gwynn"] })],
      batchId: BATCH,
    });

    const teams = await allTeams(t);
    expect(teams).toHaveLength(1);
    expect(await leagueNameOf(t, teams[0].leagueId)).toBe("Major League Baseball");
  });

  test("the operator's leagueName wins over the enrichment's league suggestion", async () => {
    // The staged row's own Wikidata lookup suggested one league; the operator
    // typed another into the New Team dialog. Answered means answered — the
    // suggestion must not silently reassert itself, which is the same defect
    // Jason found, one layer down.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedTree(t);

    const playerRowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      decision: { action: "create" },
      enrichment: { careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }] },
    });
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      source: { kind: "careerTeamOf", playerRowId },
      enrichment: { league: "Major League Baseball", location: "Sydney" },
      decision: {
        action: "create",
        create: {
          location: "Sydney",
          name: "Blue Sox",
          leagueName: "Australian Baseball League",
        },
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardName: "Travis Bazzana", players: ["Travis Bazzana"] }),
      ],
      batchId: BATCH,
    });

    const teams = await allTeams(t);
    expect(teams).toHaveLength(1);
    expect(await leagueNameOf(t, teams[0].leagueId)).toBe(
      "Australian Baseball League",
    );
  });

  test("carries the staged row's own enrichment — colours, era and external ids — onto the team", async () => {
    // The staged row sat in the wizard while its own lookup ran, so it arrives
    // complete. `enrichment.location` is deliberately NOT written on its own:
    // the operator saw it, and either kept, changed, or cleared it.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedTree(t);

    const playerRowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      decision: { action: "create" },
      enrichment: { careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }] },
    });
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      source: { kind: "careerTeamOf", playerRowId },
      enrichment: {
        // A location the operator OVERRODE on the step — the stored row keeps
        // their answer, not this.
        location: "Sydney, New South Wales",
        yearsActive: { from: 2010 },
        colors: { primary: "#0033A0", secondary: "#FFFFFF" },
        wikidataId: "Q7660066",
        espnId: "12345",
      },
      decision: {
        action: "create",
        create: { location: "Sydney", name: "Blue Sox", leagueId: null },
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardName: "Travis Bazzana", players: ["Travis Bazzana"] }),
      ],
      batchId: BATCH,
    });

    const teams = await allTeams(t);
    expect(teams).toHaveLength(1);
    expect(teams[0].location).toBe("Sydney");
    expect(teams[0].yearsActive).toEqual({ from: 2010 });
    expect(teams[0].colors).toEqual({ primary: "#0033A0", secondary: "#FFFFFF" });
    expect(teams[0].externalIds).toEqual({
      wikidataId: "Q7660066",
      espnId: "12345",
    });
  });

  test("a staged row answered with a team we already hold links instead of minting a duplicate", async () => {
    // ("San Diego", "Padres") against a stored "San Diego Padres" is the same
    // dedup key — `normalizeTeamName` token-sorts, so the split cannot change
    // it.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedTree(t);
    const existingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "San Diego Padres",
        nameNormalized: normalizeTeamName("San Diego Padres"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    const playerRowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "player",
      name: "Tony Gwynn",
      decision: { action: "create" },
      enrichment: { careerTeams: [{ name: "Padres", fromYear: 1982 }] },
    });
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "Padres",
      source: { kind: "careerTeamOf", playerRowId },
      decision: {
        action: "create",
        create: { location: "San Diego", name: "Padres" },
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardName: "Tony Gwynn", players: ["Tony Gwynn"] })],
      batchId: BATCH,
    });

    const teams = await allTeams(t);
    expect(teams).toHaveLength(1);
    expect(teams[0]._id).toBe(existingTeamId);
    const player = await playerNamed(t, "Tony Gwynn");
    expect(player!.teamYears!.map((ty) => ty.teamId)).toEqual([existingTeamId]);
  });

  test("a staged row left UNDECIDED creates nothing and does not break the commit", async () => {
    // It is not a name off the checklist, so no card sits on it. The player's
    // stint for that label is simply dropped — a fabricated stint at a
    // fabricated team is worse than a career history one team short.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedTree(t);

    const playerRowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      decision: { action: "create" },
      enrichment: {
        careerTeams: [
          { name: "Sydney Blue Sox", fromYear: 2019 },
          { name: "Oregon State Beavers", fromYear: 2022 },
        ],
      },
    });
    // Answered.
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      source: { kind: "careerTeamOf", playerRowId },
      decision: {
        action: "create",
        create: { location: "Sydney", name: "Blue Sox", leagueId: null },
      },
    });
    // Never answered — the operator quit the walker before this step.
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "Oregon State Beavers",
      source: { kind: "careerTeamOf", playerRowId },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardName: "Travis Bazzana", players: ["Travis Bazzana"] }),
      ],
      batchId: BATCH,
    });

    const teams = await allTeams(t);
    expect(teams.map((row) => row.name)).toEqual(["Blue Sox"]);
    const player = await playerNamed(t, "Travis Bazzana");
    expect(player!.teamYears).toHaveLength(1);
    expect(player!.teamYears![0].teamId).toBe(teams[0]._id);
    // The card still committed and still links to the player.
    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .first(),
    );
    expect(card!.playerIds).toEqual([player!._id]);
  });

  test("a staged row the operator SKIPPED creates nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedTree(t);

    const playerRowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      decision: { action: "create" },
      enrichment: {
        careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }],
      },
    });
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      source: { kind: "careerTeamOf", playerRowId },
      decision: { action: "skip" },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardName: "Travis Bazzana", players: ["Travis Bazzana"] }),
      ],
      batchId: BATCH,
    });

    expect(await allTeams(t)).toEqual([]);
    const player = await playerNamed(t, "Travis Bazzana");
    expect(player!.teamYears).toBeUndefined();
  });
});

// ===========================================================================
// The old shape still commits exactly as before
// ===========================================================================

describe("commit prelude: a pre-NEO-236 decision carrying createTeams is unchanged by the reordering", () => {
  test("createTeams on the player row, with no staged rows, still creates the teams and the stints", async () => {
    // The prelude still CONSUMES `decision.createTeams` even though the wizard
    // no longer produces it — a batch started before this shipped and
    // committed after it must not lose its career teams. Pinned because the
    // loop reorder (team before player) is exactly the kind of change that
    // silently breaks the path nothing in the UI exercises any more.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedTree(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "player",
      name: "Daulton Varsho",
      decision: {
        action: "create",
        manualCareerTeams: [{ name: "Toronto Blue Jays", fromYear: 2023 }],
        createTeams: [
          {
            sourceName: "Arizona Diamondbacks",
            location: "Arizona",
            name: "Diamondbacks",
          },
          { sourceName: "Toronto Blue Jays", name: "Toronto Blue Jays" },
        ],
      },
      enrichment: {
        careerTeams: [
          { name: "Arizona Diamondbacks", fromYear: 2020, toYear: 2022 },
        ],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardName: "Daulton Varsho", players: ["Daulton Varsho"] }),
      ],
      batchId: BATCH,
    });

    const teams = await allTeams(t);
    expect(teams.map((row) => row.name).sort()).toEqual([
      "Diamondbacks",
      "Toronto Blue Jays",
    ]);
    const dbacks = teams.find((row) => row.name === "Diamondbacks")!;
    expect(dbacks.location).toBe("Arizona");
    // Created off a player's career list with no reviewed League, so the sport
    // default still applies — the old behaviour, unchanged.
    expect(await leagueNameOf(t, dbacks.leagueId)).toBe("Major League Baseball");

    const player = await playerNamed(t, "Daulton Varsho");
    expect(player!.teamYears).toHaveLength(2);
    expect(player!.teamYears![0]).toMatchObject({ fromYear: 2020, toYear: 2022 });
    expect(player!.teamYears![1]).toMatchObject({ fromYear: 2023 });
  });

  test("a checklist TEAM row still creates from the operator's Location + Name after the reorder", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedTree(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      kind: "team",
      name: "San Diego Padres",
      decision: {
        action: "create",
        create: { location: "San Diego", name: "Padres" },
      },
      enrichment: { league: "Major League Baseball", location: "San Diego" },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardName: "Padres Team Card", teams: ["San Diego Padres"] })],
      batchId: BATCH,
    });

    const teams = await allTeams(t);
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("Padres");
    expect(teams[0].location).toBe("San Diego");
    expect(await leagueNameOf(t, teams[0].leagueId)).toBe("Major League Baseball");

    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .first(),
    );
    expect(card!.teamOnCardIds).toEqual([teams[0]._id]);
    // The FULL name — location plus nickname — is what leaves the mutation.
    // `teamNames` is not stored on the card; it is a prelude-resolved wire
    // value the chunk feeds to listing generation, so the title is where the
    // composed name is observable. "Padres" alone would be a worse search term
    // for exactly the collectors who type the city.
    expect(card!.listingTitle).toContain("San Diego Padres");
  });
});
