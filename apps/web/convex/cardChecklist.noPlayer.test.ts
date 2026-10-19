/**
 * NEO-339 — the operator side of "this card shows no player":
 * `cardChecklist.confirmCardNoPlayer`, the two writers that retire its stamp
 * (`selectorOptions.updateCard` on a non-empty `playerIds`), and
 * `getCardChecklist`'s strict returns validator carrying it to the client,
 * where `deriveCardAttention` reads it.
 *
 * The twin of cardChecklist.noTeam.test.ts, on the same fixture shape (a raw
 * sport → setName → variantType tree and direct `ctx.db.insert` rows).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { normalizePlayerName } from "./players";
import { deriveCardAttention } from "./features/cardAttention";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_no_player_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_no_player_001",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "user_no_player_002",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_no_player_002",
};

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

async function insertCard(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  opts: {
    playerIds?: Array<Id<"players">>;
    pendingPlayerNames?: string[];
    playerNoneConfirmedAt?: number;
    playerNoneConfirmedByUserId?: string;
  } = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber: "660",
      cardName: "Seattle Mariners Team Card",
      platformData: {},
      sortOrder: 0,
      lastUpdated: 1_700_000_000_000,
      ...(opts.playerIds
        ? {
            playerIds: opts.playerIds,
            playerLinks: opts.playerIds.map((playerId) => ({ playerId, nameOnCard: "Someone" })),
          }
        : {}),
      ...(opts.pendingPlayerNames ? { pendingPlayerNames: opts.pendingPlayerNames } : {}),
      ...(opts.playerNoneConfirmedAt !== undefined
        ? { playerNoneConfirmedAt: opts.playerNoneConfirmedAt }
        : {}),
      ...(opts.playerNoneConfirmedByUserId !== undefined
        ? { playerNoneConfirmedByUserId: opts.playerNoneConfirmedByUserId }
        : {}),
    }),
  );
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
      teamYears: [],
      lastUpdated: Date.now(),
    }),
  );
}

const getCard = (t: ReturnType<typeof convexTest>, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => ctx.db.get(id));

describe("confirmCardNoPlayer", () => {
  test("stamps playerNoneConfirmedAt and the caller's user id SERVER-side, and the card stops needing a player", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);
    expect(deriveCardAttention((await getCard(t, cardId))!).map((i) => i.kind)).toContain("missingPlayer");

    const before = Date.now();
    const result = await asAdmin.mutation(api.cardChecklist.confirmCardNoPlayer, { cardId });
    expect(result).toEqual({ confirmed: true, stamped: true });

    const row = await getCard(t, cardId);
    expect(row!.playerNoneConfirmedAt).toBeGreaterThanOrEqual(before);
    expect(row!.playerNoneConfirmedByUserId).toBe(ADMIN_IDENTITY.subject);
    expect(deriveCardAttention(row!).map((i) => i.kind)).not.toContain("missingPlayer");
  });

  test("takes no timestamp or user argument at all", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    await expect(
      asAdmin.mutation(api.cardChecklist.confirmCardNoPlayer, {
        cardId,
        playerNoneConfirmedAt: 1,
      } as never),
    ).rejects.toThrow();
    await expect(
      asAdmin.mutation(api.cardChecklist.confirmCardNoPlayer, {
        cardId,
        playerNoneConfirmedByUserId: "someone_else",
      } as never),
    ).rejects.toThrow();
    expect((await getCard(t, cardId))!.playerNoneConfirmedAt).toBeUndefined();
  });

  test("refuses a card that links a player, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const playerId = await insertPlayer(t, sportId, "Ken Griffey Jr.");
    const cardId = await insertCard(t, leafId, { playerIds: [playerId] });

    const result = await asAdmin.mutation(api.cardChecklist.confirmCardNoPlayer, { cardId });
    expect(result).toEqual({ confirmed: false, stamped: false });
    const row = await getCard(t, cardId);
    expect(row!.playerNoneConfirmedAt).toBeUndefined();
    expect(row!.playerIds).toEqual([playerId]);
  });

  test("refuses a card that names a player it does not link (a typed name), and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId, { pendingPlayerNames: ["Ichiro"] });

    const result = await asAdmin.mutation(api.cardChecklist.confirmCardNoPlayer, { cardId });
    expect(result).toEqual({ confirmed: false, stamped: false });
    expect((await getCard(t, cardId))!.playerNoneConfirmedAt).toBeUndefined();
  });

  test("a card that is gone is refused, not thrown", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);
    await t.run(async (ctx) => ctx.db.delete(cardId));

    await expect(
      asAdmin.mutation(api.cardChecklist.confirmCardNoPlayer, { cardId }),
    ).resolves.toEqual({ confirmed: false, stamped: false });
  });

  test("is idempotent: a second call writes nothing and keeps the first stamp", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId, {
      playerNoneConfirmedAt: 1_700_000_000_000,
      playerNoneConfirmedByUserId: "admin_first",
    });

    const second = await asAdmin.mutation(api.cardChecklist.confirmCardNoPlayer, { cardId });
    expect(second).toEqual({ confirmed: true, stamped: false });
    const row = await getCard(t, cardId);
    expect(row!.playerNoneConfirmedAt).toBe(1_700_000_000_000);
    expect(row!.playerNoneConfirmedByUserId).toBe("admin_first");
  });

  test("does not touch lastUpdated", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    await asAdmin.mutation(api.cardChecklist.confirmCardNoPlayer, { cardId });
    expect((await getCard(t, cardId))!.lastUpdated).toBe(1_700_000_000_000);
  });

  test("is admin-gated", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    await expect(
      t.withIdentity(NON_ADMIN_IDENTITY).mutation(api.cardChecklist.confirmCardNoPlayer, { cardId }),
    ).rejects.toThrow(/Admin access required/);
    await expect(
      t.mutation(api.cardChecklist.confirmCardNoPlayer, { cardId }),
    ).rejects.toThrow(/Not authenticated/);
    expect((await getCard(t, cardId))!.playerNoneConfirmedAt).toBeUndefined();
  });
});

describe("updateCard and the no-player confirmation", () => {
  test("writing a NON-EMPTY playerIds clears the stamp in the same patch", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, leafId } = await seedTree(t);
    const playerId = await insertPlayer(t, sportId, "Ichiro Suzuki");
    const cardId = await insertCard(t, leafId, {
      playerNoneConfirmedAt: 1_700_000_000_000,
      playerNoneConfirmedByUserId: "admin_someone_else",
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, { id: cardId, playerIds: [playerId] });

    const row = await getCard(t, cardId);
    expect(row!.playerIds).toEqual([playerId]);
    expect(row!.playerNoneConfirmedAt).toBeUndefined();
    expect(row!.playerNoneConfirmedByUserId).toBeUndefined();
  });

  test("writing an EMPTY playerIds leaves the stamp standing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId, { playerNoneConfirmedAt: 1_700_000_000_000 });

    await asAdmin.mutation(api.selectorOptions.updateCard, { id: cardId, playerIds: [] });
    expect((await getCard(t, cardId))!.playerNoneConfirmedAt).toBe(1_700_000_000_000);
  });

  test("an edit that does not mention players leaves the stamp standing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId, { playerNoneConfirmedAt: 1_700_000_000_000 });

    await asAdmin.mutation(api.selectorOptions.updateCard, { id: cardId, cardName: "Mariners Team" });
    const row = await getCard(t, cardId);
    expect(row!.cardName).toBe("Mariners Team");
    expect(row!.playerNoneConfirmedAt).toBe(1_700_000_000_000);
  });

  test("updateCard does not accept the stamp as an argument", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    const cardId = await insertCard(t, leafId);

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        playerNoneConfirmedAt: 1,
      } as never),
    ).rejects.toThrow();
    expect((await getCard(t, cardId))!.playerNoneConfirmedAt).toBeUndefined();
  });
});

describe("getCardChecklist returns validator", () => {
  test("a no-player row round-trips, and playerNoneConfirmedAt reaches the client", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { leafId } = await seedTree(t);
    await insertCard(t, leafId, {
      playerNoneConfirmedAt: 1_700_000_000_000,
      playerNoneConfirmedByUserId: ADMIN_IDENTITY.subject,
    });

    // Strict `returns`: a column the table carries and the validator omits
    // throws `Object contains extra field` for every row that has it.
    const rows = await asAdmin.query(api.selectorOptions.getCardChecklist, { selectorOptionId: leafId });
    expect(rows).toHaveLength(1);
    expect(rows[0].playerNoneConfirmedAt).toBe(1_700_000_000_000);
    expect(deriveCardAttention(rows[0]).map((i) => i.kind)).not.toContain("missingPlayer");
  });
});
