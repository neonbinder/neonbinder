/**
 * NEO-335 Phase 2 — adversarial pass over the title fields on
 * `commitCardChecklist`: the caps at exactly 80 / 81 and 65 / 66 (and 72, the
 * unanswered over-long variation), whitespace and unicode, and the index
 * alignment of an answer when a stored row sits in the same commit.
 *
 * Sits beside commitCardChecklist.titleAnswers.test.ts (the happy paths).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX } from "./features/listingLimits";
import { deriveCardAttention } from "./features/cardAttention";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(`NEO-335: this test file must not reach the network: ${String(url)}`);
    }) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_titleanswers_adv",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_titleanswers_adv",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;
type Ids = { sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> };

const LONG_SET_NAME =
  "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box Hobby Exclusive";

async function seedTree(t: T): Promise<Ids> {
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
      value: LONG_SET_NAME,
      platformData: {},
      features: { manufacturer: "Topps", season: "2026" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2026" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

function card(opts: {
  cardNumber: string;
  slRef?: string;
  cardVariation?: string;
  listingTitle?: string;
  listingTitleKept?: string;
  cardVariationAnswered?: true;
}) {
  return {
    cardNumber: opts.cardNumber,
    cardName: `Card ${opts.cardNumber}`,
    teams: [],
    players: [],
    platformData: { sportlots: { ref: opts.slRef ?? `SL-${opts.cardNumber}` } },
    ...(opts.cardVariation !== undefined ? { cardVariation: opts.cardVariation } : {}),
    ...(opts.listingTitle !== undefined ? { listingTitle: opts.listingTitle } : {}),
    ...(opts.listingTitleKept !== undefined ? { listingTitleKept: opts.listingTitleKept } : {}),
    ...(opts.cardVariationAnswered ? { cardVariationAnswered: opts.cardVariationAnswered } : {}),
  };
}

async function rows(t: T, leafId: Id<"selectorOptions">): Promise<Map<string, Doc<"cardChecklist">>> {
  const all = await t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", leafId))
      .collect(),
  );
  return new Map(all.map((r) => [r.cardNumber, r]));
}

const commit = (t: T, ids: Ids, cards: ReturnType<typeof card>[]) =>
  t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
    selectorOptionId: ids.leafId,
    sportId: ids.sportId,
    cards,
  });

async function settle(t: T) {
  await drainScheduled(t);
  await cancelScheduled(t);
}

const attention = (row: Doc<"cardChecklist">) =>
  deriveCardAttention(row as unknown as Parameters<typeof deriveCardAttention>[0]).map((i) => i.kind);

describe("listingTitle — the cap at 80 / 81, measured after the trim", () => {
  test("exactly 80 is stored verbatim and the stored row raises nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const title = "t".repeat(LISTING_TITLE_MAX);
    await commit(t, ids, [card({ cardNumber: "1", listingTitle: title })]);
    const row = (await rows(t, ids.leafId)).get("1")!;
    expect(row.listingTitle).toBe(title);
    expect(row.listingTitleTruncated).toBeUndefined();
    expect(attention(row)).not.toContain("titleOverLimit");
    expect(attention(row)).not.toContain("titleTruncated");
    await settle(t);
  });

  test("81 refuses the whole commit, naming the card by number, with the length in the message", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await expect(
      commit(t, ids, [
        card({ cardNumber: "1" }),
        card({ cardNumber: "7", listingTitle: "t".repeat(LISTING_TITLE_MAX + 1) }),
      ]),
    ).rejects.toThrow(/card #7: the title is 81 characters; the limit is 80/);
    expect((await rows(t, ids.leafId)).size).toBe(0);
    await settle(t);
  });

  test("80 characters of title padded by spaces on both sides is 80, not 90: accepted and stored trimmed", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const core = "t".repeat(LISTING_TITLE_MAX);
    await commit(t, ids, [card({ cardNumber: "1", listingTitle: `   ${core}\t \n` })]);
    expect((await rows(t, ids.leafId)).get("1")!.listingTitle).toBe(core);
    await settle(t);
  });

  test("81 characters once trimmed is refused however it is padded", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await expect(
      commit(t, ids, [card({ cardNumber: "1", listingTitle: `  ${"t".repeat(81)}  ` })]),
    ).rejects.toThrow(/the title is 81 characters/);
    await settle(t);
  });

  test("a non-breaking space at the edge trims like a space; a zero-width space does not and counts", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const core = "t".repeat(LISTING_TITLE_MAX);
    await commit(t, ids, [card({ cardNumber: "1", listingTitle: ` ${core} ` })]);
    expect((await rows(t, ids.leafId)).get("1")!.listingTitle).toBe(core);
    await expect(
      commit(t, ids, [card({ cardNumber: "2", listingTitle: `​${core}` })]),
    ).rejects.toThrow(/the title is 81 characters/);
    await settle(t);
  });

  test("accented letters count one each: 80 of them fit, 81 do not", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [card({ cardNumber: "1", listingTitle: "é".repeat(LISTING_TITLE_MAX) })]);
    expect((await rows(t, ids.leafId)).get("1")!.listingTitle).toBe("é".repeat(LISTING_TITLE_MAX));
    await expect(
      commit(t, ids, [card({ cardNumber: "2", listingTitle: "é".repeat(LISTING_TITLE_MAX + 1) })]),
    ).rejects.toThrow(/81 characters/);
    await settle(t);
  });

  test("the title is held to the cap the same way the stored-row attention rule reads it (UTF-16 length)", async () => {
    // An astral character is two UTF-16 units. The commit and
    // deriveCardAttention both use `.length`, so what the commit accepts the
    // walker never flags: 40 of them (80 units) fit, 41 (82) are refused.
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const forty = "\u{1F3C0}".repeat(40);
    await commit(t, ids, [card({ cardNumber: "1", listingTitle: forty })]);
    const row = (await rows(t, ids.leafId)).get("1")!;
    expect(row.listingTitle).toBe(forty);
    expect(attention(row)).not.toContain("titleOverLimit");
    await expect(
      commit(t, ids, [card({ cardNumber: "2", listingTitle: "\u{1F3C0}".repeat(41) })]),
    ).rejects.toThrow(/the title is 82 characters/);
    await settle(t);
  });

  /** The title the server generates for card "1", renumbered: what the step would have shown. */
  async function shownFor(t: ReturnType<typeof convexTest>, ids: Ids, n: string) {
    await commit(t, ids, [card({ cardNumber: "1" })]);
    return (await rows(t, ids.leafId)).get("1")!.listingTitle!.replace("#1", `#${n}`);
  }

  test("an over-cap title is refused even when the card also says 'kept'", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await expect(
      commit(t, ids, [
        card({ cardNumber: "1", listingTitle: "t".repeat(81), listingTitleKept: "short" }),
      ]),
    ).rejects.toThrow(/the title is 81 characters/);
    await settle(t);
  });

  test("their title AND 'kept' on one card: their words win and nothing is flagged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [
      card({ cardNumber: "1", listingTitle: "My own title #1", listingTitleKept: "whatever was shown" }),
    ]);
    const row = (await rows(t, ids.leafId)).get("1")!;
    expect(row.listingTitle).toBe("My own title #1");
    expect(row.listingTitleTruncated).toBeUndefined();
    await settle(t);
  });

  test("'kept' blank or whitespace-only is no answer: the card is flagged as if nobody had been asked", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [
      card({ cardNumber: "1", listingTitleKept: "" }),
      card({ cardNumber: "2", listingTitleKept: "   " }),
    ]);
    const all = await rows(t, ids.leafId);
    expect(all.get("1")!.listingTitleTruncated).toBe(true);
    expect(all.get("2")!.listingTitleTruncated).toBe(true);
    await settle(t);
  });

  test("'kept' padded with spaces still matches what was generated: not flagged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const shown = await shownFor(t, ids, "2");
    await commit(t, ids, [card({ cardNumber: "2", listingTitleKept: `  ${shown} \t` })]);
    const row = (await rows(t, ids.leafId)).get("2")!;
    expect(row.listingTitle).toBe(shown);
    expect(row.listingTitleTruncated).toBeUndefined();
    await settle(t);
  });

  test("'kept' off by one character from what was generated is a title nobody saw: flagged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const shown = await shownFor(t, ids, "2");
    await commit(t, ids, [card({ cardNumber: "2", listingTitleKept: shown.slice(0, -1) })]);
    const row = (await rows(t, ids.leafId)).get("2")!;
    expect(row.listingTitle).toBe(shown);
    expect(row.listingTitleTruncated).toBe(true);
    await settle(t);
  });

  test("'kept' at exactly 80 characters is accepted; at 81 the commit is refused", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [card({ cardNumber: "1", listingTitleKept: "k".repeat(80) })]);
    await expect(
      commit(t, ids, [card({ cardNumber: "2", listingTitleKept: "k".repeat(81) })]),
    ).rejects.toThrow(/card #2: the title is 81 characters/);
    await settle(t);
  });

  test("their title is stored verbatim: inner spacing and punctuation are not tidied", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const odd = "2026  Topps -- Chrome  #1 !!";
    await commit(t, ids, [card({ cardNumber: "1", listingTitle: odd })]);
    expect((await rows(t, ids.leafId)).get("1")!.listingTitle).toBe(odd);
    await settle(t);
  });

  test("an over-cap title refuses the commit BEFORE any write, even on a later card than a good one", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await expect(
      commit(t, ids, [
        card({ cardNumber: "1", listingTitle: "ok #1" }),
        card({ cardNumber: "2", listingTitle: "ok #2" }),
        card({ cardNumber: "3", listingTitle: "t".repeat(90) }),
      ]),
    ).rejects.toThrow(/card #3/);
    expect((await rows(t, ids.leafId)).size).toBe(0);
    await settle(t);
  });
});

describe("cardVariation — the cap at 65 / 66, and 72 unanswered", () => {
  test("an answered variation of exactly 65 is stored; of 66 refuses the commit", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const sixtyFive = "v".repeat(ASPECT_VALUE_MAX);
    await commit(t, ids, [
      card({ cardNumber: "1", cardVariation: sixtyFive, cardVariationAnswered: true }),
    ]);
    const row = (await rows(t, ids.leafId)).get("1")!;
    expect(row.cardVariation).toBe(sixtyFive);
    expect(attention(row)).not.toContain("aspectValueOverLimit");
    await expect(
      commit(t, ids, [
        card({ cardNumber: "2", cardVariation: "v".repeat(66), cardVariationAnswered: true }),
      ]),
    ).rejects.toThrow(/card #2: the variation is 66 characters; the limit is 65/);
    await settle(t);
  });

  test("an answered variation is measured after the trim: 65 + padding is accepted, stored trimmed", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [
      card({
        cardNumber: "1",
        cardVariation: `  ${"v".repeat(ASPECT_VALUE_MAX)}  `,
        cardVariationAnswered: true,
      }),
    ]);
    const row = (await rows(t, ids.leafId)).get("1")!;
    expect(row.cardVariation).toBe("v".repeat(ASPECT_VALUE_MAX));
    expect(attention(row)).not.toContain("aspectValueOverLimit");
    await settle(t);
  });

  test("an UNanswered 72-character variation commits as printed and the stored row raises the warn-only item", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const seventyTwo = "v".repeat(72);
    await commit(t, ids, [card({ cardNumber: "1", cardVariation: seventyTwo })]);
    const row = (await rows(t, ids.leafId)).get("1")!;
    expect(row.cardVariation).toBe(seventyTwo);
    expect(attention(row)).toContain("aspectValueOverLimit");
    await settle(t);
  });

  test("an answered 72 is refused: the same string is a warning unanswered and an error answered", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await expect(
      commit(t, ids, [
        card({ cardNumber: "1", cardVariation: "v".repeat(72), cardVariationAnswered: true }),
      ]),
    ).rejects.toThrow(/the variation is 72 characters/);
    await settle(t);
  });

  test("the title and the variation are checked independently: a good title does not excuse a bad answered variation", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await expect(
      commit(t, ids, [
        card({
          cardNumber: "1",
          listingTitle: "Fine #1",
          cardVariation: "v".repeat(66),
          cardVariationAnswered: true,
        }),
      ]),
    ).rejects.toThrow(/the variation is 66 characters/);
    expect((await rows(t, ids.leafId)).size).toBe(0);
    await settle(t);
  });
});

describe("a re-synced stored row beside new rows — answers land on the right card", () => {
  async function withStoredFirst() {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [card({ cardNumber: "1", slRef: "SL-A" })]);
    const stored = (await rows(t, ids.leafId)).get("1")!;
    return { t, ids, stored };
  }

  test("the title fields on the stored row's index are ignored; the next card's are written", async () => {
    const { t, ids, stored } = await withStoredFirst();
    await commit(t, ids, [
      card({ cardNumber: "1", slRef: "SL-A", listingTitle: "Wrong place #1", listingTitleKept: stored.listingTitle }),
      card({ cardNumber: "2", slRef: "SL-B", listingTitle: "Right place #2" }),
      card({ cardNumber: "3", slRef: "SL-C", listingTitleKept: stored.listingTitle!.replace("#1", "#3") }),
    ]);
    const all = await rows(t, ids.leafId);
    expect(all.get("1")!._id).toBe(stored._id);
    expect(all.get("1")!.listingTitle).toBe(stored.listingTitle);
    expect(all.get("1")!.listingTitleTruncated).toBe(true);
    expect(all.get("2")!.listingTitle).toBe("Right place #2");
    expect(all.get("2")!.listingTitleTruncated).toBeUndefined();
    expect(all.get("3")!.listingTitleTruncated).toBeUndefined();
    await settle(t);
  });

  test("the stored row LAST: an answer on the new card ahead of it is not shifted onto it", async () => {
    const { t, ids, stored } = await withStoredFirst();
    await commit(t, ids, [
      card({ cardNumber: "2", slRef: "SL-B", listingTitle: "New one #2" }),
      card({ cardNumber: "1", slRef: "SL-A", listingTitle: "Not mine #1" }),
    ]);
    const all = await rows(t, ids.leafId);
    expect(all.get("2")!.listingTitle).toBe("New one #2");
    expect(all.get("1")!.listingTitle).toBe(stored.listingTitle);
    await settle(t);
  });

  test("an over-cap title on a stored row's index still refuses the commit (checked before the match is known)", async () => {
    const { t, ids } = await withStoredFirst();
    await expect(
      commit(t, ids, [
        card({ cardNumber: "1", slRef: "SL-A", listingTitle: "t".repeat(90) }),
        card({ cardNumber: "2", slRef: "SL-B" }),
      ]),
    ).rejects.toThrow(/card #1: the title is 90 characters/);
    expect((await rows(t, ids.leafId)).has("2")).toBe(false);
    await settle(t);
  });

  test("an answered variation on a stored row does not rewrite the stored variation", async () => {
    const { t, ids, stored } = await withStoredFirst();
    await commit(t, ids, [
      card({ cardNumber: "1", slRef: "SL-A", cardVariation: "Trimmed", cardVariationAnswered: true }),
    ]);
    const after = (await rows(t, ids.leafId)).get("1")!;
    expect(after._id).toBe(stored._id);
    expect(after.cardVariation).toBe(stored.cardVariation);
    await settle(t);
  });
});
