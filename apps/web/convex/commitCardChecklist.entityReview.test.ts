/**
 * NEO-92: `commitCardChecklist`'s (convex/selectorOptions.ts) decision-driven
 * create/link resolution — the piece that replaced the old
 * `confirmedNewPlayers`/`confirmedNewTeams: string[]` args with `batchId?:
 * string`. When a card references a player/team name that isn't already in
 * the `players`/`teams` table, commitCardChecklist looks up that name's
 * reviewed `entityReviewQueue` row (by `${kind}:${normalizedName}`, scoped to
 * the given batch) and resolves it per the row's `decision`:
 *   - `{ action: "create" }` — inserts a new row seeded directly from the
 *     row's cached `enrichment` (the wizard's own pre-fetched Wikidata
 *     preview) — for a player, this includes resolving each `careerTeams`
 *     NAME to a real team id via the inlined `resolveTeamIdByName` helper.
 *   - `{ action: "link", linkedPlayerId/linkedTeamId }` — uses that id
 *     directly; no new row is ever inserted.
 * After a successful commit, the batch's entityReviewQueue rows are cleaned
 * up via a scheduled `internal.entityReviewQueue.cleanupBatch` call (not
 * inline, per the mutation's own read-budget comment) — draining the
 * scheduler proves that wiring too.
 *
 * Fixture conventions (seedVariantTypeUnderChromeSet-style tree,
 * ADMIN_IDENTITY, raw previewCardValidator-shaped card objects) mirror
 * convex/featurePropagation.test.ts / convex/skuWiring.test.ts. Review rows
 * are inserted directly via `ctx.db.insert("entityReviewQueue", ...)`
 * (bypassing the real `startBatch`/wizard flow) so each test controls the
 * exact decision/enrichment shape under test — the wizard's own UI behavior
 * and startBatch's CRUD are covered separately in
 * components/SetSelector/EntityReviewWizard.test.tsx and
 * convex/entityReviewQueue.test.ts.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_entity_review_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_entity_review_001",
  name: "Admin User",
  role: "admin",
};

async function seedVariantTypeUnderChromeSet(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
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

/**
 * NEO-212 — a SECOND set under the same setName (and therefore the same sport
 * ancestor, which `resolveChecklistEntities` validates). Skips are scoped per
 * selectorOption, so proving that scope needs two of them.
 */
async function seedSecondVariantType(
  t: ReturnType<typeof convexTest>,
  setNameId: Id<"selectorOptions">,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Refractor",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    const setName = await ctx.db.get(setNameId);
    await ctx.db.patch(setNameId, { children: [...(setName!.children ?? []), id] });
    return id;
  });
}

function makeCard(overrides: Partial<{
  cardNumber: string;
  cardName: string;
  players: string[];
  teams: string[];
}> = {}) {
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

async function insertReviewRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    batchId: string;
    kind: "player" | "team";
    name: string;
    sportId: Id<"selectorOptions">;
    decision: {
      action: "create";
      manualCareerTeams?: Array<{ name: string; fromYear: number; toYear?: number }>;
      // NEO-212: careerTeams the admin UNCHECKED in the wizard. Commit must
      // not create team rows for these.
      excludedCareerTeamNames?: string[];
    } | {
      action: "link";
      linkedPlayerId?: Id<"players">;
      linkedTeamId?: Id<"teams">;
    } | {
      // NEO-212: "not a person / not a team". No payload — the card keeps the
      // raw name, nothing is created or linked, and the name is recorded in
      // `entityReviewSkips` so it never re-enters this set's wizard.
      action: "skip";
    };
    enrichment?: Record<string, unknown>;
  },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.selectorOptionId,
      batchId: opts.batchId,
      createdByUserId: "user_review_001",
      kind: opts.kind,
      name: opts.name,
      sportId: opts.sportId,
      status: "ready",
      decision: opts.decision,
      ...(opts.enrichment ? { enrichment: opts.enrichment as never } : {}),
    }),
  );
}

// ===========================================================================
// "create" decision — player, with careerTeams
// ===========================================================================

describe("commitCardChecklist: 'create' decision seeds a new row from the batch's cached enrichment", () => {
  test("a player 'create' decision inserts a new player with teamYears/isHallOfFame/externalIds.wikidataId from its enrichment", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Mike Trout",
      decision: { action: "create" },
      enrichment: {
        wikidataId: "Q123456",
        isHallOfFame: true,
        careerTeams: [
          { name: "Los Angeles Angels", fromYear: 2011 },
          { name: "Los Angeles Angels of Anaheim", fromYear: 2005, toYear: 2010 },
        ],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Mike Trout", players: ["Mike Trout"] })],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "mike trout").eq("sportId", sportId),
        )
        .first(),
    );
    expect(player).not.toBeNull();
    expect(player!.isHallOfFame).toBe(true);
    expect(player!.externalIds?.wikidataId).toBe("Q123456");
    expect(player!.teamYears).toHaveLength(2);
    // NEO-212: stored in CHRONOLOGICAL order (sortTeamYears), not in the order
    // the enrichment happened to list them — the fixture above is deliberately
    // latest-first so this asserts the sort rather than the input.
    expect(player!.teamYears?.[0].fromYear).toBe(2005);
    expect(player!.teamYears?.[0].toYear).toBe(2010);
    expect(player!.teamYears?.[1].fromYear).toBe(2011);

    // Each careerTeams NAME resolved to a real (bare, unenriched) team row —
    // proves resolveTeamIdByName's get-or-create ran for both names.
    const team1 = await t.run(async (ctx) => ctx.db.get(player!.teamYears![0].teamId));
    const team2 = await t.run(async (ctx) => ctx.db.get(player!.teamYears![1].teamId));
    expect(team1!.name).toBe("Los Angeles Angels of Anaheim");
    expect(team2!.name).toBe("Los Angeles Angels");
    // Still deliberately minimal on ENRICHMENT — an incidental career team is
    // not looked up at commit time. NEO-156 changed one thing about that: the
    // league is not enrichment, it is a structural fact every team gets at
    // creation from its sport's config, so this row carries one.
    expect(team1!.league).toBeUndefined(); // the deprecated free-text field
    expect(team1!.leagueId).toBeDefined();
    expect(team1!.externalIds).toBeUndefined();
    expect(team2!.externalIds).toBeUndefined();

    // The card itself resolved to this new player.
    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .first(),
    );
    expect(card!.playerIds).toEqual([player!._id]);
  });

  test("merges enrichment.careerTeams with decision.manualCareerTeams into teamYears (manual appended after Wikidata)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Daulton Varsho",
      decision: {
        action: "create",
        manualCareerTeams: [
          { name: "Toronto Blue Jays", fromYear: 2023 },
        ],
      },
      enrichment: {
        careerTeams: [{ name: "Arizona Diamondbacks", fromYear: 2020, toYear: 2022 }],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Daulton Varsho", players: ["Daulton Varsho"] })],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "daulton varsho").eq("sportId", sportId),
        )
        .first(),
    );
    expect(player!.teamYears).toHaveLength(2);
    // Wikidata entry first, manual entry appended after.
    const t0 = await t.run(async (ctx) => ctx.db.get(player!.teamYears![0].teamId));
    const t1 = await t.run(async (ctx) => ctx.db.get(player!.teamYears![1].teamId));
    expect(t0!.name).toBe("Arizona Diamondbacks");
    expect(player!.teamYears![0]).toMatchObject({ fromYear: 2020, toYear: 2022 });
    expect(t1!.name).toBe("Toronto Blue Jays");
    expect(player!.teamYears![1].fromYear).toBe(2023);
    expect(player!.teamYears![1].toYear).toBeUndefined();
  });

  test("Daulton Varsho case: no Wikidata careerTeams — teamYears comes purely from manual entries", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    // enrichment absent entirely (the "No Wikidata match found" path) — the
    // ONLY source of career-team history is what the admin typed by hand.
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Daulton Varsho",
      decision: {
        action: "create",
        manualCareerTeams: [
          { name: "Arizona Diamondbacks", fromYear: 2020, toYear: 2022 },
          { name: "Toronto Blue Jays", fromYear: 2023 },
        ],
      },
      // no enrichment key at all
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Daulton Varsho", players: ["Daulton Varsho"] })],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "daulton varsho").eq("sportId", sportId),
        )
        .first(),
    );
    expect(player!.teamYears).toHaveLength(2);
    expect(player!.teamYears![0].fromYear).toBe(2020);
    expect(player!.teamYears![1].fromYear).toBe(2023);
  });

  test("dedupes by resolved teamId when Wikidata and manual name the SAME team — the MANUAL correction wins", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Mike Trout",
      decision: {
        action: "create",
        // Same team the enrichment already carries, but spelled with a
        // different word order — norm() collapses both to the same
        // nameNormalized, so resolveTeamIdByName returns the SAME teamId. The
        // admin is deliberately CORRECTING Wikidata's years (2011–2018 →
        // 2011–2019), so the manual years must win, not be discarded.
        manualCareerTeams: [{ name: "Angels Los Angeles", fromYear: 2011, toYear: 2019 }],
      },
      enrichment: {
        careerTeams: [{ name: "Los Angeles Angels", fromYear: 2011, toYear: 2018 }],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Mike Trout", players: ["Mike Trout"] })],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "mike trout").eq("sportId", sportId),
        )
        .first(),
    );
    // One entry, not two — the duplicate team was collapsed...
    expect(player!.teamYears).toHaveLength(1);
    // ...and the surviving years are the admin's correction, NOT Wikidata's.
    expect(player!.teamYears![0].fromYear).toBe(2011);
    expect(player!.teamYears![0].toYear).toBe(2019); // manual correction wins (was 2018 from Wikidata)

    // The surviving entry still points at the one team row that name resolves to.
    const team = await t.run(async (ctx) => ctx.db.get(player!.teamYears![0].teamId));
    expect(team!.name).toBe("Los Angeles Angels"); // created by the Wikidata pass (first to resolve it)

    // And only one teams row was ever created for that name.
    const angelsRows = await t.run(async (ctx) =>
      ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "angeles angels los").eq("sportId", sportId),
        )
        .collect(),
    );
    expect(angelsRows).toHaveLength(1);
  });

  test("a team 'create' decision inserts a new team with league/city/yearsActive/colors/espnId from its enrichment", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "team",
      name: "Los Angeles Angels",
      decision: { action: "create" },
      enrichment: {
        wikidataId: "Q217123",
        espnId: "3",
        league: "Major League Baseball",
        city: "Anaheim",
        yearsActive: { from: 1961 },
        colors: { primary: "#BA0021", secondary: "#003263" },
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Team Card", teams: ["Los Angeles Angels"] })],
      batchId: "batch-1",
    });

    const team = await t.run(async (ctx) =>
      ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "angeles angels los").eq("sportId", sportId),
        )
        .first(),
    );
    expect(team).not.toBeNull();
    // NEO-156: the wizard's enrichment carries a league NAME; the row stores a
    // reference to a real league. Resolve it rather than asserting a string,
    // which would have kept passing against the field this replaced.
    const league = await t.run(async (ctx) =>
      team!.leagueId ? ctx.db.get(team!.leagueId) : null,
    );
    expect(league?.name).toBe("Major League Baseball");
    expect(team!.city).toBe("Anaheim");
    expect(team!.yearsActive).toEqual({ from: 1961, to: undefined });
    expect(team!.colors).toEqual({ primary: "#BA0021", secondary: "#003263" });
    expect(team!.externalIds).toEqual({ wikidataId: "Q217123", espnId: "3" });

    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .first(),
    );
    expect(card!.teamOnCardIds).toEqual([team!._id]);
  });
});

// ===========================================================================
// "link" decision — uses the existing id, no new row inserted
// ===========================================================================

describe("commitCardChecklist: 'link' decision resolves to the existing row, no duplicate inserted", () => {
  test("a player 'link' decision uses linkedPlayerId directly — no new player row is created", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    // The REAL player, under a different spelling than what the
    // marketplace card carries.
    const realPlayerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Ken Griffey Jr.",
        nameNormalized: "griffey jr ken",
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      // A spelling that normalizes differently from "Ken Griffey Jr." (no
      // period) so it's genuinely treated as "unknown" pre-link.
      name: "Ken Griffey Junior",
      decision: { action: "link", linkedPlayerId: realPlayerId },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Griffey", players: ["Ken Griffey Junior"] })],
      batchId: "batch-1",
    });

    const allPlayers = await t.run(async (ctx) => ctx.db.query("players").collect());
    // Still exactly one player row — the linked one, not a duplicate.
    expect(allPlayers).toHaveLength(1);
    expect(allPlayers[0]._id).toBe(realPlayerId);

    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .first(),
    );
    expect(card!.playerIds).toEqual([realPlayerId]);
  });

  test("a team 'link' decision uses linkedTeamId directly — no new team row is created", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const realTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Los Angeles Angels",
        nameNormalized: "angeles angels los",
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "team",
      name: "LA Angels of Anaheim", // normalizes differently -> "genuinely unknown"
      decision: { action: "link", linkedTeamId: realTeamId },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Team Card", teams: ["LA Angels of Anaheim"] })],
      batchId: "batch-1",
    });

    const allTeams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(allTeams).toHaveLength(1);
    expect(allTeams[0]._id).toBe(realTeamId);

    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .first(),
    );
    expect(card!.teamOnCardIds).toEqual([realTeamId]);
  });
});

// ===========================================================================
// Post-commit cleanup — the batch's entityReviewQueue rows are deleted
// SYNCHRONOUSLY, inline, in the same transaction as the commit (not
// scheduled). This closes a real race a scheduled-delete version had: a
// re-fetch of the same selectorOptionId landing in the gap between the
// commit returning and a scheduled delete actually running could observe
// every row already decided and wrongly resume the dead batch instead of
// starting fresh (see startBatch's docstring).
// ===========================================================================

describe("commitCardChecklist: post-commit batch cleanup", () => {
  test("after a successful commit, the batch's entityReviewQueue rows are gone immediately — no scheduled step needed", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const rowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Mike Trout",
      decision: { action: "create" },
      enrichment: { careerTeams: [] },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Mike Trout", players: ["Mike Trout"] })],
      batchId: "batch-1",
    });

    // Gone the instant the mutation returns — no scheduler drain required,
    // and no window where a re-fetch could observe a stale decided row.
    const afterCommit = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(afterCommit).toBeNull();
  });

  test("committing WITHOUT a batchId never touches entityReviewQueue at all", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    // A row for an UNRELATED batch — must survive since this commit has no
    // batchId at all (the zero-unknowns fast path).
    const unrelatedRowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "unrelated-batch",
      kind: "player",
      name: "Someone Else",
      decision: { action: "create" },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "No Unknowns Card" })],
    });

    const row = await t.run(async (ctx) => ctx.db.get(unrelatedRowId));
    expect(row).not.toBeNull();
  });
});

// ===========================================================================
// NEO-212 — the "skip" decision: "this name is not a person / not a team"
//
// The escape hatch for the junk that BSC checklists carry in player columns:
// header rows, the literal string "CHECKLIST", sponsor text. Before this
// existed the only way to clear such a row from the wizard was to CREATE a
// bogus player for it, permanently polluting a globally-shared table.
//
// A skip is defined by what it does NOT do — nothing is created, nothing is
// linked, and the card keeps the raw name as free text exactly as if the name
// had never been reviewed. Its one durable effect is a row in
// `entityReviewSkips`, which is what stops the same junk being handed back on
// the next fetch of the set.
// ===========================================================================

/** Every `entityReviewSkips` row, for asserting the whole table at once. */
async function allSkips(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.query("entityReviewSkips").collect());
}

describe("commitCardChecklist: 'skip' decision creates nothing, links nothing, and records the name", () => {
  test("a player 'skip' creates no player, leaves the card's name untouched, and writes an entityReviewSkips row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      // Real BSC junk: a checklist header row parsed into the player column.
      name: "CHECKLIST",
      decision: { action: "skip" },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardNumber: "1", cardName: "Checklist Card", players: ["CHECKLIST"] }),
      ],
      batchId: "batch-1",
    });

    // Nothing was created. This is the whole point — a skip must never leave a
    // bogus row in the globally-shared players table.
    const allPlayers = await t.run(async (ctx) => ctx.db.query("players").collect());
    expect(allPlayers).toEqual([]);

    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .first(),
    );
    // The card committed normally — a skip is not a card-level failure.
    expect(card).not.toBeNull();
    // No link to anything...
    expect(card!.playerIds ?? []).toEqual([]);
    // ...and the card's own name is untouched. A skip rules on the ENTITY
    // name, never on the card that mentioned it.
    expect(card!.cardName).toBe("Checklist Card");

    // The durable record, scoped to this set.
    const skips = await allSkips(t);
    expect(skips).toHaveLength(1);
    expect(skips[0].selectorOptionId).toBe(variantTypeId);
    expect(skips[0].kind).toBe("player");
    expect(skips[0].name).toBe("CHECKLIST");
    expect(skips[0].nameNormalized).toBe("checklist");
    expect(skips[0].skippedByUserId).toBe(ADMIN_IDENTITY.subject);
    expect(skips[0].skippedAt).toBeGreaterThan(0);
  });

  test("a team 'skip' creates no team and records under kind 'team'", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "team",
      name: "SPONSORED BY ACME",
      decision: { action: "skip" },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardNumber: "1", cardName: "Ad Card", teams: ["SPONSORED BY ACME"] }),
      ],
      batchId: "batch-1",
    });

    const allTeams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(allTeams).toEqual([]);

    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .first(),
    );
    expect(card!.teamOnCardIds ?? []).toEqual([]);

    const skips = await allSkips(t);
    expect(skips).toHaveLength(1);
    expect(skips[0].kind).toBe("team");
    // The `kind` is part of the key precisely because the same string can be
    // junk as a team and a real player (or vice versa) on the same set.
    expect(skips[0].nameNormalized).toBe("acme by sponsored");
  });

  test("the batch's entityReviewQueue rows are deleted after a skip-only commit, same as create/link", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const rowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "CHECKLIST",
      decision: { action: "skip" },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Card", players: ["CHECKLIST"] })],
      batchId: "batch-1",
    });

    // A skipped row is as consumed as a created one — leaving it would let a
    // re-fetch resume the dead batch (see startBatch's docstring).
    expect(await t.run(async (ctx) => ctx.db.get(rowId))).toBeNull();
  });

  test("re-skipping the same name on the same set UPSERTS — one row, refreshed skippedAt", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const commitSkip = async (batchId: string) => {
      await insertReviewRow(t, {
        selectorOptionId: variantTypeId,
        sportId,
        batchId,
        kind: "player",
        name: "CHECKLIST",
        decision: { action: "skip" },
      });
      await asAdmin.action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ cardNumber: "1", cardName: "Card", players: ["CHECKLIST"] })],
        batchId,
      });
    };

    await commitSkip("batch-1");
    const [first] = await allSkips(t);

    // Two commits inside one test can land on the same millisecond, which
    // would make "skippedAt moved forward" unfalsifiable. Backdate the stored
    // row so the second commit's patch is unambiguously observable — the
    // assertion under test is that the row was PATCHED, not re-inserted.
    await t.run(async (ctx) => ctx.db.patch(first._id, { skippedAt: 0 }));

    await commitSkip("batch-2");

    const skips = await allSkips(t);
    // One row, not two — the index key is (selectorOptionId, kind,
    // nameNormalized), and a second commit must refresh it rather than
    // accumulate a row per commit forever.
    expect(skips).toHaveLength(1);
    expect(skips[0]._id).toBe(first._id);
    expect(skips[0].skippedAt).toBeGreaterThan(0);
  });

  test("skips are PER SET — the same name skipped on one selectorOption leaves another set's row alone", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, setNameId, sportId } = await seedVariantTypeUnderChromeSet(t);
    const otherVariantTypeId = await seedSecondVariantType(t, setNameId);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Chase",
      decision: { action: "skip" },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Card", players: ["Chase"] })],
      batchId: "batch-1",
    });

    const skips = await allSkips(t);
    expect(skips).toHaveLength(1);
    // "Chase" is a sponsor logo on this issue and a shortstop on the next — a
    // global skip list would let one operator's call on one set silently
    // suppress a real player everywhere.
    expect(skips[0].selectorOptionId).toBe(variantTypeId);
    expect(skips[0].selectorOptionId).not.toBe(otherVariantTypeId);
  });
});

// ===========================================================================
// NEO-212 — a skipped name never re-enters the wizard
//
// `resolveUnknownsAndStartBatch` (driven here through its public entry point,
// resolveChecklistEntities) reads `entityReviewSkips` before it enqueues
// anything. Without this the skip would survive only until the next fetch,
// since the queue rows themselves are per-batch throwaways.
// ===========================================================================

describe("resolveChecklistEntities: a name skipped for this set is not enqueued again", () => {
  test("the skipped name is neither reported as unknown nor queued — but an unskipped name on the same fetch still is", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "CHECKLIST",
      decision: { action: "skip" },
    });
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Card", players: ["CHECKLIST"] })],
      batchId: "batch-1",
    });

    // The next sync of the same set hands the same junk name back...
    const resolved = await asAdmin.action(api.selectorOptions.resolveChecklistEntities, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardNumber: "1", cardName: "Card", players: ["CHECKLIST"] }),
        makeCard({ cardNumber: "2", cardName: "Trout", players: ["Mike Trout"] }),
      ],
    });

    // ...and it is dropped before it is even counted. Dropped BEFORE the
    // existence check, so it is not "an unknown we chose not to queue" — it is
    // not an open question at all.
    expect(resolved.unknownPlayers).toEqual(["Mike Trout"]);

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId: variantTypeId,
      batchId: resolved.batchId!,
    });
    expect(rows.map((r) => r.name)).toEqual(["Mike Trout"]);
  });

  test("the SAME name on a DIFFERENT set is still enqueued — the skip is per-set", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, setNameId, sportId } = await seedVariantTypeUnderChromeSet(t);
    const otherVariantTypeId = await seedSecondVariantType(t, setNameId);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Chase",
      decision: { action: "skip" },
    });
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Card", players: ["Chase"] })],
      batchId: "batch-1",
    });

    const resolved = await asAdmin.action(api.selectorOptions.resolveChecklistEntities, {
      selectorOptionId: otherVariantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Card", players: ["Chase"] })],
    });

    // Sponsor logo on one issue, shortstop on the next.
    expect(resolved.unknownPlayers).toEqual(["Chase"]);
    expect(resolved.batchId).toBeTruthy();
  });

  test("a skip on a name does not suppress the SAME name reviewed as the other kind", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Cardinals",
      decision: { action: "skip" },
    });
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Card", players: ["Cardinals"] })],
      batchId: "batch-1",
    });

    const resolved = await asAdmin.action(api.selectorOptions.resolveChecklistEntities, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Card", teams: ["Cardinals"] })],
    });

    // Junk in the player column, a real franchise in the team column.
    expect(resolved.unknownTeams).toEqual(["Cardinals"]);
    expect(resolved.unknownPlayers).toEqual([]);
  });
});

// ===========================================================================
// NEO-212 — finalize retires a custom card's SKIPPED pending name
//
// "Pending" means "waiting to become a players/teams row". A skipped name
// never will be one, so it is settled, not waiting — and left pending it would
// be re-offered on every later fetch, making the skip only half-work.
// ===========================================================================

describe("commitCardChecklist: a custom card's skipped pendingPlayerNames entry is retired", () => {
  test("the skipped name is cleared from pendingPlayerNames; an unrelated pending name survives", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const customCardId = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: "C1",
        cardName: "Hand-added Card",
        isCustom: true,
        pendingPlayerNames: ["CHECKLIST", "Still Unreviewed"],
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "CHECKLIST",
      decision: { action: "skip" },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      // A marketplace card that says nothing about either name — the custom
      // card's own pending names are what the prelude folds in.
      cards: [makeCard({ cardNumber: "1", cardName: "Unrelated" })],
      batchId: "batch-1",
    });

    const card = await t.run(async (ctx) => ctx.db.get(customCardId));
    expect(card!.pendingPlayerNames).toEqual(["Still Unreviewed"]);
    // And still nothing created for the skipped name.
    expect(await t.run(async (ctx) => ctx.db.query("players").collect())).toEqual([]);
  });
});

// ===========================================================================
// NEO-212 — career stints are keyed on (teamId, fromYear), not teamId
//
// The old `Map<teamId, years>` collapsed a player's second stint at a team
// they returned to, storing one entry spanning whichever stint happened to
// come last: a timeline that was not merely incomplete but wrong about the
// years it did show.
// ===========================================================================

describe("commitCardChecklist: multi-stint careers survive commit", () => {
  test("two stints at ONE team are both stored, ordered earliest-first, pointing at one team row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Returning Player",
      decision: { action: "create" },
      enrichment: {
        careerTeams: [
          // Latest first, so the assertion is about the sort and not the input.
          { name: "Los Angeles Angels", fromYear: 2016, toYear: 2019 },
          { name: "Los Angeles Angels", fromYear: 2011, toYear: 2013 },
        ],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardNumber: "1", cardName: "Returning", players: ["Returning Player"] }),
      ],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "player returning").eq("sportId", sportId),
        )
        .first(),
    );
    expect(player!.teamYears).toHaveLength(2);
    expect(player!.teamYears![0]).toMatchObject({ fromYear: 2011, toYear: 2013 });
    expect(player!.teamYears![1]).toMatchObject({ fromYear: 2016, toYear: 2019 });
    // Two stints, ONE team row — resolveTeamIdByName's get-or-create still
    // folds the repeated name.
    expect(player!.teamYears![0].teamId).toBe(player!.teamYears![1].teamId);
    const angels = await t.run(async (ctx) =>
      ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "angeles angels los").eq("sportId", sportId),
        )
        .collect(),
    );
    expect(angels).toHaveLength(1);
  });

  test("a manual entry with a DIFFERENT fromYear at a Wikidata team APPENDS rather than replacing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Returning Player",
      decision: {
        action: "create",
        // The admin adding the stint Wikidata missed entirely, at a team it
        // does know about — the case the old teamId key could not express.
        manualCareerTeams: [{ name: "Los Angeles Angels", fromYear: 2016, toYear: 2019 }],
      },
      enrichment: {
        careerTeams: [{ name: "Los Angeles Angels", fromYear: 2011, toYear: 2013 }],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardNumber: "1", cardName: "Returning", players: ["Returning Player"] }),
      ],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "player returning").eq("sportId", sportId),
        )
        .first(),
    );
    expect(player!.teamYears).toHaveLength(2);
    expect(player!.teamYears![0]).toMatchObject({ fromYear: 2011, toYear: 2013 });
    expect(player!.teamYears![1]).toMatchObject({ fromYear: 2016, toYear: 2019 });
  });
});

// ===========================================================================
// NEO-212 — career teams the operator UNCHECKED in the wizard
//
// The filter runs BEFORE resolveTeamIdByName, and that ordering is the whole
// point: resolving a name is get-or-CREATE, so merely asking for the id of an
// excluded team would mint the very `teams` row the operator just rejected.
// ===========================================================================

describe("commitCardChecklist: decision.excludedCareerTeamNames", () => {
  test("an excluded career team is neither created as a team row nor present in teamYears", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Mike Trout",
      decision: {
        action: "create",
        // Spelled with different punctuation/word order from the enrichment
        // entry — the exclusion is matched on the NORMALIZED name, so it must
        // not be defeated by how the label happened to be rendered in the UI.
        excludedCareerTeamNames: ["Wrong, Team F.C."],
      },
      enrichment: {
        careerTeams: [
          { name: "Los Angeles Angels", fromYear: 2011 },
          { name: "Wrong Team FC", fromYear: 1999, toYear: 2001 },
        ],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Mike Trout", players: ["Mike Trout"] })],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "mike trout").eq("sportId", sportId),
        )
        .first(),
    );
    expect(player!.teamYears).toHaveLength(1);
    const kept = await t.run(async (ctx) => ctx.db.get(player!.teamYears![0].teamId));
    expect(kept!.name).toBe("Los Angeles Angels");

    // The rejected team was never MINTED. Filtering after resolveTeamIdByName
    // would leave an orphan row here that nothing points at, and that the next
    // lookup of that name would silently adopt.
    const allTeams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(allTeams.map((tm) => tm.name)).toEqual(["Los Angeles Angels"]);
  });

  test("an exclusion never touches a manual entry — the admin typed that one on purpose", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Mike Trout",
      decision: {
        action: "create",
        manualCareerTeams: [{ name: "Los Angeles Angels", fromYear: 2011 }],
        // The exclusion list is built from what the LOOKUP returned; it is not
        // a global blocklist, and an admin who unchecked Wikidata's entry and
        // then typed their own is asking for exactly the typed one.
        excludedCareerTeamNames: ["Los Angeles Angels"],
      },
      enrichment: {
        careerTeams: [{ name: "Los Angeles Angels", fromYear: 2005, toYear: 2010 }],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Mike Trout", players: ["Mike Trout"] })],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "mike trout").eq("sportId", sportId),
        )
        .first(),
    );
    expect(player!.teamYears).toHaveLength(1);
    // The manual entry's years, not the excluded Wikidata entry's 2005–2010.
    expect(player!.teamYears![0].fromYear).toBe(2011);
    expect(player!.teamYears![0].toYear).toBeUndefined();
  });
});
