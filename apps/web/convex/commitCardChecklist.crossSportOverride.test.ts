/**
 * NEO-313 — the commit prelude's cross-sport override surface:
 *
 *   1. Security fix: `addSetSport` must add the SET's sport, walked from
 *      `selectorOptionId`, never the client-supplied `args.sportId`. Before
 *      the fix a caller who sent the wrong (but validly-shaped) `sportId`
 *      could make `commitCardChecklist` attach a player to a sport that has
 *      nothing to do with the set being committed.
 *   2. A player-review row switched to another sport creates its new player
 *      under THAT sport, not the set's.
 *   3. A cross-sport LINK survives the commit: `playerIds` and `playerLinks`
 *      both carry the football-only player onto the baseball card.
 *
 * Fixture shape (tree, `makeCard`, `insertReviewRow`) copied from
 * commitCardChecklist.entityReview.test.ts, which this file sits beside.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const ADMIN_IDENTITY = {
  subject: "admin_cross_sport_commit",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_cross_sport_commit",
  role: "admin",
};

async function seedSport(t: T, value: string): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function seedBaseballSet(t: T) {
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
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    return { sportId, setNameId, variantTypeId };
  });
}

function makeCard(overrides: Partial<{ cardNumber: string; players: string[] }> = {}) {
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

async function insertPlayer(
  t: T,
  opts: { name: string; sportId: Id<"selectorOptions"> },
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name: opts.name,
      nameNormalized: normalizePlayerName(opts.name),
      sportId: opts.sportId,
      lastUpdated: Date.now(),
    }),
  );
}

async function insertLinkRow(
  t: T,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    batchId: string;
    sportId: Id<"selectorOptions">;
    name: string;
    linkedPlayerId: Id<"players">;
    addSetSport?: boolean;
  },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.selectorOptionId,
      batchId: opts.batchId,
      createdByUserId: "user_review_001",
      kind: "player",
      name: opts.name,
      sportId: opts.sportId,
      status: "ready",
      decision: {
        action: "link",
        linkedPlayerId: opts.linkedPlayerId,
        ...(opts.addSetSport ? { addSetSport: true } : {}),
      },
    }),
  );
}

const additionalSports = (t: T, playerId: Id<"players">) =>
  t.run((ctx) =>
    ctx.db
      .query("playerSports")
      .withIndex("by_player_id", (q) => q.eq("playerId", playerId))
      .collect(),
  );

describe("NEO-313: commit's cross-sport override, and its security fix", () => {
  test("addSetSport adds the SET's walked sport, never the client-supplied args.sportId", async () => {
    const t = convexTest(schema, modules);
    const { sportId: baseball, variantTypeId } = await seedBaseballSet(t);
    const football = await seedSport(t, "Football");
    // A bogus-but-validly-shaped sport a malicious or stale client sends as
    // `args.sportId` — nothing to do with the set actually being committed.
    const basketball = await seedSport(t, "Basketball");
    const fields = await insertPlayer(t, { name: "Justin Fields", sportId: football });
    await insertLinkRow(t, {
      selectorOptionId: variantTypeId,
      batchId: "b1",
      sportId: football,
      name: "Justin Fields",
      linkedPlayerId: fields,
      addSetSport: true,
    });

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      // The lie: this does not match the set's real (baseball) ancestry.
      sportId: basketball,
      batchId: "b1",
      cards: [makeCard({ players: ["Justin Fields"] })],
    });

    const memberships = await additionalSports(t, fields);
    expect(memberships.map((m) => m.sportId)).toEqual([baseball]);
    expect(memberships.map((m) => m.sportId)).not.toContain(basketball);
  });

  test("a player-review row switched to another sport creates its NEW player under that sport", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedBaseballSet(t);
    const football = await seedSport(t, "Football");
    await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: variantTypeId,
        batchId: "b1",
        createdByUserId: "user_review_001",
        kind: "player",
        name: "Earl Campbell",
        sportId: football,
        status: "ready",
        decision: { action: "create" },
      }),
    );

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId: (await seedBaseballSet(t)).sportId, // any real baseball-level sport for the SKU check
        batchId: "b1",
        cards: [makeCard({ players: ["Earl Campbell"] })],
      });

    expect(result.createdPlayerIds).toHaveLength(1);
    const created = await t.run((ctx) => ctx.db.get(result.createdPlayerIds[0]));
    expect(created?.sportId).toBe(football);
  });

  test("a cross-sport LINK survives the commit: playerIds and playerLinks both carry the guest", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedBaseballSet(t);
    const football = await seedSport(t, "Football");
    const fields = await insertPlayer(t, { name: "Justin Fields", sportId: football });
    await insertLinkRow(t, {
      selectorOptionId: variantTypeId,
      batchId: "b1",
      sportId: football,
      name: "Justin Fields",
      linkedPlayerId: fields,
    });

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId: (await seedBaseballSet(t)).sportId,
      batchId: "b1",
      cards: [makeCard({ players: ["Justin Fields"] })],
    });

    const cards = await t.run((ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].playerIds).toEqual([fields]);
    expect(cards[0].playerLinks).toEqual([
      { playerId: fields, nameOnCard: "Justin Fields" },
    ]);
  });

  test("a cross-sport guest keeps playerIds and playerLinks as one list, same order", async () => {
    // Same invariant `cardPlayerLinks.test.ts` pins generally, specifically for
    // a CROSS-SPORT guest — the shape most likely to be special-cased by an
    // incomplete fix ("guests don't get a printed-name link").
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedBaseballSet(t);
    const football = await seedSport(t, "Football");
    const fields = await insertPlayer(t, { name: "Justin Fields", sportId: football });
    await insertLinkRow(t, {
      selectorOptionId: variantTypeId,
      batchId: "b1",
      sportId: football,
      name: "Justin Fields",
      linkedPlayerId: fields,
    });

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId: (await seedBaseballSet(t)).sportId,
      batchId: "b1",
      cards: [makeCard({ players: ["Justin Fields"] })],
    });

    const [card] = await t.run((ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    expect(card.playerLinks?.map((l) => l.playerId)).toEqual(card.playerIds);
  });
});
