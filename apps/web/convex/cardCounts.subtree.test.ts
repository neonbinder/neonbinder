/**
 * NEO-358 (Jason, 2026-10-24) — `selectorOptions.subtreeCardCount` and
 * `subtreeNonVariationCardCount`: the cards on a row or anywhere beneath it,
 * on every level, kept by the same `CardCountLedger` flush as the own counts
 * (convex/cardCounts.ts → "Subtree counts").
 *
 * Every case ends by holding the stored subtree counts against a fresh sum of
 * the true own counts, so a writer that moved the wrong chain fails here.
 * `cardCounts.pin.test.ts` pins that no writer is missed.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import {
  NEW_ROW_SUBTREE_COUNTS,
  createCardCountLedger,
  parseSubtreeResumeCursor,
  recountCards,
} from "./cardCounts";
import { removeCardRow } from "./cardRowDelete";
import { moveCards } from "./setShapeMove";
import { rehomeSetRowsToBrand } from "./brandRehome";
import { insertTestCard } from "../lib/testing/card-row";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "user_admin", role: "admin" };
const NOW = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;
type RowId = Id<"selectorOptions">;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Baseball › 2024 › Topps › Chrome (Base; an Insert type holding "Gold" with
 * a "Gold Refractor" parallel, and "Silver") and › Finest (Base), plus a
 * second brand, Bowman, with no sets.
 *
 * `known: true` (the default): every row born as a row is born today, with
 * both subtree counts at 0. `known: false`: every count absent, as on a row
 * written before NEO-358.
 */
async function seed(t: T, { known = true }: { known?: boolean } = {}) {
  return t.run(async (ctx) => {
    const row = (level: Doc<"selectorOptions">["level"], value: string, parentId?: RowId) =>
      ctx.db.insert("selectorOptions", {
        ...(known ? NEW_ROW_SUBTREE_COUNTS : {}),
        level,
        value,
        ...(parentId ? { parentId } : {}),
        platformData: {},
        children: [],
        lastUpdated: NOW,
      });
    const sport = await row("sport", "Baseball");
    const year = await row("year", "2024", sport);
    const brand = await row("manufacturer", "Topps", year);
    const bowman = await row("manufacturer", "Bowman", year);
    const set = await row("setName", "Chrome", brand);
    const otherSet = await row("setName", "Finest", brand);
    const base = await row("variantType", "Base", set);
    const otherBase = await row("variantType", "Base", otherSet);
    const insertType = await row("variantType", "Insert", set);
    const insert = await row("insert", "Gold", insertType);
    const silver = await row("insert", "Silver", insertType);
    const parallel = await row("parallel", "Gold Refractor", insert);
    for (const [parent, kids] of [
      [sport, [year]],
      [year, [brand, bowman]],
      [brand, [set, otherSet]],
      [set, [base, insertType]],
      [otherSet, [otherBase]],
      [insertType, [insert, silver]],
      [insert, [parallel]],
    ] as Array<[RowId, RowId[]]>) {
      await ctx.db.patch(parent, { children: kids });
    }
    return { sport, year, brand, bowman, set, otherSet, base, otherBase, insertType, insert, silver, parallel };
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

async function addCard(
  t: T,
  selectorOptionId: RowId,
  cardNumber: string,
  extra: Partial<Doc<"cardChecklist">> = {},
): Promise<Id<"cardChecklist">> {
  return t.run((ctx) =>
    insertTestCard(ctx, {
      selectorOptionId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      listingTitle: `Card ${cardNumber}`,
      platformData: {},
      sortOrder: Number.parseInt(cardNumber, 10) || 0,
      lastUpdated: NOW,
      ...extra,
    }),
  );
}

/** Insert a card through a ledger, flushed: what every real card insert does. */
async function insertCounted(
  t: T,
  selectorOptionId: RowId,
  cardNumber: string,
  extra: Partial<Doc<"cardChecklist">> = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) => {
    const ledger = createCardCountLedger();
    const id = await insertTestCard(ctx, {
      selectorOptionId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      platformData: {},
      sortOrder: 0,
      lastUpdated: NOW,
      ...extra,
    });
    ledger.addCard((await ctx.db.get(id))!);
    await ledger.flush(ctx);
    return id;
  });
}

/** The stored subtree counts on a row. */
const subtree = (t: T, id: RowId) =>
  t.run(async (ctx) => {
    const row = (await ctx.db.get(id))!;
    return { all: row.subtreeCardCount, base: row.subtreeNonVariationCardCount };
  });

/** The true subtree counts: own recount plus every child's, recursively. */
async function trueSubtree(t: T, id: RowId): Promise<{ all: number; base: number }> {
  return t.run(async (ctx) => {
    const walk = async (rowId: RowId): Promise<{ all: number; base: number }> => {
      const own = (await recountCards(ctx, rowId))!;
      let all = own.cardCount;
      let base = own.nonVariationCardCount;
      const kids = await ctx.db
        .query("selectorOptions")
        .withIndex("by_parent", (q) => q.eq("parentId", rowId))
        .collect();
      for (const kid of kids) {
        const sub = await walk(kid._id);
        all += sub.all;
        base += sub.base;
      }
      return { all, base };
    };
    return walk(id);
  });
}

/** Every row's stored subtree counts equal the truth. */
async function expectAllTrue(t: T, s: Seeded) {
  for (const id of Object.values(s)) {
    expect(await subtree(t, id), `row ${id}`).toEqual(await trueSubtree(t, id));
  }
}

const CHAIN = (s: Seeded) => [s.parallel, s.insert, s.insertType, s.set, s.brand, s.year, s.sport];

describe("the ledger carries every delta up the chain", () => {
  test("a card insert moves its row and every ancestor, and nothing beside them", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await insertCounted(t, s.parallel, "1");
    await insertCounted(t, s.parallel, "1a", { variationOfCardId: parent });
    for (const id of CHAIN(s)) {
      expect(await subtree(t, id)).toEqual({ all: 2, base: 1 });
    }
    for (const id of [s.base, s.silver, s.otherSet, s.otherBase, s.bowman]) {
      expect(await subtree(t, id)).toEqual({ all: 0, base: 0 });
    }
    await expectAllTrue(t, s);
  });

  test("one read and one patch per row per flush, however many cards", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      for (let i = 0; i < 25; i++) {
        const id = await insertTestCard(ctx, {
          selectorOptionId: i % 2 === 0 ? s.base : s.insert,
          cardNumber: String(i),
          cardName: `Card ${i}`,
          platformData: {},
          sortOrder: i,
          lastUpdated: NOW,
        });
        ledger.addCard((await ctx.db.get(id))!);
      }
      const get = vi.spyOn(ctx.db, "get");
      const patch = vi.spyOn(ctx.db, "patch");
      await ledger.flush(ctx);
      // base, insert, insertType, set, brand, year, sport: each once.
      const touched = new Set(patch.mock.calls.map((c) => String(c[0])));
      expect(patch.mock.calls.length).toBe(touched.size);
      expect(touched.size).toBe(7);
      expect(get.mock.calls.length).toBe(7);
    });
    expect(await subtree(t, s.set)).toEqual({ all: 25, base: 25 });
    await expectAllTrue(t, s);
  });

  test("commitCardChecklistChunk lands the subtree counts with the own counts", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.selectorOptions.commitCardChecklistChunk, {
      selectorOptionId: s.base,
      sportValue: "Baseball",
      setNameValue: "Chrome",
      cards: ["1", "2", "3"].map((n, i) => ({
        cardNumber: n,
        cardName: `Card ${n}`,
        platformData: {},
        sortOrder: i,
        playerNames: [],
        teamNames: [],
      })),
    });
    for (const id of [s.base, s.set, s.brand, s.year, s.sport]) {
      expect(await subtree(t, id)).toEqual({ all: 3, base: 3 });
    }
    await expectAllTrue(t, s);
  });

  test("deleteCard takes the card off every ancestor", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await insertCounted(t, s.insert, "1");
    await insertCounted(t, s.insert, "2");
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.deleteCard, { id: card });
    for (const id of [s.insert, s.insertType, s.set, s.brand, s.year, s.sport]) {
      expect(await subtree(t, id)).toEqual({ all: 1, base: 1 });
    }
    await expectAllTrue(t, s);
  });

  test("a variation link moves the base subtree count only", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await insertCounted(t, s.base, "1");
    const child = await insertCounted(t, s.base, "1a");
    const as = t.withIdentity(ADMIN);
    await as.mutation(api.selectorOptions.setCardVariationParent, {
      cardId: child,
      parentCardId: parent,
    });
    expect(await subtree(t, s.sport)).toEqual({ all: 2, base: 1 });
    await as.mutation(api.selectorOptions.setCardVariationParent, { cardId: child });
    expect(await subtree(t, s.sport)).toEqual({ all: 2, base: 2 });
    await expectAllTrue(t, s);
  });

  test("moveCards between sets: off one set, onto the other; the brand above both is unchanged", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = await insertCounted(t, s.base, "1");
    const b = await insertCounted(t, s.base, "2");
    await t.run(async (ctx) => {
      const cards = await Promise.all([a, b].map((id) => ctx.db.get(id)));
      await moveCards(ctx, s.otherBase, cards.map((card) => ({ card: card!, slotMap: {} })), NOW);
    });
    expect(await subtree(t, s.set)).toEqual({ all: 0, base: 0 });
    expect(await subtree(t, s.otherSet)).toEqual({ all: 2, base: 2 });
    expect(await subtree(t, s.brand)).toEqual({ all: 2, base: 2 });
    await expectAllTrue(t, s);
  });
});

describe("a row deleted in the same transaction", () => {
  test("its delta still reaches every ancestor, through the chain removeCardRow remembered", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await insertCounted(t, s.parallel, "1");
    await insertCounted(t, s.base, "9");
    // The card goes, then the emptied parallel row goes, THEN the flush: the
    // order `deleteEmptySelectorOptionRow` callers produce.
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      await removeCardRow(ctx, (await ctx.db.get(card))!, ledger);
      await ctx.db.patch(s.insert, { children: [] });
      await ctx.db.delete(s.parallel);
      await ledger.flush(ctx);
    });
    expect(await subtree(t, s.insert)).toEqual({ all: 0, base: 0 });
    expect(await subtree(t, s.insertType)).toEqual({ all: 0, base: 0 });
    expect(await subtree(t, s.set)).toEqual({ all: 1, base: 1 });
    expect(await subtree(t, s.sport)).toEqual({ all: 1, base: 1 });
    const { parallel: _gone, ...rest } = s;
    void _gone;
    for (const id of Object.values(rest)) {
      expect(await subtree(t, id)).toEqual(await trueSubtree(t, id));
    }
  });

  test("an ancestor deleted too is walked through as well", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await insertCounted(t, s.parallel, "1");
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      await removeCardRow(ctx, (await ctx.db.get(card))!, ledger);
      await ctx.db.delete(s.parallel);
      await ctx.db.delete(s.insert);
      await ledger.flush(ctx);
    });
    for (const id of [s.insertType, s.set, s.brand, s.year, s.sport]) {
      expect(await subtree(t, id)).toEqual({ all: 0, base: 0 });
    }
  });
});

describe("unknown and drifted counts", () => {
  test("an ABSENT ancestor stays absent; the rows around it still move", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) =>
      ctx.db.patch(s.brand, { subtreeCardCount: undefined, subtreeNonVariationCardCount: undefined }),
    );
    await insertCounted(t, s.base, "1");
    expect(await subtree(t, s.brand)).toEqual({ all: undefined, base: undefined });
    expect(await subtree(t, s.set)).toEqual({ all: 1, base: 1 });
    expect(await subtree(t, s.year)).toEqual({ all: 1, base: 1 });
  });

  test("a subtree count that would go negative is cleared to unknown and logged, never clamped", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await insertCounted(t, s.base, "1");
    await t.run((ctx) => ctx.db.patch(s.set, { subtreeCardCount: 0, subtreeNonVariationCardCount: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.deleteCard, { id: card });
    expect(await subtree(t, s.set)).toEqual({ all: undefined, base: undefined });
    expect(await subtree(t, s.brand)).toEqual({ all: 0, base: 0 });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"msg":"subtree_card_count_drift"'))).toBe(true);
  });
});

describe("a re-parented row takes its subtree count with it", () => {
  test("applyParallelGroupings: a reparented parallel leaves one insert for the other; the type is unchanged", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await insertCounted(t, s.parallel, "1");
    await insertCounted(t, s.parallel, "2");
    await insertCounted(t, s.insert, "3");
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: s.insertType,
      promotions: [],
      demotions: [],
      reparentings: [{ parallelId: s.parallel, newInsertId: s.silver }],
    });
    expect(await subtree(t, s.insert)).toEqual({ all: 1, base: 1 });
    expect(await subtree(t, s.silver)).toEqual({ all: 2, base: 2 });
    expect(await subtree(t, s.insertType)).toEqual({ all: 3, base: 3 });
    await expectAllTrue(t, s);
  });

  test("applyParallelGroupings: a promotion and a demotion in one plan compose", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await insertCounted(t, s.parallel, "1");
    await insertCounted(t, s.silver, "2");
    await insertCounted(t, s.silver, "3");
    // Silver becomes a parallel of Gold; Gold Refractor becomes an insert.
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: s.insertType,
      promotions: [{ insertId: s.silver, targetInsertId: s.insert }],
      demotions: [{ parallelId: s.parallel }],
    });
    expect(await subtree(t, s.insert)).toEqual({ all: 2, base: 2 });
    expect(await subtree(t, s.parallel)).toEqual({ all: 1, base: 1 });
    await expectAllTrue(t, s);
  });

  test("rehomeSetRowsToBrand: a set moved to another brand moves its cards across brands", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await insertCounted(t, s.base, "1");
    await insertCounted(t, s.otherBase, "2");
    await t.run(async (ctx) => {
      await rehomeSetRowsToBrand(ctx, { rows: [(await ctx.db.get(s.set))!], brandId: s.bowman });
    });
    expect(await subtree(t, s.brand)).toEqual({ all: 1, base: 1 });
    expect(await subtree(t, s.bowman)).toEqual({ all: 1, base: 1 });
    expect(await subtree(t, s.year)).toEqual({ all: 2, base: 2 });
    await expectAllTrue(t, s);
  });

  test("a row of UNKNOWN size makes both brands unknown, and the year they share stays", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await insertCounted(t, s.base, "1");
    await t.run((ctx) =>
      ctx.db.patch(s.set, { subtreeCardCount: undefined, subtreeNonVariationCardCount: undefined }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await t.run(async (ctx) => {
      await rehomeSetRowsToBrand(ctx, { rows: [(await ctx.db.get(s.set))!], brandId: s.bowman });
    });
    expect(await subtree(t, s.brand)).toEqual({ all: undefined, base: undefined });
    expect(await subtree(t, s.bowman)).toEqual({ all: undefined, base: undefined });
    expect(await subtree(t, s.year)).toEqual({ all: 1, base: 1 });
  });
});

describe("backfillSubtreeCardCounts", () => {
  async function legacy(t: T) {
    const s = await seed(t, { known: false });
    const parent = await addCard(t, s.base, "1");
    await addCard(t, s.base, "1a", { variationOfCardId: parent });
    await addCard(t, s.parallel, "2");
    // Own counts are stored on one row and absent on the rest: the backfill
    // recounts an absent own count read-only.
    await t.run((ctx) => ctx.db.patch(s.parallel, { cardCount: 1, nonVariationCardCount: 1 }));
    return s;
  }

  test("a dry run writes nothing; levels above an unfilled one report as waiting", async () => {
    const t = convexTest(schema, modules);
    const s = await legacy(t);
    const result = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {});
    expect(result).toMatchObject({ armed: false, complete: true, scanned: 12 });
    // Rows with no unfilled child: the parallel, Silver, both Bases and the
    // empty Bowman brand. Every other row waits on a child a dry run cannot
    // fill.
    expect(result.filled).toBe(5);
    expect(result.waiting).toBe(7);
    expect(await subtree(t, s.sport)).toEqual({ all: undefined, base: undefined });
  });

  test("an armed run on an unarmed deployment is refused, not thrown", async () => {
    const t = convexTest(schema, modules);
    await legacy(t);
    const result = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {
      confirm: "BACKFILL",
    });
    expect(result.armed).toBe(false);
    expect(result.message).toMatch(/not armed/);
  });

  test("armed: fills every level bottom-up; a disagreeing count is fixed only with repair", async () => {
    vi.stubEnv("ALLOW_SUBTREE_CARD_COUNT_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const s = await legacy(t);
    const first = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {
      confirm: "BACKFILL",
    });
    expect(first).toMatchObject({ armed: true, complete: true, filled: 12, waiting: 0 });
    expect(await subtree(t, s.sport)).toEqual({ all: 3, base: 2 });
    expect(await subtree(t, s.otherSet)).toEqual({ all: 0, base: 0 });
    await expectAllTrue(t, s);

    await t.run((ctx) => ctx.db.patch(s.set, { subtreeCardCount: 40, subtreeNonVariationCardCount: 30 }));
    const plain = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {
      confirm: "BACKFILL",
    });
    // The set disagrees with its children, and the brand with the tampered
    // set it is summed from (the year sums the brand's stored, true count).
    expect(plain).toMatchObject({ filled: 0, disagreed: 2, repaired: 0 });
    expect(await subtree(t, s.set)).toEqual({ all: 40, base: 30 });

    const repair = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {
      confirm: "BACKFILL",
      repair: true,
    });
    // Bottom-up, so the set is repaired before the brand, year and sport are
    // summed: they then agree, and only the set is rewritten.
    expect(repair).toMatchObject({ filled: 0, disagreed: 1, repaired: 1 });
    await expectAllTrue(t, s);

    const again = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {
      confirm: "BACKFILL",
    });
    expect(again).toMatchObject({ filled: 0, disagreed: 0, repaired: 0, waiting: 0 });
  });

  test("pages across levels one row at a time and resumes from the cursor it returns", async () => {
    vi.stubEnv("ALLOW_SUBTREE_CARD_COUNT_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const s = await legacy(t);
    const result = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {
      confirm: "BACKFILL",
      numItems: 1,
    });
    expect(result).toMatchObject({ complete: true, scanned: 12, filled: 12 });
    await expectAllTrue(t, s);
    expect(parseSubtreeResumeCursor("year:3:abc:def")).toEqual({
      levelIndex: 5,
      skip: 3,
      cursor: "abc:def",
    });
    expect(parseSubtreeResumeCursor("parallel")).toEqual({ levelIndex: 0, skip: 0, cursor: null });
    expect(() => parseSubtreeResumeCursor("league:0:")).toThrow(/not one this backfill returned/);
  });

  test("the ledger keeps a backfilled tree true from then on", async () => {
    vi.stubEnv("ALLOW_SUBTREE_CARD_COUNT_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const s = await legacy(t);
    await t.action(internal.cardCounts.backfillSubtreeCardCounts, { confirm: "BACKFILL" });
    await insertCounted(t, s.silver, "7");
    await expectAllTrue(t, s);
  });
});
