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
    sourcePlatformIds: undefined,
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
    sport?: string;
    decision: { action: "create" } | {
      action: "link";
      linkedPlayerId?: Id<"players">;
      linkedTeamId?: Id<"teams">;
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
      sport: opts.sport ?? "Baseball",
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
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
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

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sport: "Baseball",
      cards: [makeCard({ cardNumber: "1", cardName: "Mike Trout", players: ["Mike Trout"] })],
      batchId: "batch-1",
    });

    const player = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport", (q) =>
          q.eq("nameNormalized", "mike trout").eq("primarySport", "Baseball"),
        )
        .first(),
    );
    expect(player).not.toBeNull();
    expect(player!.isHallOfFame).toBe(true);
    expect(player!.externalIds?.wikidataId).toBe("Q123456");
    expect(player!.teamYears).toHaveLength(2);
    expect(player!.teamYears?.[0].fromYear).toBe(2011);
    expect(player!.teamYears?.[1].fromYear).toBe(2005);
    expect(player!.teamYears?.[1].toYear).toBe(2010);

    // Each careerTeams NAME resolved to a real (bare, unenriched) team row —
    // proves resolveTeamIdByName's get-or-create ran for both names.
    const team1 = await t.run(async (ctx) => ctx.db.get(player!.teamYears![0].teamId));
    const team2 = await t.run(async (ctx) => ctx.db.get(player!.teamYears![1].teamId));
    expect(team1!.name).toBe("Los Angeles Angels");
    expect(team2!.name).toBe("Los Angeles Angels of Anaheim");
    // Deliberately minimal — no enrichment fields on the incidental team row.
    expect(team1!.league).toBeUndefined();
    expect(team1!.externalIds).toBeUndefined();

    // The card itself resolved to this new player.
    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .first(),
    );
    expect(card!.playerIds).toEqual([player!._id]);
  });

  test("a team 'create' decision inserts a new team with league/city/yearsActive/colors/espnId from its enrichment", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
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

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sport: "Baseball",
      cards: [makeCard({ cardNumber: "1", cardName: "Team Card", teams: ["Los Angeles Angels"] })],
      batchId: "batch-1",
    });

    const team = await t.run(async (ctx) =>
      ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport", (q) =>
          q.eq("nameNormalized", "angeles angels los").eq("sport", "Baseball"),
        )
        .first(),
    );
    expect(team).not.toBeNull();
    expect(team!.league).toBe("Major League Baseball");
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
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    // The REAL player, under a different spelling than what the
    // marketplace card carries.
    const realPlayerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Ken Griffey Jr.",
        nameNormalized: "griffey jr ken",
        primarySport: "Baseball",
        lastUpdated: Date.now(),
      }),
    );

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      batchId: "batch-1",
      kind: "player",
      // A spelling that normalizes differently from "Ken Griffey Jr." (no
      // period) so it's genuinely treated as "unknown" pre-link.
      name: "Ken Griffey Junior",
      decision: { action: "link", linkedPlayerId: realPlayerId },
    });

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sport: "Baseball",
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
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    const realTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Los Angeles Angels",
        nameNormalized: "angeles angels los",
        sport: "Baseball",
        lastUpdated: Date.now(),
      }),
    );

    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      batchId: "batch-1",
      kind: "team",
      name: "LA Angels of Anaheim", // normalizes differently -> "genuinely unknown"
      decision: { action: "link", linkedTeamId: realTeamId },
    });

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sport: "Baseball",
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
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    const rowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      batchId: "batch-1",
      kind: "player",
      name: "Mike Trout",
      decision: { action: "create" },
      enrichment: { careerTeams: [] },
    });

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sport: "Baseball",
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
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    // A row for an UNRELATED batch — must survive since this commit has no
    // batchId at all (the zero-unknowns fast path).
    const unrelatedRowId = await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      batchId: "unrelated-batch",
      kind: "player",
      name: "Someone Else",
      decision: { action: "create" },
    });

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sport: "Baseball",
      cards: [makeCard({ cardNumber: "1", cardName: "No Unknowns Card" })],
    });

    const row = await t.run(async (ctx) => ctx.db.get(unrelatedRowId));
    expect(row).not.toBeNull();
  });
});
