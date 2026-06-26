/**
 * NEO-24 Stage 2: unit tests for the feature propagation engine.
 *
 * Covers `setSelectorOptionFeature`, `setCardFeature`, and the
 * `commitCardChecklist` ancestor-feature inheritance merge.
 *
 * Test matrix:
 *  - Set at sport level → cards under multiple sets all inherit
 *  - Cards with explicit overrides don't change
 *  - Re-set same value → no-op idempotency (counts surface zero changes)
 *  - Change value: cards still matching the old value follow; overridden don't
 *  - commitCardChecklist merges ancestor features into new card
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

// ---------------------------------------------------------------------------
// Auth identities
// ---------------------------------------------------------------------------

const ADMIN_IDENTITY = {
  subject: "admin_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_001",
  name: "Admin User",
  role: "admin",
};

// ---------------------------------------------------------------------------
// Builder: seed a sport → setName → variantType subtree with cards under
// the variantType. Returns every id the test will need.
// ---------------------------------------------------------------------------

type SubtreeIds = {
  sportId: Id<"selectorOptions">;
  setNameId: Id<"selectorOptions">;
  variantTypeId: Id<"selectorOptions">;
  cardIds: Array<Id<"cardChecklist">>;
};

async function seedSubtree(
  t: ReturnType<typeof convexTest>,
  opts?: { cardFeaturesPerIndex?: Record<number, Record<string, string>> },
): Promise<SubtreeIds> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: "bsc-baseball", sportlots: "sl-baseball" },
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: { bsc: "bsc-2024-topps", sportlots: "sl-2024-topps" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: "bsc-2024-topps-base", sportlots: "sl-base" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });

    const cardIds: Array<Id<"cardChecklist">> = [];
    for (let i = 0; i < 3; i++) {
      const features = opts?.cardFeaturesPerIndex?.[i];
      const id = await ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: String(i + 1),
        cardName: `Card ${i + 1}`,
        platformData: {},
        sortOrder: i,
        lastUpdated: Date.now(),
        ...(features ? { features } : {}),
      });
      cardIds.push(id);
    }

    return { sportId, setNameId, variantTypeId, cardIds };
  });
}

// Builder: add a second setName + variantType under the same sport, with a
// few of its own cards. Used to confirm cross-set propagation when setting a
// feature at the sport root.
async function addSecondSet(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
): Promise<{
  setNameId: Id<"selectorOptions">;
  variantTypeId: Id<"selectorOptions">;
  cardIds: Array<Id<"cardChecklist">>;
}> {
  return t.run(async (ctx) => {
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps Chrome",
      platformData: { bsc: "bsc-2024-topps-chrome", sportlots: "sl-chrome" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: "bsc-chrome-base", sportlots: "sl-chrome-base" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });

    const sport = await ctx.db.get(sportId);
    const existingChildren = sport?.children ?? [];
    await ctx.db.patch(sportId, {
      children: [...existingChildren, setNameId],
    });

    const cardIds: Array<Id<"cardChecklist">> = [];
    for (let i = 0; i < 2; i++) {
      const id = await ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: `C${i + 1}`,
        cardName: `Chrome ${i + 1}`,
        platformData: {},
        sortOrder: i,
        lastUpdated: Date.now(),
      });
      cardIds.push(id);
    }

    return { setNameId, variantTypeId, cardIds };
  });
}

// ===========================================================================
// setSelectorOptionFeature: propagation
// ===========================================================================

describe("setSelectorOptionFeature", () => {
  test("propagates a sport-level feature to cards under multiple sets", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const subtree = await seedSubtree(t);
    const second = await addSecondSet(t, subtree.sportId);

    const result = await asAdmin.mutation(
      api.selectorOptions.setSelectorOptionFeature,
      { selectorOptionId: subtree.sportId, key: "league", value: "MLB" },
    );

    // 3 cards under the first set + 2 under the second = 5.
    expect(result.propagatedToCardCount).toBe(5);
    expect(result.skippedAsOverridden).toBe(0);

    // Verify every card has league=MLB.
    const everyCard = [...subtree.cardIds, ...second.cardIds];
    for (const id of everyCard) {
      const card = await t.run(async (ctx) => ctx.db.get(id));
      expect(card!.features?.league).toBe("MLB");
    }

    // Root row also has league=MLB.
    const root = await t.run(async (ctx) => ctx.db.get(subtree.sportId));
    expect(root!.features?.league).toBe("MLB");
  });

  test("leaves cards with explicit overrides untouched and counts them", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Pre-override one card's `league` to "NPB" (Japanese league override).
    const subtree = await seedSubtree(t, {
      cardFeaturesPerIndex: { 1: { league: "NPB" } },
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.setSelectorOptionFeature,
      { selectorOptionId: subtree.sportId, key: "league", value: "MLB" },
    );

    expect(result.propagatedToCardCount).toBe(2); // cards 0 and 2
    expect(result.skippedAsOverridden).toBe(1);   // card 1

    const card0 = await t.run(async (ctx) => ctx.db.get(subtree.cardIds[0]));
    const card1 = await t.run(async (ctx) => ctx.db.get(subtree.cardIds[1]));
    const card2 = await t.run(async (ctx) => ctx.db.get(subtree.cardIds[2]));

    expect(card0!.features?.league).toBe("MLB");
    expect(card1!.features?.league).toBe("NPB"); // override preserved
    expect(card2!.features?.league).toBe("MLB");
  });

  test("re-setting the same value is a no-op (idempotent counts)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const subtree = await seedSubtree(t);

    // First write: 3 cards get league=MLB.
    const first = await asAdmin.mutation(
      api.selectorOptions.setSelectorOptionFeature,
      { selectorOptionId: subtree.sportId, key: "league", value: "MLB" },
    );
    expect(first.propagatedToCardCount).toBe(3);

    // Second write of the same value: cards already match -> neither
    // propagated (already equal) nor skipped-as-overridden.
    const second = await asAdmin.mutation(
      api.selectorOptions.setSelectorOptionFeature,
      { selectorOptionId: subtree.sportId, key: "league", value: "MLB" },
    );
    expect(second.propagatedToCardCount).toBe(0);
    expect(second.skippedAsOverridden).toBe(0);
  });

  test("changing value: cards matching old value follow; overridden don't", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const subtree = await seedSubtree(t);

    // Initial set: 3 cards get league=MLB.
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: subtree.sportId,
      key: "league",
      value: "MLB",
    });

    // Now operator overrides card 1 to MiLB on its own.
    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: subtree.cardIds[1],
      key: "league",
      value: "MiLB",
    });

    // Change set-level value to "MLB-International". Cards 0 and 2 still
    // match the OLD value ("MLB") so they follow; card 1 differs from both
    // undefined and the OLD value ("MLB"), so it's now an override and
    // counted as skipped.
    const result = await asAdmin.mutation(
      api.selectorOptions.setSelectorOptionFeature,
      {
        selectorOptionId: subtree.sportId,
        key: "league",
        value: "MLB-International",
      },
    );
    expect(result.propagatedToCardCount).toBe(2);
    expect(result.skippedAsOverridden).toBe(1);

    const card0 = await t.run(async (ctx) => ctx.db.get(subtree.cardIds[0]));
    const card1 = await t.run(async (ctx) => ctx.db.get(subtree.cardIds[1]));
    const card2 = await t.run(async (ctx) => ctx.db.get(subtree.cardIds[2]));

    expect(card0!.features?.league).toBe("MLB-International");
    expect(card1!.features?.league).toBe("MiLB");
    expect(card2!.features?.league).toBe("MLB-International");
  });

  // -------------------------------------------------------------------------
  // NEO-38: materialized inheritance — descendant NODES (not just cards).
  // -------------------------------------------------------------------------
  test("materializes onto intermediate descendant NODES and cards", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const subtree = await seedSubtree(t);

    const result = await asAdmin.mutation(
      api.selectorOptions.setSelectorOptionFeature,
      { selectorOptionId: subtree.sportId, key: "league", value: "MLB" },
    );

    // Two descendant nodes (setName + variantType) get the value written
    // through; 3 cards under the variantType also get it.
    expect(result.propagatedToNodeCount).toBe(2);
    expect(result.propagatedToCardCount).toBe(3);
    expect(result.skippedAsOverridden).toBe(0);

    // Read the intermediate NODES back and confirm the value materialized.
    const setNameNode = await t.run(async (ctx) =>
      ctx.db.get(subtree.setNameId),
    );
    const variantTypeNode = await t.run(async (ctx) =>
      ctx.db.get(subtree.variantTypeId),
    );
    expect(setNameNode!.features?.league).toBe("MLB");
    expect(variantTypeNode!.features?.league).toBe("MLB");

    // Root node too.
    const root = await t.run(async (ctx) => ctx.db.get(subtree.sportId));
    expect(root!.features?.league).toBe("MLB");
  });

  test("intermediate node with its own override is skipped (node + its cards)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const subtree = await seedSubtree(t);
    // Give the variantType node its own override value BEFORE the sport-level
    // set. The materialized model means this node — and the cards under it —
    // already hold a value that differs from both undefined and the (still
    // undefined) sport-level old value, so the sport-level write must skip it.
    await t.run(async (ctx) => {
      await ctx.db.patch(subtree.variantTypeId, {
        features: { league: "NPB" },
        lastUpdated: Date.now(),
      });
      // Materialize that override onto the cards under it too, mirroring how
      // a real setSelectorOptionFeature at the variantType level would have.
      for (const cardId of subtree.cardIds) {
        await ctx.db.patch(cardId, {
          features: { league: "NPB" },
          lastUpdated: Date.now(),
        });
      }
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.setSelectorOptionFeature,
      { selectorOptionId: subtree.sportId, key: "league", value: "MLB" },
    );

    // setName node (no value) gets MLB → 1 node propagated.
    // variantType node already holds "NPB" → skipped.
    // 3 cards already hold "NPB" → skipped.
    expect(result.propagatedToNodeCount).toBe(1);
    expect(result.propagatedToCardCount).toBe(0);
    expect(result.skippedAsOverridden).toBe(4); // variantType node + 3 cards

    const setNameNode = await t.run(async (ctx) =>
      ctx.db.get(subtree.setNameId),
    );
    const variantTypeNode = await t.run(async (ctx) =>
      ctx.db.get(subtree.variantTypeId),
    );
    expect(setNameNode!.features?.league).toBe("MLB"); // materialized
    expect(variantTypeNode!.features?.league).toBe("NPB"); // override preserved

    for (const cardId of subtree.cardIds) {
      const card = await t.run(async (ctx) => ctx.db.get(cardId));
      expect(card!.features?.league).toBe("NPB"); // override preserved
    }
  });

  test("idempotent re-set is a no-op across nodes and cards", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const subtree = await seedSubtree(t);

    // First write materializes nodes + cards.
    const first = await asAdmin.mutation(
      api.selectorOptions.setSelectorOptionFeature,
      { selectorOptionId: subtree.sportId, key: "league", value: "MLB" },
    );
    expect(first.propagatedToNodeCount).toBe(2);
    expect(first.propagatedToCardCount).toBe(3);

    // Second write of the same value: every node + card already matches, so
    // nothing is propagated and nothing is counted as overridden.
    const second = await asAdmin.mutation(
      api.selectorOptions.setSelectorOptionFeature,
      { selectorOptionId: subtree.sportId, key: "league", value: "MLB" },
    );
    expect(second.propagatedToNodeCount).toBe(0);
    expect(second.propagatedToCardCount).toBe(0);
    expect(second.skippedAsOverridden).toBe(0);
  });
});

// ===========================================================================
// commitCardChecklist inheritance merge
// ===========================================================================

describe("commitCardChecklist (ancestor feature inheritance)", () => {
  test("new cards inherit merged ancestor features (deeper overrides shallower)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Seed a subtree but no cards yet — commitCardChecklist will insert them.
    const subtreeIds = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: { bsc: "bsc-baseball", sportlots: "sl-baseball" },
        features: { league: "MLB", era: "Modern" },
        children: [],
        lastUpdated: Date.now(),
      });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "2024 Topps",
        platformData: { bsc: "bsc-2024-topps", sportlots: "sl-2024-topps" },
        // Override era at the set level — deeper ancestors win. `subsetLabel`
        // is a non-heuristic key the seed won't touch, so it flows through
        // untouched to the card (NEO-38: `cardType` is now seeded by the
        // heuristic at the variantType leaf, which is deeper than setName, so
        // a setName-level cardType would be shadowed — see explicit assertion
        // below).
        features: { era: "Modern-2020s", subsetLabel: "Flagship" },
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(sportId, { children: [setNameId] });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: "bsc-base", sportlots: "sl-base" },
        parentId: setNameId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(setNameId, { children: [variantTypeId] });
      return { sportId, setNameId, variantTypeId };
    });

    // Commit two preview cards via the public mutation.
    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: subtreeIds.variantTypeId,
      sport: "Baseball",
      cards: [
        {
          cardNumber: "1",
          cardName: "Mike Trout",
          team: undefined,
          teams: [],
          players: ["Mike Trout"],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: "bsc-card-1" },
          sourcePlatformIds: undefined,
          unmatched: undefined,
        },
        {
          cardNumber: "2",
          cardName: "Aaron Judge",
          team: undefined,
          teams: [],
          players: ["Aaron Judge"],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: "bsc-card-2" },
          sourcePlatformIds: undefined,
          unmatched: undefined,
        },
      ],
      // Confirm names so commitCardChecklist actually creates the player
      // rows and resolves them — exercises the realistic write path.
      confirmedNewPlayers: ["Mike Trout", "Aaron Judge"],
      confirmedNewTeams: [],
    });

    const cards = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", subtreeIds.variantTypeId),
        )
        .collect(),
    );

    expect(cards).toHaveLength(2);
    for (const card of cards) {
      // sport-level `league=MLB` survives (fill-absent heuristic didn't
      // overwrite the operator's existing sport value).
      expect(card.features?.league).toBe("MLB");
      // set-level `era` overrides sport-level (deeper ancestor wins).
      expect(card.features?.era).toBe("Modern-2020s");
      // set-level non-heuristic key flows through untouched.
      expect(card.features?.subsetLabel).toBe("Flagship");
      // NEO-38: the heuristic seeds `cardType` at the variantType LEAF node
      // (fill-absent), and the card inherits it via materialization — even
      // though no operator set cardType anywhere.
      expect(card.features?.cardType).toBe("Base");
      // NEO-38: `isReprint` is seeded at the setName node by the heuristic and
      // flows down to the card.
      expect(card.features?.isReprint).toBe("false");
    }

    // NEO-38: confirm the heuristic materialized onto the NODES (not just the
    // cards) — cardType on the leaf, isReprint on the setName.
    const variantNode = await t.run(async (ctx) =>
      ctx.db.get(subtreeIds.variantTypeId),
    );
    const setNameNode = await t.run(async (ctx) =>
      ctx.db.get(subtreeIds.setNameId),
    );
    expect(variantNode!.features?.cardType).toBe("Base");
    expect(setNameNode!.features?.isReprint).toBe("false");
  });

  // -------------------------------------------------------------------------
  // NEO-38 — heuristic seeded at NODE level (fill-absent), cards inherit via
  // materialization; pre-existing operator node values are not overwritten.
  // -------------------------------------------------------------------------
  test("commit seeds the heuristic onto originating nodes (fill-absent) and cards inherit it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Full chain sport→year→manufacturer→setName→variantType. The
    // manufacturer node carries an operator override so we can prove the
    // heuristic seed is fill-absent (won't clobber it).
    const ids = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport" as const,
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      });
      const yearId = await ctx.db.insert("selectorOptions", {
        level: "year" as const,
        value: "1975",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(sportId, { children: [yearId] });
      const mfrId = await ctx.db.insert("selectorOptions", {
        level: "manufacturer" as const,
        value: "Topps",
        platformData: {},
        // Operator already corrected manufacturer at this node — the
        // fill-absent heuristic seed must NOT overwrite it.
        features: { manufacturer: "Topps (Operator)" },
        parentId: yearId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(yearId, { children: [mfrId] });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName" as const,
        value: "1975 Topps",
        platformData: {},
        parentId: mfrId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(mfrId, { children: [setNameId] });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType" as const,
        value: "Base",
        platformData: {},
        parentId: setNameId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(setNameId, { children: [variantTypeId] });
      return { sportId, yearId, mfrId, setNameId, variantTypeId };
    });

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: ids.variantTypeId,
      sport: "Baseball",
      cards: [
        {
          cardNumber: "1",
          cardName: "George Brett",
          team: undefined,
          teams: [],
          players: ["George Brett"],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: "bsc-1" },
          sourcePlatformIds: undefined,
          unmatched: undefined,
        },
      ],
      confirmedNewPlayers: ["George Brett"],
      confirmedNewTeams: [],
    });

    // --- Heuristic landed on the ORIGINATING nodes (fill-absent). ---
    const sportNode = await t.run(async (ctx) => ctx.db.get(ids.sportId));
    const yearNode = await t.run(async (ctx) => ctx.db.get(ids.yearId));
    const mfrNode = await t.run(async (ctx) => ctx.db.get(ids.mfrId));
    const setNameNode = await t.run(async (ctx) => ctx.db.get(ids.setNameId));
    const variantNode = await t.run(async (ctx) =>
      ctx.db.get(ids.variantTypeId),
    );

    expect(sportNode!.features?.league).toBe("MLB"); // sport node
    expect(yearNode!.features?.era).toBe("Vintage (1970-79)"); // year node
    expect(yearNode!.features?.vintage).toBe("true"); // year node, ≤1979
    expect(variantNode!.features?.cardType).toBe("Base"); // leaf node
    expect(setNameNode!.features?.isReprint).toBe("false"); // setName node

    // --- Fill-absent: the operator's manufacturer override is preserved. ---
    expect(mfrNode!.features?.manufacturer).toBe("Topps (Operator)");

    // --- The card inherited the materialized node features. ---
    const cards = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", ids.variantTypeId),
        )
        .collect(),
    );
    expect(cards).toHaveLength(1);
    const f = cards[0].features ?? {};
    expect(f.league).toBe("MLB");
    expect(f.era).toBe("Vintage (1970-79)");
    expect(f.vintage).toBe("true");
    expect(f.cardType).toBe("Base");
    expect(f.isReprint).toBe("false");
    // The operator manufacturer override materialized down to the card too.
    expect(f.manufacturer).toBe("Topps (Operator)");
  });

  // -------------------------------------------------------------------------
  // NEO-24 Stage 3b — per-card feature derivation from BSC/SL adapter fields
  // -------------------------------------------------------------------------
  test("per-card derived features (signedBy, parallelName, isRookie, isRelic) land on insert", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const subtreeIds = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        features: { league: "MLB" }, // inherited; should still survive merge
        children: [],
        lastUpdated: Date.now(),
      });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "2024 Topps Chrome",
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

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: subtreeIds.variantTypeId,
      sport: "Baseball",
      cards: [
        // Card 1: rookie, signed, gold parallel
        {
          cardNumber: "1",
          cardName: "Mike Trout",
          team: undefined,
          teams: [],
          players: ["Mike Trout"],
          attributes: ["RC", "AU"],
          isRookie: true,
          isRelic: false,
          printRun: 99,
          autographType: "On-Card",
          cardVariation: "Gold",
          platformData: { bsc: "bsc-1" },
          sourcePlatformIds: undefined,
          unmatched: undefined,
        },
        // Card 2: relic, no auto, no variation
        {
          cardNumber: "2",
          cardName: "Aaron Judge",
          team: undefined,
          teams: [],
          players: ["Aaron Judge"],
          attributes: ["RELIC"],
          isRookie: false,
          isRelic: true,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: "bsc-2" },
          sourcePlatformIds: undefined,
          unmatched: undefined,
        },
      ],
      confirmedNewPlayers: ["Mike Trout", "Aaron Judge"],
      confirmedNewTeams: [],
    });

    const cards = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", subtreeIds.variantTypeId),
        )
        .collect(),
    );

    const byNumber = new Map(cards.map((c) => [c.cardNumber, c]));
    const c1 = byNumber.get("1")!;
    const c2 = byNumber.get("2")!;

    // Inherited from sport.
    expect(c1.features?.league).toBe("MLB");
    expect(c2.features?.league).toBe("MLB");

    // Derived from per-card columns.
    expect(c1.features?.isRookie).toBe("true");
    expect(c1.features?.signedBy).toBe("On-Card");
    expect(c1.features?.parallelName).toBe("Gold");
    expect(c1.features?.isRelic).toBeUndefined();

    expect(c2.features?.isRelic).toBe("true");
    expect(c2.features?.isRookie).toBeUndefined();
    expect(c2.features?.signedBy).toBeUndefined();
    expect(c2.features?.parallelName).toBeUndefined();
  });

  test("set-level totalCardCount + lastSyncedAt land on the setName ancestor after commit", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const subtreeIds = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "2024 Topps Chrome",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(sportId, { children: [setNameId] });
      // Commit AT the setName level so totalCardCount is taken as-is.
      return { sportId, setNameId };
    });

    const before = Date.now();
    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: subtreeIds.setNameId,
      sport: "Baseball",
      cards: [
        {
          cardNumber: "1",
          cardName: "A",
          team: undefined,
          teams: [],
          players: ["A"],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: {},
          sourcePlatformIds: undefined,
          unmatched: undefined,
        },
        {
          cardNumber: "2",
          cardName: "B",
          team: undefined,
          teams: [],
          players: ["B"],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: {},
          sourcePlatformIds: undefined,
          unmatched: undefined,
        },
        {
          cardNumber: "3",
          cardName: "C",
          team: undefined,
          teams: [],
          players: ["C"],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: {},
          sourcePlatformIds: undefined,
          unmatched: undefined,
        },
      ],
      confirmedNewPlayers: ["A", "B", "C"],
      confirmedNewTeams: [],
    });

    const row = await asAdmin.query(
      api.selectorOptions.getSelectorOptionById,
      { id: subtreeIds.setNameId },
    );
    expect(row).not.toBeNull();
    expect(row!.setMetadata?.totalCardCount).toBe(3);
    expect(row!.setMetadata?.lastSyncedAt).toBeGreaterThanOrEqual(before);
  });
});
