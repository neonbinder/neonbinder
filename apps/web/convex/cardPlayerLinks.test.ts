/**
 * NEO-254 — a card records the name it was PRINTED with.
 *
 * Jason, 2026-09-08: a 1986 card says "Doc Gooden" and a 1990 card says
 * "Dwight Gooden". Both link to one player row, and until now the card kept no
 * trace of which string it carried. That string is the card's own fact; the
 * player's name is NB data that can be corrected, renamed or aliased at any
 * time, and none of that may rewrite what a 1986 card says.
 *
 * The invariant under test throughout: `playerIds` and `playerLinks` are one
 * list — same ids, same order — because two copies of one list can disagree.
 * The static half is `cardChecklist.playerLinksPin.test.ts`; this is the
 * behavioural half.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_player_links_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_player_links_001",
  name: "Admin User",
  role: "admin",
};

async function seedSetTree(t: ReturnType<typeof convexTest>) {
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
      value: "Topps",
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
    return { sportId, variantTypeId };
  });
}

/** Dwight Gooden, who also answers to "Doc Gooden". */
async function seedGooden(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("players", {
      name: "Dwight Gooden",
      nameNormalized: normalizePlayerName("Dwight Gooden"),
      sportId,
      aliases: ["Doc Gooden"],
      lastUpdated: Date.now(),
    });
    await ctx.db.insert("playerAliases", {
      playerId: id,
      sportId,
      aliasNormalized: normalizePlayerName("Doc Gooden"),
    });
    return id;
  });
}

function makeCard(overrides: { cardNumber?: string; players?: string[] } = {}) {
  return {
    cardNumber: overrides.cardNumber ?? "1",
    cardName: "Card",
    team: undefined,
    teams: [],
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

const cardsIn = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("cardChecklist").collect());

describe("NEO-254: the commit records the printed name", () => {
  test("an ALIAS card keeps the name it printed, not the player's", async () => {
    /*
     * The case the feature exists for. "Doc Gooden" resolves to Dwight Gooden
     * through the alias index, and the card must go on saying "Doc Gooden"
     * however the player row is later renamed.
     */
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetTree(t);
    const gooden = await seedGooden(t, sportId);

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ players: ["Doc Gooden"] })],
      });

    const [card] = await cardsIn(t);
    expect(card.playerIds).toEqual([gooden]);
    expect(card.playerLinks).toEqual([
      { playerId: gooden, nameOnCard: "Doc Gooden" },
    ]);
  });

  test("a primary-name card records that name too", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetTree(t);
    const gooden = await seedGooden(t, sportId);

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ players: ["Dwight Gooden"] })],
      });

    const [card] = await cardsIn(t);
    expect(card.playerLinks).toEqual([
      { playerId: gooden, nameOnCard: "Dwight Gooden" },
    ]);
  });

  test("ids and links stay the same list, in the same order", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetTree(t);
    const gooden = await seedGooden(t, sportId);
    const other = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Darryl Strawberry",
        nameNormalized: normalizePlayerName("Darryl Strawberry"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [
          makeCard({ players: ["Darryl Strawberry", "Doc Gooden"] }),
        ],
      });

    const [card] = await cardsIn(t);
    expect(card.playerIds).toEqual([other, gooden]);
    expect(card.playerLinks?.map((l) => l.playerId)).toEqual(card.playerIds);
    expect(card.playerLinks?.map((l) => l.nameOnCard)).toEqual([
      "Darryl Strawberry",
      "Doc Gooden",
    ]);
  });

  test("an unresolved name contributes to neither list", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetTree(t);
    const gooden = await seedGooden(t, sportId);

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [makeCard({ players: ["Doc Gooden", "Nobody At All"] })],
      });

    const [card] = await cardsIn(t);
    expect(card.playerIds).toEqual([gooden]);
    expect(card.playerLinks).toEqual([
      { playerId: gooden, nameOnCard: "Doc Gooden" },
    ]);
    // The unresolved name is still reported, as it always was.
    expect(card.pendingPlayerNames).toContain("Nobody At All");
  });
});

describe("NEO-254: a hand-added card records one too", () => {
  test("defaults to the player's own name — that is what the picker showed", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetTree(t);
    const gooden = await seedGooden(t, sportId);

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.addCustomCard,
      {
        selectorOptionId: variantTypeId,
        cardNumber: "99",
        cardName: "Custom",
        playerIds: [gooden],
      },
    );

    const [card] = await cardsIn(t);
    expect(card.playerLinks).toEqual([
      { playerId: gooden, nameOnCard: "Dwight Gooden" },
    ]);
    expect(sportId).toBeTruthy();
  });

  test("a caller that knows the printed spelling sends it, and it wins", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetTree(t);
    const gooden = await seedGooden(t, sportId);

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.addCustomCard,
      {
        selectorOptionId: variantTypeId,
        cardNumber: "99",
        cardName: "Custom",
        playerIds: [gooden],
        playerNamesOnCard: [{ playerId: gooden, nameOnCard: "Doc Gooden" }],
      },
    );

    const [card] = await cardsIn(t);
    expect(card.playerLinks).toEqual([
      { playerId: gooden, nameOnCard: "Doc Gooden" },
    ]);
    expect(sportId).toBeTruthy();
  });

  test("updateCard rewrites both lists together", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetTree(t);
    const gooden = await seedGooden(t, sportId);
    const other = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Darryl Strawberry",
        nameNormalized: normalizePlayerName("Darryl Strawberry"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "99",
      cardName: "Custom",
      playerIds: [gooden],
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      playerIds: [other],
      playerNamesOnCard: [{ playerId: other, nameOnCard: "Straw" }],
    });

    const [card] = await cardsIn(t);
    expect(card.playerIds).toEqual([other]);
    expect(card.playerLinks).toEqual([
      { playerId: other, nameOnCard: "Straw" },
    ]);
  });
});

describe("NEO-254: the backfill fills rows written before the field", () => {
  function armed<T>(run: () => Promise<T>): Promise<T> {
    process.env.ALLOW_BACKFILL_PLAYER_LINKS = "true";
    return run().finally(() => {
      delete process.env.ALLOW_BACKFILL_PLAYER_LINKS;
    });
  }

  async function seedLegacyCard(
    t: ReturnType<typeof convexTest>,
    variantTypeId: Id<"selectorOptions">,
    playerIds: Array<Id<"players">>,
  ) {
    return t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: "1",
        cardName: "Legacy",
        playerIds,
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );
  }

  test("writes the canonical name — the honest answer for a lost string", async () => {
    /*
     * There is nowhere to recover what the card actually said: the checklist
     * payload that produced it is long gone. The canonical name says "this
     * card links to Dwight Gooden, and nobody kept what it printed", and the
     * panel then shows no "As printed" line — which is correct, because we do
     * not know that it printed anything else.
     */
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetTree(t);
    const gooden = await seedGooden(t, sportId);
    const cardId = await seedLegacyCard(t, variantTypeId, [gooden]);

    const result = await armed(() =>
      t.mutation(internal.selectorOptions.backfillPlayerLinks, {
        confirm: "BACKFILL_PLAYER_LINKS",
      }),
    );

    expect(result.filled).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(cardId)))!.playerLinks).toEqual([
      { playerId: gooden, nameOnCard: "Dwight Gooden" },
    ]);
  });

  test("is idempotent — a second pass writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetTree(t);
    const gooden = await seedGooden(t, sportId);
    await seedLegacyCard(t, variantTypeId, [gooden]);

    await armed(() =>
      t.mutation(internal.selectorOptions.backfillPlayerLinks, {
        confirm: "BACKFILL_PLAYER_LINKS",
      }),
    );
    const second = await armed(() =>
      t.mutation(internal.selectorOptions.backfillPlayerLinks, {
        confirm: "BACKFILL_PLAYER_LINKS",
      }),
    );
    expect(second.filled).toBe(0);
  });

  test("never overwrites a link the commit already recorded", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetTree(t);
    const gooden = await seedGooden(t, sportId);
    const cardId = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: "1",
        cardName: "Real",
        playerIds: [gooden],
        playerLinks: [{ playerId: gooden, nameOnCard: "Doc Gooden" }],
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );

    await armed(() =>
      t.mutation(internal.selectorOptions.backfillPlayerLinks, {
        confirm: "BACKFILL_PLAYER_LINKS",
      }),
    );

    expect((await t.run(async (ctx) => ctx.db.get(cardId)))!.playerLinks).toEqual([
      { playerId: gooden, nameOnCard: "Doc Gooden" },
    ]);
  });

  test("refuses when the deployment is not armed", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.selectorOptions.backfillPlayerLinks, {
        confirm: "BACKFILL_PLAYER_LINKS",
      }),
    ).rejects.toThrow(/not armed/);
  });
});
