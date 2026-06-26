/**
 * NEO-25: `updateCard` accepts the structured per-card fields the card
 * detail panel edits — printRun, autographType, cardVariation, the
 * attributes array (+ derived isRookie/isRelic booleans), playerIds, and
 * the marketplace-agnostic listingTitle / listingDescription — and they
 * round-trip through `getCardChecklist` without `ReturnsValidationError`.
 *
 * Covers the panel save path: operator edits fields → mutation patches
 * only the supplied keys → next query render reflects them. Also asserts
 * the clear path (empty array / false / "") and that a partial patch
 * leaves untouched fields intact (the filter-undefined-then-patch loop).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_001",
  name: "Admin User",
  role: "admin",
};

async function seed() {
  const t = convexTest(schema, modules);
  const asAdmin = t.withIdentity(ADMIN_IDENTITY);

  const ids = await t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: "x", sportlots: "y" },
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: { bsc: "x", sportlots: "y" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: "x", sportlots: "y" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });

    const teamA = await ctx.db.insert("teams", {
      name: "Dodgers",
      nameNormalized: "dodgers",
      sport: "Baseball",
      lastUpdated: Date.now(),
    });
    const playerA = await ctx.db.insert("players", {
      name: "Shohei Ohtani",
      nameNormalized: "ohtani shohei",
      primarySport: "Baseball",
      lastUpdated: Date.now(),
    });

    const cardId = await ctx.db.insert("cardChecklist", {
      selectorOptionId: variantTypeId,
      cardNumber: "17",
      cardName: "Original Name",
      teamOnCardIds: [teamA],
      platformData: {},
      sortOrder: 0,
      lastUpdated: Date.now(),
    });

    return { variantTypeId, teamA, playerA, cardId };
  });

  return { asAdmin, ...ids };
}

describe("updateCard structured fields (NEO-25)", () => {
  test("round-trips every new field through getCardChecklist", async () => {
    const { asAdmin, variantTypeId, playerA, cardId } = await seed();

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      cardName: "Shohei Ohtani",
      attributes: ["RC", "AU", "RELIC", "SP", "unmatched-bsc"],
      isRookie: true,
      isRelic: true,
      printRun: 99,
      autographType: "On-Card",
      cardVariation: "Gold Refractor",
      playerIds: [playerA],
      listingTitle: "2024 Topps Chrome #17 Shohei Ohtani RC Gold Refractor /99",
      listingDescription: "Mint condition. Ships in a top loader.",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const card = cards.find((c) => c._id === cardId)!;

    expect(card.cardName).toBe("Shohei Ohtani");
    expect(card.attributes).toEqual(["RC", "AU", "RELIC", "SP", "unmatched-bsc"]);
    expect(card.isRookie).toBe(true);
    expect(card.isRelic).toBe(true);
    expect(card.printRun).toBe(99);
    expect(card.autographType).toBe("On-Card");
    expect(card.cardVariation).toBe("Gold Refractor");
    expect(card.playerIds).toEqual([playerA]);
    expect(card.listingTitle).toBe(
      "2024 Topps Chrome #17 Shohei Ohtani RC Gold Refractor /99",
    );
    expect(card.listingDescription).toBe("Mint condition. Ships in a top loader.");
  });

  test("clears fields via empty array / false / empty string", async () => {
    const { asAdmin, variantTypeId, cardId } = await seed();

    // First set values, then clear them.
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      attributes: ["RC", "RELIC"],
      isRookie: true,
      isRelic: true,
      listingTitle: "Some title",
      listingDescription: "Some description",
    });
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      attributes: [],
      isRookie: false,
      isRelic: false,
      listingTitle: "",
      listingDescription: "",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const card = cards.find((c) => c._id === cardId)!;

    expect(card.attributes).toEqual([]);
    expect(card.isRookie).toBe(false);
    expect(card.isRelic).toBe(false);
    expect(card.listingTitle).toBe("");
    expect(card.listingDescription).toBe("");
  });

  test("partial patch leaves omitted fields untouched", async () => {
    const { asAdmin, variantTypeId, teamA, cardId } = await seed();

    // Patch only printRun; cardName + teamOnCardIds must survive.
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      printRun: 25,
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const card = cards.find((c) => c._id === cardId)!;

    expect(card.printRun).toBe(25);
    expect(card.cardName).toBe("Original Name");
    expect(card.teamOnCardIds).toEqual([teamA]);
    // Fields never set stay undefined (no accidental writes).
    expect(card.listingTitle).toBeUndefined();
    expect(card.autographType).toBeUndefined();
  });
});
