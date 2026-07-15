/**
 * NEO-24 Stage 2 / NEO-71-74: unit tests for feature persistence.
 *
 * Covers `setSelectorOptionFeature` (single-row patch, NEO-71-74 — no
 * cascade to descendants/cards), `setCardFeature`, and the
 * `commitCardChecklist` card-creation read path (a single leaf-node read,
 * since every selectorOptions row is already a complete, self-contained
 * `features` snapshot from its own creation — see
 * convex/features/deriveCardFeatures.ts's `deriveOwnLevelFeatures` and the
 * copy-down wiring in `storeSelectorOptions`/`addCustomSelectorOption`/
 * `storeReconciledOptions`).
 *
 * Test matrix:
 *  - setSelectorOptionFeature edits ONLY the target row — descendants/cards
 *    that would have matched the OLD fill-absent cascade rule stay untouched
 *  - Existing values are overwritten; other keys on the row are preserved
 *  - validateFeatureValue's era-enum guard still fires
 *  - commitCardChecklist reads the leaf node's complete snapshot for new
 *    cards, with card-observed facts winning over it
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
// the variantType. Returns every id the test will need. Raw inserts here
// deliberately do NOT go through the copy-down write path (that's exercised
// separately in convex/selectorOptions.test.ts) — these fixtures exist to
// test setSelectorOptionFeature's single-row-only behavior in isolation.
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

// ===========================================================================
// setSelectorOptionFeature: single-row patch only (NEO-71-74)
// ===========================================================================

describe("setSelectorOptionFeature", () => {
  test("edits only the target row; descendant nodes and cards are unaffected", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const subtree = await seedSubtree(t);

    const result = await asAdmin.mutation(
      api.selectorOptions.setSelectorOptionFeature,
      { selectorOptionId: subtree.sportId, key: "league", value: "MLB" },
    );
    expect(result).toBeNull();

    const root = await t.run(async (ctx) => ctx.db.get(subtree.sportId));
    expect(root!.features?.league).toBe("MLB");

    // Descendant nodes and cards — even though the OLD cascade would have
    // fill-absent-matched every one of them — must stay untouched.
    const setNameNode = await t.run(async (ctx) =>
      ctx.db.get(subtree.setNameId),
    );
    const variantTypeNode = await t.run(async (ctx) =>
      ctx.db.get(subtree.variantTypeId),
    );
    expect(setNameNode!.features?.league).toBeUndefined();
    expect(variantTypeNode!.features?.league).toBeUndefined();
    for (const id of subtree.cardIds) {
      const card = await t.run(async (ctx) => ctx.db.get(id));
      expect(card!.features?.league).toBeUndefined();
    }
  });

  test("overwrites an existing value on the target row only", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const subtree = await seedSubtree(t);

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: subtree.sportId,
      key: "league",
      value: "MLB",
    });
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: subtree.sportId,
      key: "league",
      value: "MLB-International",
    });

    const root = await t.run(async (ctx) => ctx.db.get(subtree.sportId));
    expect(root!.features?.league).toBe("MLB-International");
  });

  test("a descendant card that independently already holds the same value is not touched by an ancestor edit", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    // Card 0 already has league=MLB from its OWN fixture value (simulating
    // it having been resolved at its own creation, unrelated to the edit
    // below) — the edit must not be the reason it holds that value.
    const subtree = await seedSubtree(t, {
      cardFeaturesPerIndex: { 0: { league: "MLB" } },
    });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: subtree.sportId,
      key: "league",
      value: "MLB",
    });

    const card0 = await t.run(async (ctx) => ctx.db.get(subtree.cardIds[0]));
    expect(card0!.features?.league).toBe("MLB");
    const card1 = await t.run(async (ctx) => ctx.db.get(subtree.cardIds[1]));
    expect(card1!.features?.league).toBeUndefined();
  });

  test("preserves other existing keys on the row when patching one key", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const subtree = await seedSubtree(t);

    await t.run(async (ctx) => {
      await ctx.db.patch(subtree.sportId, {
        features: { manufacturer: "Topps" },
      });
    });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: subtree.sportId,
      key: "league",
      value: "MLB",
    });

    const root = await t.run(async (ctx) => ctx.db.get(subtree.sportId));
    expect(root!.features?.league).toBe("MLB");
    expect(root!.features?.manufacturer).toBe("Topps");
  });

  test("rejects an invalid era value via validateFeatureValue", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const subtree = await seedSubtree(t);

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
        selectorOptionId: subtree.sportId,
        key: "era",
        value: "Not A Real Era",
      }),
    ).rejects.toThrow();
  });

  test("throws for a non-existent selectorOptionId", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const subtree = await seedSubtree(t);
    await t.run(async (ctx) => ctx.db.delete(subtree.sportId));

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
        selectorOptionId: subtree.sportId,
        key: "league",
        value: "MLB",
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// commitCardChecklist: card creation reads the leaf node's complete snapshot
// ===========================================================================

describe("commitCardChecklist (ancestor feature inheritance)", () => {
  test("new cards inherit the complete resolved snapshot from their leaf node (deeper edits override shallower auto-derivation)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Build via the real creation mutations, in parent->child order, so
    // copy-down (NEO-71-74) naturally carries values forward — this
    // exercises the real pipeline end-to-end rather than hand-injecting a
    // `features` shape production code could never produce.
    const sportId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Baseball" },
    );
    // auto: sportId.features = { league: "MLB" }

    const setNameId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "setName", value: "2024 Topps", parentId: sportId },
    );
    // auto: copies league="MLB" down from sport + own isReprint="false"

    // Operator overrides at the setName level, BEFORE the variantType child
    // exists, so copy-down carries them forward. `subsetLabel` has no
    // deriver at all — proves an arbitrary key still flows through
    // copy-down. Overriding `league` here (deeper than sport's auto value)
    // proves deeper-wins now happens via copy-down timing, not a cascade.
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: setNameId,
      key: "subsetLabel",
      value: "Flagship",
    });
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: setNameId,
      key: "league",
      value: "MLB-Flagship",
    });

    const variantTypeId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "variantType", value: "Base", parentId: setNameId },
    );
    // auto: copies league="MLB-Flagship", subsetLabel="Flagship",
    // isReprint="false" down from setName + own cardType="Base"

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
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
      confirmedNewPlayers: ["Mike Trout", "Aaron Judge"],
      confirmedNewTeams: [],
    });

    const cards = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .collect(),
    );

    expect(cards).toHaveLength(2);
    for (const card of cards) {
      // setName's override survived copy-down onto the leaf, and from
      // there onto the card — proves deeper-wins without any cascade.
      expect(card.features?.league).toBe("MLB-Flagship");
      // Arbitrary non-heuristic key flows through copy-down untouched.
      expect(card.features?.subsetLabel).toBe("Flagship");
      // Own-level heuristic at the leaf (variantType).
      expect(card.features?.cardType).toBe("Base");
      // Seeded at setName creation, copied down through the leaf.
      expect(card.features?.isReprint).toBe("false");
    }
  });

  // -------------------------------------------------------------------------
  // NEO-24 Stage 3b — per-card feature derivation from BSC/SL adapter fields
  // -------------------------------------------------------------------------
  test("per-card derived features (signedBy, parallelName, isRookie, isRelic) land on insert", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // NEO-71-74: commitCardChecklist now reads a single leaf node's
    // `features` (no ancestor walk), so the fixture must put the resolved
    // value directly on the LEAF (variantTypeId) row it actually reads —
    // mirroring what real copy-down would have produced.
    const subtreeIds = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        features: { league: "MLB" },
        children: [],
        lastUpdated: Date.now(),
      });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "2024 Topps Chrome",
        platformData: {},
        features: { league: "MLB" },
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(sportId, { children: [setNameId] });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        features: { league: "MLB" },
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

    // Inherited from the leaf node's snapshot.
    expect(c1.features?.league).toBe("MLB");
    expect(c2.features?.league).toBe("MLB");

    // Derived from per-card columns — wins over the inherited snapshot.
    expect(c1.features?.isRookie).toBe("true");
    expect(c1.features?.signedBy).toBe("On-Card");
    expect(c1.features?.parallelName).toBe("Gold");
    expect(c1.features?.isRelic).toBeUndefined();

    expect(c2.features?.isRelic).toBe("true");
    expect(c2.features?.isRookie).toBeUndefined();
    expect(c2.features?.signedBy).toBeUndefined();
    expect(c2.features?.parallelName).toBeUndefined();
  });

  test("set-level totalCardCount lands on the setName ancestor's features after commit", async () => {
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
    expect(row!.features?.totalCardCount).toBe("3");
  });
});
