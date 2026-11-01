/**
 * NEO-313 — behavioural coverage for `cardPlayerLinks.ts`: `planCardPlayerLinks`
 * (the pure diff), `cardsForPlayer` (the reader it exists for), and the
 * backfill's dry-run-vs-armed contract.
 *
 * `cardPlayerLinks.pin.test.ts` already pins that exactly one module writes
 * the table; this file is the missing behavioural half, the same split
 * `cardPlayerLinks.test.ts` and `cardChecklist.playerLinksPin.test.ts` use for
 * `playerLinks`.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { planCardPlayerLinks } from "./cardPlayerLinks";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const ADMIN_IDENTITY = {
  subject: "admin_card_player_links",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_card_player_links",
  role: "admin",
};

async function seedTree(t: T) {
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

async function insertPlayer(t: T, name: string, sportId: Id<"selectorOptions">) {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

// ===========================================================================
// planCardPlayerLinks — the pure diff
// ===========================================================================

describe("planCardPlayerLinks", () => {
  const rowId = (n: number) => `row${n}` as unknown as Id<"cardPlayerLinks">;
  const playerId = (n: number) => `player${n}` as unknown as Id<"players">;
  const sportId = "sportA" as unknown as Id<"selectorOptions">;
  const otherSport = "sportB" as unknown as Id<"selectorOptions">;

  test("no existing rows, some players: inserts every one, deletes nothing", () => {
    const plan = planCardPlayerLinks([], [playerId(1), playerId(2)], sportId);
    expect(plan.toDelete).toEqual([]);
    expect(new Set(plan.toInsert)).toEqual(new Set([playerId(1), playerId(2)]));
  });

  test("a duplicate playerId on the card yields exactly ONE insert", () => {
    const plan = planCardPlayerLinks([], [playerId(1), playerId(1)], sportId);
    expect(plan.toInsert).toEqual([playerId(1)]);
  });

  test("a matching existing row is held — no delete, no insert", () => {
    const existing = [{ _id: rowId(1), playerId: playerId(1), sportId }];
    const plan = planCardPlayerLinks(existing, [playerId(1)], sportId);
    expect(plan.toDelete).toEqual([]);
    expect(plan.toInsert).toEqual([]);
  });

  test("a row for the wrong sport is deleted even though the player is still wanted", () => {
    const existing = [{ _id: rowId(1), playerId: playerId(1), sportId: otherSport }];
    const plan = planCardPlayerLinks(existing, [playerId(1)], sportId);
    expect(plan.toDelete).toEqual([rowId(1)]);
    expect(plan.toInsert).toEqual([playerId(1)]);
  });

  test("a row no longer in playerIds is deleted", () => {
    const existing = [{ _id: rowId(1), playerId: playerId(1), sportId }];
    const plan = planCardPlayerLinks(existing, [], sportId);
    expect(plan.toDelete).toEqual([rowId(1)]);
    expect(plan.toInsert).toEqual([]);
  });

  test("a duplicate existing row for the same player is deleted down to one", () => {
    const existing = [
      { _id: rowId(1), playerId: playerId(1), sportId },
      { _id: rowId(2), playerId: playerId(1), sportId },
    ];
    const plan = planCardPlayerLinks(existing, [playerId(1)], sportId);
    expect(plan.toDelete).toEqual([rowId(2)]);
    expect(plan.toInsert).toEqual([]);
  });

  test("no sport (orphaned ancestor chain): every existing row is removed, nothing inserted", () => {
    const existing = [{ _id: rowId(1), playerId: playerId(1), sportId }];
    const plan = planCardPlayerLinks(existing, [playerId(1), playerId(2)], undefined);
    expect(plan.toDelete).toEqual([rowId(1)]);
    expect(plan.toInsert).toEqual([]);
  });
});

// ===========================================================================
// cardsForPlayer — the reader
// ===========================================================================

describe("cardsForPlayer", () => {
  test("finds a card via the index, with the card's sport and a breadcrumb", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const gooden = await insertPlayer(t, "Dwight Gooden", sportId);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "1",
      cardName: "Gooden",
      playerIds: [gooden],
    });

    const cards = await asAdmin.query(api.players.cardsForPlayer, { playerId: gooden });
    expect(cards).toEqual([
      expect.objectContaining({
        cardId,
        cardNumber: "1",
        sportId,
        sportValue: "Baseball",
        setLabel: "Topps · Base",
      }),
    ]);
  });

  test("a card the player was removed from no longer appears", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const gooden = await insertPlayer(t, "Dwight Gooden", sportId);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "1",
      cardName: "Gooden",
      playerIds: [gooden],
    });
    await asAdmin.mutation(api.selectorOptions.updateCard, { id: cardId, playerIds: [] });

    expect(await asAdmin.query(api.players.cardsForPlayer, { playerId: gooden })).toEqual([]);
  });
});

// ===========================================================================
// The backfill — dry run vs armed
// ===========================================================================

describe("backfillCardPlayerLinks", () => {
  async function seedLegacyCard(
    t: T,
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

  function armed<Res>(run: () => Promise<Res>): Promise<Res> {
    process.env.ALLOW_CARD_PLAYER_LINKS_BACKFILL = "1";
    return run().finally(() => {
      delete process.env.ALLOW_CARD_PLAYER_LINKS_BACKFILL;
    });
  }

  test("a dry run reports the plan and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const gooden = await insertPlayer(t, "Dwight Gooden", sportId);
    await seedLegacyCard(t, variantTypeId, [gooden]);

    const result = await t.action(internal.cardPlayerLinks.backfillCardPlayerLinks, {});
    expect(result.armed).toBe(false);
    expect(result.cardsChanged).toBe(1);
    expect(result.rowsInserted).toBe(1);

    const rows = await t.run((ctx) => ctx.db.query("cardPlayerLinks").collect());
    expect(rows).toEqual([]);
  });

  test("refuses to apply on an unarmed deployment even with the confirm token", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const gooden = await insertPlayer(t, "Dwight Gooden", sportId);
    await seedLegacyCard(t, variantTypeId, [gooden]);

    const result = await t.action(internal.cardPlayerLinks.backfillCardPlayerLinks, {
      confirm: "BACKFILL",
    });
    expect(result.armed).toBe(false);
    expect(result.message).toMatch(/not armed/);

    const rows = await t.run((ctx) => ctx.db.query("cardPlayerLinks").collect());
    expect(rows).toEqual([]);
  });

  test("an armed run with the confirm token writes the missing rows and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const gooden = await insertPlayer(t, "Dwight Gooden", sportId);
    const cardId = await seedLegacyCard(t, variantTypeId, [gooden]);

    const first = await armed(() =>
      t.action(internal.cardPlayerLinks.backfillCardPlayerLinks, { confirm: "BACKFILL" }),
    );
    expect(first.armed).toBe(true);
    expect(first.rowsInserted).toBe(1);

    const rows = await t.run((ctx) => ctx.db.query("cardPlayerLinks").collect());
    expect(rows).toEqual([
      expect.objectContaining({ cardChecklistId: cardId, playerId: gooden, sportId }),
    ]);

    const second = await armed(() =>
      t.action(internal.cardPlayerLinks.backfillCardPlayerLinks, { confirm: "BACKFILL" }),
    );
    expect(second.cardsChanged).toBe(0);
    expect(second.rowsInserted).toBe(0);
  });
});
