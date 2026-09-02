/**
 * NEO-102 — the operator side of "this card carries no team":
 * `cardChecklist.confirmCardNoTeam`, `cardChecklist.suggestedTeamsForCard`,
 * and the two places the resulting flag has to be honoured or retired outside
 * the BSC queue (`selectorOptions.updateCard`, and `getCardChecklist`'s strict
 * returns validator).
 *
 * The BSC background-writer half — `getForBscTeamCheck`,
 * `applyBscTeamResolution`, `enqueueBscTeamBackfill` — lives in
 * convex/cardChecklist.bscTeamEnrichment.test.ts alongside the rest of that
 * queue's coverage. The commit-path half lives in
 * convex/commitCardChecklist.operatorDecisions.test.ts alongside the
 * `applyFields`/`baseVersion` gate it rides on.
 *
 * Fixture conventions mirror convex/cardChecklist.bscTeamEnrichment.test.ts
 * (raw sport → setName → variantType tree, direct `ctx.db.insert` rows) —
 * these functions read one card row and its ancestor chain, so nothing here
 * needs to go through a real sync.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_no_team_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_no_team_001",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "user_no_team_002",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_no_team_002",
};

/**
 * sport → setName → variantType, with `features.season` on the leaf. The
 * season is what `findSetYearForSelectorOption` reads first, so this fixture
 * exercises the cheap path; the `year`-ancestor fallback gets its own test.
 */
async function seedTree(
  t: ReturnType<typeof convexTest>,
  opts: { season?: string; yearLevelValue?: string } = { season: "2024" },
): Promise<{
  sportId: Id<"selectorOptions">;
  leafId: Id<"selectorOptions">;
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
    let parentId = sportId;
    if (opts.yearLevelValue !== undefined) {
      parentId = await ctx.db.insert("selectorOptions", {
        level: "year",
        value: opts.yearLevelValue,
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
    }
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Test Set",
      platformData: {},
      parentId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      ...(opts.season ? { features: { season: opts.season } } : {}),
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

async function insertCard(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  opts: {
    cardNumber?: string;
    playerIds?: Array<Id<"players">>;
    teamOnCardIds?: Array<Id<"teams">>;
    teamNoneConfirmedAt?: number;
    teamNoneConfirmedByUserId?: string;
  } = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber: opts.cardNumber ?? "327",
      cardName: "American League Leaders ERA",
      platformData: {},
      sortOrder: 0,
      lastUpdated: Date.now(),
      ...(opts.playerIds ? { playerIds: opts.playerIds } : {}),
      ...(opts.teamOnCardIds ? { teamOnCardIds: opts.teamOnCardIds } : {}),
      ...(opts.teamNoneConfirmedAt !== undefined
        ? { teamNoneConfirmedAt: opts.teamNoneConfirmedAt }
        : {}),
      ...(opts.teamNoneConfirmedByUserId !== undefined
        ? { teamNoneConfirmedByUserId: opts.teamNoneConfirmedByUserId }
        : {}),
    }),
  );
}

const getCard = (t: ReturnType<typeof convexTest>, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => ctx.db.get(id));

async function insertTeam(
  t: ReturnType<typeof convexTest>,
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
  t: ReturnType<typeof convexTest>,
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
// confirmCardNoTeam
// ===========================================================================

describe("confirmCardNoTeam", () => {
  test("stamps teamNoneConfirmedAt and the caller's user id SERVER-side", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    const before = Date.now();
    const result = await asAdmin.mutation(api.cardChecklist.confirmCardNoTeam, {
      cardId,
    });
    expect(result).toEqual({ confirmed: true, stamped: true });

    const row = await getCard(t, cardId);
    expect(row!.teamNoneConfirmedAt).toBeGreaterThanOrEqual(before);
    // The audit stamp comes from `requireAdmin`'s return, not from any
    // argument — there is no way for a caller to name someone else.
    expect(row!.teamNoneConfirmedByUserId).toBe(ADMIN_IDENTITY.subject);
  });

  test("takes no timestamp argument at all", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    // A forgeable suppression timestamp is the whole risk this design avoids,
    // so the validator must reject one outright rather than ignore it.
    await expect(
      asAdmin.mutation(api.cardChecklist.confirmCardNoTeam, {
        cardId,
        teamNoneConfirmedAt: 1,
      } as never),
    ).rejects.toThrow();

    const row = await getCard(t, cardId);
    expect(row!.teamNoneConfirmedAt).toBeUndefined();
  });

  test("refuses on a card that already HAS a team, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const teamId = await insertTeam(t, sportId, "New York Yankees");
    const cardId = await insertCard(t, leafId, { teamOnCardIds: [teamId] });

    const result = await asAdmin.mutation(api.cardChecklist.confirmCardNoTeam, {
      cardId,
    });
    // Not an error: the operator clicked against a stale render, and the card
    // already has the thing they were being asked about.
    expect(result).toEqual({ confirmed: false, stamped: false });

    const row = await getCard(t, cardId);
    expect(row!.teamNoneConfirmedAt).toBeUndefined();
    expect(row!.teamOnCardIds).toEqual([teamId]);
  });

  test("is idempotent: a second call writes nothing and keeps the first stamp", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    await asAdmin.mutation(api.cardChecklist.confirmCardNoTeam, { cardId });
    const first = await getCard(t, cardId);

    const second = await asAdmin.mutation(
      api.cardChecklist.confirmCardNoTeam,
      { cardId },
    );
    expect(second).toEqual({ confirmed: true, stamped: false });

    const after = await getCard(t, cardId);
    expect(after!.teamNoneConfirmedAt).toBe(first!.teamNoneConfirmedAt);
    expect(after!.teamNoneConfirmedByUserId).toBe(
      first!.teamNoneConfirmedByUserId,
    );
  });

  test("does not touch lastUpdated", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);
    const before = (await getCard(t, cardId))!.lastUpdated;

    await asAdmin.mutation(api.cardChecklist.confirmCardNoTeam, { cardId });

    // Suppression bookkeeping, not card content. Bumping `lastUpdated` would
    // invalidate the `baseVersion` of a sync review open in another tab and
    // turn an unrelated accepted diff stale.
    expect((await getCard(t, cardId))!.lastUpdated).toBe(before);
  });

  test("is admin-gated", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .mutation(api.cardChecklist.confirmCardNoTeam, { cardId }),
    ).rejects.toThrow(/Admin access required/);
    await expect(
      t.mutation(api.cardChecklist.confirmCardNoTeam, { cardId }),
    ).rejects.toThrow(/Not authenticated/);
  });
});

// ===========================================================================
// updateCard retires the flag
// ===========================================================================

describe("updateCard and the no-team confirmation", () => {
  test("writing a NON-EMPTY teamOnCardIds clears the flag in the same patch", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const teamId = await insertTeam(t, sportId, "Boston Red Sox");
    const cardId = await insertCard(t, leafId, {
      teamNoneConfirmedAt: 1_700_000_000_000,
      teamNoneConfirmedByUserId: "admin_someone_else",
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: [teamId],
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([teamId]);
    // The flag must never contradict the teams on the row.
    expect(row!.teamNoneConfirmedAt).toBeUndefined();
    expect(row!.teamNoneConfirmedByUserId).toBeUndefined();
  });

  test("writing an EMPTY teamOnCardIds leaves the flag standing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const teamId = await insertTeam(t, sportId, "Boston Red Sox");
    const cardId = await insertCard(t, leafId, {
      teamOnCardIds: [teamId],
      teamNoneConfirmedAt: 1_700_000_000_000,
    });

    // Unlinking every team leaves the card teamless, which is the state the
    // confirmation describes — so it stays true.
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: [],
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([]);
    expect(row!.teamNoneConfirmedAt).toBe(1_700_000_000_000);
  });

  test("an edit that does not mention teams leaves the flag standing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId, {
      teamNoneConfirmedAt: 1_700_000_000_000,
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      cardName: "Renamed",
    });

    const row = await getCard(t, cardId);
    expect(row!.cardName).toBe("Renamed");
    expect(row!.teamNoneConfirmedAt).toBe(1_700_000_000_000);
  });

  test("neither field is settable through updateCard's args", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    // `updateCard` patches a filtered SPREAD of its args, so a field present
    // in its validator is directly settable. These must not be in it.
    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        teamNoneConfirmedAt: 1,
      } as never),
    ).rejects.toThrow();
    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        teamNoneConfirmedByUserId: "someone",
      } as never),
    ).rejects.toThrow();

    const row = await getCard(t, cardId);
    expect(row!.teamNoneConfirmedAt).toBeUndefined();
    expect(row!.teamNoneConfirmedByUserId).toBeUndefined();
  });
});

// ===========================================================================
// getCardChecklist round-trips the new columns
// ===========================================================================

describe("getCardChecklist returns validator", () => {
  test("a none-confirmed row round-trips, and teamNoneConfirmedAt reaches the client", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    await insertCard(t, leafId, {
      teamNoneConfirmedAt: 1_700_000_000_000,
      teamNoneConfirmedByUserId: ADMIN_IDENTITY.subject,
    });

    // Convex validates `returns` STRICTLY: a column the table carries and the
    // validator omits throws `Object contains extra field` for every row that
    // has it. This repo has shipped that bug twice (see the note on
    // `selectorOptionFields`), and both new columns land on real rows — so
    // this is the pin, not a formality.
    const rows = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: leafId,
    });
    expect(rows).toHaveLength(1);
    // The client derives the "missing team" badge from this, so it has to
    // actually cross the wire.
    expect(rows[0].teamNoneConfirmedAt).toBe(1_700_000_000_000);
  });
});

// ===========================================================================
// suggestedTeamsForCard
// ===========================================================================

describe("suggestedTeamsForCard", () => {
  test("suggests each player's team for the SET's year and filters the rest out", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t, { season: "2024" });
    const angels = await insertTeam(t, sportId, "Los Angeles Angels");
    const dbacks = await insertTeam(t, sportId, "Arizona Diamondbacks");
    const jays = await insertTeam(t, sportId, "Toronto Blue Jays");
    const trout = await insertPlayer(t, sportId, "Mike Trout", [
      // Open-ended = current team, so 2024 is inside it.
      { teamId: angels, fromYear: 2011 },
      // Ended before the set year.
      { teamId: dbacks, fromYear: 2008, toYear: 2010 },
      // Starts after the set year.
      { teamId: jays, fromYear: 2026 },
    ]);
    const cardId = await insertCard(t, leafId, { playerIds: [trout] });

    const suggestions = await asAdmin.query(
      api.cardChecklist.suggestedTeamsForCard,
      { cardId },
    );
    expect(suggestions).toEqual([
      {
        teamId: angels,
        name: "Los Angeles Angels",
        source: "career",
        playerName: "Mike Trout",
      },
    ]);
  });

  test("dedupes by teamId across a multi-player card, attributing the first player", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t, { season: "2024" });
    const braves = await insertTeam(t, sportId, "Atlanta Braves");
    const mets = await insertTeam(t, sportId, "New York Mets");
    const a = await insertPlayer(t, sportId, "Chris Sale", [
      { teamId: braves, fromYear: 2024 },
    ]);
    const b = await insertPlayer(t, sportId, "Reynaldo Lopez", [
      { teamId: braves, fromYear: 2024 },
    ]);
    const c = await insertPlayer(t, sportId, "Sean Manaea", [
      { teamId: mets, fromYear: 2024 },
    ]);
    const cardId = await insertCard(t, leafId, { playerIds: [a, b, c] });

    const suggestions = await asAdmin.query(
      api.cardChecklist.suggestedTeamsForCard,
      { cardId },
    );
    // A League Leaders card whose players share a team yields ONE chip, and
    // `playerName` says why it is being suggested.
    expect(suggestions).toEqual([
      {
        teamId: braves,
        name: "Atlanta Braves",
        source: "career",
        playerName: "Chris Sale",
      },
      {
        teamId: mets,
        name: "New York Mets",
        source: "career",
        playerName: "Sean Manaea",
      },
    ]);
  });

  test("falls back to the year-level ancestor when the leaf has no features.season", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t, {
      season: undefined,
      yearLevelValue: "1996",
    });
    const expos = await insertTeam(t, sportId, "Montreal Expos");
    const nationals = await insertTeam(t, sportId, "Washington Nationals");
    const player = await insertPlayer(t, sportId, "Vintage Guy", [
      { teamId: expos, fromYear: 1994, toYear: 1998 },
      { teamId: nationals, fromYear: 2005, toYear: 2010 },
    ]);
    const cardId = await insertCard(t, leafId, { playerIds: [player] });

    const suggestions = await asAdmin.query(
      api.cardChecklist.suggestedTeamsForCard,
      { cardId },
    );
    expect(suggestions.map((s) => s.name)).toEqual(["Montreal Expos"]);
  });

  test("offers the whole career when no year is resolvable", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t, { season: undefined });
    const expos = await insertTeam(t, sportId, "Montreal Expos");
    const nationals = await insertTeam(t, sportId, "Washington Nationals");
    const player = await insertPlayer(t, sportId, "Vintage Guy", [
      { teamId: expos, fromYear: 1994, toYear: 1998 },
      { teamId: nationals, fromYear: 2005, toYear: 2010 },
    ]);
    const cardId = await insertCard(t, leafId, { playerIds: [player] });

    // A suggestion the operator can reject beats an empty panel; they are the
    // one deciding either way.
    const suggestions = await asAdmin.query(
      api.cardChecklist.suggestedTeamsForCard,
      { cardId },
    );
    expect(suggestions.map((s) => s.name)).toEqual([
      "Montreal Expos",
      "Washington Nationals",
    ]);
  });

  test("returns nothing for a card with no players, and skips dangling links", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const noPlayers = await insertCard(t, leafId, { cardNumber: "1" });
    expect(
      await asAdmin.query(api.cardChecklist.suggestedTeamsForCard, {
        cardId: noPlayers,
      }),
    ).toEqual([]);

    // A player pointing at a deleted team is a soft data error: skip the chip
    // rather than render a blank one.
    const ghostTeam = await insertTeam(t, sportId, "Deleted Team");
    const player = await insertPlayer(t, sportId, "Orphan Link", [
      { teamId: ghostTeam, fromYear: 2020 },
    ]);
    await t.run(async (ctx) => ctx.db.delete(ghostTeam));
    const dangling = await insertCard(t, leafId, {
      cardNumber: "2",
      playerIds: [player],
    });
    expect(
      await asAdmin.query(api.cardChecklist.suggestedTeamsForCard, {
        cardId: dangling,
      }),
    ).toEqual([]);
  });

  test("is admin-gated", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .query(api.cardChecklist.suggestedTeamsForCard, { cardId }),
    ).rejects.toThrow(/Admin access required/);
    await expect(
      t.query(api.cardChecklist.suggestedTeamsForCard, { cardId }),
    ).rejects.toThrow(/Not authenticated/);
  });
});
