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
import { MAX_CARD_PLAYERS } from "./features/cardAttention";
import type { Id } from "./_generated/dataModel";

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
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      platformData: { bsc: { b0: "x" }, sportlots: { s0: "y" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: { bsc: { b0: "x" }, sportlots: { s0: "y" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: { b0: "x" }, sportlots: { s0: "y" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });

    const teamA = await ctx.db.insert("teams", {
      name: "Dodgers",
      nameNormalized: "dodgers",
      sportId,
      lastUpdated: Date.now(),
    });
    const playerA = await ctx.db.insert("players", {
      name: "Shohei Ohtani",
      nameNormalized: "ohtani shohei",
      sportId,
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

    return { sportId, variantTypeId, teamA, playerA, cardId };
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

/**
 * NEO-101 — the hard title cap at the write path.
 *
 * `updateCard` is the single mutation every operator title edit goes through
 * (card detail panel, attention walker's title fixer), so it is the whole
 * enforcement surface: there is no eBay publish path yet, and the panel's own
 * counter is UI only. eBay REJECTS an over-length title rather than truncating
 * it, so an unbounded write here is a listing that fails months later.
 */
describe("updateCard listingTitle length cap (NEO-101)", () => {
  test("81 characters is rejected, and the error names the cap and the length", async () => {
    const { asAdmin, cardId } = await seed();
    const tooLong = "x".repeat(81);

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        listingTitle: tooLong,
      }),
    ).rejects.toThrow(/81 characters/);
    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        listingTitle: tooLong,
      }),
    ).rejects.toThrow(/limit is 80/);
  });

  test("the rejection message never carries the title text itself", async () => {
    // This string travels through Convex's error path into Sentry and the
    // browser console. Row content has no business there — the operator can
    // already see their own title in the field they typed it into.
    const { asAdmin, cardId } = await seed();
    const secret = "SUPERSECRETCARDTITLETOKEN";
    const tooLong = `${secret}${"x".repeat(81 - secret.length)}`;
    expect(tooLong).toHaveLength(81);

    let message = "";
    try {
      await asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        listingTitle: tooLong,
      });
      throw new Error("expected updateCard to reject an 81-character title");
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(secret);
    expect(message).not.toContain(tooLong);
    expect(message).toContain("81");
  });

  test("exactly 80 characters is accepted", async () => {
    const { asAdmin, variantTypeId, cardId } = await seed();
    const atCap = "y".repeat(80);

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: atCap,
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards.find((c) => c._id === cardId)!.listingTitle).toBe(atCap);
  });

  test("the title is trimmed, and trimming is what the cap measures", async () => {
    // Trailing whitespace an operator cannot see must be neither stored nor
    // counted against them: an 80-character title with a stray trailing space
    // is an 80-character title.
    const { asAdmin, variantTypeId, cardId } = await seed();
    const atCap = "z".repeat(80);

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: `   ${atCap}   `,
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards.find((c) => c._id === cardId)!.listingTitle).toBe(atCap);
  });

  test("writing a title CLEARS listingTitleTruncated", async () => {
    // The flag answers "did the GENERATOR's core fit?". Once a human has
    // authored the title, nobody is asking that any more — and leaving it set
    // would badge the card forever.
    const { asAdmin, variantTypeId, cardId } = await seed();
    await asAdmin.run(async (ctx) => {
      await ctx.db.patch(cardId, { listingTitleTruncated: true });
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: "2024 Topps Chrome Shohei Ohtani #17",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(
      cards.find((c) => c._id === cardId)!.listingTitleTruncated,
    ).toBeUndefined();
  });

  test("re-saving the SAME title leaves listingTitleTruncated intact", async () => {
    // The defect this pins: `CardDetailPanel` sends `listingTitle` on EVERY
    // save, touched or not. Clearing the flag merely because the field was
    // PRESENT meant that adding a team or flipping RC silently retired the
    // "auto title was cut short" item — the badge disappeared while the title
    // was still missing the words the generator had to cut.
    const { asAdmin, variantTypeId, cardId } = await seed();
    const generated = "2024 Topps Chrome An Absurdly Long Player Full Name #17";
    await asAdmin.run(async (ctx) => {
      await ctx.db.patch(cardId, {
        listingTitle: generated,
        listingTitleTruncated: true,
      });
    });

    // Exactly what the panel sends when the operator edited only the RC flag.
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      isRookie: true,
      listingTitle: generated,
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const card = cards.find((c) => c._id === cardId)!;
    expect(card.isRookie).toBe(true);
    expect(card.listingTitleTruncated).toBe(true);
  });

  test("a title identical after trimming counts as unchanged", async () => {
    // The comparison is against the TRIMMED incoming value, so whitespace a
    // textarea round-trip added is not mistaken for an operator rewrite.
    const { asAdmin, variantTypeId, cardId } = await seed();
    const generated = "2024 Topps Chrome Shohei Ohtani #17";
    await asAdmin.run(async (ctx) => {
      await ctx.db.patch(cardId, {
        listingTitle: generated,
        listingTitleTruncated: true,
      });
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: `  ${generated}  `,
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards.find((c) => c._id === cardId)!.listingTitleTruncated).toBe(true);
  });

  test("saving a CHANGED title clears listingTitleTruncated", async () => {
    const { asAdmin, variantTypeId, cardId } = await seed();
    await asAdmin.run(async (ctx) => {
      await ctx.db.patch(cardId, {
        listingTitle: "2024 Topps Chrome An Absurdly Long Player Full Name #17",
        listingTitleTruncated: true,
      });
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: "2024 Topps Chrome Shohei Ohtani #17",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(
      cards.find((c) => c._id === cardId)!.listingTitleTruncated,
    ).toBeUndefined();
  });

  test("a patch that does NOT touch the title leaves listingTitleTruncated alone", async () => {
    const { asAdmin, variantTypeId, cardId } = await seed();
    await asAdmin.run(async (ctx) => {
      await ctx.db.patch(cardId, { listingTitleTruncated: true });
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      printRun: 25,
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards.find((c) => c._id === cardId)!.listingTitleTruncated).toBe(true);
  });

  test("cardVariation over the 65-char aspect limit is ACCEPTED — warn only", async () => {
    // Deliberate: no NB field is yet proven to map verbatim onto an eBay
    // aspect, and hard-blocking an operator edit on that guess is the
    // over-structuring NEO-189 rolled back. `features/cardAttention.ts` raises
    // `aspectValueOverLimit` instead.
    const { asAdmin, variantTypeId, cardId } = await seed();
    const longVariation = "v".repeat(120);

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      cardVariation: longVariation,
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards.find((c) => c._id === cardId)!.cardVariation).toBe(longVariation);
  });

  test("a whitespace-only title trims to empty and clears the field, same as sending \"\"", async () => {
    // Trim happens BEFORE the field is stored, so "   " is not a 3-character
    // title that happens to be invisible — it is the same write as "", which
    // the panel already treats as "clear the title" (see the round-trip
    // describe block above). Nothing about the cap logic should special-case
    // whitespace: 0 <= 80 either way, so it is never the REJECTED path, only
    // the "what gets stored" one.
    const { asAdmin, variantTypeId, cardId } = await seed();
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: "A real title",
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: "    ",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards.find((c) => c._id === cardId)!.listingTitle).toBe("");
  });

  test("clearing to whitespace-only clears listingTitleTruncated too — it is a changed title", async () => {
    const { asAdmin, variantTypeId, cardId } = await seed();
    await asAdmin.run(async (ctx) => {
      await ctx.db.patch(cardId, {
        listingTitle: "2024 Topps Chrome An Absurdly Long Player Full Name #17",
        listingTitleTruncated: true,
      });
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: "   ",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const card = cards.find((c) => c._id === cardId)!;
    expect(card.listingTitle).toBe("");
    expect(card.listingTitleTruncated).toBeUndefined();
  });
});

/**
 * NEO-217 — `printRun` is the one NUMBER an operator can clear.
 *
 * Every other editable field already had a spelling for "nothing" that
 * `updateCard`'s filter-undefined-then-patch loop carries through: "" for a
 * string, [] for an array, false for a boolean. A number had none, so a card
 * wrongly marked /99 could never be un-numbered from the drawer. `null` now
 * means exactly one thing — delete the field — and it must never reach the
 * database, because a stored `null` would fail `v.optional(v.number())` on the
 * very next read (which is what `getCardChecklist` below would surface as a
 * ReturnsValidationError).
 *
 * The positive-integer guard exists because the drawer's Print run is a
 * free-text input and a nonsense print run does not stay in the database — it
 * goes into a listing title.
 */
describe("updateCard printRun clear + validation (NEO-217)", () => {
  test("null deletes the field, and the row still reads back through getCardChecklist", async () => {
    const { asAdmin, variantTypeId, cardId } = await seed();

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      printRun: 99,
    });
    let cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards.find((c) => c._id === cardId)!.printRun).toBe(99);

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      printRun: null,
    });

    cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards.find((c) => c._id === cardId)!.printRun).toBeUndefined();

    // Absent, not stored as null: read the raw document, since the query's
    // return validator would already have rejected a null.
    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored).not.toHaveProperty("printRun");
  });

  test("null on a card that never had a printRun is a harmless no-op", async () => {
    const { asAdmin, variantTypeId, cardId } = await seed();

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      printRun: null,
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const card = cards.find((c) => c._id === cardId)!;
    expect(card.printRun).toBeUndefined();
    expect(card.cardName).toBe("Original Name");
  });

  test("omitting printRun leaves an existing value untouched", async () => {
    const { asAdmin, variantTypeId, cardId } = await seed();

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      printRun: 25,
    });
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      cardName: "Renamed",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const card = cards.find((c) => c._id === cardId)!;
    expect(card.printRun).toBe(25);
    expect(card.cardName).toBe("Renamed");
  });

  test.each([0, -1, 2.5])(
    "rejects %p and writes nothing",
    async (badPrintRun) => {
      const { asAdmin, variantTypeId, cardId } = await seed();

      await asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        printRun: 10,
      });

      await expect(
        asAdmin.mutation(api.selectorOptions.updateCard, {
          id: cardId,
          printRun: badPrintRun,
        }),
      ).rejects.toThrow();

      // The whole mutation is rejected, so the previous value survives.
      const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
        selectorOptionId: variantTypeId,
      });
      expect(cards.find((c) => c._id === cardId)!.printRun).toBe(10);
    },
  );

  test("a rejected printRun does not let a co-sent field through", async () => {
    const { asAdmin, variantTypeId, cardId } = await seed();

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        cardName: "Should Not Land",
        printRun: 0,
      }),
    ).rejects.toThrow();

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards.find((c) => c._id === cardId)!.cardName).toBe("Original Name");
  });
});

/**
 * NEO-216 — the card detail drawer now autosaves ONE FIELD PER CALL rather
 * than sending its whole draft on a Save button. `updateCard`'s
 * absent-means-untouched contract is what makes that safe, and these pin it
 * for the exact payload shapes the drawer emits: a lone text field, and the
 * attribute-chip write that carries `attributes` plus the derived booleans in
 * a single mutation.
 *
 * The failure this prevents is the one the plan of record describes: a
 * full-replacement save sending `teamOnCardIds: []` a moment after the BSC
 * per-card team queue filled the team in, permanently un-teaming the card.
 * With field-scoped writes there is no payload that can say that by accident.
 */
describe("updateCard single-field autosave payloads (NEO-216)", () => {
  test("a lone cardName write leaves every other field untouched", async () => {
    const { asAdmin, variantTypeId, teamA, playerA, cardId } = await seed();

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      attributes: ["RC"],
      isRookie: true,
      isRelic: false,
      printRun: 99,
      cardVariation: "Gold",
      playerIds: [playerA],
      listingTitle: "A title",
      listingDescription: "A description",
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      cardName: "Just The Name",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const card = cards.find((c) => c._id === cardId)!;
    expect(card.cardName).toBe("Just The Name");
    expect(card.attributes).toEqual(["RC"]);
    expect(card.isRookie).toBe(true);
    expect(card.isRelic).toBe(false);
    expect(card.printRun).toBe(99);
    expect(card.cardVariation).toBe("Gold");
    expect(card.playerIds).toEqual([playerA]);
    expect(card.teamOnCardIds).toEqual([teamA]);
    expect(card.listingTitle).toBe("A title");
    expect(card.listingDescription).toBe("A description");
  });

  test("an attributes + isRookie chip write leaves every other field untouched", async () => {
    const { asAdmin, variantTypeId, teamA, playerA, cardId } = await seed();

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      cardName: "Shohei Ohtani",
      attributes: ["RC"],
      isRookie: true,
      printRun: 99,
      playerIds: [playerA],
      listingTitle: "A title",
      listingDescription: "A description",
    });

    // The chip row's payload: the new token array plus the boolean it derives.
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      attributes: [],
      isRookie: false,
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const card = cards.find((c) => c._id === cardId)!;
    expect(card.attributes).toEqual([]);
    // NEO-217 (C): RC off really turns the flag off. The old panel's
    // "never AND-downgrade" OR is gone, and nothing else may resurrect it.
    expect(card.isRookie).toBe(false);
    expect(card.cardName).toBe("Shohei Ohtani");
    expect(card.printRun).toBe(99);
    expect(card.playerIds).toEqual([playerA]);
    expect(card.teamOnCardIds).toEqual([teamA]);
    expect(card.listingTitle).toBe("A title");
    expect(card.listingDescription).toBe("A description");
  });

  test("a lone listingTitle write does not disturb the team the enrichment queue just linked", async () => {
    const { asAdmin, variantTypeId, teamA, cardId } = await seed();

    // Stand in for `applyBscTeamResolution` landing while the drawer is open.
    await asAdmin.run(async (ctx) => {
      await ctx.db.patch(cardId, {
        teamOnCardIds: [teamA],
        teamCheckDoneAt: Date.now(),
      });
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: "Operator title",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    const card = cards.find((c) => c._id === cardId)!;
    expect(card.listingTitle).toBe("Operator title");
    expect(card.teamOnCardIds).toEqual([teamA]);
  });
});

/**
 * Adversarial pass (NEO-216/217) — `printRun` boundary values the sweep at
 * `test.each([0, -1, 2.5])` above does not reach. The client (the drawer's
 * `Number(trimmed)`) can hand the mutation any of these if it is ever called
 * with something other than a clean digit string — direct API/CLI callers
 * are not bound by the panel's own text input at all. `updateCard`'s guard
 * is `!Number.isInteger(x) || x < 1`, so these pin exactly what that
 * expression does at its edges rather than assume it.
 */
describe("updateCard printRun — boundary values beyond the basic sweep", () => {
  test("rejects NaN (typeof \"number\", but not an integer)", async () => {
    const { asAdmin, cardId } = await seed();

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        printRun: NaN,
      }),
    ).rejects.toThrow();

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.printRun).toBeUndefined();
  });

  test("rejects Infinity (Number.isInteger(Infinity) is false)", async () => {
    const { asAdmin, cardId } = await seed();

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        printRun: Infinity,
      }),
    ).rejects.toThrow();

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.printRun).toBeUndefined();
  });

  test("rejects -0 — it is an integer but still < 1", async () => {
    // Object.is(-0, 0) is false, but `-0 < 1` is true, so this must be
    // refused by the SAME branch as 0/-1, not silently coerced to a
    // positive zero and let through by an `x < 1` that treats -0 specially.
    const { asAdmin, cardId } = await seed();

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        printRun: -0,
      }),
    ).rejects.toThrow();

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.printRun).toBeUndefined();
  });

  test("rejects an absurdly large integer print run — the ceiling is enforced", async () => {
    // `Number.isInteger` is true for any finite value with no fractional part,
    // including magnitudes far past MAX_SAFE_INTEGER (doubles represent them
    // exactly as whole numbers even though they cannot count anything real at
    // that scale). Without a ceiling, 1e21 round-tripped and reached a listing
    // title verbatim as "1e+21" — nonsense on the listing, and a
    // title-length-shaped input for NEO-101's cap to absorb.
    const { asAdmin, cardId } = await seed();
    const huge = 1e21;
    expect(Number.isInteger(huge)).toBe(true);

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        printRun: huge,
      }),
    ).rejects.toThrow();

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.printRun).toBeUndefined();
  });

  test("accepts exactly 1,000,000 — the bound is inclusive", async () => {
    // The ceiling is orders of magnitude above the largest print run ever
    // produced, so it must never be what stops a real edit. Pinned inclusive
    // so an off-by-one tightening is a test failure, not a support ticket.
    const { asAdmin, variantTypeId, cardId } = await seed();

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      printRun: 1_000_000,
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards.find((c) => c._id === cardId)!.printRun).toBe(1_000_000);
  });

  test("rejects 1,000,001 — one past the bound", async () => {
    const { asAdmin, cardId } = await seed();

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        printRun: 1_000_001,
      }),
    ).rejects.toThrow();

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.printRun).toBeUndefined();
  });
});

// ===========================================================================
// NEO-221 — the unreviewed-name fixer's clear path
//
// `pendingPlayerNames`/`pendingTeamNames` are names the card carries that link
// to nothing: typed by an operator on a hand-added card, or left unresolved by
// a commit whose review never ruled on them. The attention walker's fixer
// resolves them — by linking a real player/team, or by deciding the name was
// never one — and then has to be able to say so. These two arguments are how.
// ===========================================================================

describe("updateCard pending-name arguments (NEO-221)", () => {
  test("an EMPTY array clears the field rather than storing []", async () => {
    // "None" is the ABSENCE of the field everywhere else that writes these two
    // (addCustomCard, the commit chunk), and `deriveCardAttention` reads `[]`
    // and absent identically — but a stored `[]` would still be a second
    // spelling of the same state for every future reader to get wrong.
    const { asAdmin, cardId } = await seed();
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingPlayerNames: ["Never Reviewed"],
      pendingTeamNames: ["Reno Aces"],
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingPlayerNames).toBeUndefined();
    expect(stored!.pendingTeamNames).toBeUndefined();
  });

  test("omitting the arguments leaves the stored names alone", async () => {
    // The fixer is one of several writers of this row; an unrelated title edit
    // must not retire a name nobody has dealt with.
    const { asAdmin, cardId } = await seed();
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingPlayerNames: ["Never Reviewed"],
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: "A new title",
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingPlayerNames).toEqual(["Never Reviewed"]);
  });

  test("linking a real team still retires a typed team name on its own (NEO-208)", async () => {
    // Derived from the write, not accepted as an argument — and the two paths
    // agree rather than fighting: sending the name back alongside a non-empty
    // `teamOnCardIds` still clears it, because linking a team IS the answer
    // the typed name was waiting for.
    const { asAdmin, teamA, cardId } = await seed();
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingTeamNames: ["Reno Aces"],
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: [teamA],
      pendingTeamNames: ["Reno Aces"],
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingTeamNames).toBeUndefined();
    expect(stored!.teamOnCardIds).toEqual([teamA]);
  });
});

// ===========================================================================
// NEO-246 — `updateCard.playerIds` is validated, not written straight through
//
// It shipped to production in #229 as the ONE full-replacement entity array on
// this mutation with no dedupe, no cap, and no existence or sport check, while
// its own twin `teamOnCardIds` and its own sibling `addCustomCard.playerIds`
// both went through a shared resolver. A card could therefore be born
// validated and edited into an unvalidated state on the very next save, from
// `CardDetailPanel`'s PlayerPicker or the attention walker's
// `UnreviewedNameFixer` — both admin clients whose 20-player cap is UI only,
// and neither of which binds a direct API caller at all.
//
// These mirror `addCustomCard.playerIds.test.ts` case for case on purpose: the
// two paths share `resolvePlayerIdsForWrite`, and a difference in what they
// accept is exactly the regression this file has to catch. Players are
// inserted straight into the table rather than through `players.findOrCreate`,
// so nothing here schedules enrichment work that could race teardown (see
// lib/testing/drain-scheduled.ts for when that matters).
// ===========================================================================

describe("updateCard playerIds validation (NEO-246)", () => {
  /** A second player in the card's OWN sport. */
  const addPlayer = (
    asAdmin: Awaited<ReturnType<typeof seed>>["asAdmin"],
    sportId: Id<"selectorOptions">,
    name: string,
  ): Promise<Id<"players">> =>
    asAdmin.run(async (ctx) =>
      ctx.db.insert("players", {
        name,
        nameNormalized: name.toLowerCase(),
        sportId,
        lastUpdated: Date.now(),
      }),
    );

  test("stores a valid list verbatim, in the order it was sent", async () => {
    // The array is DISPLAY order — the operator's chip order — not a set.
    const { asAdmin, sportId, playerA, cardId } = await seed();
    const lindor = await addPlayer(asAdmin, sportId, "Francisco Lindor");

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      playerIds: [lindor, playerA],
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.playerIds).toEqual([lindor, playerA]);
  });

  test("stores a repeated id once, keeping first-seen order", async () => {
    // A double-submitted chip is a client bug, not an operator decision:
    // storing it twice prints the player twice in a generated listing title
    // and pays for the read twice in `previewListingTitle`.
    const { asAdmin, sportId, playerA, cardId } = await seed();
    const lindor = await addPlayer(asAdmin, sportId, "Francisco Lindor");

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      playerIds: [lindor, playerA, lindor],
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.playerIds).toEqual([lindor, playerA]);
  });

  test(`rejects more than MAX_CARD_PLAYERS ids, and writes nothing`, async () => {
    const { asAdmin, sportId, cardId } = await seed();
    const ids = await Promise.all(
      Array.from({ length: MAX_CARD_PLAYERS + 1 }, (_, i) =>
        addPlayer(asAdmin, sportId, `Player ${i}`),
      ),
    );

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        playerIds: ids,
      }),
    ).rejects.toThrow(new RegExp(`at most ${MAX_CARD_PLAYERS} players`));

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.playerIds).toBeUndefined();
  });

  test("counts the cap AFTER the dedupe", async () => {
    // Same rule the team side has always had: a client that repeats one chip
    // past the cap is not punished for it — it resolves to one player.
    const { asAdmin, playerA, cardId } = await seed();

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      playerIds: Array.from({ length: MAX_CARD_PLAYERS + 1 }, () => playerA),
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.playerIds).toEqual([playerA]);
  });

  test("rejects an id that resolves to no player, and writes nothing", async () => {
    const { asAdmin, sportId, cardId } = await seed();
    const dangling = await addPlayer(asAdmin, sportId, "Deleted Player");
    await asAdmin.run(async (ctx) => ctx.db.delete(dangling));

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        playerIds: [dangling],
      }),
    ).rejects.toThrow(/no longer exists/);

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.playerIds).toBeUndefined();
  });

  test("rejects a player from another sport, and writes nothing", async () => {
    // A basketball player on a baseball card is invisible until a listing is
    // generated from it, which is months later and across a whole set at once.
    const { asAdmin, cardId } = await seed();
    const basketballSportId = await asAdmin.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Basketball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const lebron = await addPlayer(asAdmin, basketballSportId, "LeBron James");

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        playerIds: [lebron],
      }),
    ).rejects.toThrow(/not a player in this card's sport/);

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.playerIds).toBeUndefined();
  });

  test("a refused playerIds write does not let a co-sent field through", async () => {
    // The drawer autosaves one field per call, but the walker's fixer sends
    // players, teams and both pending-name lists together — a refusal there
    // must leave the whole row as it was, not half-apply the call.
    const { asAdmin, cardId } = await seed();
    const dangling = await asAdmin.run(async (ctx) => {
      const id = await ctx.db.insert("players", {
        name: "Gone",
        nameNormalized: "gone",
        sportId: (await ctx.db.get(cardId))!.selectorOptionId,
        lastUpdated: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        playerIds: [dangling],
        cardName: "Should Not Land",
      }),
    ).rejects.toThrow(/no longer exists/);

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.cardName).toBe("Original Name");
  });

  test("omitting playerIds leaves the stored list untouched", async () => {
    // The absent-means-untouched contract the whole per-field autosave design
    // rests on. Validation must not turn "not mentioned" into "cleared".
    const { asAdmin, playerA, cardId } = await seed();
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      playerIds: [playerA],
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: "A new title",
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.playerIds).toEqual([playerA]);
  });

  test("an empty array still clears the link", async () => {
    // `[]` is a real value for a full-replacement array — the operator
    // unlinking every player — and the resolver returns before it reads
    // anything, so an empty write costs no extra reads either.
    const { asAdmin, playerA, cardId } = await seed();
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      playerIds: [playerA],
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      playerIds: [],
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.playerIds).toEqual([]);
  });
});

// ===========================================================================
// NEO-246 — `updateCard`'s TYPED name args are bounded too
//
// #229 added `pendingPlayerNames` / `pendingTeamNames` for the walker's fixer
// and left them as bare `v.array(v.string())`, while `addCustomCard`'s
// free-text `players` / `teams` had gone through `normalizePendingNames` since
// NEO-208 — the same asymmetry `playerIds` had, on the other spelling of the
// same two fields. These names land on a row that the listing-title generator,
// the entity-review wizard and the row sub-line all render, so the bound is not
// cosmetic.
//
// Same helper as `addCustomCard`, therefore the same refusal wording; the
// mirror-image cases live in `cardChecklist.noTeam.test.ts`'s
// "addCustomCard — pending name bounds".
// ===========================================================================

describe("updateCard pending-name bounds (NEO-246)", () => {
  test("refuses more typed player names than the cap, and writes nothing", async () => {
    const { asAdmin, cardId } = await seed();

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        pendingPlayerNames: Array.from(
          { length: MAX_CARD_PLAYERS + 1 },
          (_, i) => `Player ${i}`,
        ),
      }),
    ).rejects.toThrow(/at most 20 player names/);

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingPlayerNames).toBeUndefined();
  });

  test("refuses more typed team names than the cap, and writes nothing", async () => {
    // The team cap is the NARROWER of the two (8 vs 20) — a card is never
    // printed for more than a handful of teams.
    const { asAdmin, cardId } = await seed();

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        pendingTeamNames: Array.from({ length: 9 }, (_, i) => `Team ${i}`),
      }),
    ).rejects.toThrow(/at most 8 team names/);

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingTeamNames).toBeUndefined();
  });

  test("refuses an over-long name without quoting it back", async () => {
    // The message carries the LENGTH and the limit, never the text: it travels
    // through Convex's error path into Sentry and the browser console, and row
    // content has no business there.
    const { asAdmin, cardId } = await seed();
    const essay = "z".repeat(121);

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        pendingPlayerNames: [essay],
      }),
    ).rejects.toThrow(/A player name is 121 characters; the limit is 120\./);

    // Read the thrown value directly rather than through a negated `rejects`
    // matcher, which passes vacuously if nothing is thrown at all — the same
    // non-vacuous shape `cardChecklist.noTeam.test.ts` uses for the
    // `addCustomCard` half of this rule.
    let thrown: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        pendingPlayerNames: [essay],
      });
    } catch (err) {
      thrown = err;
    }
    const serialized = `${(thrown as Error)?.message ?? ""} ${JSON.stringify(thrown)}`;
    // Non-vacuous: the limit IS in there, so the absence of the content is a
    // real observation about the same string.
    expect(serialized).toContain("the limit is 120");
    expect(serialized).not.toContain("zzzz");

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingPlayerNames).toBeUndefined();
  });

  test("accepts a name of exactly the limit", async () => {
    const { asAdmin, cardId } = await seed();
    const atLimit = "z".repeat(120);

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingPlayerNames: [atLimit],
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingPlayerNames).toEqual([atLimit]);
  });

  test("trims whitespace, drops empties, and stores a repeat once", async () => {
    // Order is the operator's, so first-seen wins — the same rule the LINKED
    // spelling (`playerIds`) follows, and the reason the cap is measured after
    // this rather than before it.
    const { asAdmin, cardId } = await seed();

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingPlayerNames: [
        "  Yordan Alvrez  ",
        "",
        "   ",
        "Bobby Witt Jr.",
        "Yordan Alvrez",
      ],
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingPlayerNames).toEqual([
      "Yordan Alvrez",
      "Bobby Witt Jr.",
    ]);
  });

  test("counts the cap AFTER the dedupe", async () => {
    const { asAdmin, cardId } = await seed();

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingTeamNames: Array.from({ length: 12 }, () => "Reno Aces"),
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingTeamNames).toEqual(["Reno Aces"]);
  });

  test("an all-whitespace list clears the field, exactly like []", async () => {
    // It normalises to `[]`, and `[]` is stored as the ABSENCE of the field —
    // the one spelling of "none" every other writer of these two uses.
    const { asAdmin, cardId } = await seed();
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingPlayerNames: ["Never Reviewed"],
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingPlayerNames: ["   ", ""],
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingPlayerNames).toBeUndefined();
  });

  test("validates a name list even when the same call retires it", async () => {
    // A non-empty `teamOnCardIds` write clears `pendingTeamNames` on its own,
    // so this argument was about to be thrown away — but a refusal must not
    // depend on which OTHER field happened to ride along in the same call.
    const { asAdmin, teamA, cardId } = await seed();

    await expect(
      asAdmin.mutation(api.selectorOptions.updateCard, {
        id: cardId,
        teamOnCardIds: [teamA],
        pendingTeamNames: Array.from({ length: 9 }, (_, i) => `Team ${i}`),
      }),
    ).rejects.toThrow(/at most 8 team names/);

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.teamOnCardIds).toEqual([teamA]);
  });

  test("the walker fixer's write-back of untouched names still passes", async () => {
    // `UnreviewedNameFixer` sends the OTHER side's stored names back unchanged
    // when only one side gained a link. Those names are already trimmed,
    // deduped and under the cap, so the normaliser is a no-op on them — this
    // pins that the new validation did not turn the fixer's own payload into a
    // refusal.
    const { asAdmin, playerA, cardId } = await seed();
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingPlayerNames: ["Yordan Alvrez"],
      pendingTeamNames: ["Reno Aces"],
    });

    // The fixer's exact payload: player side linked and cleared, team side
    // written back as-is.
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      playerIds: [playerA],
      teamOnCardIds: [],
      pendingPlayerNames: [],
      pendingTeamNames: ["Reno Aces"],
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.playerIds).toEqual([playerA]);
    expect(stored!.pendingPlayerNames).toBeUndefined();
    expect(stored!.pendingTeamNames).toEqual(["Reno Aces"]);
  });

  test("omitting the arguments leaves stored names untouched", async () => {
    const { asAdmin, cardId } = await seed();
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      pendingPlayerNames: ["Never Reviewed"],
      pendingTeamNames: ["Reno Aces"],
    });

    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      listingTitle: "A new title",
    });

    const stored = await asAdmin.run(async (ctx) => ctx.db.get(cardId));
    expect(stored!.pendingPlayerNames).toEqual(["Never Reviewed"]);
    expect(stored!.pendingTeamNames).toEqual(["Reno Aces"]);
  });
});
