/**
 * NEO-91: integration tests for the cross-marketplace SKU wiring into
 * `commitCardChecklist`'s insert branch and `addCustomCard`
 * (convex/selectorOptions.ts) — both use the same insert-then-patch
 * pattern (Convex only returns `_id` after `ctx.db.insert`, so the row is
 * inserted first, then patched with the computed `sku`), calling
 * `generateSku` (convex/sku.ts, unit-tested on its own in
 * convex/sku.test.ts) with sport/year/setName/cardNumber plus a fresh
 * `crypto.randomUUID()` as `uniqueSuffix`.
 *
 * These tests target the WIRING (does a committed/added card end up with a
 * correctly-formatted, non-empty, unique sku?) — not generateSku's own
 * string logic, which is already covered in convex/sku.test.ts.
 *
 * Fixture conventions (seedVariantTypeUnderChromeSet, ADMIN_IDENTITY,
 * previewCardValidator-shaped card objects) are lifted directly from
 * convex/featurePropagation.test.ts's
 * "commitCardChecklist generates listingTitle/listingDescription" suite,
 * which already exercises this same insert branch.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_sku_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_sku_001",
  name: "Admin User",
  role: "admin",
};

async function seedVariantTypeUnderChromeSet(t: ReturnType<typeof convexTest>) {
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

describe("commitCardChecklist generates a cross-marketplace sku on insert (NEO-91)", () => {
  test("a freshly-committed card gets a non-empty sku reflecting sport/year/set/cardNumber", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sport: "Baseball",
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
          platformData: { bsc: "bsc-50" },
          sourcePlatformIds: undefined,
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
    const card = cards.find((c) => c.cardNumber === "50");
    expect(card?.sku).toBeTruthy();
    // sport="Baseball" -> BB, year from features.season="2024",
    // setName ancestor "Chrome" -> CHROME, cardNumber "50", 6-char suffix.
    expect(card?.sku).toMatch(/^NB-BB-2024-CHROME-50-[A-Z0-9]{6}$/);
    expect((card?.sku ?? "").length).toBeLessThanOrEqual(41);
  });

  test("two different cards committed in the same batch get DIFFERENT skus", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sport: "Baseball",
      cards: [
        {
          cardNumber: "50",
          cardName: "Elly De La Cruz",
          team: undefined,
          teams: [],
          players: [],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: "bsc-50" },
          sourcePlatformIds: undefined,
          unmatched: undefined,
        },
        {
          cardNumber: "51",
          cardName: "Some Other Player",
          team: undefined,
          teams: [],
          players: [],
          attributes: [],
          isRookie: false,
          isRelic: false,
          printRun: undefined,
          autographType: undefined,
          cardVariation: undefined,
          platformData: { bsc: "bsc-51" },
          sourcePlatformIds: undefined,
          unmatched: undefined,
        },
      ],
    });

    const committedCards = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    const card50 = committedCards.find((c) => c.cardNumber === "50");
    const card51 = committedCards.find((c) => c.cardNumber === "51");
    expect(card50?.sku).toBeTruthy();
    expect(card51?.sku).toBeTruthy();
    expect(card50?.sku).not.toBe(card51?.sku);
  });

  test("re-committing an already-existing card number does not overwrite its sku", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    const commitCard = () =>
      asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sport: "Baseball",
        cards: [
          {
            cardNumber: "50",
            cardName: "Elly De La Cruz",
            team: undefined,
            teams: [],
            players: [],
            attributes: [],
            isRookie: false,
            isRelic: false,
            printRun: undefined,
            autographType: undefined,
            cardVariation: undefined,
            platformData: { bsc: "bsc-50" },
            sourcePlatformIds: undefined,
            unmatched: undefined,
          },
        ],
      });

    const findCard50 = async () => {
      const cards = await t.run(async (ctx) =>
        ctx.db
          .query("cardChecklist")
          .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
          .collect(),
      );
      return cards.find((c) => c.cardNumber === "50");
    };

    await commitCard();
    const firstSku = (await findCard50())?.sku;
    expect(firstSku).toBeTruthy();

    await commitCard();
    const secondSku = (await findCard50())?.sku;
    expect(secondSku).toBe(firstSku);
  });
});

describe("addCustomCard generates a cross-marketplace sku (NEO-91)", () => {
  test("a card added via addCustomCard gets a non-empty, correctly-formatted sku", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "9001",
      cardName: "My Custom Card",
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card?.sku).toBeTruthy();
    // findSportForSelectorOption walks up from variantTypeId to the sport
    // ancestor "Baseball" -> BB; year from the leaf's features.season snapshot
    // "2024"; setName ancestor "Chrome" -> CHROME; cardNumber "9001".
    expect(card?.sku).toMatch(/^NB-BB-2024-CHROME-9001-[A-Z0-9]{6}$/);
  });

  test("two custom cards added under the same set get DIFFERENT skus", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedVariantTypeUnderChromeSet(t);

    const cardId1 = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "9001",
      cardName: "First Custom Card",
    });
    const cardId2 = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "9001",
      cardName: "Second Custom Card With Same Number",
    });

    const card1 = await t.run(async (ctx) => ctx.db.get(cardId1));
    const card2 = await t.run(async (ctx) => ctx.db.get(cardId2));
    expect(card1?.sku).toBeTruthy();
    expect(card2?.sku).toBeTruthy();
    // Same cardNumber, same set — only the random uniqueSuffix distinguishes
    // them, proving generateSku's uniqueSuffix is genuinely doing its job
    // here rather than the two custom rows silently colliding.
    expect(card1?.sku).not.toBe(card2?.sku);
  });
});
