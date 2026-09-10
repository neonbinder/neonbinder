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
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { MAX_CARD_PLAYERS, MAX_CARD_TEAMS } from "./features/cardAttention";

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
      // NEO-236: the operator's Location + Name. A team row is built from
      // THIS and nothing else — `name` above is the raw checklist string and
      // is never stored. Absent means the prelude creates nothing.
      create?: { location?: string; name: string };
      // NEO-236, player rows: the same, per accepted career team that matched
      // no existing row. Absent for a label means that stint is dropped.
      createTeams?: Array<{ sourceName: string; location?: string; name: string }>;
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

/**
 * NEO-236: what the wizard sends for career-team labels the operator LEFT
 * UNTOUCHED — Name pre-filled to the label, Location blank.
 *
 * This is the fixture that keeps these tests about what they were about. The
 * split itself is exercised by the tests that pass a real Location; here the
 * point is that a career team is only created because the OPERATOR supplied a
 * Location + Name for it, even when the pair they confirmed happens to be the
 * label unchanged.
 */
function untouchedCreateTeams(
  labels: string[],
): Array<{ sourceName: string; name: string }> {
  return labels.map((sourceName) => ({ sourceName, name: sourceName }));
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
      decision: {
        action: "create",
        createTeams: untouchedCreateTeams([
          "Los Angeles Angels",
          "Los Angeles Angels of Anaheim",
        ]),
      },
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

    // Each careerTeams NAME resolved to a real (bare, unenriched) team row.
    // NEO-236: created from the operator's Location + Name (here the untouched
    // pre-fill: the label, no location), never from the label itself — a label
    // with no `createTeams` entry and no existing match is dropped instead.
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
        createTeams: untouchedCreateTeams([
          "Arizona Diamondbacks",
          "Toronto Blue Jays",
        ]),
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
        createTeams: untouchedCreateTeams([
          "Arizona Diamondbacks",
          "Toronto Blue Jays",
        ]),
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
        createTeams: untouchedCreateTeams([
          "Los Angeles Angels",
          "Angels Los Angeles",
        ]),
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

  test("a team 'create' decision builds the row from the operator's Location + Name, and takes league/yearsActive/colors/espnId from its enrichment", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "team",
      name: "Los Angeles Angels",
      // NEO-236: the operator's split, confirmed in the wizard. Note it does
      // NOT agree with `enrichment.location` below, on purpose — see the
      // assertions.
      decision: {
        action: "create",
        create: { location: "Los Angeles", name: "Angels" },
      },
      enrichment: {
        wikidataId: "Q217123",
        espnId: "3",
        league: "Major League Baseball",
        // Wikidata/ESPN say the franchise is headquartered in Anaheim. It is
        // not the location part of the NAME, and nothing may write it as one.
        location: "Anaheim",
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
    // ── NEO-236 ───────────────────────────────────────────────────────────
    // The row is the OPERATOR's two fields, not the checklist string and not
    // the enrichment's location. "Anaheim" was a headquarters, and writing it
    // behind the operator's answer would have produced "Anaheim Angels" — a
    // team that has not existed since 2005.
    expect(team!.name).toBe("Angels");
    expect(team!.location).toBe("Los Angeles");
    // ...while the dedup key is still derived from the WHOLE name, which is
    // why the lookup above (`angeles angels los`) found it at all. That is the
    // invariant the split rests on: token-sorted normalisation makes a split
    // row and an unsplit one the same key.
    expect(team!.nameNormalized).toBe("angeles angels los");
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
    // NEO-212 security review: the commit that produced the skip is recorded
    // alongside it. It is the audit handle `entityReviewSkips.listForSet`
    // returns in place of `skippedByUserId`, so a suppressed name can be traced
    // back to a review session without shipping an operator id to the client.
    expect(skips[0].batchId).toBe("batch-1");
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
    expect(first.batchId).toBe("batch-1");

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
    // NEO-212 security review: `batchId` moves forward with the other two
    // audit fields. The row records who most recently stood behind the skip
    // and in which session — pointing at the first batch while naming the
    // second commit's operator would describe a session that never happened.
    expect(skips[0].batchId).toBe("batch-2");
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

  /**
   * NEO-253 — the two spellings are ONE name to the retirement pass too.
   *
   * A custom card's pending name is hand-typed by an operator; the name the
   * wizard settles came off a marketplace roster. Two spellings of one person
   * between those two sources is the normal case, not an edge one, and it is
   * precisely what the fold now treats as identical everywhere else in the
   * commit. Compared as trimmed literals, the retirement pass was the one place
   * that still disagreed: the operator skips "José Ramírez", and the custom
   * card's "Jose Ramirez" stays pending forever — re-offered on every later
   * fetch of the set, which is the exact loop `entityReviewSkips` exists to
   * break, half-working.
   */
  test("a pending name is retired by the OTHER spelling being settled (NEO-253)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const customCardId = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: "C1",
        cardName: "Hand-added Card",
        isCustom: true,
        // The operator typed it without accents.
        pendingPlayerNames: ["Jose Ramirez", "Still Unreviewed"],
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );

    // The wizard settles the ACCENTED spelling, which is how SportLots spells
    // it.
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "José Ramírez",
      decision: { action: "skip" },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Unrelated" })],
      batchId: "batch-1",
    });

    const card = await t.run(async (ctx) => ctx.db.get(customCardId));
    // Retired, and the unrelated pending name is untouched.
    expect(card!.pendingPlayerNames).toEqual(["Still Unreviewed"]);
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
      decision: {
        action: "create",
        createTeams: untouchedCreateTeams(["Los Angeles Angels"]),
      },
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
    // Two stints, ONE team row. NEO-236: the first stint creates it from the
    // operator's Location + Name, the second FINDS it — `findTeamByFullName`
    // runs before the insert in `createTeamFromOperatorInput`, so a repeated
    // label cannot produce a second row.
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
        createTeams: untouchedCreateTeams(["Los Angeles Angels"]),
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
        // NEO-236: BOTH labels are answered here, including the excluded one.
        // The exclusion has to be what stops it, not the absence of a create
        // entry — otherwise this test would pass for the wrong reason.
        createTeams: untouchedCreateTeams([
          "Los Angeles Angels",
          "Wrong Team FC",
        ]),
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

    // The rejected team was never MINTED — even though the decision carries a
    // `createTeams` entry for it. The exclusion is checked before the label is
    // resolved at all, so an orphan row nothing points at (and that the next
    // lookup of that name would silently adopt) cannot appear.
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
        createTeams: untouchedCreateTeams(["Los Angeles Angels"]),
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

// ===========================================================================
// NEO-236 — the prelude MATCHES teams; it never inserts on a miss
//
// Jason, 2026-09-05: the operator-less creators "are still looking up the team
// in each of those places and if there is a match we are linking to the team
// still"; on a miss they leave the card for operator review instead of
// inserting. These tests pin both halves of that, plus the one path that DOES
// create — an operator's reviewed Location + Name.
// ===========================================================================

/** Insert a team row the way `teamRowFields` would, split or whole. */
async function seedTeam(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  parts: { name: string; location?: string },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name: parts.name,
      ...(parts.location ? { location: parts.location } : {}),
      // The invariant: the key is derived from the WHOLE name, token-sorted.
      nameNormalized: [parts.location, parts.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .split(/\s+/)
        .sort()
        .join(" "),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

describe("commitCardChecklist: an unresolvable team name is reported, never invented", () => {
  test("an UNREVIEWED team name creates nothing, links nothing, and comes back in unresolvedTeamNames", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const prelude = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistPrelude,
      {
        selectorOptionId: variantTypeId,
        sportId,
        playerNames: [],
        teamNames: ["Wichita Wind Surge"],
      },
    );

    expect(prelude.teamIdByName).toEqual([]);
    expect(prelude.createdTeamIds).toEqual([]);
    expect(prelude.unresolvedTeamNames).toEqual(["Wichita Wind Surge"]);
    expect(prelude.unresolvedTeamCount).toBe(1);

    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toEqual([]);
  });

  /**
   * NEO-236 security review — the unlinked list is bounded; the count is not.
   *
   * A first sync of a large set can leave hundreds of team names unlinked at
   * once, and each is raw marketplace text of unbounded length — so an
   * uncapped `unresolvedTeamNames` is an unbounded return value assembled from
   * third-party strings. Capped at 200 with `unresolvedTeamCount` carrying the
   * real number, the same shape `ambiguousKeys` and `staleDecisionIds` already
   * use. The count is what the commit's log line and its "anything to review?"
   * check read, so truncating the list cannot make work disappear.
   */
  test("unresolvedTeamNames is capped at 200 while unresolvedTeamCount stays true", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const teamNames = Array.from(
      { length: 260 },
      (_, i) => `Unknown Ballclub ${i}`,
    );

    const prelude = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistPrelude,
      {
        selectorOptionId: variantTypeId,
        sportId,
        playerNames: [],
        teamNames,
      },
    );

    expect(prelude.unresolvedTeamCount).toBe(260);
    expect(prelude.unresolvedTeamNames).toHaveLength(200);
    // A real sample, not one name repeated.
    expect(new Set(prelude.unresolvedTeamNames).size).toBe(200);
    // And still nothing created — the cap is about the REPORT, not the rule.
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toEqual([]);
  });

  test("a 'create' decision with NO operator Location + Name creates nothing", async () => {
    // The shape a pre-NEO-236 queue row has, and the shape a bulk decide would
    // have had if it did not pre-fill. There is deliberately no fallback to the
    // raw string, so this is the one place the rule is provably load-bearing.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "team",
      name: "Wichita Wind Surge",
      decision: { action: "create" },
    });

    const prelude = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistPrelude,
      {
        selectorOptionId: variantTypeId,
        sportId,
        playerNames: [],
        teamNames: ["Wichita Wind Surge"],
        batchId: "batch-1",
      },
    );

    expect(prelude.createdTeamIds).toEqual([]);
    expect(prelude.unresolvedTeamNames).toEqual(["Wichita Wind Surge"]);
    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toEqual([]);
  });

  test("a SKIPPED team is not 'unresolved' — 'not a team' is an answer", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "team",
      name: "CHECKLIST",
      decision: { action: "skip" },
    });

    const prelude = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistPrelude,
      {
        selectorOptionId: variantTypeId,
        sportId,
        playerNames: [],
        teamNames: ["CHECKLIST"],
        batchId: "batch-1",
      },
    );

    expect(prelude.unresolvedTeamNames).toEqual([]);
    expect(prelude.skippedTeamNames).toEqual(["CHECKLIST"]);
  });

  test("an unresolved team leaves the CARD without a team id, and the name pending", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({
          cardNumber: "1",
          cardName: "Team Card",
          teams: ["Wichita Wind Surge"],
        }),
      ],
    });

    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .first(),
    );
    // No team id — the attention walker's missing-team lane is what surfaces
    // this, exactly as it does for a card that named no team at all.
    expect(card!.teamOnCardIds ?? []).toEqual([]);
    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toEqual([]);
  });
});

describe("commitCardChecklist: an operator's Location + Name LINKS before it creates", () => {
  test("links to an existing SPLIT row when the composed name matches it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    const padresId = await seedTeam(t, sportId, {
      location: "San Diego",
      name: "Padres",
    });

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "team",
      // A checklist string that normalises to something ELSE, so the loop's
      // own by-name lookup misses and only the composed name can match.
      name: "SD Padres",
      decision: {
        action: "create",
        create: { location: "San Diego", name: "Padres" },
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Padres", teams: ["SD Padres"] })],
      batchId: "batch-1",
    });

    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(1);
    expect(teams[0]._id).toBe(padresId);

    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .first(),
    );
    expect(card!.teamOnCardIds).toEqual([padresId]);
    // NEO-236: the name that reaches the listing title is the FULL one, not
    // the nickname the row happens to store — roughly half of sold comps are
    // searched by city, so "Padres" alone is a worse search term.
    expect(card!.listingTitle).toContain("San Diego Padres");
  });

  test("links to an existing UNSPLIT row too — the dedup key is the same either way", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    // A row nobody has split yet: the whole name in `name`, no location.
    const padresId = await seedTeam(t, sportId, { name: "San Diego Padres" });

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "team",
      name: "SD Padres",
      decision: {
        action: "create",
        create: { location: "San Diego", name: "Padres" },
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Padres", teams: ["SD Padres"] })],
      batchId: "batch-1",
    });

    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(1);
    expect(teams[0]._id).toBe(padresId);
    // The existing row is NOT rewritten into the operator's split. Linking is
    // linking; re-splitting a row behind an operator who was creating a
    // different one is exactly the silent overwrite NEO-236 forbids.
    expect(teams[0].name).toBe("San Diego Padres");
    expect(teams[0].location).toBeUndefined();
  });

  test("creates a properly split row when nothing matches, and enqueues no re-enrichment", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "team",
      name: "Wind Surge",
      decision: {
        action: "create",
        create: { location: "Wichita", name: "Wind Surge" },
      },
    });

    const prelude = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistPrelude,
      {
        selectorOptionId: variantTypeId,
        sportId,
        playerNames: [],
        teamNames: ["Wind Surge"],
        batchId: "batch-1",
      },
    );

    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("Wind Surge");
    expect(teams[0].location).toBe("Wichita");
    expect(teams[0].nameNormalized).toBe("surge wichita wind");
    expect(prelude.createdTeamIds).toEqual([teams[0]._id]);
    expect(prelude.unresolvedTeamNames).toEqual([]);
    // And the FULL name is what leaves the prelude.
    expect(prelude.teamNameById).toEqual([
      { id: teams[0]._id, name: "Wichita Wind Surge" },
    ]);
  });
});

describe("commitCardChecklist: career teams link on a match and are dropped without one", () => {
  test("a career team matching an existing SPLIT row links to it and creates nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    const padresId = await seedTeam(t, sportId, {
      location: "San Diego",
      name: "Padres",
    });

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Tony Gwynn",
      decision: { action: "create" },
      enrichment: {
        careerTeams: [{ name: "San Diego Padres", fromYear: 1982, toYear: 2001 }],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Tony Gwynn", players: ["Tony Gwynn"] })],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "gwynn tony").eq("sportId", sportId),
        )
        .first(),
    );
    // Linked, with NO `createTeams` entry needed — matching comes first.
    expect(player!.teamYears).toHaveLength(1);
    expect(player!.teamYears![0].teamId).toBe(padresId);
    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(1);
  });

  test("a career team matching NOTHING, with no operator pair, is dropped rather than minted", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Tony Gwynn",
      // The old behaviour minted a `teams` row straight off this P54 label.
      decision: { action: "create" },
      enrichment: {
        careerTeams: [
          { name: "San Diego State Aztecs baseball", fromYear: 1979, toYear: 1981 },
        ],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", cardName: "Tony Gwynn", players: ["Tony Gwynn"] })],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "gwynn tony").eq("sportId", sportId),
        )
        .first(),
    );
    // The player is still created — only the unreviewable stint is dropped.
    expect(player).not.toBeNull();
    expect(player!.teamYears).toBeUndefined();
    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toEqual([]);
  });

  test("with an operator pair, the same career team is created SPLIT and enqueued for enrichment", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Tony Gwynn",
      decision: {
        action: "create",
        createTeams: [
          {
            sourceName: "Padres",
            location: "San Diego",
            name: "Padres",
          },
        ],
      },
      enrichment: {
        careerTeams: [{ name: "Padres", fromYear: 1982, toYear: 2001 }],
      },
    });

    const prelude = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistPrelude,
      {
        selectorOptionId: variantTypeId,
        sportId,
        playerNames: ["Tony Gwynn"],
        teamNames: [],
        batchId: "batch-1",
      },
    );

    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("Padres");
    expect(teams[0].location).toBe("San Diego");
    // NEO-254 — it lands BARE and stays bare. This used to assert the id came
    // back on `prelude.enrichmentTeamIds` for `commitCardChecklistFinalize` to
    // enqueue; teams are no longer enriched automatically at creation, so
    // there is no such list and the only remedy is Team Management's
    // Discover. The row itself is what the commit is responsible for, and it
    // is asserted above.
    // Answered, so it is not reported as unresolved.
    expect(prelude.unresolvedTeamNames).toEqual([]);
  });
});

describe("commitCardChecklist: a team is created by its OWN step, not by the bulk", () => {
  /**
   * NEO-236. Jason, 2026-09-05: "add all remaining as new should still process
   * teams, it should only apply to players."
   *
   * This block used to pin the opposite — that the bulk wrote a team row's
   * pre-fill and the prelude built from it. That pre-fill included the LEAGUE,
   * chosen from the enrichment's suggestion with no human in the loop, which is
   * the defect this ticket exists to close. So the contract is inverted: the
   * bulk leaves the team alone, and the row is created from the answer given on
   * its own New Team step.
   */
  async function seedTeamRow(
    t: ReturnType<typeof convexTest>,
    variantTypeId: Id<"selectorOptions">,
    sportId: Id<"selectorOptions">,
  ) {
    return t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: variantTypeId,
        batchId: "batch-1",
        // NEO-221 added a review-session ownership check to the bulk
        // mutations, so the row has to belong to the session that decides it.
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "team",
        name: "San Diego Padres",
        sportId,
        status: "ready",
        enrichment: { location: "San Diego" },
      }),
    );
  }

  const teamCard = () => [
    makeCard({ cardNumber: "1", cardName: "Team Card", teams: ["San Diego Padres"] }),
  ];

  test("the bulk alone creates NO team, and the card keeps the name unresolved", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    await seedTeamRow(t, variantTypeId, sportId);

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId: variantTypeId,
      batchId: "batch-1",
    });
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: teamCard(),
      batchId: "batch-1",
    });

    // Nothing invented. In the product the wizard would not have offered
    // "Confirm & Save" at all while that step was open — this asserts the
    // server half of that promise, which is what holds if a client ever
    // commits early.
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toEqual([]);
    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .first(),
    );
    expect(card!.teamOnCardIds ?? []).toEqual([]);
  });

  test("answering the New Team step lands a real, split teams row on the card", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    const rowId = await seedTeamRow(t, variantTypeId, sportId);

    // What one tap on the step's primary action records: the Location and Name
    // the step was already showing.
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      create: { location: "San Diego", name: "Padres" },
    });
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: teamCard(),
      batchId: "batch-1",
    });

    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("Padres");
    expect(teams[0].location).toBe("San Diego");
    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .first(),
    );
    expect(card!.teamOnCardIds).toEqual([teams[0]._id]);
  });
});

// ===========================================================================
// NEO-221 — a name that reached commit with NO decision
//
// Every test above hands commit a batch whose rows are all decided, because
// that is what the wizard produces when it runs to completion. This block is
// about the other endings: the operator dismissed the wizard, committed with
// rows still open, or came back to a batch that had moved on. Commit has to
// land the cards anyway — refusing would cost the operator the whole sync —
// so the names it could not resolve are recorded ON the cards, counted for the
// caller, and folded straight back into the next fetch's wizard by
// `resolveUnknownsAndStartBatch`, which already reads these two fields off
// every row.
//
// A "skip" is deliberately NOT one of these: the operator ruled that the name
// is not an entity, so the card keeping it as free text is the intended
// outcome rather than an unanswered question.
// ===========================================================================

/** A review row with no decision at all — the shape this block is about. */
async function insertUndecidedReviewRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    batchId: string;
    kind: "player" | "team";
    name: string;
    sportId: Id<"selectorOptions">;
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
      status: "ready" as const,
    }),
  );
}

async function readCards(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", selectorOptionId),
      )
      .collect(),
  );
}

describe("commitCardChecklist: unreviewed names", () => {
  test("an undecided player name is stamped on the card and counted in the return", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertUndecidedReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Never Reviewed",
    });

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCard({ cardNumber: "1", players: ["Never Reviewed"] }),
        makeCard({ cardNumber: "2", players: [] }),
      ],
      batchId: "batch-1",
    });

    // The commit still LANDS — refusing would cost the operator the sync.
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    // Distinct names, not cards: one name went unanswered.
    expect(result.unreviewedNameCount).toBe(1);

    const cards = await readCards(t, variantTypeId);
    const one = cards.find((c) => c.cardNumber === "1")!;
    expect(one.pendingPlayerNames).toEqual(["Never Reviewed"]);
    // No player row was minted for it, and the card links to nothing.
    expect(one.playerIds ?? []).toEqual([]);
    expect(
      await t.run(async (ctx) => ctx.db.query("players").collect()),
    ).toHaveLength(0);
    // A card that carried none of the unreviewed names is untouched.
    expect(cards.find((c) => c.cardNumber === "2")!.pendingPlayerNames).toBeUndefined();
  });

  test("an undecided TEAM name is stamped the same way", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertUndecidedReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "team",
      name: "Reno Aces",
    });

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", teams: ["Reno Aces"] })],
      batchId: "batch-1",
    });

    expect(result.unreviewedNameCount).toBe(1);
    const [card] = await readCards(t, variantTypeId);
    expect(card.pendingTeamNames).toEqual(["Reno Aces"]);
    expect(card.teamOnCardIds ?? []).toEqual([]);
  });

  test("a SKIPPED name is not unreviewed — the operator answered", async () => {
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

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["CHECKLIST"] })],
      batchId: "batch-1",
    });

    expect(result.unreviewedNameCount).toBe(0);
    const [card] = await readCards(t, variantTypeId);
    // The card keeps the raw name as free text, exactly as before — nothing
    // is stamped, because nothing is waiting.
    expect(card.pendingPlayerNames).toBeUndefined();
  });

  test("a LATER commit that carries a decision clears the stamp", async () => {
    // The self-healing loop, end to end: the unreviewed name goes onto the
    // card, `resolveUnknownsAndStartBatch` folds it back into the next fetch's
    // wizard, the operator rules on it, and the next commit retires the stamp
    // because the name is now one this commit SETTLED.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertUndecidedReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Elly De La Cruz",
    });
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Elly De La Cruz"] })],
      batchId: "batch-1",
    });
    expect((await readCards(t, variantTypeId))[0].pendingPlayerNames).toEqual([
      "Elly De La Cruz",
    ]);

    // Second sync: this time the operator reviewed the name.
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-2",
      kind: "player",
      name: "Elly De La Cruz",
      decision: { action: "create" },
    });
    const second = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Elly De La Cruz"] })],
      batchId: "batch-2",
    });

    expect(second.unreviewedNameCount).toBe(0);
    const cards = await readCards(t, variantTypeId);
    expect(cards).toHaveLength(1);
    expect(cards[0].pendingPlayerNames).toBeUndefined();
    expect(
      await t.run(async (ctx) => ctx.db.query("players").collect()),
    ).toHaveLength(1);
  });

  test("a name the operator SKIPPED on a later commit also clears the stamp", async () => {
    // "Not a person" is an answer, so the name stops waiting for one. Left
    // stamped it would badge the card forever, since a skip means no
    // players/teams row will ever exist to resolve it.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertUndecidedReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "CHECKLIST",
    });
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["CHECKLIST"] })],
      batchId: "batch-1",
    });

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-2",
      kind: "player",
      name: "CHECKLIST",
      decision: { action: "skip" },
    });
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["CHECKLIST"] })],
      batchId: "batch-2",
    });

    expect((await readCards(t, variantTypeId))[0].pendingPlayerNames).toBeUndefined();
  });

  test("a re-sync does NOT drop an operator-typed name this commit said nothing about", async () => {
    // The load-bearing half of the merge. `pendingPlayerNames` is storage this
    // feature SHARES with `addCustomCard`: a hand-added card can carry a name
    // an operator typed, and a marketplace card matching that row later must
    // not silently throw it away. This commit only speaks for the names it
    // actually settled.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const handAddedId = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: "1",
        cardName: "Hand added",
        isCustom: true,
        pendingPlayerNames: ["Operator Typed"],
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );

    await insertUndecidedReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Never Reviewed",
    });
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Never Reviewed"] })],
      batchId: "batch-1",
    });

    const row = await t.run(async (ctx) => ctx.db.get(handAddedId));
    // Both: the operator's own name is untouched, and the sync's unreviewed
    // name is added beside it.
    expect(row!.pendingPlayerNames).toEqual(["Operator Typed", "Never Reviewed"]);
  });

  test("the count is what was STAMPED, not every name the prelude could not resolve", async () => {
    // The prelude also folds in existing custom cards' own pending names, so
    // an unreviewed one of those is unresolved but sits on no incoming card.
    // Counting it would tell the operator "2 names were not reviewed" about a
    // commit that stamped one, and send them looking for a card that does not
    // carry it.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: "9001",
        cardName: "Hand added, not in this sync",
        isCustom: true,
        pendingPlayerNames: ["Folded In From A Custom Card"],
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );
    for (const name of ["On An Incoming Card", "Folded In From A Custom Card"])
      await insertUndecidedReviewRow(t, {
        selectorOptionId: variantTypeId,
        sportId,
        batchId: "batch-1",
        kind: "player",
        name,
      });

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["On An Incoming Card"] })],
      batchId: "batch-1",
    });

    // One, not two.
    expect(result.unreviewedNameCount).toBe(1);
    const cards = await readCards(t, variantTypeId);
    expect(cards.find((c) => c.cardNumber === "1")!.pendingPlayerNames).toEqual([
      "On An Incoming Card",
    ]);
    // And the hand-added card keeps its own name, untouched by this commit.
    expect(cards.find((c) => c.cardNumber === "9001")!.pendingPlayerNames).toEqual([
      "Folded In From A Custom Card",
    ]);
  });

  test("a re-sync that changes nothing writes nothing but the timestamp", async () => {
    // The merge must not manufacture a patch out of a value it is restating.
    // `platformData`/`sortOrder`/`lastUpdated` are refreshed unconditionally on
    // every matched row (that is what the sync is FOR), so the assertion is
    // that everything ELSE — the pending-name fields included — comes back
    // byte-identical.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const commit = (batchId: string) =>
      asAdmin.action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ cardNumber: "1", players: ["Still Unreviewed"] })],
        batchId,
      });

    await insertUndecidedReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Still Unreviewed",
    });
    await commit("batch-1");
    const before = (await readCards(t, variantTypeId))[0];
    expect(before.pendingPlayerNames).toEqual(["Still Unreviewed"]);

    // Same card, same still-unreviewed name.
    await insertUndecidedReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-2",
      kind: "player",
      name: "Still Unreviewed",
    });
    await commit("batch-2");

    const after = (await readCards(t, variantTypeId))[0];
    expect(after._id).toBe(before._id);
    expect(after.pendingPlayerNames).toEqual(["Still Unreviewed"]);
    expect({ ...after, lastUpdated: 0 }).toEqual({ ...before, lastUpdated: 0 });
  });

  test("a fully-reviewed commit writes neither field and reports zero", async () => {
    // The common path has to be byte-identical to what it was before this
    // feature existed — no stamp, nothing to badge, nothing to say.
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
    });

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Mike Trout"] })],
      batchId: "batch-1",
    });

    expect(result.unreviewedNameCount).toBe(0);
    const [card] = await readCards(t, variantTypeId);
    expect(card.pendingPlayerNames).toBeUndefined();
    expect(card.pendingTeamNames).toBeUndefined();
    expect(card.playerIds).toHaveLength(1);
  });
});

// ===========================================================================
// NEO-221 — the "Back to matching" return trip must not orphan the batch
// ===========================================================================

describe("resolveChecklistEntities: an open batch is reconciled even when nothing is unknown", () => {
  test("returns the open batchId, drops the undecided row, keeps the decided one", async () => {
    // The exact loop: Confirm opens the wizard, the operator goes Back to
    // matching, re-pairs so every name now resolves, and Confirms again. The
    // guard used to be "only call startBatch when unknowns > 0", so this
    // second Confirm returned no batchId — commit never read the batch, never
    // deleted it, and its rows resumed themselves into the NEXT fetch of the
    // set, carrying decisions taken against a card list that had moved on.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const rowIds = await t.run(async (ctx) => {
      const mk = (name: string, decided: boolean) =>
        ctx.db.insert("entityReviewQueue", {
          selectorOptionId: variantTypeId,
          batchId: "batch-open",
          // Must be the CALLER, or this is somebody else's batch and
          // `findOpenBatch` correctly declines to see it.
          createdByUserId: ADMIN_IDENTITY.subject,
          kind: "player" as const,
          name,
          sportId,
          status: "ready" as const,
          ...(decided ? { decision: { action: "create" as const } } : {}),
        });
      return {
        decided: await mk("Ruled On", true),
        undecided: await mk("Never Ruled On", false),
      };
    });

    // Nothing unknown this time round — the re-pair resolved everything.
    const resolved = await asAdmin.action(
      api.selectorOptions.resolveChecklistEntities,
      { selectorOptionId: variantTypeId, sportId, cards: [] },
    );

    expect(resolved.unknownPlayers).toEqual([]);
    expect(resolved.unknownTeams).toEqual([]);
    // The id commit needs in order to consume and delete the batch.
    expect(resolved.batchId).toBe("batch-open");

    expect(await t.run(async (ctx) => ctx.db.get(rowIds.undecided))).toBeNull();
    const kept = await t.run(async (ctx) => ctx.db.get(rowIds.decided));
    expect(kept!.decision).toEqual({ action: "create" });
  });

  test("with NO open batch and nothing unknown, no batch is minted", async () => {
    // The other half of the guard: calling startBatch unconditionally would
    // hand the client a batchId for a wizard with nothing in it.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const resolved = await asAdmin.action(
      api.selectorOptions.resolveChecklistEntities,
      { selectorOptionId: variantTypeId, sportId, cards: [] },
    );

    expect(resolved.batchId).toBeUndefined();
    expect(
      await t.run(async (ctx) => ctx.db.query("entityReviewQueue").collect()),
    ).toHaveLength(0);
  });
});

// ===========================================================================
// NEO-254 — the prelude never guesses between two players with one name
// ===========================================================================

/** A bare `players` row on the exact dedup key, with no review row behind it. */
async function insertBarePlayer(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
  nameNormalized: string,
  extra: { birthYear?: number } = {},
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized,
      sportId,
      lastUpdated: Date.now(),
      ...extra,
    }),
  );
}

describe("NEO-254: an ambiguous player name is resolved by the operator, never by the index", () => {
  test("exactly ONE existing row is still adopted silently", async () => {
    // The unchanged half, pinned so the guard cannot be tightened into
    // demanding a decision for every name that already resolves.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    const only = await insertBarePlayer(t, sportId, "Tony Gwynn", "gwynn tony");

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Tony Gwynn"] })],
    });

    const cards = await readCards(t, variantTypeId);
    expect(cards[0].playerIds).toEqual([only]);
    // No second row minted, and no decision was needed.
    expect(
      await t.run(async (ctx) => ctx.db.query("players").collect()),
    ).toHaveLength(1);
  });

  test("TWO existing rows and no decision links NOTHING and reports the name", async () => {
    // The failure this ticket exists for. `.first()` bound the card to
    // whichever Bob Allen the index returned, silently. Now the name is
    // treated exactly like an unreviewed one: the card keeps it as text, the
    // commit still lands, and the operator is told.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    await insertBarePlayer(t, sportId, "Bob Allen", "allen bob", { birthYear: 1867 });
    await insertBarePlayer(t, sportId, "Bob Allen", "allen bob", { birthYear: 1937 });

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Bob Allen"] })],
    });

    expect(result.success).toBe(true);
    expect(result.unreviewedNameCount).toBe(1);

    const cards = await readCards(t, variantTypeId);
    expect(cards[0].playerIds ?? []).toEqual([]);
    expect(cards[0].pendingPlayerNames).toEqual(["Bob Allen"]);
    // And no third Bob Allen was minted to paper over the ambiguity.
    expect(
      await t.run(async (ctx) => ctx.db.query("players").collect()),
    ).toHaveLength(2);
  });

  test("a LINK decision names which of the two, and that one is used", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    await insertBarePlayer(t, sportId, "Bob Allen", "allen bob", { birthYear: 1867 });
    const younger = await insertBarePlayer(t, sportId, "Bob Allen", "allen bob", {
      birthYear: 1937,
    });

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Bob Allen",
      decision: { action: "link", linkedPlayerId: younger },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Bob Allen"] })],
      batchId: "batch-1",
    });

    const cards = await readCards(t, variantTypeId);
    expect(cards[0].playerIds).toEqual([younger]);
    expect(
      await t.run(async (ctx) => ctx.db.query("players").collect()),
    ).toHaveLength(2);
  });

  test("a CREATE decision on an ambiguous name mints a third row on purpose", async () => {
    // Two Bob Allens on file and the operator says this is a THIRD man. That
    // is a real answer — the wizard showed them both — and the commit must
    // take it rather than quietly reusing one of the rows they rejected.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    await insertBarePlayer(t, sportId, "Bob Allen", "allen bob", { birthYear: 1867 });
    await insertBarePlayer(t, sportId, "Bob Allen", "allen bob", { birthYear: 1937 });

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Bob Allen",
      decision: { action: "create" },
      enrichment: { wikidataId: "Q999" },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Bob Allen"] })],
      batchId: "batch-1",
    });

    const players = await t.run(async (ctx) => ctx.db.query("players").collect());
    expect(players).toHaveLength(3);
    const created = players.find((p) => p.externalIds?.wikidataId === "Q999")!;
    const cards = await readCards(t, variantTypeId);
    expect(cards[0].playerIds).toEqual([created._id]);
  });
});

// ===========================================================================
// NEO-254 — an undated Wikidata team the operator DATED in the wizard
// ===========================================================================

describe("NEO-254: dating a lead in the wizard is what makes it career data", () => {
  test("a dated lead becomes a stint; one left undated persists nothing", async () => {
    // NEO-235's rule: a membership with no start year cannot become a stint,
    // because inventing the year fabricates history the SKU and listing paths
    // then read as fact. The wizard surfaces those names anyway and offers
    // "Add years", which turns one into an ordinary manual career team — and
    // THAT is the only thing that persists.
    //
    // Jason, 2026-09-06: a lead nobody dated is not stored on the player. It
    // is a suggestion for this review, and the lookup returns it again next
    // time the name is reviewed, so nothing is lost by leaving it out of NB's
    // own data.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    // NEO-236: the commit prelude resolves a manual career team by NAME and
    // never inserts a team of its own — a team that does not exist yet gets
    // its own New Team step in the wizard. So the team is on file here, which
    // is the state the wizard leaves behind by the time Confirm is pressed.
    const aztecs = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "San Diego State Aztecs baseball",
        nameNormalized: "aztecs baseball diego san state",
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Tony Gwynn",
      decision: {
        action: "create",
        manualCareerTeams: [
          { name: "San Diego State Aztecs baseball", fromYear: 1979, toYear: 1981 },
        ],
      },
      enrichment: {
        undatedCareerTeams: [
          "San Diego State Aztecs baseball",
          "United States national team",
        ],
      },
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Tony Gwynn"] })],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "gwynn tony").eq("sportId", sportId),
        )
        .first(),
    );
    // The dated one, and only the dated one.
    expect(player!.teamYears).toEqual([
      { teamId: aztecs, fromYear: 1979, toYear: 1981 },
    ]);
    // The undated one created no team row and left no trace on the player.
    const teams = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(teams.map((row) => row.name)).toEqual(["San Diego State Aztecs baseball"]);
  });
});

// ===========================================================================
// NEO-254 — the public entry point, and a link whose target went away
// ===========================================================================

describe("NEO-254: resolveChecklistEntities enqueues an ambiguous name for review", () => {
  test("TWO same-name rows enqueue a review row, carrying the candidates", async () => {
    // The end-to-end shape of the gate: `.first()` used to answer "known" here
    // and the wizard never opened at all, so nothing downstream could have
    // helped. The candidates ride on the row from the moment it is inserted —
    // NOT from when its Wikidata lookup lands — because the backstop and the
    // stale-row sweep both settle a row without ever going near `players`.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    await insertBarePlayer(t, sportId, "Bob Allen", "allen bob", { birthYear: 1867 });
    await insertBarePlayer(t, sportId, "Bob Allen", "allen bob", { birthYear: 1937 });

    const resolved = await asAdmin.action(
      api.selectorOptions.resolveChecklistEntities,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ cardNumber: "1", players: ["Bob Allen"] })],
      },
    );

    expect(resolved.unknownPlayers).toEqual(["Bob Allen"]);
    expect(resolved.batchId).toBeDefined();

    const rows = await t.run(async (ctx) =>
      ctx.db.query("entityReviewQueue").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Bob Allen");
    // Still `pending` — no lookup has run — and already knows it is a choice.
    expect(rows[0].status).toBe("pending");
    expect(rows[0].enrichment?.existingCandidates).toHaveLength(2);
    expect(
      rows[0].enrichment?.existingCandidates?.map((c) => c.birthYear).sort(),
    ).toEqual([1867, 1937]);
  });

  test("exactly ONE existing row enqueues nothing — the name is resolved", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    await insertBarePlayer(t, sportId, "Tony Gwynn", "gwynn tony");

    const resolved = await asAdmin.action(
      api.selectorOptions.resolveChecklistEntities,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ cardNumber: "1", players: ["Tony Gwynn"] })],
      },
    );

    expect(resolved.unknownPlayers).toEqual([]);
    expect(resolved.batchId).toBeUndefined();
    expect(
      await t.run(async (ctx) => ctx.db.query("entityReviewQueue").collect()),
    ).toHaveLength(0);
  });

  test("an unambiguous NEW name still enqueues a row with no candidates on it", async () => {
    // The ordinary path, pinned so the enqueue-time candidate build cannot
    // start decorating rows that are not a choice.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await asAdmin.action(api.selectorOptions.resolveChecklistEntities, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Daulton Varsho"] })],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("entityReviewQueue").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].enrichment).toBeUndefined();
  });
});

describe("NEO-254: a link decision is re-validated at commit", () => {
  test("a linked player deleted since the decision leaves the card unlinked and reports the name", async () => {
    // A review session is human-paced. Between recording the decision and
    // pressing Confirm, another operator can merge or delete the row that was
    // picked — and this used to write the dead id straight onto the card,
    // where it was invisible to every query that joins through it.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    const doomed = await insertBarePlayer(t, sportId, "Bob Allen", "allen bob");

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Bob Allen",
      decision: { action: "link", linkedPlayerId: doomed },
    });
    // …and it is gone by the time Confirm lands.
    await t.run(async (ctx) => ctx.db.delete(doomed));

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Bob Allen"] })],
      batchId: "batch-1",
    });

    // The commit still lands — one dead link must not cost the whole sync.
    expect(result.success).toBe(true);
    expect(result.unreviewedNameCount).toBe(1);

    const cards = await readCards(t, variantTypeId);
    expect(cards[0].playerIds ?? []).toEqual([]);
    expect(cards[0].pendingPlayerNames).toEqual(["Bob Allen"]);
  });

  test("a linked player from ANOTHER sport is refused the same way", async () => {
    // A cross-sport row is unreachable by every query that matters — they all
    // key on the sport id — so linking to one is a dangling reference wearing
    // a valid id. Same rule `savePlayerFields` applies to a stint.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    const otherSportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const wrongSport = await insertBarePlayer(
      t,
      otherSportId,
      "Bob Allen",
      "allen bob",
    );

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Bob Allen",
      decision: { action: "link", linkedPlayerId: wrongSport },
    });

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Bob Allen"] })],
      batchId: "batch-1",
    });

    expect(result.unreviewedNameCount).toBe(1);
    expect((await readCards(t, variantTypeId))[0].playerIds ?? []).toEqual([]);
  });

  test("a live linked player is still used, and contributes its own spelling", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    const live = await insertBarePlayer(t, sportId, "Bob Allen", "allen bob");

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "bob allen",
      decision: { action: "link", linkedPlayerId: live },
    });

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["bob allen"] })],
      batchId: "batch-1",
    });

    expect(result.unreviewedNameCount).toBe(0);
    expect((await readCards(t, variantTypeId))[0].playerIds).toEqual([live]);
  });
});


// ===========================================================================
// NEO-246 — the commit writes a `pendingPlayerNames` / `pendingTeamNames`
// shape `updateCard` will accept
//
// These two fields have three writers, and until NEO-246 only one of them
// bounded what it stored. `updateCard` now REFUSES an over-cap or over-long
// list, and the attention walker's `UnreviewedNameFixer` writes a row's stored
// names straight back whenever it answers only one of the two sides — so a row
// the commit stamped over the cap would be a row the operator could never
// save. The fix for a bad row would itself be refused.
//
// TWO different mechanisms hold that agreement, at two different places, and
// the split is the point:
//
//  1. THE BOUNDARY REFUSES. `assertCardBatchWithinLimits` (NEO-251 security
//     review) runs at the top of `commitCardChecklist` — and of
//     `resolveChecklistEntities` and `diffChecklistAgainstExisting` — and
//     throws on a card carrying more than `MAX_CARD_PLAYERS` / `MAX_CARD_TEAMS`
//     names, or a name over `MAX_PLAYER_NAME_LENGTH`. `players` crosses an
//     operator's browser as a bare `v.array(v.string())`, so this is the trust
//     boundary; hostile or oversized INPUT is refused there, before any phase
//     runs and before a single row is written. An earlier draft of NEO-246 had
//     the commit truncate this case instead; that argument is retired, because
//     silently storing 20 of the 25 names a caller sent is a worse answer than
//     telling them the payload is wrong while they are still looking at it.
//     The bounds are also closed upstream, in the adapters, so a real
//     marketplace row cannot reach the boundary over-cap in the first place
//     (see convex/adapters/buysportscards.test.ts).
//
//  2. THE CHUNK DROPS. `boundPendingNames` still trims inside
//     `commitCardChecklistChunk`, and it is NOT redundant with the boundary.
//     It covers the two cases the boundary cannot see: a LEGACY row stamped
//     over the cap before any of this existed, and — the ordinary one — the
//     MERGE of a row's stored backlog with the names this sync stamped, whose
//     union can exceed the cap while each side is comfortably inside it. That
//     case must stay a drop: nothing about the incoming payload is wrong, so
//     refusing it would fail a whole chunk of a sync over arithmetic.
//
// The tests below are ordered that way: refusals first, then the merge, then
// the legacy repair.
// ===========================================================================

describe("commitCardChecklist: pending-name bounds (NEO-246, NEO-251)", () => {
  test("a card carrying more players than the cap is REFUSED, and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    // Five past the cap. A real multi-player card never lists this many; an
    // adapter emitting a checklist blob into the player field does — which is
    // why the adapters bound it too, and why this is refused rather than
    // quietly trimmed if one ever gets through.
    const names = Array.from(
      { length: MAX_CARD_PLAYERS + 5 },
      (_, i) => `Unknown Player ${String(i).padStart(2, "0")}`,
    );

    await expect(
      asAdmin.action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ cardNumber: "1", players: names })],
        batchId: "batch-1",
      }),
    ).rejects.toThrow(
      new RegExp(
        `card #1 carries ${MAX_CARD_PLAYERS + 5} players, above the ${MAX_CARD_PLAYERS}-player limit`,
      ),
    );

    // The refusal is at the boundary, so the batch is refused WHOLE — no card
    // row, not even the part of the payload that was fine.
    expect(await readCards(t, variantTypeId)).toHaveLength(0);
  });

  test("an over-long name is REFUSED, and the message does not echo it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    // 121 characters — one past MAX_PLAYER_NAME_LENGTH.
    const essay = "z".repeat(121);

    const err = await asAdmin
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ cardNumber: "1", players: ["Real Unknown", essay] })],
        batchId: "batch-1",
      })
      .then(
        () => {
          throw new Error("expected the commit to refuse the over-long name");
        },
        (e: unknown) => e as Error,
      );

    expect(err.message).toMatch(
      /carries a player name of 121 characters; the limit is 120\./,
    );
    // The message reaches Sentry and the browser console, so it names the
    // LENGTH and never the text — the same convention `players.ts` set.
    expect(err.message).not.toContain(essay);

    expect(await readCards(t, variantTypeId)).toHaveLength(0);
  });

  test("the TEAM side is refused by its own, narrower cap", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const teams = Array.from(
      { length: MAX_CARD_TEAMS + 3 },
      (_, i) => `Unknown Team ${i}`,
    );

    await expect(
      asAdmin.action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ cardNumber: "1", teams })],
        batchId: "batch-1",
      }),
    ).rejects.toThrow(
      new RegExp(
        `card #1 carries ${MAX_CARD_TEAMS + 3} teams, above the ${MAX_CARD_TEAMS}-team limit`,
      ),
    );

    expect(await readCards(t, variantTypeId)).toHaveLength(0);
  });

  test("a full-cap card commits, and the stored list is one the walker's fixer can then save", async () => {
    // The load-bearing assertion of this whole change: the three writers
    // agree. Take the row the commit just wrote — at exactly the cap, the
    // largest list the boundary lets through — and send it back through
    // `updateCard` exactly as `UnreviewedNameFixer` does when it answers the
    // team side and leaves the player names alone.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const names = Array.from(
      { length: MAX_CARD_PLAYERS },
      (_, i) => `Unknown Player ${String(i).padStart(2, "0")}`,
    );
    for (const name of names) {
      await insertUndecidedReviewRow(t, {
        selectorOptionId: variantTypeId,
        sportId,
        batchId: "batch-1",
        kind: "player",
        name,
      });
    }

    const result = await asAdmin.action(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ cardNumber: "1", players: names })],
        batchId: "batch-1",
      },
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);

    const [card] = await readCards(t, variantTypeId);
    const stored = card.pendingPlayerNames!;
    // First-seen order, kept verbatim — nothing was dropped at the cap.
    expect(stored).toEqual(names);
    // The operator is told about what was STORED.
    expect(result.unreviewedNameCount).toBe(MAX_CARD_PLAYERS);
    // The plain path: nothing to merge with, nothing over the cap, so nothing
    // is dropped and the count needs no correction.
    expect(result.droppedPendingNameCount).toBe(0);

    // The fixer's payload for "answered the team side, player names untouched".
    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: card._id,
        playerIds: [],
        teamOnCardIds: [],
        pendingPlayerNames: stored,
        pendingTeamNames: [],
      }),
    ).resolves.toBeNull();

    const after = await t.run(async (ctx) => ctx.db.get(card._id));
    expect(after!.pendingPlayerNames).toEqual(stored);
  });

  test("a stored backlog plus a freshly stamped list that together exceed the cap is a DROP, not a refusal", async () => {
    // The case the boundary cannot see and must not be asked to: BOTH payloads
    // are well inside the cap, and it is their union on the row that is not.
    // 15 already waiting on the operator + 10 this sync just found = 25, and
    // the row keeps the first 20 with the stored backlog outranking the new
    // names. Refusing here would fail a chunk of a sync over arithmetic
    // nobody's payload got wrong.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const stored = Array.from(
      { length: 15 },
      (_, i) => `Backlog ${String(i).padStart(2, "0")}`,
    );
    const stamped = Array.from(
      { length: 10 },
      (_, i) => `Freshly Found ${String(i).padStart(2, "0")}`,
    );
    expect(stored.length).toBeLessThanOrEqual(MAX_CARD_PLAYERS);
    expect(stamped.length).toBeLessThanOrEqual(MAX_CARD_PLAYERS);
    expect(stored.length + stamped.length).toBeGreaterThan(MAX_CARD_PLAYERS);

    // Create the row first, through the commit, with a payload the boundary is
    // happy with.
    for (const name of stored) {
      await insertUndecidedReviewRow(t, {
        selectorOptionId: variantTypeId,
        sportId,
        batchId: "batch-1",
        kind: "player",
        name,
      });
    }
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: stored })],
      batchId: "batch-1",
    });

    // The next sync finds ten more unreviewed names on the same card.
    for (const name of stamped) {
      await insertUndecidedReviewRow(t, {
        selectorOptionId: variantTypeId,
        sportId,
        batchId: "batch-2",
        kind: "player",
        name,
      });
    }
    const result = await asAdmin.action(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ cardNumber: "1", players: stamped })],
        batchId: "batch-2",
      },
    );

    // It LANDS.
    expect(result.success).toBe(true);

    // `unreviewedNameCount` is what this commit left WAITING on the operator,
    // and that is not the same as what it stamped. Ten names were stamped;
    // five of them lost the truncation and never reached the row, so five is
    // the number of new names the operator will actually find. The chunk
    // reports its drops back (`droppedPendingNameCount`) precisely so the
    // action can subtract them here rather than quoting a figure five higher
    // than the card.
    expect(result.unreviewedNameCount).toBe(5);
    expect(result.droppedPendingNameCount).toBe(5);
    // Stated as the relationship, not just the arithmetic, so a change to
    // either half is caught rather than absorbed.
    expect(
      result.unreviewedNameCount + result.droppedPendingNameCount,
    ).toBe(stamped.length);

    const [merged] = await readCards(t, variantTypeId);
    expect(merged.pendingPlayerNames).toHaveLength(MAX_CARD_PLAYERS);
    // Stored first, so the operator's existing backlog outranks a name this
    // sync just found; the truncation is deterministic rather than whichever
    // names a Set happened to yield.
    expect(merged.pendingPlayerNames).toEqual(
      [...stored, ...stamped].slice(0, MAX_CARD_PLAYERS),
    );

    // And the merged row is one the fixer can save — which is the reason the
    // drop exists at all.
    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: merged._id,
        pendingPlayerNames: merged.pendingPlayerNames!,
      }),
    ).resolves.toBeNull();
  });

  test("a row stamped over the cap before this landed is REPAIRED by the next commit, keeping the names it already had", async () => {
    // The update branch merges stored names with newly stamped ones, and the
    // union of two individually-fine lists can still be over the cap. Stored
    // names come first, so the operator's existing backlog outranks a name
    // this sync just found — and the shortened list differs from what was
    // there, so it is actually written rather than left as-is.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    await insertUndecidedReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-1",
      kind: "player",
      name: "Seed Name",
    });
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCard({ cardNumber: "1", players: ["Seed Name"] })],
      batchId: "batch-1",
    });

    // Stand in for a row written before the bound existed.
    const legacyNames = Array.from(
      { length: MAX_CARD_PLAYERS + 5 },
      (_, i) => `Legacy ${String(i).padStart(2, "0")}`,
    );
    const [seeded] = await readCards(t, variantTypeId);
    await t.run(async (ctx) =>
      ctx.db.patch(seeded._id, { pendingPlayerNames: legacyNames }),
    );

    // Next sync finds one more unreviewed name on the same card.
    await insertUndecidedReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "batch-2",
      kind: "player",
      name: "Freshly Found",
    });
    const repair = await asAdmin.action(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ cardNumber: "1", players: ["Freshly Found"] })],
        batchId: "batch-2",
      },
    );

    // The repair drops six names — the five legacy ones over the cap plus the
    // one this sync stamped, which the backlog outranked. Only one of them was
    // ever stamped, so the subtraction bottoms out: ZERO new names are waiting
    // on the operator, which is the honest answer. This is the floor in
    // `unreviewedNameCount` doing its job — the drop count and the stamped set
    // measure different populations, and the floor is what keeps a repair from
    // reporting a negative.
    expect(repair.droppedPendingNameCount).toBe(6);
    expect(repair.unreviewedNameCount).toBe(0);

    const [repaired] = await readCards(t, variantTypeId);
    expect(repaired.pendingPlayerNames).toEqual(
      legacyNames.slice(0, MAX_CARD_PLAYERS),
    );
    // The newly found name lost to the backlog the row already carried.
    expect(repaired.pendingPlayerNames).not.toContain("Freshly Found");

    // And the repaired row is now one the fixer can save.
    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: repaired._id,
        pendingPlayerNames: repaired.pendingPlayerNames!,
      }),
    ).resolves.toBeNull();
  });
});
