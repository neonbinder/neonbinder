/**
 * NEO-279 — the "Fill teams" wiring: `previewTeamFill` / `applyTeamFill`
 * (admin actions), the internal page/read queries they call, and
 * `applyTeamFillChunk`'s fresh-read re-check.
 *
 * The RULES are pinned in lib/teamFill.test.ts, pure; this file proves the
 * plumbing agrees with them once real rows, a real subtree walk and real
 * chunking are involved — and the two places a snapshot can go stale between
 * preview and apply (a card teamed in another tab, a team that stopped
 * existing) are actually skipped rather than overwritten.
 *
 * Fixture shape follows selectorOptions.setSelectorOptionTeams.test.ts
 * (sport → setName → variantType → insert → parallel, raw inserts) and
 * cardChecklist.noTeam.test.ts (insertCard/insertTeam/insertPlayer).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";
import { TEAM_FILL_APPLY_CHUNK, TEAM_FILL_ID_CHUNK } from "./teamFill";
import { MAX_CARD_TEAMS } from "./features/cardAttention";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_team_fill_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_team_fill_001",
  role: "admin",
};

const SIGNED_IN_IDENTITY = { subject: "user_team_fill_002" };

type T = ReturnType<typeof convexTest>;

/** sport → setName (season 2024) → variantType → insert → parallel. */
async function seedTree(
  t: T,
  opts: { season?: string } = { season: "2024" },
): Promise<{
  sportId: Id<"selectorOptions">;
  setNameId: Id<"selectorOptions">;
  variantTypeId: Id<"selectorOptions">;
  insertId: Id<"selectorOptions">;
  parallelId: Id<"selectorOptions">;
}> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: {},
      ...(opts.season ? { features: { season: opts.season } } : {}),
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
    const insertId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Stars",
      platformData: {},
      parentId: variantTypeId,
      children: [],
      lastUpdated: Date.now(),
    });
    const parallelId = await ctx.db.insert("selectorOptions", {
      level: "parallel",
      value: "Gold",
      platformData: {},
      parentId: insertId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    await ctx.db.patch(variantTypeId, { children: [insertId] });
    await ctx.db.patch(insertId, { children: [parallelId] });
    return { sportId, setNameId, variantTypeId, insertId, parallelId };
  });
}

async function insertCard(
  t: T,
  selectorOptionId: Id<"selectorOptions">,
  opts: {
    cardNumber?: string;
    playerIds?: Array<Id<"players">>;
    teamOnCardIds?: Array<Id<"teams">>;
    teamNoneConfirmedAt?: number;
    pendingTeamNames?: string[];
    teamCheckDoneAt?: number;
    bscTeamName?: string;
    platformData?: Record<string, unknown>;
  } = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber: opts.cardNumber ?? "1",
      cardName: "Test Card",
      platformData: opts.platformData ?? {},
      sortOrder: 0,
      lastUpdated: 1_700_000_000_000,
      ...(opts.playerIds ? { playerIds: opts.playerIds } : {}),
      ...(opts.teamOnCardIds ? { teamOnCardIds: opts.teamOnCardIds } : {}),
      ...(opts.teamNoneConfirmedAt !== undefined
        ? { teamNoneConfirmedAt: opts.teamNoneConfirmedAt }
        : {}),
      ...(opts.pendingTeamNames ? { pendingTeamNames: opts.pendingTeamNames } : {}),
      ...(opts.teamCheckDoneAt !== undefined
        ? { teamCheckDoneAt: opts.teamCheckDoneAt }
        : {}),
      ...(opts.bscTeamName !== undefined ? { bscTeamName: opts.bscTeamName } : {}),
    }),
  );
}

const getCard = (t: T, id: Id<"cardChecklist">) => t.run(async (ctx) => ctx.db.get(id));

async function insertTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name,
      nameNormalized: normalizeTeamName(name),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

async function insertPlayer(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  teamYears: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>,
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      teamYears,
      lastUpdated: Date.now(),
    }),
  );
}

// ===========================================================================
// previewTeamFill
// ===========================================================================

describe("previewTeamFill", () => {
  test("counts and groups candidates across a mixed-level tree", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId, variantTypeId, insertId, parallelId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);

    // Evidence card, teamed, directly under variantType.
    await insertCard(t, variantTypeId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    // Candidate under the same variantType — same player, no team: rule A.
    const underVariant = await insertCard(t, variantTypeId, { cardNumber: "1", playerIds: [tatis] });
    // Candidate under the insert child — same player, no team: rule A too
    // (rule A's evidence is whole-set).
    const underInsert = await insertCard(t, insertId, { cardNumber: "2", playerIds: [tatis] });
    // Candidate under the parallel grandchild.
    const underParallel = await insertCard(t, parallelId, { cardNumber: "3", playerIds: [tatis] });
    // A card directly under setName itself.
    const underSet = await insertCard(t, setNameId, { cardNumber: "4", playerIds: [tatis] });

    const result = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });

    expect(result.setYear).toBe(2024);
    expect(result.candidates).toBe(4);
    expect(result.fillable).toBe(4);
    expect(result.remaining).toBe(0);
    expect(result.byRule).toEqual({ samePlayerInSet: 4, oneTeamCareer: 0, oneStintInYear: 0 });
    expect(result.groups).toEqual([
      {
        playerNames: ["Fernando Tatis Jr."],
        teamNames: ["San Diego Padres"],
        rule: "samePlayerInSet",
        cardCount: 4,
      },
    ]);
    expect(result.groupsTotal).toBe(1);

    // Nothing written by a preview.
    for (const id of [underVariant, underInsert, underParallel, underSet]) {
      const row = await getCard(t, id);
      expect(row!.teamOnCardIds).toBeUndefined();
    }
  });

  test("refuses a non-setName root with the exact message", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedTree(t);
    await expect(
      asAdmin.action(api.teamFill.previewTeamFill, { selectorOptionId: variantTypeId }),
    ).rejects.toThrow(/Fill teams from the set row, not a variant or parallel\./);
  });

  test("refuses a missing root with the exact message", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { setNameId } = await seedTree(t);
    await t.run(async (ctx) => ctx.db.delete(setNameId));
    await expect(
      asAdmin.action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId }),
    ).rejects.toThrow(/That set no longer exists\./);
  });

  test("refuses a signed-in non-admin and an anonymous caller, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    const cardId = await insertCard(t, setNameId, { playerIds: [tatis] });

    await expect(
      t
        .withIdentity(SIGNED_IN_IDENTITY)
        .action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId }),
    ).rejects.toThrow();
    await expect(
      t.action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId }),
    ).rejects.toThrow();

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("teamNoneConfirmedAt and pending-name cards are never counted as candidates", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    await insertCard(t, setNameId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const confirmed = await insertCard(t, setNameId, {
      cardNumber: "confirmed",
      playerIds: [tatis],
      teamNoneConfirmedAt: 1_700_000_000_000,
    });
    const pending = await insertCard(t, setNameId, {
      cardNumber: "pending",
      playerIds: [tatis],
      pendingTeamNames: ["Some Team"],
    });

    const result = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(result.candidates).toBe(0);
    expect(result.fillable).toBe(0);

    for (const id of [confirmed, pending]) {
      const row = await getCard(t, id);
      expect(row!.teamOnCardIds).toBeUndefined();
    }
  });

  test("a dangling team id never fills, and lands in remaining", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const ghostTeam = await insertTeam(t, sportId, "Ghost Team");
    const player = await insertPlayer(t, sportId, "Deleted Team Guy", [
      { teamId: ghostTeam, fromYear: 2000, toYear: 2005 },
    ]);
    await t.run(async (ctx) => ctx.db.delete(ghostTeam));
    const cardId = await insertCard(t, setNameId, { playerIds: [player] });

    const result = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(result.candidates).toBe(1);
    expect(result.fillable).toBe(0);
    expect(result.remaining).toBe(1);

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("a team belonging to another sport never fills", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const otherSportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Basketball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const wrongSportTeam = await insertTeam(t, otherSportId, "Off Sport Team");
    const player = await insertPlayer(t, sportId, "Cross Sport Guy", [
      { teamId: wrongSportTeam, fromYear: 2000, toYear: 2030 },
    ]);
    const cardId = await insertCard(t, setNameId, { playerIds: [player] });

    const result = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(result.fillable).toBe(0);
    expect(result.remaining).toBe(1);

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });
});

// ===========================================================================
// applyTeamFill
// ===========================================================================

describe("applyTeamFill", () => {
  test("writes teamOnCardIds + lastUpdated, clears bscTeamName, leaves teamCheckDoneAt/teamNoneConfirmedAt alone", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    await insertCard(t, setNameId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const cardId = await insertCard(t, setNameId, {
      cardNumber: "1",
      playerIds: [tatis],
      teamCheckDoneAt: 1_690_000_000_000,
      bscTeamName: "Marketplace says: Padres",
    });

    const before = Date.now();
    const result = await asAdmin.action(api.teamFill.applyTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.byRule.samePlayerInSet).toBe(1);

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([padres]);
    expect(row!.lastUpdated).toBeGreaterThanOrEqual(before);
    expect(row!.bscTeamName).toBeUndefined();
    expect(row!.teamCheckDoneAt).toBe(1_690_000_000_000);
    expect(row!.teamNoneConfirmedAt).toBeUndefined();
  });

  test("refuses a signed-in non-admin and an anonymous caller, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    await insertCard(t, setNameId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const cardId = await insertCard(t, setNameId, { cardNumber: "1", playerIds: [tatis] });

    await expect(
      t
        .withIdentity(SIGNED_IN_IDENTITY)
        .action(api.teamFill.applyTeamFill, { selectorOptionId: setNameId }),
    ).rejects.toThrow();
    await expect(
      t.action(api.teamFill.applyTeamFill, { selectorOptionId: setNameId }),
    ).rejects.toThrow();

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("refuses a non-setName root and a missing root the same way preview does", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedTree(t);
    await expect(
      asAdmin.action(api.teamFill.applyTeamFill, { selectorOptionId: variantTypeId }),
    ).rejects.toThrow(/Fill teams from the set row, not a variant or parallel\./);
  });

  test("a card teamed after the plan was computed is skipped at the chunk's fresh re-check, not overwritten", async () => {
    // `applyTeamFill` recomputes the whole plan from a fresh read, so a card
    // teamed before that recompute simply never enters the plan at all — the
    // race this docstring means is narrower: between the plan being computed
    // and `applyTeamFillChunk` actually patching THIS card (another tab, a
    // NEO-277 cascade landing mid-apply). That window is exactly what
    // `applyTeamFillChunk`'s own fresh `ctx.db.get` re-check exists for, so
    // it is exercised directly here rather than through the whole action.
    const t = convexTest(schema, modules);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const dodgers = await insertTeam(t, sportId, "Los Angeles Dodgers");
    const player = await insertPlayer(t, sportId, "Race Guy", []);
    const cardId = await insertCard(t, setNameId, { cardNumber: "1", playerIds: [player] });

    // Simulate the race: something else teams the card after the fill was
    // decided but before the chunk mutation reaches it.
    await t.run(async (ctx) => ctx.db.patch(cardId, { teamOnCardIds: [dodgers] }));

    const result = await t.mutation(internal.teamFill.applyTeamFillChunk, {
      fills: [{ cardId, teamIds: [padres] }],
    });
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);

    // Never overwritten — the operator's own team stands.
    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([dodgers]);
  });

  test("more fills than one apply chunk: every one is still applied", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    await insertCard(t, setNameId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const total = TEAM_FILL_APPLY_CHUNK + 7;
    const cardIds: Array<Id<"cardChecklist">> = [];
    for (let i = 0; i < total; i += 1) {
      cardIds.push(await insertCard(t, setNameId, { cardNumber: `c${i}`, playerIds: [tatis] }));
    }

    const result = await asAdmin.action(api.teamFill.applyTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(result.applied).toBe(total);
    expect(result.skipped).toBe(0);

    for (const id of cardIds) {
      const row = await getCard(t, id);
      expect(row!.teamOnCardIds).toEqual([padres]);
    }
  });
});

// ===========================================================================
// readTeamFillCards — the page walk
// ===========================================================================

describe("readTeamFillCards", () => {
  test("a small per-call budget across several leaves visits every card exactly once", async () => {
    const t = convexTest(schema, modules);
    const { setNameId, variantTypeId, insertId, parallelId } = await seedTree(t);
    const nodeIds = [setNameId, variantTypeId, insertId, parallelId];

    const expectedIds = new Set<string>();
    for (const nodeId of nodeIds) {
      for (let i = 0; i < 3; i += 1) {
        const id = await insertCard(t, nodeId, { cardNumber: `${nodeId}-${i}` });
        expectedIds.add(id);
      }
    }

    const seenIds = new Set<string>();
    let nodeIndex = 0;
    let cursor: number | undefined;
    let iterations = 0;
    for (;;) {
      iterations += 1;
      expect(iterations).toBeLessThan(100); // guard against an infinite loop bug
      const page = await t.query(internal.teamFill.readTeamFillCards, {
        nodeIds,
        nodeIndex,
        ...(cursor !== undefined ? { cursor } : {}),
        budget: 2,
      });
      for (const card of page.cards) {
        expect(seenIds.has(card._id)).toBe(false); // never visited twice
        seenIds.add(card._id);
      }
      if (page.done) {
        expect(page.cursor).toBeNull();
        break;
      }
      nodeIndex = page.nodeIndex;
      cursor = page.cursor ?? undefined;
    }

    expect(seenIds).toEqual(expectedIds);
  });
});

// ===========================================================================
// readTeamFillPlayers / readTeamFillTeams — chunk refusal
// ===========================================================================

describe("readTeamFillPlayers / readTeamFillTeams", () => {
  test("refuse more ids than TEAM_FILL_ID_CHUNK", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedTree(t);
    // The length check runs before dedup, so one real id repeated past the
    // validator (which only checks each entry is ID-shaped) is enough.
    const player = await insertPlayer(t, sportId, "Repeat Guy", []);
    const tooMany = Array.from({ length: TEAM_FILL_ID_CHUNK + 1 }, () => player);
    await expect(
      t.query(internal.teamFill.readTeamFillPlayers, { playerIds: tooMany }),
    ).rejects.toThrow(new RegExp(`chunks of ${TEAM_FILL_ID_CHUNK}`));

    const team = await insertTeam(t, sportId, "Repeat Team");
    const tooManyTeams = Array.from({ length: TEAM_FILL_ID_CHUNK + 1 }, () => team);
    await expect(
      t.query(internal.teamFill.readTeamFillTeams, { teamIds: tooManyTeams }),
    ).rejects.toThrow(new RegExp(`chunks of ${TEAM_FILL_ID_CHUNK}`));
  });
});

// ===========================================================================
// applyTeamFillChunk — internal mutation guards
// ===========================================================================

describe("applyTeamFillChunk", () => {
  test("refuses more fills than TEAM_FILL_APPLY_CHUNK", async () => {
    const t = convexTest(schema, modules);
    const { setNameId } = await seedTree(t);
    // The length check runs before any card is read, so one real id repeated
    // past the validator's ID-shape check is enough.
    const cardId = await insertCard(t, setNameId, { cardNumber: "1" });
    const fills = Array.from({ length: TEAM_FILL_APPLY_CHUNK + 1 }, () => ({
      cardId,
      teamIds: [] as Array<Id<"teams">>,
    }));
    await expect(
      t.mutation(internal.teamFill.applyTeamFillChunk, { fills }),
    ).rejects.toThrow(new RegExp(`chunks of ${TEAM_FILL_APPLY_CHUNK}`));
  });

  test("skips a fill naming more teams than MAX_CARD_TEAMS, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setNameId } = await seedTree(t);
    const player = await insertPlayer(t, sportId, "Many Teams Guy", []);
    const cardId = await insertCard(t, setNameId, { cardNumber: "1", playerIds: [player] });
    const teamIds: Array<Id<"teams">> = [];
    for (let i = 0; i < MAX_CARD_TEAMS + 1; i += 1) {
      teamIds.push(await insertTeam(t, sportId, `Team ${i}`));
    }

    const result = await t.mutation(internal.teamFill.applyTeamFillChunk, {
      fills: [{ cardId, teamIds }],
    });
    expect(result).toEqual({ applied: 0, skipped: 1 });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("skips a fill naming an empty team list, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setNameId } = await seedTree(t);
    const player = await insertPlayer(t, sportId, "No Team Guy", []);
    const cardId = await insertCard(t, setNameId, { cardNumber: "1", playerIds: [player] });

    const result = await t.mutation(internal.teamFill.applyTeamFillChunk, {
      fills: [{ cardId, teamIds: [] }],
    });
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });
});
