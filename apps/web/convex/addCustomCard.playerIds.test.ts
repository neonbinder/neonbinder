/**
 * NEO-220 — `addCustomCard` accepts real PLAYER ids, so a card added by hand
 * is born LINKED.
 *
 * The players twin of the `addCustomCard — team ids (NEO-208)` block in
 * convex/cardChecklist.noTeam.test.ts, and deliberately case-for-case the same
 * so a divergence between the two sides shows up as one block passing and the
 * other failing. Read the two together.
 *
 * The defect this closes: the quick-add form sent `players: [typedName]`,
 * which landed in `pendingPlayerNames` — a name the card CARRIED while linking
 * to nothing. `deriveCardAttention` then badged the row `unreviewedName` and
 * sent the attention walker to ask the operator for a player they had just
 * typed in. Real ids from a `PlayerPicker` mean the card starts answered.
 *
 * Validation lives in `resolvePlayerIdsForWrite`, mirroring
 * `resolveTeamOnCardIdsForWrite`: dedupe preserving order, `MAX_CARD_PLAYERS`,
 * existence, and same-sport — all BEFORE the insert, so a bad id leaves no
 * half-created card behind.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import {
  deriveCardAttention,
  MAX_CARD_PLAYERS,
} from "./features/cardAttention";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_add_custom_players_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_add_custom_players_001",
  role: "admin",
};

/** sport → setName → variantType, matching cardChecklist.noTeam.test.ts. */
async function seedTree(t: ReturnType<typeof convexTest>): Promise<{
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
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Test Set",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

async function insertPlayer(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

const getCard = (t: ReturnType<typeof convexTest>, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => ctx.db.get(id));

const allCards = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("cardChecklist").collect());

/** A second sport row, for the cross-sport refusals. */
const insertOtherSport = (t: ReturnType<typeof convexTest>, value: string) =>
  t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );

// ===========================================================================
// The write itself
// ===========================================================================

describe("addCustomCard — player ids (NEO-220)", () => {
  test("writes the picked players as playerIds, and no pending names", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const judge = await insertPlayer(t, sportId, "Aaron Judge");
    const lindor = await insertPlayer(t, sportId, "Francisco Lindor");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "601",
      cardName: "Subway Series",
      playerIds: [judge, lindor],
    });

    const row = await getCard(t, cardId);
    expect(row!.playerIds).toEqual([judge, lindor]);
    expect(row!.pendingPlayerNames).toBeUndefined();
  });

  test("a card born linked carries no unreviewedName — which is the whole point", async () => {
    // `deriveCardAttention` is unchanged by this ticket. What changed is that
    // the quick-add path now satisfies its `playerIds` clause instead of
    // parking a name in `pendingPlayerNames` that the same rule then badges.
    // Asserted through the derivation so the two halves of NEO-220 are pinned
    // together: the card is not badged, and not badged for the honest reason.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const judge = await insertPlayer(t, sportId, "Aaron Judge");
    const yankees = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "New York Yankees",
        nameNormalized: normalizeTeamName("New York Yankees"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "602",
      cardName: "Aaron Judge",
      playerIds: [judge],
      // A team too, so `missingTeam` does not stand in the way of asserting
      // the empty list — the point here is the PLAYER side specifically.
      teamOnCardIds: [yankees],
    });

    const row = await getCard(t, cardId);
    expect(deriveCardAttention(row!)).toEqual([]);
  });

  test("the SAME card written the OLD way IS badged — the before/after in one pair", async () => {
    // The pin that makes the test above mean something: an identical card
    // whose players arrive as typed names is flagged, so the empty attention
    // list is a property of the LINK, not of the fixture.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const yankees = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "New York Yankees",
        nameNormalized: normalizeTeamName("New York Yankees"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "603",
      cardName: "Aaron Judge",
      players: ["Aaron Judge"],
      teamOnCardIds: [yankees],
    });

    const row = await getCard(t, cardId);
    expect(deriveCardAttention(row!)).toEqual([
      { kind: "unreviewedName", names: ["Aaron Judge"] },
    ]);
  });

  test("sending neither field leaves the card with no players at all", async () => {
    // "No answer about players" — and unlike teams, that is not itself an
    // attention item. A card with no player named is a complete card.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "604",
      cardName: "Team Checklist",
    });

    const row = await getCard(t, cardId);
    expect(row!.playerIds).toBeUndefined();
    expect(row!.pendingPlayerNames).toBeUndefined();
  });

  test("an explicit empty playerIds behaves exactly like omitting it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "605",
      cardName: "No Players Explicitly",
      playerIds: [],
    });

    const row = await getCard(t, cardId);
    expect(row!.playerIds).toBeUndefined();
    expect(row!.pendingPlayerNames).toBeUndefined();
  });
});

// ===========================================================================
// Validation — mirrors `addCustomCard — team ids` case for case
// ===========================================================================

describe("addCustomCard — playerIds validation", () => {
  test("rejects an id that resolves to no player, and writes NO card at all", async () => {
    // Validated before the insert, so a bad id cannot leave a half-created
    // card behind for the operator to find and wonder about.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const dangling = await insertPlayer(t, sportId, "Deleted Player");
    await t.run(async (ctx) => ctx.db.delete(dangling));

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "610",
        cardName: "Nope",
        playerIds: [dangling],
      }),
    ).rejects.toThrow(/no longer exists/);

    expect(await allCards(t)).toHaveLength(0);
  });

  test("rejects a player from another sport, and writes NO card at all", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t); // Baseball
    const basketballSportId = await insertOtherSport(t, "Basketball");
    const lebron = await insertPlayer(t, basketballSportId, "LeBron James");

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "611",
        cardName: "Nope",
        playerIds: [lebron],
      }),
    ).rejects.toThrow(/not a player in this card's sport/);

    expect(await allCards(t)).toHaveLength(0);
  });

  test("rejects a same-NAMED player from another sport — the check is by sportId, never by name", async () => {
    // Two rows can legitimately share a display name across sports. This pins
    // that `resolvePlayerIdsForWrite` compares `player.sportId`, not
    // `player.name` — a name-based check would let the wrong-sport id through
    // whenever the names happened to collide. Card numbers are never unique
    // and neither are names; only ids are.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t); // Baseball
    const otherSportId = await insertOtherSport(t, "Other Sport");
    await insertPlayer(t, sportId, "Chris Davis");
    const wrongSportDavis = await insertPlayer(t, otherSportId, "Chris Davis");

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "612",
        cardName: "Nope",
        playerIds: [wrongSportDavis],
      }),
    ).rejects.toThrow(/not a player in this card's sport/);

    expect(await allCards(t)).toHaveLength(0);
  });

  test("dedupes duplicate ids before writing, preserving first-seen order", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const judge = await insertPlayer(t, sportId, "Aaron Judge");
    const lindor = await insertPlayer(t, sportId, "Francisco Lindor");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "613",
      cardName: "Doubled Up",
      playerIds: [lindor, judge, lindor],
    });

    const row = await getCard(t, cardId);
    // The array is DISPLAY order, not a set — first-seen wins.
    expect(row!.playerIds).toEqual([lindor, judge]);
  });

  test("rejects more players than MAX_CARD_PLAYERS, and writes NO card at all", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const ids = await Promise.all(
      Array.from({ length: MAX_CARD_PLAYERS + 1 }, (_, i) =>
        insertPlayer(t, sportId, `Player ${i}`),
      ),
    );

    await expect(
      asAdmin.mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "614",
        cardName: "Too Many",
        playerIds: ids,
      }),
    ).rejects.toThrow(
      new RegExp(`at most ${MAX_CARD_PLAYERS} players`),
    );

    expect(await allCards(t)).toHaveLength(0);
  });

  test("a duplicate-heavy list that dedupes UNDER the cap is accepted", async () => {
    // The cap is checked AFTER the dedupe, so a client that double-submits a
    // chip is not punished for it.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const judge = await insertPlayer(t, sportId, "Aaron Judge");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "615",
      cardName: "Same Chip Many Times",
      playerIds: Array.from({ length: MAX_CARD_PLAYERS + 1 }, () => judge),
    });

    const row = await getCard(t, cardId);
    expect(row!.playerIds).toEqual([judge]);
  });

  test("a card whose ancestor chain has no sport accepts ANY player id", async () => {
    // Documented behaviour, not a bug, and identical to the team side:
    // `findSportForSelectorOption` returns nothing for an orphaned chain, and
    // an unresolvable sport must not turn an otherwise-valid write into a hard
    // failure. Pinned so a future change to that skip is a deliberate one.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const orphanLeafId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Orphan",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const basketballSportId = await insertOtherSport(t, "Basketball");
    const lebron = await insertPlayer(t, basketballSportId, "LeBron James");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: orphanLeafId,
      cardNumber: "616",
      cardName: "No Sport Anywhere",
      playerIds: [lebron],
    });

    const row = await getCard(t, cardId);
    expect(row!.playerIds).toEqual([lebron]);
  });
});

// ===========================================================================
// The legacy `players` name array — kept for an old SPA bundle
// ===========================================================================

describe("addCustomCard — the legacy `players` name array", () => {
  test("an OLD SPA bundle's `players` array still lands in pendingPlayerNames", async () => {
    // A Vercel deploy does not reload anybody's browser, so a tab holding the
    // pre-NEO-220 bundle keeps sending typed names for a while. It must keep
    // behaving exactly as it did — trimmed, empties dropped, parked in
    // `pendingPlayerNames` for the next sync's resolve pass.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "620",
      cardName: "Legacy Client Card",
      players: ["  Aaron Judge  ", "", "   ", "Francisco Lindor"],
    });

    const row = await getCard(t, cardId);
    expect(row!.pendingPlayerNames).toEqual([
      "Aaron Judge",
      "Francisco Lindor",
    ]);
    expect(row!.playerIds).toBeUndefined();
  });

  test("ids WIN over typed names when a caller sends both, and the row names its players once", async () => {
    // No client sends both. The rule exists so a future one cannot produce a
    // row that names the same player twice — in two spellings, one of which
    // links to nothing and would badge the row.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const judge = await insertPlayer(t, sportId, "Aaron Judge");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "621",
      cardName: "Both Shapes",
      players: ["Aron Judge"],
      playerIds: [judge],
    });

    const row = await getCard(t, cardId);
    expect(row!.playerIds).toEqual([judge]);
    expect(row!.pendingPlayerNames).toBeUndefined();
    expect(deriveCardAttention(row!)).not.toContainEqual(
      expect.objectContaining({ kind: "unreviewedName" }),
    );
  });
});

// ===========================================================================
// The generated listing title / description
// ===========================================================================

describe("addCustomCard — the listing title names the LINKED players", () => {
  test("uses the linked players' STORED names, not a typed string", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const judge = await insertPlayer(t, sportId, "Aaron Judge");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "630",
      cardName: "Aaron Judge",
      playerIds: [judge],
    });

    const row = await getCard(t, cardId);
    // The visible payoff of the ids: before this, a hand-added card's title
    // could only say what the operator typed, misspellings and all.
    expect(row!.listingTitle).toContain("Aaron Judge");
  });

  test("falls back to the pending names for an old-client write", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "631",
      cardName: "Legacy Client Card",
      players: ["Shohei Ohtani"],
    });

    const row = await getCard(t, cardId);
    expect(row!.listingTitle).toContain("Shohei Ohtani");
  });

  test("the stored title is a WRITE-ONCE snapshot — a later player rename does not change it", async () => {
    // Same split the team side pins: `assessListingTitle` runs once inside
    // `addCustomCard` off the name `resolvePlayerIdsForWrite` read at that
    // moment, while `previewListingTitle` resolves names LIVE on every call
    // because it exists to show what the generator would say TODAY.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const judge = await insertPlayer(t, sportId, "Aaron Judge");

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "632",
      cardName: "Aaron Judge",
      playerIds: [judge],
    });
    const stored = await getCard(t, cardId);
    expect(stored!.listingTitle).toContain("Aaron Judge");

    await t.run(async (ctx) =>
      ctx.db.patch(judge, { name: "Aaron Judge (renamed)" }),
    );

    const afterRename = await getCard(t, cardId);
    expect(afterRename!.listingTitle).toBe(stored!.listingTitle);
    expect(afterRename!.listingTitle).not.toContain("(renamed)");

    const preview = await asAdmin.query(
      api.selectorOptions.previewListingTitle,
      { cardId },
    );
    expect(preview.inputs.playerNames).toEqual(["Aaron Judge (renamed)"]);
  });
});
