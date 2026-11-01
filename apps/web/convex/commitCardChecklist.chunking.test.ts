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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  CARDS_PER_COMMIT_CHUNK,
  FINALIZE_DELETES_PER_PAGE,
  FINALIZE_REVIEW_ROWS_PER_PAGE,
  FINALIZE_ROWS_PER_PAGE,
  type FinalizePageResult,
  type FinalizeResume,
} from "./selectorOptions";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { compareCardNumbers } from "../lib/cards/card-number";
import { drainScheduled, cancelScheduled } from "../lib/testing/drain-scheduled";

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

beforeEach(() => {
  // NEO-188/NEO-247: commitCardChecklist can schedule a BSC per-card team
  // lookup (processBscTeamEnrichmentQueue) as a side effect. This file has
  // nothing to say about team resolution. A THROWING stub rather than a
  // canned 200 — same convention as
  // convex/cardChecklist.bscTeamEnrichment.test.ts's NEO-220 fix: the
  // adapter already swallows a request failure ("network unavailable" is a
  // state it handles), and it cannot write anything derived from a payload
  // this file invented.
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(
        `NEO-247: this test file must not reach the network: ${String(url)}`,
      );
    }) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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
    await drainScheduled(t);
    await cancelScheduled(t);
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
    await drainScheduled(t);
    await cancelScheduled(t);
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
    await drainScheduled(t);
    await cancelScheduled(t);
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
    await drainScheduled(t);
    await cancelScheduled(t);
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
    await drainScheduled(t);
    await cancelScheduled(t);
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
    await drainScheduled(t);
    await cancelScheduled(t);
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
    await drainScheduled(t);
    await cancelScheduled(t);
  });
});

// ===========================================================================
// NEO-294 — the FINALIZE phase is bounded, resumable and idempotent
//
// The chunk phase has been bounded since NEO-189. Finalize was not: it read
// the whole checklist and deleted the whole review batch in one transaction,
// and PR #272's 1996 Score commit (220 cards, 433 review rows) died on
// `Your request timed out performing too many system operations.` AFTER every
// chunk had written — the worst possible place to fail, because the cards are
// on disk and none of the bookkeeping is.
//
// So finalize does one bounded page of one phase per call and the action walks
// it. What these pin is everything that has to stay true once it does: the
// walk completes across pages, `hasMore` is honest, an interrupted walk loses
// nothing and applies nothing twice, a small commit is still a couple of
// round trips, and every whole-commit pass finalize owns still produces the
// same answer it produced in one transaction.
// ===========================================================================

describe("commitCardChecklistFinalize — bounded, resumable pages (NEO-294)", () => {
  /** The empty whole-commit lists every direct drive below starts from. */
  function baseFinalizeArgs(selectorOptionId: Id<"selectorOptions">) {
    return {
      selectorOptionId,
      committedIds: [] as Array<Id<"cardChecklist">>,
      committedNumbers: [] as string[],
      operatorDeleteIds: [] as Array<Id<"cardChecklist">>,
      variationLinks: [] as Array<{
        childId: Id<"cardChecklist">;
        parentId: Id<"cardChecklist">;
      }>,
      variationClearIds: [] as Array<Id<"cardChecklist">>,
      customSortOrders: [] as Array<{ cardNumber: string; sortOrder: number }>,
      resolvedPlayerNames: [] as string[],
      resolvedTeamNames: [] as string[],
      skippedPlayerNames: [] as string[],
      skippedTeamNames: [] as string[],
      reviewRowIds: [] as Array<Id<"entityReviewQueue">>,
      bscTeamEnrichmentIds: [] as Array<Id<"cardChecklist">>,
      cardCount: 0,
    };
  }

  /**
   * The action's walk, as `commitCardChecklist` performs it: keep calling with
   * the `resume` the server returned until it says stop.
   */
  async function drainFinalize(
    t: ReturnType<typeof convexTest>,
    args: ReturnType<typeof baseFinalizeArgs>,
  ) {
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    let resume: FinalizeResume | null = null;
    let calls = 0;
    let variationsLinked = 0;
    let operatorDeleted = 0;
    let deleteSkipped = 0;
    const unmatchedExistingIds: Array<Id<"cardChecklist">> = [];
    const phases: string[] = [];
    for (;;) {
      const page: FinalizePageResult = await asAdmin.mutation(
        internal.selectorOptions.commitCardChecklistFinalize,
        { ...args, ...(resume ? { resume } : {}) },
      );
      calls += 1;
      variationsLinked += page.variationsLinked;
      operatorDeleted += page.operatorDeleted;
      deleteSkipped += page.deleteSkipped;
      unmatchedExistingIds.push(...page.unmatchedExistingIds);
      if (page.resume) phases.push(page.resume.phase);
      if (!page.hasMore || page.resume === null) {
        return {
          calls,
          variationsLinked,
          operatorDeleted,
          deleteSkipped,
          unmatchedExistingIds,
          phases,
        };
      }
      resume = page.resume;
      // A walk that cannot terminate is the failure mode a resume token
      // introduces; fail loudly rather than hanging the suite.
      if (calls > 200) throw new Error("finalize walk did not terminate");
    }
  }

  /** `count` bare marketplace rows on one checklist, in one transaction. */
  async function seedRows(
    t: ReturnType<typeof convexTest>,
    selectorOptionId: Id<"selectorOptions">,
    count: number,
    opts: { ref?: boolean } = {},
  ): Promise<Array<Id<"cardChecklist">>> {
    const withRef = opts.ref ?? true;
    return t.run(async (ctx) => {
      const ids: Array<Id<"cardChecklist">> = [];
      for (let i = 0; i < count; i++) {
        ids.push(
          await ctx.db.insert("cardChecklist", {
            selectorOptionId,
            cardNumber: String(i + 1),
            cardName: `Card ${i + 1}`,
            sortOrder: i,
            lastUpdated: Date.now(),
            // `platformData` is required on the row; whether it carries a REF
            // is what `hasMarketplaceRef` asks, and what decides which of
            // finalize's passes a row is in scope for.
            platformData: withRef ? { bsc: { ref: `bsc-${i + 1}` } } : {},
          }),
        );
      }
      return ids;
    });
  }

  test("a checklist larger than one page is walked completely, across several calls", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    // Every row is a ref-carrying row no incoming card matched, so the
    // unmatched-existing report is the pass that proves the whole checklist
    // was seen — not just the first page.
    const total = FINALIZE_ROWS_PER_PAGE * 2 + 7;
    const ids = await seedRows(t, variantTypeId, total);

    const walk = await drainFinalize(t, baseFinalizeArgs(variantTypeId));

    expect(walk.unmatchedExistingIds.sort()).toEqual([...ids].sort());
    // Three row pages (the short third ends the walk) plus the tail.
    expect(walk.calls).toBe(4);
  });

  test("one call does ONE page and no more", async () => {
    // The property the 1996 Score commit needed: whatever the checklist's
    // size, a single transaction's work is capped.
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    await seedRows(t, variantTypeId, FINALIZE_ROWS_PER_PAGE * 3);

    const first: FinalizePageResult = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(internal.selectorOptions.commitCardChecklistFinalize, {
        ...baseFinalizeArgs(variantTypeId),
      });

    expect(first.unmatchedExistingIds.length).toBe(FINALIZE_ROWS_PER_PAGE);
    expect(first.hasMore).toBe(true);
    expect(first.resume).toEqual({
      phase: "rows",
      offset: 0,
      rowCursor: expect.any(Number),
    });
  });

  test("hasMore is true while work remains and false only on the tail", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    // One row past a full page, so the row walk ends on a genuinely short
    // page rather than on an exactly-full one.
    await seedRows(t, variantTypeId, FINALIZE_ROWS_PER_PAGE + 1);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const args = baseFinalizeArgs(variantTypeId);

    const first: FinalizePageResult = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistFinalize,
      args,
    );
    expect(first.hasMore).toBe(true);
    expect(first.resume!.phase).toBe("rows");

    const second: FinalizePageResult = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistFinalize,
      { ...args, resume: first.resume! },
    );
    // A short page ends the ROW walk, but not the run: the tail still has to
    // happen, and it is the only page allowed to say `hasMore: false`.
    expect(second.unmatchedExistingIds.length).toBe(1);
    expect(second.hasMore).toBe(true);
    expect(second.resume!.phase).toBe("review");

    const tail: FinalizePageResult = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistFinalize,
      { ...args, resume: second.resume! },
    );
    expect(tail.hasMore).toBe(false);
    expect(tail.resume).toBeNull();
  });

  test("a checklist smaller than a page is a row page and a tail, and nothing more", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    await seedRows(t, variantTypeId, 3);

    const walk = await drainFinalize(t, baseFinalizeArgs(variantTypeId));

    expect(walk.calls).toBe(2);
    expect(walk.unmatchedExistingIds.length).toBe(3);
    // No deletes were asked for, so that phase is never entered at all.
    expect(walk.phases).toEqual(["review"]);
  });

  test("an interrupted walk keeps what it wrote, and re-running finishes without applying anything twice", async () => {
    // The operator's connection drops after the first page. Nothing is rolled
    // back, nothing is half-written, and re-invoking the commit re-sends the
    // same lists and converges.
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const total = FINALIZE_ROWS_PER_PAGE * 2 + 5;
    const ids = await seedRows(t, variantTypeId, total, { ref: false });

    // Every row is ref-less and preserved, and every one of them wants a new
    // sortOrder — so the row pass has a visible, countable write per row.
    const args = {
      ...baseFinalizeArgs(variantTypeId),
      customSortOrders: ids.map((_, i) => ({
        cardNumber: String(i + 1),
        sortOrder: 5000 + i,
      })),
    };

    const first: FinalizePageResult = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistFinalize,
      args,
    );
    expect(first.hasMore).toBe(true);
    const afterInterruption = await t.run(async (ctx) =>
      Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.sortOrder)),
    );
    // Exactly the first page was re-ordered; the rest are untouched.
    expect(
      afterInterruption.filter((s) => s !== undefined && s >= 5000).length,
    ).toBe(FINALIZE_ROWS_PER_PAGE);

    // …and the resume token is GONE with the connection, so the re-run starts
    // over from the head of the checklist.
    const rerun = await drainFinalize(t, args);

    expect(rerun.calls).toBe(4);
    const final = await t.run(async (ctx) =>
      Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.sortOrder)),
    );
    // Every row landed on its target exactly once. A pass that double-applied
    // would have moved the first page's rows twice; one that lost work would
    // have left the tail of the checklist on its original order.
    expect(final).toEqual(ids.map((_, i) => 5000 + i));
  });

  test("a replayed page writes nothing the first one did not", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const ids = await seedRows(t, variantTypeId, 5, { ref: false });
    const args = {
      ...baseFinalizeArgs(variantTypeId),
      customSortOrders: ids.map((_, i) => ({
        cardNumber: String(i + 1),
        sortOrder: 900 + i,
      })),
    };

    await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistFinalize,
      args,
    );
    const stamps = await t.run(async (ctx) =>
      Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.lastUpdated)),
    );

    // Same call, same (absent) resume, twice — a retry after a dropped
    // response. Every pass here patches only when the value differs, which is
    // what makes that a no-op.
    await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistFinalize,
      args,
    );

    expect(
      await t.run(async (ctx) =>
        Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.lastUpdated)),
      ),
    ).toEqual(stamps);
  });

  test("operator deletes are their own bounded phase, and every id is ruled on exactly once", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const total = FINALIZE_DELETES_PER_PAGE + 10;
    const ids = await seedRows(t, variantTypeId, total);

    const walk = await drainFinalize(t, {
      ...baseFinalizeArgs(variantTypeId),
      operatorDeleteIds: ids,
    });

    expect(walk.operatorDeleted).toBe(total);
    expect(walk.deleteSkipped).toBe(0);
    // Two delete pages, then the row walk over an empty checklist, then the
    // tail — and the row walk sees nothing, because deletes run first.
    expect(walk.phases).toEqual(["deletes", "rows", "review"]);
    expect(walk.unmatchedExistingIds).toEqual([]);
    const { rows } = await readChecklist(t, variantTypeId);
    expect(rows).toEqual([]);
  });

  test("an interrupted delete phase leaves whole rows, never torn ones, and a re-run finishes the list", async () => {
    // The guarantee that actually matters once whole-list atomicity is gone: a
    // card's cross-listings and its children's re-parenting are in the SAME
    // page as its own delete, so a partial walk is a shorter delete list and
    // never a dangling pointer.
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const total = FINALIZE_DELETES_PER_PAGE + 6;
    const ids = await seedRows(t, variantTypeId, total);
    // Give the first id a cross-listing and a variation child, the two things
    // a delete has to tidy.
    const childId = ids[total - 1];
    await t.run(async (ctx) => {
      await ctx.db.insert("cardCrossListings", {
        cardChecklistId: ids[0],
        selectorOptionId: variantTypeId,
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(childId, { variationOfCardId: ids[0] });
    });
    const args = { ...baseFinalizeArgs(variantTypeId), operatorDeleteIds: ids };

    const first: FinalizePageResult = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistFinalize,
      args,
    );
    expect(first.operatorDeleted).toBe(FINALIZE_DELETES_PER_PAGE);
    // The interrupted state: the first page's rows are gone WITH their
    // cross-listings, and the child it parented is an ordinary card again.
    const midwalk = await t.run(async (ctx) => ({
      crossListings: (await ctx.db.query("cardCrossListings").collect()).length,
      child: (await ctx.db.get(childId))!.variationOfCardId ?? null,
      survivors: (await ctx.db.query("cardChecklist").collect()).length,
    }));
    expect(midwalk.crossListings).toBe(0);
    expect(midwalk.child).toBeNull();
    expect(midwalk.survivors).toBe(total - FINALIZE_DELETES_PER_PAGE);

    // The re-run re-sends the whole list. The ids already gone are refused and
    // counted, never deleted twice and never thrown on.
    const rerun = await drainFinalize(t, args);
    expect(rerun.operatorDeleted).toBe(total - FINALIZE_DELETES_PER_PAGE);
    expect(rerun.deleteSkipped).toBe(FINALIZE_DELETES_PER_PAGE);
    const { rows } = await readChecklist(t, variantTypeId);
    expect(rows).toEqual([]);
  });

  test("a delete of a row that came back in this commit is refused, not silently dropped from the count", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const ids = await seedRows(t, variantTypeId, 3);

    const walk = await drainFinalize(t, {
      ...baseFinalizeArgs(variantTypeId),
      operatorDeleteIds: ids,
      committedIds: [ids[1]],
    });

    expect(walk.operatorDeleted).toBe(2);
    expect(walk.deleteSkipped).toBe(1);
    const { rows } = await readChecklist(t, variantTypeId);
    expect(rows.map((r) => r._id)).toEqual([ids[1]]);
  });

  test("the review batch is deleted in bounded pages, and an interrupted run resumes without failing on a row already gone", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const reviewRowIds = await t.run(async (ctx) => {
      const out: Array<Id<"entityReviewQueue">> = [];
      for (let i = 0; i < FINALIZE_REVIEW_ROWS_PER_PAGE + 11; i++) {
        out.push(
          await ctx.db.insert("entityReviewQueue", {
            selectorOptionId: variantTypeId,
            batchId: "finalize-batch",
            createdByUserId: ADMIN_IDENTITY.subject,
            kind: "player",
            name: `Rookie${i}`,
            sportId,
            status: "ready",
            decision: { action: "create" },
          }),
        );
      }
      return out;
    });
    const args = { ...baseFinalizeArgs(variantTypeId), reviewRowIds };

    // Walk to the review phase by hand so the interruption lands inside it.
    let page: FinalizePageResult = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistFinalize,
      args,
    );
    expect(page.resume!.phase).toBe("review");
    page = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistFinalize,
      { ...args, resume: page.resume! },
    );
    expect(page.hasMore).toBe(true);
    expect(page.resume).toEqual({
      phase: "review",
      offset: FINALIZE_REVIEW_ROWS_PER_PAGE,
      rowCursor: null,
    });
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("entityReviewQueue").collect()).length,
      ),
    ).toBe(reviewRowIds.length - FINALIZE_REVIEW_ROWS_PER_PAGE);

    // …and the re-run re-sends the whole id list. The rows already deleted are
    // existence-checked rather than deleted again, which is what keeps a
    // replayed page from failing an otherwise complete commit.
    const rerun = await drainFinalize(t, args);
    expect(rerun.calls).toBeGreaterThan(1);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("entityReviewQueue").collect()).length,
      ),
    ).toBe(0);
  });

  test("a variation whose parent sits several row pages earlier is still linked", async () => {
    // The whole reason finalize owns the variation pass: a child in a late
    // page and a parent in an early one. Paging the walk must not reintroduce
    // the limitation chunking had.
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    const ids = await seedRows(t, variantTypeId, FINALIZE_ROWS_PER_PAGE * 2 + 3);
    const parentId = ids[0];
    const childId = ids[FINALIZE_ROWS_PER_PAGE * 2 + 1];

    const walk = await drainFinalize(t, {
      ...baseFinalizeArgs(variantTypeId),
      variationLinks: [{ childId, parentId }],
    });

    expect(walk.variationsLinked).toBe(1);
    expect(
      await t.run(async (ctx) => (await ctx.db.get(childId))!.variationOfCardId),
    ).toBe(parentId);
  });

  test("the tail runs once, on the last page, and an interrupted walk schedules nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await seedRows(t, variantTypeId, FINALIZE_ROWS_PER_PAGE + 2);
    const args = {
      ...baseFinalizeArgs(variantTypeId),
      setNameAncestorId: variantTypeId,
      cardCount: 42,
    };

    const first: FinalizePageResult = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistFinalize,
      args,
    );
    expect(first.hasMore).toBe(true);
    // The setName harvest has NOT happened yet — it belongs to the tail.
    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.get(variantTypeId))!.features?.totalCardCount ?? null,
      ),
    ).toBeNull();

    await drainFinalize(t, args);

    expect(
      await t.run(
        async (ctx) => (await ctx.db.get(variantTypeId))!.features?.totalCardCount,
      ),
    ).toBe("42");
    // Nothing above reaches the sport row; asserted so a future tail addition
    // has to think about which page it belongs on.
    expect(await t.run(async (ctx) => (await ctx.db.get(sportId))!.level)).toBe(
      "sport",
    );
  });
});
