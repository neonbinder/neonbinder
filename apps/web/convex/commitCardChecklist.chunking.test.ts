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
 *  - the stale-card sweep in finalize sees rows written by EVERY chunk, so if
 *    it were told only about the last chunk it would delete the rest of the
 *    commit it just wrote;
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
    platformData: {},
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
    // The finalize phase sweeps rows it was not told about. If it had seen
    // only the final chunk's ids, the first two chunks would be gone.
    expect(rows.length).toBe(TOTAL_CARDS);
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

  test("re-committing a SMALLER multi-chunk set deletes only the stale cards", async () => {
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
    expect((await readChecklist(t, variantTypeId)).rows.length).toBe(TOTAL_CARDS);

    // Still more than one chunk, so a sweep keyed on a single chunk's ids
    // would delete the first chunk's rows along with the genuinely stale ones.
    const smaller = cards.slice(0, CARDS_PER_COMMIT_CHUNK + 20);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: smaller,
      });

    const { rows, byNumber } = await readChecklist(t, variantTypeId);
    expect(rows.length).toBe(smaller.length);
    // Kept: everything still on the checklist, including the first chunk's
    // very first row.
    for (const c of smaller) expect(byNumber.has(c.cardNumber)).toBe(true);
    // Dropped: everything the marketplace no longer lists.
    for (const c of cards.slice(smaller.length)) {
      expect(byNumber.has(c.cardNumber)).toBe(false);
    }
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
    // Same rows, not new ones: the upsert key is resolved once, against the
    // PRE-commit snapshot, and handed to every chunk. A chunk that re-read the
    // table would still find these rows — but it would also find the rows
    // earlier chunks of the same commit had just inserted, which is what would
    // collapse a legitimately duplicate-numbered checklist. See
    // convex/commitCardChecklist.duplicateNumbers.test.ts.
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
