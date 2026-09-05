/**
 * NEO-189 — `commitCardChecklist` commits a checklist in server-side CHUNKS.
 *
 * ## Why this file exists
 *
 * The commit used to be one mutation. On the PR #205 Convex preview a 712-card
 * checklist failed with `Your request timed out performing too many system
 * operations.`; a 335-card one passed but sat near its budget. NEO-189 is what
 * produces 712-card checklists in the first place — attaching SportLots
 * "Base Set" + "Base Set Series 2" + BSC to one variant roughly doubles a set —
 * so the ceiling is the feature, not a corner case.
 *
 * The fix splits the transaction: an action runs a prelude mutation, then one
 * chunk mutation per `CARDS_PER_COMMIT_CHUNK` cards, then a finalize mutation.
 * That split introduces failure modes a single transaction could not have:
 *
 *  - finalize's whole-commit bookkeeping (the unmatched-existing report, the
 *    custom-card sortOrder pass, the operator's explicit deletes) sees rows
 *    written by EVERY chunk, so if it were told only about the last chunk it
 *    would mis-report — and, before NEO-203 made deletion explicit, would have
 *    DELETED the rest of the commit it had just written;
 *  - a variation's parent can be written by a different chunk than the child,
 *    so the link cannot be resolved inside a chunk;
 *  - sortOrder is computed across the whole commit, so two chunks must not
 *    each number their own slice from zero.
 *
 * Every test here exists for one of those. The card counts are derived from
 * `CARDS_PER_COMMIT_CHUNK` rather than hard-coded so that raising the chunk
 * size cannot quietly turn these into single-chunk tests.
 *
 * Fixture conventions mirror convex/commitCardChecklist.variations.test.ts.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { CARDS_PER_COMMIT_CHUNK } from "./selectorOptions";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { compareCardNumbers } from "../lib/cards/card-number";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_chunking_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_chunking_001",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "user_chunking_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_chunking_001",
  name: "Ordinary User",
  role: "user",
};

/** 2.5 chunks — enough that a boundary falls in the middle of the batch. */
const TOTAL_CARDS = Math.ceil(CARDS_PER_COMMIT_CHUNK * 2.5);
/** Index of the variation's PARENT — first chunk. */
const PARENT_INDEX = 0;
/** Index of the VARIATION — a later chunk, by construction. */
const CHILD_INDEX = CARDS_PER_COMMIT_CHUNK + 10;

async function seedTree(t: ReturnType<typeof convexTest>) {
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
      value: "Heritage",
      platformData: {},
      features: { manufacturer: "Topps", season: "2021" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2021" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, variantTypeId };
  });
}

function card(
  cardNumber: string,
  cardName: string,
  extra: { isVariation?: boolean; cardVariation?: string } = {},
) {
  return {
    cardNumber,
    cardName,
    team: undefined,
    teams: [],
    players: [],
    attributes: [],
    isRookie: undefined,
    isRelic: undefined,
    printRun: undefined,
    autographType: undefined,
    cardVariation: extra.cardVariation,
    isVariation: extra.isVariation,
    // NEO-239 — a card carries a marketplace REF or it does not, and that is
    // now what decides whether upstream dropping it means anything. A row with
    // no ref has no upstream, so it is preserved and never reported as
    // "no longer listed" (which is what `isCustom` used to say, less
    // accurately). These fixtures model MARKETPLACE cards, so they carry one.
    platformData: { bsc: { ref: `bsc-${cardNumber}` } },
  };
}

/**
 * A multi-chunk batch. Filler numbers start at 1000 so they share no
 * card-number stem with the "5" / "5b" variation pair — the grouping rule
 * would otherwise pull an unrelated filler into the pair's group.
 */
function multiChunkCards() {
  const cards = [];
  for (let i = 0; i < TOTAL_CARDS; i++) {
    if (i === PARENT_INDEX) {
      cards.push(card("5", "Base Card Five"));
    } else if (i === CHILD_INDEX) {
      cards.push(
        card("5b", "Base Card Five", {
          isVariation: true,
          cardVariation: "Action",
        }),
      );
    } else {
      cards.push(card(String(1000 + i), `Filler ${1000 + i}`));
    }
  }
  return cards;
}

async function readChecklist(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
) {
  // Build the Map OUTSIDE t.run — a Map is not a Convex value and cannot cross
  // the mutation boundary. Collected whole and filtered in JS rather than via
  // `.withIndex`: convex-test's `t.run` ctx does not carry this schema's index
  // types, and the fixtures here are small enough that it costs nothing.
  const all = await t.run(async (ctx) => ctx.db.query("cardChecklist").collect());
  const rows = all.filter((r) => r.selectorOptionId === selectorOptionId);
  return { rows, byNumber: new Map(rows.map((r) => [r.cardNumber, r])) };
}

describe("commitCardChecklist — chunked commit", () => {
  test("a batch spanning several chunks stores every card exactly once", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const cards = multiChunkCards();
    expect(cards.length).toBeGreaterThan(CARDS_PER_COMMIT_CHUNK * 2);

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards,
      });

    expect(result).toMatchObject({ success: true, count: TOTAL_CARDS });

    const { rows, byNumber } = await readChecklist(t, variantTypeId);
    // Every chunk's rows are present, and finalize accounted for all of them:
    // a phase told only about the final chunk would report the first two
    // chunks as unmatched (and, before NEO-203, would have deleted them).
    expect(rows.length).toBe(TOTAL_CARDS);
    expect(result.unmatchedExistingCount).toBe(0);
    expect(byNumber.size).toBe(TOTAL_CARDS);
    for (const c of cards) expect(byNumber.has(c.cardNumber)).toBe(true);
    // Every row got a SKU — the insert-then-patch pair inside each chunk.
    expect(rows.every((r) => typeof r.sku === "string" && r.sku.length > 0)).toBe(
      true,
    );
  });

  test("sortOrder is numbered across the WHOLE commit, not per chunk", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const cards = multiChunkCards();

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards,
      });

    const { rows } = await readChecklist(t, variantTypeId);
    // A per-chunk numbering would restart at 0 for every chunk, so the set of
    // sortOrders would be {0..149} three times over instead of {0..N-1} once.
    const sortOrders = rows.map((r) => r.sortOrder ?? -1).sort((a, b) => a - b);
    expect(sortOrders).toEqual(
      Array.from({ length: TOTAL_CARDS }, (_, i) => i),
    );

    // And the ordering is the natural card-number ordering, not input order.
    const expectedOrder = cards
      .map((c) => c.cardNumber)
      .sort(compareCardNumbers);
    const actualOrder = [...rows]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((r) => r.cardNumber);
    expect(actualOrder).toEqual(expectedOrder);
  });

  test("a variation whose parent is in an EARLIER chunk still gets linked", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const cards = multiChunkCards();
    // The premise of this test, asserted rather than assumed.
    expect(Math.floor(PARENT_INDEX / CARDS_PER_COMMIT_CHUNK)).not.toBe(
      Math.floor(CHILD_INDEX / CARDS_PER_COMMIT_CHUNK),
    );

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards,
      });

    const { byNumber } = await readChecklist(t, variantTypeId);
    const parent = byNumber.get("5")!;
    const child = byNumber.get("5b")!;
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    // Neither chunk could see the other's ids — the action holds both.
    expect(child.variationOfCardId).toBe(parent._id);
    expect(child.cardVariation).toBe("Action");
    expect(parent.variationOfCardId).toBeUndefined();
  });

  /**
   * BEHAVIOUR CHANGE — NEO-203. This test used to be
   * "re-committing a SMALLER multi-chunk set deletes only the stale cards",
   * and asserted that finalize deleted every non-custom row the new payload
   * did not mention.
   *
   * That made a marketplace the authority on whether a NeonBinder card exists.
   * BSC dropping a listing, a short checklist, or a partially-failed fetch
   * destroyed NB rows and their cross-listings as a side effect of a sync.
   * NeonBinder owns its sets: a marketplace could be dropped entirely tomorrow
   * and every NB set must stand untouched.
   *
   * So the sweep is gone. A row upstream no longer lists is KEPT and counted
   * in `unmatchedExistingCount`; deleting it is a separate, explicit operator
   * decision carried by `operatorDeleteIds` on a later commit. The multi-chunk
   * premise still matters — finalize must see every chunk's ids, or it would
   * report the first two chunks' rows as unmatched.
   */
  test("re-committing a SMALLER multi-chunk set deletes NOTHING and reports the gap", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const cards = multiChunkCards();

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards,
      });
    const before = await readChecklist(t, variantTypeId);
    expect(before.rows.length).toBe(TOTAL_CARDS);

    // Still more than one chunk, so a report keyed on a single chunk's ids
    // would name the first chunk's rows as missing upstream.
    const smaller = cards.slice(0, CARDS_PER_COMMIT_CHUNK + 20);
    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: smaller,
      });

    const { rows, byNumber } = await readChecklist(t, variantTypeId);
    // Nothing was destroyed. Every row that existed before still exists.
    expect(rows.length).toBe(TOTAL_CARDS);
    expect(new Set(rows.map((r) => r._id))).toEqual(
      new Set(before.rows.map((r) => r._id)),
    );
    for (const c of cards) expect(byNumber.has(c.cardNumber)).toBe(true);
    // And the cards upstream stopped listing are reported, exactly once each,
    // so an operator can act on them instead of discovering them missing.
    expect(result.unmatchedExistingCount).toBe(cards.length - smaller.length);
    expect(result.operatorDeleted).toBe(0);
  });

  test("re-committing the SAME multi-chunk set upserts rather than duplicating", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const cards = multiChunkCards();

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards,
      });
    const first = await readChecklist(t, variantTypeId);

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards,
      });
    const second = await readChecklist(t, variantTypeId);

    expect(second.rows.length).toBe(TOTAL_CARDS);
    // Same rows, not new ones: the match is resolved once, against the
    // PRE-commit snapshot, and handed to every chunk. A chunk that re-read the
    // table would still find these rows — but it would also find the rows
    // earlier chunks of the same commit had just inserted, which is what would
    // collapse a legitimately duplicate-numbered checklist. See
    // convex/commitCardChecklist.duplicateNumbers.test.ts.
    //
    // NEO-203: these fixture cards carry no `platformData` at all, so they
    // match on the LAST tier of the cascade — bare cardNumber against rows
    // with no ref on either side. That tier is what keeps custom and legacy
    // rows re-syncable, and it applies here because every number in the
    // fixture is distinct.
    expect(new Set(second.rows.map((r) => r._id))).toEqual(
      new Set(first.rows.map((r) => r._id)),
    );
    // The cross-chunk variation link survives a re-sync.
    expect(second.byNumber.get("5b")!.variationOfCardId).toBe(
      second.byNumber.get("5")!._id,
    );
  });

  test("a non-admin is rejected and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .action(api.selectorOptions.commitCardChecklist, {
          selectorOptionId: variantTypeId,
          sportId,
          cards: multiChunkCards(),
        }),
    ).rejects.toThrow(/Admin access required/);

    // The action checks BEFORE the prelude, so not even the first chunk ran.
    expect((await readChecklist(t, variantTypeId)).rows.length).toBe(0);
    const players = await t.run(async (ctx) => ctx.db.query("players").collect());
    expect(players.length).toBe(0);
  });
});

/**
 * NEO-203 — matching survives BOTH kinds of scale at once: a checklist large
 * enough to span several chunks, carrying duplicate card numbers across two
 * source sets (the `duplicateNumbers.test.ts` shape), re-synced with
 * per-card corrections.
 *
 * The prelude resolves every match ONCE, from a single pre-commit snapshot,
 * and hands each chunk only the ids it needs — so this is really asserting
 * that `resolveExistingIds`' cascade and the chunk boundary never interact:
 * a correction aimed at a card in the FIRST chunk and one aimed at a card in
 * the LAST chunk each land on the one row they name, never on that row's
 * same-numbered sibling in the other series.
 */
describe("commitCardChecklist — chunked re-sync with duplicate-numbered cards (NEO-203)", () => {
  const S1 = "series-1";
  const S2 = "series-2";
  // Larger than one chunk on its own, so the combined two-series payload
  // spans at least three chunks and the two probed cards land in different
  // ones (see targetNumberEarly/targetNumberLate below).
  const PER_SERIES = CARDS_PER_COMMIT_CHUNK + 20;

  function dupCard(series: string, n: number, name: string) {
    return {
      cardNumber: String(n),
      cardName: name,
      team: undefined,
      teams: [],
      players: [],
      attributes: [],
      isRookie: undefined,
      isRelic: undefined,
      printRun: undefined,
      autographType: undefined,
      cardVariation: undefined,
      isVariation: undefined,
      platformData: { bsc: { ref: `${series}-card-${n}` } },
    };
  }

  test("a fresh multi-chunk commit stores every duplicate-numbered row distinctly, and a later multi-chunk re-sync corrects each row independently", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);

    const initialCards: ReturnType<typeof dupCard>[] = [];
    for (const series of [S1, S2]) {
      for (let n = 1; n <= PER_SERIES; n++) {
        initialCards.push(dupCard(series, n, `${series} player ${n}`));
      }
    }
    expect(initialCards.length).toBeGreaterThan(CARDS_PER_COMMIT_CHUNK * 2);

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: initialCards,
      });

    const { rows } = await readChecklist(t, variantTypeId);
    expect(rows).toHaveLength(initialCards.length);
    expect(new Set(rows.map((r) => r.cardNumber)).size).toBe(PER_SERIES);
    expect(new Set(rows.map((r) => r.platformData?.bsc?.ref)).size).toBe(
      initialCards.length,
    );

    const byRef = new Map(rows.map((r) => [r.platformData?.bsc?.ref, r]));

    // One card from the FIRST chunk, one from the LAST — different series, so
    // a number-keyed match would cross-contaminate them.
    const targetNumberEarly = 1;
    const targetNumberLate = PER_SERIES;
    const s1Early = byRef.get(`${S1}-card-${targetNumberEarly}`)!;
    const s2Late = byRef.get(`${S2}-card-${targetNumberLate}`)!;
    // The premise of this test, asserted rather than assumed: S1's #1 is the
    // very first card in the payload (chunk 1) and S2's last card is the very
    // last (a later chunk), so the fix below crosses a chunk boundary.
    const earlyIndex = 0;
    const lateIndex = initialCards.length - 1;
    expect(Math.floor(earlyIndex / CARDS_PER_COMMIT_CHUNK)).not.toBe(
      Math.floor(lateIndex / CARDS_PER_COMMIT_CHUNK),
    );

    const correctedCards = initialCards.map((c) => {
      if (c.platformData.bsc.ref === s1Early.platformData!.bsc!.ref) {
        return {
          ...c,
          cardName: "S1 Early Corrected",
          applyFields: ["cardName"],
          baseVersion: s1Early.lastUpdated,
        };
      }
      if (c.platformData.bsc.ref === s2Late.platformData!.bsc!.ref) {
        return {
          ...c,
          cardName: "S2 Late Corrected",
          applyFields: ["cardName"],
          baseVersion: s2Late.lastUpdated,
        };
      }
      return c;
    });

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: correctedCards,
      });

    expect(result.count).toBe(initialCards.length);
    expect(result.collisionInserts).toBe(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.staleDecisions).toBe(0);

    const after = (await readChecklist(t, variantTypeId)).rows;
    expect(after).toHaveLength(initialCards.length); // no duplication, no loss

    const afterByRef = new Map(after.map((r) => [r.platformData?.bsc?.ref, r]));
    const s1EarlyAfter = afterByRef.get(`${S1}-card-${targetNumberEarly}`)!;
    const s2LateAfter = afterByRef.get(`${S2}-card-${targetNumberLate}`)!;
    expect(s1EarlyAfter.cardName).toBe("S1 Early Corrected");
    expect(s2LateAfter.cardName).toBe("S2 Late Corrected");
    // The correction landed on the SAME row it started as...
    expect(s1EarlyAfter._id).toBe(s1Early._id);
    expect(s2LateAfter._id).toBe(s2Late._id);
    // ...and its same-numbered sibling in the OTHER series is untouched —
    // the Alice/Bob probe, at chunk-spanning scale.
    expect(afterByRef.get(`${S2}-card-${targetNumberEarly}`)!.cardName).toBe(
      `${S2} player ${targetNumberEarly}`,
    );
    expect(afterByRef.get(`${S1}-card-${targetNumberLate}`)!.cardName).toBe(
      `${S1} player ${targetNumberLate}`,
    );
  });
});
