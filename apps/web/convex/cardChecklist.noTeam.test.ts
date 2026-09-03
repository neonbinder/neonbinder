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
import { deriveCardAttention, MAX_CARD_TEAMS } from "./features/cardAttention";
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

  /**
   * NEO-208 — the SAME patch also retires a typed team name.
   *
   * `pendingTeamNames` means "the operator named a team no `teams` row existed
   * for"; linking a real team is that same intent, answered. Leaving both on
   * the row would print the team twice — once resolved, once as
   * "(unconfirmed)" in the row sub-line and the drawer — and would leave the
   * next sync's resolve pass chasing a name nobody is waiting on.
   */
  test("writing a NON-EMPTY teamOnCardIds also clears pendingTeamNames", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const teamId = await insertTeam(t, sportId, "Boston Red Sox");
    const cardId = await insertCard(t, leafId);
    await t.run(async (ctx) =>
      ctx.db.patch(cardId, { pendingTeamNames: ["Bosten Red Sox"] }),
    );

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: [teamId],
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([teamId]);
    expect(row!.pendingTeamNames).toBeUndefined();
  });

  test("writing an EMPTY teamOnCardIds leaves pendingTeamNames alone", async () => {
    // Unlinking every team leaves the typed name as the only thing the row
    // still knows about its team — dropping it here would destroy the
    // operator's answer as a side effect of an unrelated edit.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const teamId = await insertTeam(t, sportId, "Boston Red Sox");
    const cardId = await insertCard(t, leafId, { teamOnCardIds: [teamId] });
    await t.run(async (ctx) =>
      ctx.db.patch(cardId, { pendingTeamNames: ["Bosten Red Sox"] }),
    );

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: [],
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([]);
    expect(row!.pendingTeamNames).toEqual(["Bosten Red Sox"]);
  });

  test("an edit that does not mention teams leaves pendingTeamNames alone", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);
    await t.run(async (ctx) =>
      ctx.db.patch(cardId, { pendingTeamNames: ["Bosten Red Sox"] }),
    );

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      cardName: "Renamed",
    });

    const row = await getCard(t, cardId);
    expect(row!.pendingTeamNames).toEqual(["Bosten Red Sox"]);
  });

  test("pendingTeamNames is not settable through updateCard's args", async () => {
    // Same discipline as the two no-team fields above: the clear is DERIVED
    // from the write. A validator entry would make it directly settable,
    // which would let a client fabricate "the operator typed this".
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        pendingTeamNames: ["Invented"],
      } as never),
    ).rejects.toThrow();

    const row = await getCard(t, cardId);
    expect(row!.pendingTeamNames).toBeUndefined();
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
// updateCard — MAX_CARD_TEAMS is server-enforced, not just a UI cap
// ===========================================================================

/**
 * `MissingTeamFixer.tsx`'s 8-team cap is advisory: it stops the operator from
 * building a silly write in the UI, but nothing before this validation
 * stopped a direct `updateCard` call (or a future caller that forgets the
 * client-side cap) from writing an unbounded array, a pile of duplicate ids,
 * or an id that doesn't resolve to a real team at all.
 */
describe("updateCard — team validation", () => {
  test("rejects more teams than MAX_CARD_TEAMS, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);
    const teamIds = await Promise.all(
      Array.from({ length: MAX_CARD_TEAMS + 1 }, (_, i) =>
        insertTeam(t, sportId, `Team ${i + 1}`),
      ),
    );

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        teamOnCardIds: teamIds,
      }),
    ).rejects.toThrow(/at most 8 teams/);

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("dedupes duplicate team ids before writing, preserving first-seen order", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);
    const yankees = await insertTeam(t, sportId, "New York Yankees");
    const redSox = await insertTeam(t, sportId, "Boston Red Sox");

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: [yankees, redSox, yankees],
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([yankees, redSox]);
  });

  test("a duplicate-heavy list that dedupes UNDER the cap is accepted", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);
    const yankees = await insertTeam(t, sportId, "New York Yankees");
    // Nine copies of the same id — over the raw cap, but dedupes to one.
    const requested = Array.from({ length: MAX_CARD_TEAMS + 1 }, () => yankees);

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: requested,
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([yankees]);
  });

  test("rejects a team id that no longer resolves to a row, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);
    const danglingTeamId = await insertTeam(t, sportId, "Deleted Team");
    await t.run(async (ctx) => ctx.db.delete(danglingTeamId));

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        teamOnCardIds: [danglingTeamId],
      }),
    ).rejects.toThrow(/no longer exists/);

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("rejects a team from a different sport than the card's, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t); // Baseball
    const cardId = await insertCard(t, leafId);
    const basketballSportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Basketball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const lakers = await insertTeam(t, basketballSportId, "Los Angeles Lakers");

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        teamOnCardIds: [lakers],
      }),
    ).rejects.toThrow(/not a team in this card's sport/);

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("accepts a team that matches the card's own sport", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);
    const yankees = await insertTeam(t, sportId, "New York Yankees");

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: [yankees],
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([yankees]);
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

  test("a player with no career teamYears contributes nothing, while a co-player on the same card still suggests theirs", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t, { season: "2024" });
    const dbacks = await insertTeam(t, sportId, "Arizona Diamondbacks");
    // No teamYears at all — a rookie card shot before any career entry exists,
    // or a player row created without one. The `?? []` fallback must make
    // this a silent no-op for THIS player, not a thrown error for the card.
    const rookie = await insertPlayer(t, sportId, "Blank Career Rookie", []);
    const veteran = await insertPlayer(t, sportId, "Corbin Carroll", [
      { teamId: dbacks, fromYear: 2022 },
    ]);
    const cardId = await insertCard(t, leafId, { playerIds: [rookie, veteran] });

    const suggestions = await asAdmin.query(
      api.cardChecklist.suggestedTeamsForCard,
      { cardId },
    );
    expect(suggestions).toEqual([
      {
        teamId: dbacks,
        name: "Arizona Diamondbacks",
        source: "career",
        playerName: "Corbin Carroll",
      },
    ]);
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

// ===========================================================================
// NEO-208 — addCustomCard accepts real team ids
// ===========================================================================

/**
 * The quick-add form used to send `teams: [typedName]`, which landed in
 * `pendingTeamNames` — a column NOTHING rendered. The operator watched their
 * typed team vanish and the row stayed badged "no team on this card yet". It
 * now sends `teamOnCardIds` from a real `TeamPicker`, so a hand-added card is
 * born LINKED.
 *
 * The validation is not a second implementation: `addCustomCard` and
 * `updateCard` share `resolveTeamOnCardIdsForWrite`, so the born-with-a-team
 * path accepts exactly what the given-one-later path accepts. That sharing is
 * what these tests are really pinning — the cases below deliberately mirror
 * the `updateCard — team validation` block above, and a divergence shows up as
 * one block passing and the other failing.
 */
const allCards = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("cardChecklist").collect());

describe("addCustomCard — team ids (NEO-208)", () => {
  test("writes the picked teams as teamOnCardIds, and no pending names", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const yankees = await insertTeam(t, sportId, "New York Yankees");
    const mets = await insertTeam(t, sportId, "New York Mets");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "501",
      cardName: "Subway Series",
      teamOnCardIds: [yankees, mets],
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([yankees, mets]);
    expect(row!.pendingTeamNames).toBeUndefined();
  });

  test("a card born linked needs no attention — which is the whole point", async () => {
    // `deriveCardAttention` is unchanged by this ticket; what changed is that
    // the quick-add path now satisfies its FIRST clause (a real team) instead
    // of its pending-name clause. Asserted through the derivation so the two
    // halves of NEO-208 are pinned together: a linked card is not badged, and
    // it is not badged for the honest reason.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const yankees = await insertTeam(t, sportId, "New York Yankees");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "502",
      cardName: "Aaron Judge",
      teamOnCardIds: [yankees],
    });

    const row = await getCard(t, cardId);
    expect(deriveCardAttention(row!)).toEqual([]);
  });

  test("sends neither field and the card is correctly left needing a team", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "503",
      cardName: "Unknown Team Guy",
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
    expect(row!.pendingTeamNames).toBeUndefined();
    expect(deriveCardAttention(row!)).toEqual([{ kind: "missingTeam" }]);
  });

  test("rejects an id that resolves to no team, and writes NO card at all", async () => {
    // Validated before the insert, so a bad id cannot leave a half-created
    // card behind for the operator to find and wonder about.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const dangling = await insertTeam(t, sportId, "Deleted Team");
    await t.run(async (ctx) => ctx.db.delete(dangling));

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "504",
        cardName: "Nope",
        teamOnCardIds: [dangling],
      }),
    ).rejects.toThrow(/no longer exists/);

    expect(await allCards(t)).toHaveLength(0);
  });

  test("rejects a team from another sport, and writes NO card at all", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t); // Baseball
    const basketballSportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Basketball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const lakers = await insertTeam(t, basketballSportId, "Los Angeles Lakers");

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "505",
        cardName: "Nope",
        teamOnCardIds: [lakers],
      }),
    ).rejects.toThrow(/not a team in this card's sport/);

    expect(await allCards(t)).toHaveLength(0);
  });

  test("rejects a same-NAMED team from another sport — the check is by sportId, never by name", async () => {
    // Two rows can legitimately share a display name across sports (a
    // "Yankees" in a minor league, say). This pins that
    // `resolveTeamOnCardIdsForWrite` compares `team.sportId`, not
    // `team.name` — a name-based check would let the wrong-sport id through
    // whenever the names happened to collide.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t); // Baseball
    const otherSportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Other Sport",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    // Same name, different sport.
    await insertTeam(t, sportId, "Yankees");
    const wrongSportYankees = await insertTeam(t, otherSportId, "Yankees");

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "5051",
        cardName: "Nope",
        teamOnCardIds: [wrongSportYankees],
      }),
    ).rejects.toThrow(/not a team in this card's sport/);

    expect(await allCards(t)).toHaveLength(0);
  });

  test("dedupes duplicate ids before writing, preserving first-seen order", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const yankees = await insertTeam(t, sportId, "New York Yankees");
    const redSox = await insertTeam(t, sportId, "Boston Red Sox");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "506",
      cardName: "Rivalry",
      teamOnCardIds: [yankees, redSox, yankees],
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([yankees, redSox]);
  });

  test("rejects more teams than MAX_CARD_TEAMS, and writes NO card at all", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const teamIds = await Promise.all(
      Array.from({ length: MAX_CARD_TEAMS + 1 }, (_, i) =>
        insertTeam(t, sportId, `Team ${i + 1}`),
      ),
    );

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "507",
        cardName: "Too Many",
        teamOnCardIds: teamIds,
      }),
    ).rejects.toThrow(/at most 8 teams/);

    expect(await allCards(t)).toHaveLength(0);
  });

  test("a duplicate-heavy list that dedupes UNDER the cap is accepted", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const yankees = await insertTeam(t, sportId, "New York Yankees");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "508",
      cardName: "Same Chip Nine Times",
      teamOnCardIds: Array.from({ length: MAX_CARD_TEAMS + 1 }, () => yankees),
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([yankees]);
  });

  test("an OLD SPA bundle's `teams` name array still lands in pendingTeamNames", async () => {
    // A Vercel deploy does not reload anybody's browser, so a tab holding the
    // pre-NEO-208 bundle keeps sending typed names for a while. It must keep
    // behaving exactly as it did — the names park in `pendingTeamNames` and
    // the next sync's resolve pass turns them into links.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "509",
      cardName: "Legacy Client Card",
      teams: ["  New York Yankees  ", "", "   "],
    });

    const row = await getCard(t, cardId);
    expect(row!.pendingTeamNames).toEqual(["New York Yankees"]);
    expect(row!.teamOnCardIds).toBeUndefined();
    // Still counted as answered, so the row is not badged — the rule
    // `deriveCardAttention` has always applied to these.
    expect(deriveCardAttention(row!)).toEqual([]);
  });

  test("ids WIN over a typed name when a caller sends both, and the row says its team once", async () => {
    // No client sends both. The rule exists so a future one cannot produce a
    // row that states its team twice — the same rule `updateCard` applies
    // when it retires `pendingTeamNames` on a real link.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const yankees = await insertTeam(t, sportId, "New York Yankees");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "510",
      cardName: "Both Shapes",
      teams: ["Yankess"],
      teamOnCardIds: [yankees],
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([yankees]);
    expect(row!.pendingTeamNames).toBeUndefined();
  });
});

describe("addCustomCard — the generated listing title/description name the LINKED teams", () => {
  test("uses the linked teams' STORED names, not a typed string", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const yankees = await insertTeam(t, sportId, "New York Yankees");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "511",
      cardName: "Aaron Judge",
      teamOnCardIds: [yankees],
    });

    const row = await getCard(t, cardId);
    // The generator's write-once title/description are the visible payoff of
    // the ids: before this, a hand-added card's title could only say what the
    // operator typed, misspellings and all.
    expect(row!.listingTitle).toContain("New York Yankees");
    expect(row!.listingDescription).toContain("Team: New York Yankees.");
  });

  test("falls back to the pending names for an old-client write", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "512",
      cardName: "Legacy Client Card",
      teams: ["Savannah Bananas"],
    });

    const row = await getCard(t, cardId);
    expect(row!.listingTitle).toContain("Savannah Bananas");
    expect(row!.listingDescription).toContain("Team: Savannah Bananas.");
  });

  test("the stored title is a WRITE-ONCE snapshot — a later team rename does not change it", async () => {
    // `assessListingTitle` runs once, inside `addCustomCard`, off the name
    // `resolveTeamOnCardIdsForWrite` read at that moment. Nothing re-derives
    // `row.listingTitle` after insert (mirrors the write-once semantics
    // `writeOnceFeatureSnapshots.test.ts` pins for the features snapshot), so
    // renaming the team afterward must not retroactively change the stored
    // title. `previewListingTitle`, by contrast, resolves the team name LIVE
    // on every call — it exists precisely to show what the generator would
    // say TODAY, for the panel's Regenerate button — so it MUST pick up the
    // rename. Both halves are asserted here so a future change that makes one
    // of them stop matching this description is caught immediately.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const yankees = await insertTeam(t, sportId, "New York Yankees");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "512",
      cardName: "Aaron Judge",
      teamOnCardIds: [yankees],
    });
    const stored = await getCard(t, cardId);
    expect(stored!.listingTitle).toContain("New York Yankees");

    await t.run(async (ctx) =>
      ctx.db.patch(yankees, { name: "New York Yankees (renamed)" }),
    );

    const afterRename = await getCard(t, cardId);
    // The stored, write-once title is untouched by the rename.
    expect(afterRename!.listingTitle).toBe(stored!.listingTitle);
    expect(afterRename!.listingTitle).not.toContain("(renamed)");

    // The live preview, however, reflects it — that split is the design.
    const preview = await asAdmin.query(api.selectorOptions.previewListingTitle, {
      cardId,
    });
    expect(preview.inputs.teamNames).toEqual(["New York Yankees (renamed)"]);
  });
});

describe("addCustomCard — teamOnCardIds edge shapes", () => {
  test("an explicit empty teamOnCardIds behaves exactly like omitting it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "513",
      cardName: "No Team Explicitly",
      teamOnCardIds: [],
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
    expect(row!.pendingTeamNames).toBeUndefined();
    expect(deriveCardAttention(row!)).toEqual([{ kind: "missingTeam" }]);
  });

  test("addCustomCard and updateCard agree: a card whose ancestor chain has no sport accepts ANY team id", async () => {
    // `resolveTeamOnCardIdsForWrite`'s sport check is skipped entirely when
    // `findSportForSelectorOption` can't resolve a sport for the card's own
    // ancestor chain (an orphaned/corrupted tree) — see the comment on that
    // function: "an orphaned ancestor chain must not turn an otherwise-valid
    // team edit into a hard failure." Both write paths share the helper, so
    // this pins that they give the SAME answer rather than merely asserting
    // it once.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    // A leaf with NO parentId at all: findSportForSelectorOption walks up,
    // finds a non-sport row with no parent, and returns undefined.
    const orphanLeafId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Orphan",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    // A team from an UNRELATED sport — this is exactly the id that a normal
    // (resolvable) ancestor chain would reject.
    const basketballSportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Basketball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const lakers = await insertTeam(t, basketballSportId, "Los Angeles Lakers");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: orphanLeafId,
      cardNumber: "514",
      cardName: "Orphan Chain Card",
      teamOnCardIds: [lakers],
    });
    const addRow = await getCard(t, cardId);
    expect(addRow!.teamOnCardIds).toEqual([lakers]);

    // updateCard on a SEPARATE card under the same orphan leaf gives the
    // identical answer.
    const secondCardId = await insertCard(t, orphanLeafId, {
      cardNumber: "515",
    });
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: secondCardId,
      teamOnCardIds: [lakers],
    });
    const updateRow = await getCard(t, secondCardId);
    expect(updateRow!.teamOnCardIds).toEqual([lakers]);
  });
});

describe("updateCard — pendingTeamNames clear semantics (NEO-208)", () => {
  test("a no-op write (same ids as already stored) still clears pendingTeamNames", async () => {
    // The clear is keyed on "the write is non-empty", not "the write
    // changed anything" — `updateCard` never compares against the stored
    // value. Both behaviours are defensible; this pins what the code
    // actually does so a future change is a deliberate decision, not a
    // silent drift.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const yankees = await insertTeam(t, sportId, "New York Yankees");
    const cardId = await insertCard(t, leafId, { teamOnCardIds: [yankees] });
    await t.run(async (ctx) =>
      ctx.db.patch(cardId, { pendingTeamNames: ["Stale Typed Name"] }),
    );

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: [yankees], // identical to what's already stored
    });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([yankees]);
    expect(row!.pendingTeamNames).toBeUndefined();
  });

  test("a write that FAILS validation leaves pendingTeamNames untouched", async () => {
    // Validation throws before the patch is ever built, so a bad id must not
    // have any side effect on the row at all — including retiring a pending
    // name the operator hasn't actually resolved yet.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);
    await t.run(async (ctx) =>
      ctx.db.patch(cardId, { pendingTeamNames: ["Stale Typed Name"] }),
    );
    const dangling = await insertTeam(t, sportId, "Deleted Team");
    await t.run(async (ctx) => ctx.db.delete(dangling));

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        teamOnCardIds: [dangling],
      }),
    ).rejects.toThrow(/no longer exists/);

    const row = await getCard(t, cardId);
    expect(row!.pendingTeamNames).toEqual(["Stale Typed Name"]);
    expect(row!.teamOnCardIds).toBeUndefined();
  });
});

describe("deriveCardAttention — a stale row carrying BOTH fields (NEO-208)", () => {
  test("a card with teamOnCardIds AND a leftover pendingTeamNames is not flagged", async () => {
    // This shape is reachable today: `updateCard` only clears
    // `pendingTeamNames` when a NON-EMPTY `teamOnCardIds` write goes through
    // it, so a row that got its link some other way (a direct write, or a
    // resolve pass that doesn't share this clear) can carry both. The
    // `missingTeam` clause is an OR of the two fields, so this is not flagged
    // either way — pinned here rather than left implicit.
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const yankees = await insertTeam(t, sportId, "New York Yankees");
    const cardId = await insertCard(t, leafId, { teamOnCardIds: [yankees] });
    await t.run(async (ctx) =>
      ctx.db.patch(cardId, { pendingTeamNames: ["Stale Typed Name"] }),
    );

    const row = await getCard(t, cardId);
    expect(deriveCardAttention(row!)).toEqual([]);
  });
});

// ===========================================================================
// NEO-208 security review — the free-text name args are BOUNDED
// ===========================================================================

/**
 * `addCustomCard`'s `players` / `teams` args are operator free text that lands
 * on a row several screens then render (the listing-title generator, the
 * entity-review wizard, the row sub-line). Nothing bounded them.
 *
 * Both limits refuse rather than trim: quietly storing something other than
 * what was sent is how a mangled name gets confirmed as correct in the wizard.
 */
describe("addCustomCard — pending name bounds", () => {
  test("rejects more typed team names than the cap", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "520",
        cardName: "Too Many Names",
        teams: Array.from({ length: MAX_CARD_TEAMS + 1 }, (_, i) => `Team ${i}`),
      }),
    ).rejects.toThrow(/at most 8 team names/);

    expect(await allCards(t)).toHaveLength(0);
  });

  test("rejects more typed player names than the cap", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "521",
        cardName: "Too Many Names",
        players: Array.from({ length: 21 }, (_, i) => `Player ${i}`),
      }),
    ).rejects.toThrow(/at most 20 player names/);

    expect(await allCards(t)).toHaveLength(0);
  });

  test("accepts a team-card-sized player list well past the team cap", async () => {
    // MAX_PENDING_PLAYER_NAMES (20) is deliberately wider than MAX_CARD_TEAMS
    // (8): a team card or a League Leaders / rookie-combo insert can
    // legitimately list more players than any card ever lists teams.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const players = Array.from({ length: 20 }, (_, i) => `Player ${i}`);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "525",
      cardName: "Team Card",
      players,
    });

    const row = await getCard(t, cardId);
    expect(row!.pendingPlayerNames).toEqual(players);
  });

  test("rejects an over-long name without quoting it back", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const essay = "z".repeat(121);

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "522",
        cardName: "Essay",
        teams: [essay],
      }),
    ).rejects.toThrow(/121 characters; the limit is 120/);

    // The message carries the LENGTH, never the content: it travels through
    // Convex's error path into Sentry and the browser console. Asserted by
    // reading the thrown value directly rather than through a negated
    // `rejects` matcher, which passes vacuously if nothing is thrown.
    let thrown: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "522",
        cardName: "Essay",
        teams: [essay],
      });
    } catch (err) {
      thrown = err;
    }
    const serialized = `${(thrown as Error)?.message ?? ""} ${JSON.stringify(thrown)}`;
    // Non-vacuous: the length IS in there, so the absence of the content below
    // is a real observation about the same string.
    expect(serialized).toContain("the limit is 120");
    expect(serialized).not.toContain("zzzz");

    expect(await allCards(t)).toHaveLength(0);
  });

  test("a name AT the cap is accepted — the bound is not off by one", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const atCap = "z".repeat(120);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "523",
      cardName: "At Cap",
      teams: [atCap],
    });

    const row = await getCard(t, cardId);
    expect(row!.pendingTeamNames).toEqual([atCap]);
  });

  test("whitespace is trimmed BEFORE the length check", async () => {
    // Otherwise an operator who pastes a padded name gets refused for
    // characters that were never going to be stored.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const padded = `   ${"z".repeat(120)}   `;

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "524",
      cardName: "Padded",
      teams: [padded],
    });

    const row = await getCard(t, cardId);
    expect(row!.pendingTeamNames).toEqual(["z".repeat(120)]);
  });
});
