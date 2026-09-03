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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/**
 * NEO-188: several tests in this file commit cards carrying a BSC ref, which
 * schedules the per-card team-enrichment action. Any test that does not drain
 * that chain used to let a REAL request to BSC's production API escape and
 * land after teardown — surfacing only as `Errors 1 error` in the summary.
 *
 * This is the file-level backstop: a benign stub that keeps a forgotten drain
 * from ever becoming network traffic. It is NOT a substitute for draining —
 * tests below still await their scheduled functions so nothing lands after
 * the test that started it. Tests that assert on the request install their
 * own `vi.stubGlobal("fetch", ...)`, which takes precedence.
 */
beforeEach(() => {
  // Fake timers file-wide: `processBscTeamEnrichmentQueue` walks the card list
  // by RESCHEDULING ITSELF after BSC_TEAM_ENRICH_DELAY_MS (300ms) per card. On
  // real timers only the head runs inside the test — every remaining card is a
  // pending timeout that fires during whichever test happens to be running
  // next. That, not the head call, is what made this leak cross-test and
  // intermittent. Fake timers let a test drain the WHOLE chain.
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    (async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      platformData: { bsc: { b0: "bsc-baseball" }, sportlots: { s0: "sl-baseball" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: { bsc: { b0: "bsc-2024-topps" }, sportlots: { s0: "sl-2024-topps" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: { b0: "bsc-2024-topps-base" }, sportlots: { s0: "sl-base" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
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

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
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
          platformData: { bsc: { ref: "bsc-card-1" } },
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
          platformData: { bsc: { ref: "bsc-card-2" } },
          unmatched: undefined,
        },
      ],
    });

    // NEO-188: these refs queue BSC team enrichment. This test asserts nothing
    // about it, but the chain must finish HERE — left running, it resolved
    // after teardown and hit BSC's prod API from inside a later test.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

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
        sportConfig: {
          skuCode: "BB",
          league: "MLB",
          espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
          wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
        },
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

    // NEO-92: commitCardChecklist only resolves a card's players/teams to
    // real ids when the name is already in the players/teams table (or the
    // name was reviewed via a batchId's entityReviewQueue decision — not
    // exercised here). This test asserts `signedBy`/`listingTitle`-style
    // behavior that depends on a REAL resolved playerId (see
    // `playerNames`/`wasBlank && isNowSet` in commitCardChecklist), so
    // pre-seed both players directly via the same findOrCreate mutation the
    // old confirmedNewPlayers path used to call under the hood.
    await asAdmin.mutation(api.players.findOrCreate, { name: "Mike Trout", sportId: subtreeIds.sportId });
    await asAdmin.mutation(api.players.findOrCreate, { name: "Aaron Judge", sportId: subtreeIds.sportId });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: subtreeIds.variantTypeId,
      sportId: subtreeIds.sportId,
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
          platformData: { bsc: { ref: "bsc-1" } },
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
          platformData: { bsc: { ref: "bsc-2" } },
          unmatched: undefined,
        },
      ],
    });

    // NEO-188: drain the BSC enrichment chain these refs queue (see above).
    await t.finishAllScheduledFunctions(vi.runAllTimers);

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
    // autographType "On-Card" maps to the closed autographed vocabulary, and
    // since that's a blank->set transition on insert with a resolved player
    // on the card, signedBy defaults from the roster (real name), not the
    // raw autographType string.
    expect(c1.features?.autographed).toBe("On Card");
    expect(c1.features?.signedBy).toBe("Mike Trout");
    expect(c1.features?.parallelName).toBe("Gold");
    expect(c1.features?.isRelic).toBeUndefined();

    expect(c2.features?.isRelic).toBe("true");
    expect(c2.features?.isRookie).toBeUndefined();
    expect(c2.features?.autographed).toBeUndefined();
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
        sportConfig: {
          skuCode: "BB",
          league: "MLB",
          espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
          wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
        },
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

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: subtreeIds.setNameId,
      sportId: subtreeIds.sportId,
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
          unmatched: undefined,
        },
      ],
    });

    const row = await asAdmin.query(
      api.selectorOptions.getSelectorOptionById,
      { id: subtreeIds.setNameId },
    );
    expect(row).not.toBeNull();
    expect(row!.features?.totalCardCount).toBe("3");
  });
});

// ===========================================================================
// NEO-24/71-74 — commitCardChecklist write-once listingTitle/listingDescription
// ===========================================================================
//
// `generateListingTitle`/`generateListingDescription` already have full unit
// coverage in generateListing.test.ts. These tests prove the WIRING into
// commitCardChecklist's insert branch: a newly-inserted card gets a
// non-empty listingTitle/listingDescription generated from the leaf node's
// features snapshot + the batch-level setName ancestor value (fetched once
// via findSetNameValue) + real resolved player names (unlike addCustomCard,
// which uses pendingPlayerNames — here players are already resolved to real
// ids by this same mutation's findOrCreate pass). Also proves the
// write-once contract: RE-committing an already-existing card number never
// regenerates/overwrites an operator-edited listingTitle, matching every
// other default this session (existing rows are owned by the propagation
// engine, not by this insert-time generation).
describe("commitCardChecklist generates listingTitle/listingDescription (NEO-24/71-74)", () => {
  async function seedVariantTypeUnderChromeSet(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        sportConfig: {
          skuCode: "BB",
          league: "MLB",
          espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
          wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
        },
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Chrome",
        platformData: {},
        features: { manufacturer: "Topps", season: "2024" },
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(sportId, { children: [setNameId] });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        features: { manufacturer: "Topps", season: "2024" },
        parentId: setNameId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(setNameId, { children: [variantTypeId] });
      return { sportId, setNameId, variantTypeId };
    });
  }

  test("a freshly committed card gets a non-empty listingTitle/listingDescription reflecting its actual data", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    // Real listingTitle generation reads `playerNames` off the card's
    // RESOLVED playerIds (see commitCardChecklist) — pre-seed the player so
    // it resolves instead of going through the (unexercised here) batchId
    // review-decision path.
    await asAdmin.mutation(api.players.findOrCreate, { name: "Elly De La Cruz", sportId });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        {
          cardNumber: "50",
          cardName: "Elly De La Cruz",
          team: undefined,
          teams: [],
          players: ["Elly De La Cruz"],
          attributes: ["RC"],
          isRookie: true,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: { ref: "bsc-50" } },
          unmatched: undefined,
        },
      ],
    });

    const cards = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    expect(cards).toHaveLength(1);
    const card = cards[0];

    // year/manufacturer/set — resolved from the leaf's features snapshot +
    // the batch-level setName ancestor value.
    expect(card.listingTitle).toBeTruthy();
    expect(card.listingTitle).toContain("2024");
    expect(card.listingTitle).toContain("Topps");
    expect(card.listingTitle).toContain("Chrome");
    // player — resolved to a REAL name via this mutation's own findOrCreate
    // pass (unlike addCustomCard, which only has a pending name at add-time).
    expect(card.listingTitle).toContain("Elly De La Cruz");
    expect(card.listingTitle).toContain("#50");
    expect(card.listingTitle).toContain("RC");

    expect(card.listingDescription).toBeTruthy();
    expect(card.listingDescription).toContain("Elly De La Cruz");
    expect(card.listingDescription).toContain("Rookie Card");
  });

  test("re-committing an already-existing card number does NOT regenerate/overwrite an operator-edited listingTitle", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const commitCard = () =>
      asAdmin.action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [
          {
            cardNumber: "50",
            cardName: "Elly De La Cruz",
            team: undefined,
            teams: [],
            players: ["Elly De La Cruz"],
            attributes: [],
            isRookie: false,
            isRelic: false,
            printRun: undefined,
            autographType: undefined,
            cardVariation: undefined,
            platformData: { bsc: { ref: "bsc-50" } },
            unmatched: undefined,
          },
        ],
      });

    // First commit — inserts the row and generates its listingTitle.
    await commitCard();
    const firstPass = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    expect(firstPass).toHaveLength(1);
    const cardId = firstPass[0]._id;
    expect(firstPass[0].listingTitle).toBeTruthy();

    // Operator manually overrides the generated title.
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: "My Custom Operator Title",
    });

    // Re-commit the SAME card number — e.g. a marketplace re-sync. The
    // existing-row patch branch in commitCardChecklist never writes
    // listingTitle/listingDescription, so the operator's edit must survive.
    await commitCard();

    const secondPass = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0]._id).toBe(cardId);
    expect(secondPass[0].listingTitle).toBe("My Custom Operator Title");
  });

  // NEO-101 — the insert branch records that the generator had to CUT the
  // title's core, because nothing downstream can re-derive it: the stored row
  // carries neither the player names (they are behind `playerIds`) nor the set
  // name (an ancestor walk), so "did the core fit?" is not a question the row
  // can answer about itself. See `cardChecklist.listingTitleTruncated`.
  test("an overflowing core writes listingTitleTruncated: true", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);

    const hugeName =
      "An Absurdly Long Player Full Name That Alone Exceeds The Entire Title Budget";
    await asAdmin.mutation(api.players.findOrCreate, { name: hugeName, sportId });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        {
          cardNumber: "99999",
          cardName: hugeName,
          team: undefined,
          teams: [],
          players: [hugeName],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: { ref: "bsc-99999" } },
          unmatched: undefined,
        },
      ],
    });

    const [card] = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );

    expect(card.listingTitleTruncated).toBe(true);
    // Still a VALID, listable title — cut at a whole word, no ellipsis, card
    // number intact. The flag says "a human should put the missing words
    // back", not "this is broken".
    expect(card.listingTitle!.length).toBeLessThanOrEqual(80);
    expect(card.listingTitle).not.toContain("…");
    expect(card.listingTitle!.endsWith("#99999")).toBe(true);
  });

  test("a card whose core fits omits listingTitleTruncated entirely", async () => {
    // Absent, not `false`: the mean real title is 34 characters, so this is
    // the overwhelming majority of rows and they should carry no field at all.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    await asAdmin.mutation(api.players.findOrCreate, {
      name: "Elly De La Cruz",
      sportId,
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        {
          cardNumber: "50",
          cardName: "Elly De La Cruz",
          team: undefined,
          teams: [],
          players: ["Elly De La Cruz"],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: { ref: "bsc-50" } },
          unmatched: undefined,
        },
      ],
    });

    const [card] = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    expect(card.listingTitleTruncated).toBeUndefined();
  });

  // NEO-101 — `cardVariation` reaches the generated title and description
  // VERBATIM. Before this ticket the generator ignored the field entirely, so
  // a synced variation card titled identically to its parent apart from the
  // card number — losing the one word a buyer was most likely searching for.
  test("cardVariation reaches the generated title and description", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantTypeUnderChromeSet(t);
    await asAdmin.mutation(api.players.findOrCreate, {
      name: "Julio Rodriguez",
      sportId,
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        {
          cardNumber: "300b",
          cardName: "Julio Rodriguez",
          team: undefined,
          teams: [],
          players: ["Julio Rodriguez"],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: "Image Variation",
          platformData: { bsc: { ref: "bsc-300b" } },
          unmatched: undefined,
        },
      ],
    });

    const [card] = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    expect(card.listingTitle).toBe(
      "2024 Topps Chrome Julio Rodriguez #300b Image Variation",
    );
    // Once, not twice: `deriveCardObservedFeatures` also copies cardVariation
    // into `features.parallelName`, so the identity sentence already names it.
    expect(card.listingDescription).toBe(
      "2024 Topps Chrome Image Variation card of Julio Rodriguez, #300b.",
    );
  });
});

describe("commitCardChecklist wires up BSC per-card team enrichment (NEO-90)", () => {
  // Same fixture shape as the listingTitle describe block above — just a
  // bare sport → variantType leaf (no setName features needed here).
  async function seedVariantType(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        sportConfig: {
          skuCode: "BB",
          league: "MLB",
          espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
          wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
        },
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(sportId, { children: [variantTypeId] });
      return { variantTypeId, sportId };
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("a new card with a BSC ref and no team gets its team resolved via the enrichment queue", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantType(t);

    // NEO-188: RECORD the URLs and assert after the drain, rather than calling
    // expect() inside the stub. `fetchBscCardTeamNameRaw` wraps its fetch in a
    // try/catch, so an assertion that throws in here is swallowed by the code
    // under test — the failure then reappears as a confusing downstream
    // expectation miss, or is lost entirely.
    const fetchedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL | Request) => {
        fetchedUrls.push(String(url));
        return new Response(JSON.stringify({ teamName: "Cincinnati Reds" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    );

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        {
          cardNumber: "50",
          cardName: "Elly De La Cruz",
          team: undefined,
          teams: [], // no team recoverable from the bulk players/teams string
          players: ["Elly De La Cruz"],
          attributes: [],
          isRookie: true,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: { ref: "bsc-50" } },
          unmatched: undefined,
        },
      ],
    });

    // Drain the scheduled processBscTeamEnrichmentQueue chain.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The enrichment called BSC for THIS card and nothing else. Asserting the
    // exact call list (not just "contains") is what makes a stray request from
    // another test visible here instead of silently satisfying the match.
    expect(fetchedUrls).toEqual([
      "https://api-prod.buysportscards.com/marketplace/card/bsc-50/card-listing",
    ]);

    const cards = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].teamOnCardIds).toHaveLength(1);
    expect(cards[0].teamCheckDoneAt).toBeTypeOf("number");
    const teamRow = await t.run(async (ctx) => ctx.db.get(cards[0].teamOnCardIds![0]));
    expect(teamRow!.name).toBe("Cincinnati Reds");
  });

  test("a card whose team is already recoverable from the bulk fetch is NOT re-queued (fetch never called)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantType(t);

    // Only the BSC per-card lookup is under test here — this card's team
    // is already known, so THAT call must never happen. NEO-92: since
    // commitCardChecklist no longer auto-enriches newly-created entities
    // (Wikidata/ESPN lookups now happen pre-commit, during the review
    // wizard, only for names it doesn't already recognize), pre-seed
    // "Kansas City Royals" directly so it resolves to a real team id
    // without needing a batchId/decision — nothing besides the guarded BSC
    // endpoint should ever call fetch in this test.
    let bscFetchCalled = false;
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        if (String(url).includes("buysportscards.com")) {
          bscFetchCalled = true;
          throw new Error("BSC per-card fetch must not be called");
        }
        return new Response(null, { status: 500 });
      }) as unknown as typeof fetch,
    );

    await asAdmin.mutation(api.teams.findOrCreate, { name: "Kansas City Royals", sportId });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        {
          cardNumber: "1",
          cardName: "Kansas City Royals TC",
          team: undefined,
          teams: ["Kansas City Royals"], // already resolved via BSC's bulk players field
          players: ["Kansas City Royals"],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: { ref: "bsc-1" } },
          unmatched: undefined,
        },
      ],
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(bscFetchCalled).toBe(false);

    const cards = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    expect(cards[0].teamOnCardIds).toHaveLength(1);
    // Never queued, so the enrichment marker is never touched.
    expect(cards[0].teamCheckDoneAt).toBeUndefined();
  });

  test("a card with no BSC ref at all is not queued for BSC enrichment (fetch never called)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId, sportId } = await seedVariantType(t);

    // Same scoping as the test above — "Some Player" isn't pre-seeded and
    // has no batchId/decision, so commitCardChecklist just leaves it
    // unresolved (no player row created, no fetch of any kind triggered).
    // Only the BSC card-listing endpoint is under test.
    let bscFetchCalled = false;
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        if (String(url).includes("buysportscards.com")) {
          bscFetchCalled = true;
          throw new Error("BSC per-card fetch must not be called");
        }
        return new Response(null, { status: 500 });
      }) as unknown as typeof fetch,
    );

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        {
          cardNumber: "1",
          cardName: "Some SportLots-only Card",
          team: undefined,
          teams: [],
          players: ["Some Player"],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { sportlots: { ref: "sl-1" } }, // no bsc ref
          unmatched: undefined,
        },
      ],
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(bscFetchCalled).toBe(false);
  });
});
