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
