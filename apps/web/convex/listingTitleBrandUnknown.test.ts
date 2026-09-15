/**
 * NEO-272 — a set whose brand NB has not identified names no maker in its
 * listing.
 *
 * `syncSetsAcrossManufacturers` files a BSC set under the marketplace's
 * all-brands FILTER OPTION — "show all cards from all brands", carried on the
 * brand axis as a `manufacturer` row — whenever the set name prefix-matches no
 * real brand. That row names no brand, so its name tells a buyer nothing about
 * the card; in an 80-character title the name it wears ("All Brands") spends
 * ten characters — eleven with the separator — on meaningless text.
 *
 * `generateListing.test.ts` pins the generator's half of that in isolation.
 * THIS file pins the PLUMBING: the role has to travel from
 * `selectorOptions.metadata.isBrandUnknown` on an ancestor row, through
 * the ancestor walk, into both creation paths and into the preview — because
 * the flag is worth nothing if the walk drops it before the generator is
 * called.
 *
 * The two creation paths and the preview are three hand-kept copies of the
 * same input mapping (see the note on `previewListingTitle` in
 * selectorOptions.ts: "If you change one, change the other"), so every case
 * below asserts the preview comes back BYTE-IDENTICAL to what creation stored.
 * A regenerated title that disagrees with the stored one is the drift this
 * file exists to catch.
 *
 * Note what is deliberately NOT varied: the row keeps its usual name in
 * `value` and in the copied-down `features.manufacturer`. Nothing here is
 * spelled differently to make the point — the flag is what changes, and the
 * `a manufacturer named "All Brands" but NOT flagged` case proves the
 * generator is reading the role rather than matching the string.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_brand_unknown_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_brand_unknown_001",
  name: "Admin User",
  role: "admin",
};

/**
 * The REAL chain — sport › year › manufacturer › setName › variantType.
 *
 * Most fixtures in this directory shortcut straight from sport to setName,
 * which is exactly the shape that would hide this bug: with no manufacturer
 * level there is no role to read. `features` carries the copied-down
 * `manufacturer` on the leaf because that is where both insert branches read
 * the NAME from — the role and the name arrive from different places, and the
 * point of the ticket is that only the role decides.
 */
async function seedChain(
  t: ReturnType<typeof convexTest>,
  opts: { isBrandUnknown?: boolean; manufacturer?: string } = {},
) {
  const manufacturer = opts.manufacturer ?? "All Brands";
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      sportConfig: { skuCode: "HK", league: "NHL" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1995",
      platformData: {},
      features: { season: "1995" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const manufacturerId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: manufacturer,
      platformData: {},
      features: { season: "1995", manufacturer },
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
      ...(opts.isBrandUnknown === undefined
        ? {}
        : { metadata: { isBrandUnknown: opts.isBrandUnknown } }),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Roanoke Express ECHL",
      platformData: {},
      features: { season: "1995", manufacturer },
      parentId: manufacturerId,
      children: [],
      lastUpdated: Date.now(),
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { season: "1995", manufacturer },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [yearId] });
    await ctx.db.patch(yearId, { children: [manufacturerId] });
    await ctx.db.patch(manufacturerId, { children: [setNameId] });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    return { sportId, yearId, manufacturerId, setNameId, variantTypeId };
  });
}

const cardsUnder = (
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
) =>
  t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", selectorOptionId),
      )
      .collect(),
  );

describe("brand-unknown role plumbing (NEO-272)", () => {
  // Same convention as previewListingTitle.test.ts: creation schedules
  // enrichment work, and a stubbed-to-throw fetch keeps a drained schedule
  // from reaching the network guard with anything this file invented.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        throw new Error(
          `NEO-272: this test file must not reach the network: ${String(url)}`,
        );
      }) as unknown as typeof fetch,
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("addCustomCard under a flagged manufacturer writes a title with no maker, and the preview agrees", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedChain(t, { isBrandUnknown: true });

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "12",
      cardName: "Chris Grassie",
      players: ["Chris Grassie"],
    });
    await drainScheduled(t);

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.listingTitle).toBe(
      "1995 Roanoke Express ECHL Chris Grassie #12 Hockey",
    );
    expect(card!.listingTitle).not.toContain("All Brands");
    expect(card!.listingDescription).not.toContain("All Brands");
    expect(card!.listingDescription).toContain(
      "1995 Roanoke Express ECHL card of Chris Grassie, #12.",
    );

    // The role reaches the query too — same walk, same answer — so Regenerate
    // cannot put that maker name back into a title creation left it out of.
    const preview = await asAdmin.query(
      api.selectorOptions.previewListingTitle,
      { cardId },
    );
    expect(preview.title).toBe(card!.listingTitle);
    expect(preview.inputs.manufacturerBrandUnknown).toBe(true);
    // The NAME is still reported, because the chips describe the card's facts;
    // the flag beside it is what tells the panel not to offer it as a source.
    expect(preview.inputs.manufacturer).toBe("All Brands");
  });

  test('a manufacturer named "All Brands" but NOT flagged is an ordinary brand', async () => {
    // The regression guard and the reason the role is read instead of the name:
    // a row with no brand-unknown role keeps its name in the title, whatever
    // that name happens to be.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedChain(t);

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "12",
      cardName: "Chris Grassie",
      players: ["Chris Grassie"],
    });
    await drainScheduled(t);

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.listingTitle).toContain("All Brands");
    const preview = await asAdmin.query(
      api.selectorOptions.previewListingTitle,
      { cardId },
    );
    expect(preview.title).toBe(card!.listingTitle);
    expect(preview.inputs.manufacturerBrandUnknown).toBe(false);
  });

  test("a renamed row still drops out — the role travels, the name does not", async () => {
    // One of the two failures a string comparison would have: an operator
    // renames the row and every title generated afterwards carries the new
    // name. (The other is that the name is a marketplace filter label NB does
    // not own — product invariant 4.)
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedChain(t, {
      isBrandUnknown: true,
      manufacturer: "Unsorted Brands",
    });

    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "12",
      cardName: "Chris Grassie",
      players: ["Chris Grassie"],
    });
    await drainScheduled(t);

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.listingTitle).toBe(
      "1995 Roanoke Express ECHL Chris Grassie #12 Hockey",
    );
    expect(card!.listingTitle).not.toContain("Unsorted");
  });

  test("the COMMIT path drops it too, and the preview reproduces what it stored", async () => {
    // The other insert branch. `commitCardChecklistChunk` reads the role off
    // the prelude (resolved once per batch from the setName row's parent), so
    // this is the case that would break if the prelude, the chunk args or the
    // action threading lost the field.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedChain(t, {
      isBrandUnknown: true,
    });
    await asAdmin.mutation(api.players.findOrCreate, {
      name: "Chris Grassie",
      sportId,
    });
    await drainScheduled(t);

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        {
          cardNumber: "7",
          cardName: "Chris Grassie",
          team: undefined,
          teams: [],
          players: ["Chris Grassie"],
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
    await drainScheduled(t);

    const [card] = await cardsUnder(t, variantTypeId);
    expect(card.listingTitle).toBe(
      "1995 Roanoke Express ECHL Chris Grassie #7 Hockey",
    );
    expect(card.listingTitle).not.toContain("All Brands");
    expect(card.listingDescription).not.toContain("All Brands");

    const preview = await asAdmin.query(
      api.selectorOptions.previewListingTitle,
      { cardId: card._id },
    );
    expect(preview.title).toBe(card.listingTitle);
  });

  test("the commit path keeps an UNFLAGGED manufacturer, so the drop is the flag's doing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedChain(t);
    await asAdmin.mutation(api.players.findOrCreate, {
      name: "Chris Grassie",
      sportId,
    });
    await drainScheduled(t);

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        {
          cardNumber: "7",
          cardName: "Chris Grassie",
          team: undefined,
          teams: [],
          players: ["Chris Grassie"],
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
    await drainScheduled(t);

    const [card] = await cardsUnder(t, variantTypeId);
    expect(card.listingTitle).toContain("All Brands");
    const preview = await asAdmin.query(
      api.selectorOptions.previewListingTitle,
      { cardId: card._id },
    );
    expect(preview.title).toBe(card.listingTitle);
  });
});

/**
 * The only writer of the role, and the reason `addCustomSelectorOption` never
 * gained a `metadata` argument: granting this role decides whether a row's
 * name reaches every listing generated under it, so no client may do it.
 */
describe("markBrandUnknownRole (NEO-272)", () => {
  test("stamps an absent flag, is idempotent, and never clears one", async () => {
    const t = convexTest(schema, modules);
    const { manufacturerId } = await seedChain(t);

    await t.mutation(internal.selectorOptions.markBrandUnknownRole, {
      id: manufacturerId,
    });
    let row = await t.run(async (ctx) => ctx.db.get(manufacturerId));
    expect(row!.metadata?.isBrandUnknown).toBe(true);

    // A second pass is free — the sync's adoption branch runs on every call.
    await t.mutation(internal.selectorOptions.markBrandUnknownRole, {
      id: manufacturerId,
    });
    row = await t.run(async (ctx) => ctx.db.get(manufacturerId));
    expect(row!.metadata?.isBrandUnknown).toBe(true);
  });

  test("leaves the rest of metadata alone", async () => {
    const t = convexTest(schema, modules);
    const { manufacturerId } = await seedChain(t);
    await t.run(async (ctx) =>
      ctx.db.patch(manufacturerId, { metadata: { cardNumberPrefix: "RE-" } }),
    );

    await t.mutation(internal.selectorOptions.markBrandUnknownRole, {
      id: manufacturerId,
    });
    const row = await t.run(async (ctx) => ctx.db.get(manufacturerId));
    expect(row!.metadata).toEqual({
      cardNumberPrefix: "RE-",
      isBrandUnknown: true,
    });
  });

  test("does not overrule an explicit false, and refuses a non-manufacturer row", async () => {
    const t = convexTest(schema, modules);
    const { manufacturerId, setNameId } = await seedChain(t, {
      isBrandUnknown: false,
    });

    // `false` is an operator saying "this IS a real brand". Only an ABSENT
    // flag is filled in.
    await t.mutation(internal.selectorOptions.markBrandUnknownRole, {
      id: manufacturerId,
    });
    const mfr = await t.run(async (ctx) => ctx.db.get(manufacturerId));
    expect(mfr!.metadata?.isBrandUnknown).toBe(false);

    // A role flag on a row that is not a manufacturer would be an answer to a
    // question nobody asked.
    await t.mutation(internal.selectorOptions.markBrandUnknownRole, {
      id: setNameId,
    });
    const set = await t.run(async (ctx) => ctx.db.get(setNameId));
    expect(set!.metadata?.isBrandUnknown).toBeUndefined();
  });
});
