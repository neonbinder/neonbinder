/**
 * NEO-358 (Jason, 2026-10-24) — `selectorOptions.subtreeCardCount` and
 * `subtreeNonVariationCardCount`: the cards on a row or anywhere beneath it,
 * kept from the SET down by the same `CardCountLedger` flush as the own
 * counts; and NEO-364 (Jason, 2026-10-25) — the one-time `hasCards` flag on
 * sport, year and manufacturer rows, which keep no subtree counts
 * (convex/cardCounts.ts → "Subtree counts and `hasCards`").
 *
 * Every case ends by holding the stored subtree counts against a fresh sum of
 * the true own counts, and every flag-level row with cards beneath it against
 * its flag, so a writer that moved the wrong chain fails here.
 * `cardCounts.pin.test.ts` pins that no writer is missed.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import {
  carriesHasCards,
  createCardCountLedger,
  newRowSubtreeCounts,
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
 * `known: true` (the default): every row born as a row is born today: both
 * subtree counts at 0 from the set down, nothing on the sport, year and
 * brands. `known: false`: every count absent, as on a row written before
 * NEO-358.
 */
async function seed(t: T, { known = true }: { known?: boolean } = {}) {
  return t.run(async (ctx) => {
    const row = (level: Doc<"selectorOptions">["level"], value: string, parentId?: RowId) =>
      ctx.db.insert("selectorOptions", {
        ...(known ? newRowSubtreeCounts(level) : {}),
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

/** A row's `hasCards` flag, as stored. */
const flag = (t: T, id: RowId) => t.run(async (ctx) => (await ctx.db.get(id))!.hasCards);

/** A flag-level row as the drill reads it: no subtree counts, and its flag. */
const flagRow = (t: T, id: RowId) =>
  t.run(async (ctx) => {
    const row = (await ctx.db.get(id))!;
    return { all: row.subtreeCardCount, base: row.subtreeNonVariationCardCount, hasCards: row.hasCards };
  });

const FLAGGED = { all: undefined, base: undefined, hasCards: true };
const UNFLAGGED = { all: undefined, base: undefined, hasCards: undefined };

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

/**
 * From the set down, every row's stored subtree counts equal the truth. A
 * sport, year or brand keeps none, and is flagged whenever cards sit beneath
 * it (a flag is never cleared, so an emptied one may stay flagged).
 */
async function expectAllTrue(t: T, s: Partial<Seeded> & Record<string, RowId>) {
  for (const id of Object.values(s)) {
    const level = await t.run(async (ctx) => (await ctx.db.get(id))!.level);
    if (carriesHasCards(level)) {
      expect(await subtree(t, id), `row ${id}`).toEqual({ all: undefined, base: undefined });
      if ((await trueSubtree(t, id)).all > 0) expect(await flag(t, id), `row ${id}`).toBe(true);
      continue;
    }
    expect(await subtree(t, id), `row ${id}`).toEqual(await trueSubtree(t, id));
  }
}

/** The rows from the card's row up to its set: the ones that keep counts. */
const CHAIN = (s: Seeded) => [s.parallel, s.insert, s.insertType, s.set];
/** The rows above the set: the ones that carry `hasCards`. */
const ABOVE = (s: Seeded) => [s.brand, s.year, s.sport];

describe("the ledger carries every delta up the chain", () => {
  test("a card insert moves its row and every ancestor, and nothing beside them", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await insertCounted(t, s.parallel, "1");
    await insertCounted(t, s.parallel, "1a", { variationOfCardId: parent });
    for (const id of CHAIN(s)) {
      expect(await subtree(t, id)).toEqual({ all: 2, base: 1 });
    }
    for (const id of ABOVE(s)) expect(await flagRow(t, id)).toEqual(FLAGGED);
    for (const id of [s.base, s.silver, s.otherSet, s.otherBase]) {
      expect(await subtree(t, id)).toEqual({ all: 0, base: 0 });
    }
    expect(await flagRow(t, s.bowman)).toEqual(UNFLAGGED);
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
      // base, insert, insertType, set: each once; brand, year and sport
      // once each too, for their first card (`hasCards`).
      const touched = new Set(patch.mock.calls.map((c) => String(c[0])));
      expect(patch.mock.calls.length).toBe(touched.size);
      expect(touched.size).toBe(7);
      expect(get.mock.calls.length).toBe(7);
      for (const id of ABOVE(s)) {
        expect(patch.mock.calls.find((c) => c[0] === id)?.[1]).toEqual({ hasCards: true });
      }
    });
    expect(await subtree(t, s.set)).toEqual({ all: 25, base: 25 });
    await expectAllTrue(t, s);
  });

  test("NEO-364: the sport, year and brand are flagged by the first card and never written again", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await insertCounted(t, s.base, "1");
    for (const id of ABOVE(s)) expect(await flagRow(t, id)).toEqual(FLAGGED);
    // The second card, in another set of the same brand: the rows above are
    // read, never patched, so concurrent set builds no longer collide there.
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      const id = await insertTestCard(ctx, {
        selectorOptionId: s.otherBase,
        cardNumber: "2",
        cardName: "Card 2",
        platformData: {},
        sortOrder: 0,
        lastUpdated: NOW,
      });
      ledger.addCard((await ctx.db.get(id))!);
      const patch = vi.spyOn(ctx.db, "patch");
      await ledger.flush(ctx);
      const patched = patch.mock.calls.map((c) => String(c[0]));
      expect(patched.sort()).toEqual([s.otherBase, s.otherSet].map(String).sort());
    });
    await expectAllTrue(t, s);
  });

  test("NEO-364: a flush that removes one card and adds another still flags the rows above", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // Cards from before NEO-364: counted, but the rows above never flagged.
    const old = await insertCounted(t, s.base, "1");
    await t.run(async (ctx) => {
      for (const id of ABOVE(s)) await ctx.db.patch(id, { hasCards: undefined });
    });
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      await removeCardRow(ctx, (await ctx.db.get(old))!, ledger);
      const id = await insertTestCard(ctx, {
        selectorOptionId: s.otherBase,
        cardNumber: "2",
        cardName: "Card 2",
        platformData: {},
        sortOrder: 0,
        lastUpdated: NOW,
      });
      ledger.addCard((await ctx.db.get(id))!);
      await ledger.flush(ctx);
    });
    // The brand's net delta is zero, but a card landed beneath it.
    for (const id of ABOVE(s)) expect(await flag(t, id)).toBe(true);
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
    for (const id of [s.base, s.set]) {
      expect(await subtree(t, id)).toEqual({ all: 3, base: 3 });
    }
    for (const id of ABOVE(s)) expect(await flagRow(t, id)).toEqual(FLAGGED);
    await expectAllTrue(t, s);
  });

  test("deleteCard takes the card off every ancestor up to the set", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await insertCounted(t, s.insert, "1");
    await insertCounted(t, s.insert, "2");
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.deleteCard, { id: card });
    for (const id of [s.insert, s.insertType, s.set]) {
      expect(await subtree(t, id)).toEqual({ all: 1, base: 1 });
    }
    for (const id of ABOVE(s)) expect(await flagRow(t, id)).toEqual(FLAGGED);
    await expectAllTrue(t, s);
  });

  test("NEO-364: deleting the last card never clears the flag, and never writes the rows above", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await insertCounted(t, s.base, "1");
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      await removeCardRow(ctx, (await ctx.db.get(card))!, ledger);
      const patch = vi.spyOn(ctx.db, "patch");
      await ledger.flush(ctx);
      const patched = new Set(patch.mock.calls.map((c) => String(c[0])));
      for (const id of ABOVE(s)) expect(patched.has(String(id))).toBe(false);
    });
    expect(await subtree(t, s.set)).toEqual({ all: 0, base: 0 });
    for (const id of ABOVE(s)) expect(await flagRow(t, id)).toEqual(FLAGGED);
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
    expect(await subtree(t, s.set)).toEqual({ all: 2, base: 1 });
    await as.mutation(api.selectorOptions.setCardVariationParent, { cardId: child });
    expect(await subtree(t, s.set)).toEqual({ all: 2, base: 2 });
    await expectAllTrue(t, s);
  });

  test("moveCards between sets: off one set, onto the other; the brand above both stays flagged", async () => {
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
    expect(await flagRow(t, s.brand)).toEqual(FLAGGED);
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
    expect(await flagRow(t, s.sport)).toEqual(FLAGGED);
    const { parallel: _gone, ...rest } = s;
    void _gone;
    await expectAllTrue(t, rest);
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
    for (const id of [s.insertType, s.set]) {
      expect(await subtree(t, id)).toEqual({ all: 0, base: 0 });
    }
    // Flagged by the first card, and never cleared.
    for (const id of ABOVE(s)) expect(await flagRow(t, id)).toEqual(FLAGGED);
  });
});

describe("unknown and drifted counts", () => {
  test("an ABSENT ancestor stays absent; the rows around it still move", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) =>
      ctx.db.patch(s.insertType, { subtreeCardCount: undefined, subtreeNonVariationCardCount: undefined }),
    );
    await insertCounted(t, s.insert, "1");
    expect(await subtree(t, s.insertType)).toEqual({ all: undefined, base: undefined });
    expect(await subtree(t, s.insert)).toEqual({ all: 1, base: 1 });
    expect(await subtree(t, s.set)).toEqual({ all: 1, base: 1 });
    expect(await flagRow(t, s.year)).toEqual(FLAGGED);
  });

  test("a subtree count that would go negative is cleared to unknown and logged, never clamped", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await insertCounted(t, s.base, "1");
    await t.run((ctx) => ctx.db.patch(s.set, { subtreeCardCount: 0, subtreeNonVariationCardCount: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.deleteCard, { id: card });
    expect(await subtree(t, s.set)).toEqual({ all: undefined, base: undefined });
    expect(await subtree(t, s.base)).toEqual({ all: 0, base: 0 });
    expect(await flagRow(t, s.brand)).toEqual(FLAGGED);
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
    // NEO-364: the new brand is flagged; the old one keeps its flag.
    expect(await flagRow(t, s.bowman)).toEqual(FLAGGED);
    expect(await flagRow(t, s.brand)).toEqual(FLAGGED);
    expect(await flagRow(t, s.year)).toEqual(FLAGGED);
    expect(await subtree(t, s.set)).toEqual({ all: 1, base: 1 });
    await expectAllTrue(t, s);
  });

  test("NEO-364: a set re-homed under another year flags the whole new chain", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await insertCounted(t, s.base, "1");
    const { year2025, panini } = await t.run(async (ctx) => {
      const year2025 = await ctx.db.insert("selectorOptions", {
        ...newRowSubtreeCounts("year"),
        level: "year",
        value: "2025",
        parentId: s.sport,
        platformData: {},
        children: [],
        lastUpdated: NOW,
      });
      const panini = await ctx.db.insert("selectorOptions", {
        ...newRowSubtreeCounts("manufacturer"),
        level: "manufacturer",
        value: "Panini",
        parentId: year2025,
        platformData: {},
        children: [],
        lastUpdated: NOW,
      });
      await ctx.db.patch(year2025, { children: [panini] });
      return { year2025, panini };
    });
    expect(await flagRow(t, panini)).toEqual(UNFLAGGED);
    await t.run(async (ctx) => {
      await rehomeSetRowsToBrand(ctx, { rows: [(await ctx.db.get(s.set))!], brandId: panini });
    });
    expect(await flagRow(t, panini)).toEqual(FLAGGED);
    expect(await flagRow(t, year2025)).toEqual(FLAGGED);
    // The old chain is never un-flagged.
    expect(await flagRow(t, s.brand)).toEqual(FLAGGED);
    expect(await flagRow(t, s.year)).toEqual(FLAGGED);
    await expectAllTrue(t, { ...s, year2025, panini });
  });

  test("NEO-364: an empty set re-homed flags nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await rehomeSetRowsToBrand(ctx, { rows: [(await ctx.db.get(s.otherSet))!], brandId: s.bowman });
    });
    expect(await flagRow(t, s.bowman)).toEqual(UNFLAGGED);
    expect(await flagRow(t, s.brand)).toEqual(UNFLAGGED);
  });

  test("a row of UNKNOWN size stays unknown, and flags the brand it lands under", async () => {
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
    expect(await subtree(t, s.set)).toEqual({ all: undefined, base: undefined });
    // Showing a level is safe; hiding one that may hold cards is not.
    expect(await flagRow(t, s.bowman)).toEqual(FLAGGED);
    expect(await flagRow(t, s.brand)).toEqual(FLAGGED);
    expect(await flagRow(t, s.year)).toEqual(FLAGGED);
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
    // From the set down, rows with no unfilled child: the parallel, Silver
    // and both Bases. Gold, the Insert type and both sets wait on a child a
    // dry run cannot fill.
    expect(result.filled).toBe(4);
    expect(result.waiting).toBe(4);
    // Above the set: Topps would be flagged (its sets are of unknown count);
    // Bowman holds no set. The year and sport are judged on the brand flags
    // as stored, which a dry run has not written.
    expect(result).toMatchObject({ flagsSet: 1, flagsCleared: 0, staleCountsCleared: 0 });
    expect(await flagRow(t, s.sport)).toEqual(UNFLAGGED);
    expect(await flagRow(t, s.brand)).toEqual(UNFLAGGED);
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
    expect(first).toMatchObject({ armed: true, complete: true, filled: 8, waiting: 0, flagsSet: 3 });
    expect(await subtree(t, s.set)).toEqual({ all: 3, base: 2 });
    expect(await subtree(t, s.otherSet)).toEqual({ all: 0, base: 0 });
    for (const id of ABOVE(s)) expect(await flagRow(t, id)).toEqual(FLAGGED);
    expect(await flagRow(t, s.bowman)).toEqual(UNFLAGGED);
    await expectAllTrue(t, s);

    await t.run((ctx) => ctx.db.patch(s.set, { subtreeCardCount: 40, subtreeNonVariationCardCount: 30 }));
    const plain = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {
      confirm: "BACKFILL",
    });
    // The set disagrees with its children. Nothing above the set sums it.
    expect(plain).toMatchObject({ filled: 0, disagreed: 1, repaired: 0, flagsSet: 0, flagsCleared: 0 });
    expect(await subtree(t, s.set)).toEqual({ all: 40, base: 30 });

    const repair = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {
      confirm: "BACKFILL",
      repair: true,
    });
    expect(repair).toMatchObject({ filled: 0, disagreed: 1, repaired: 1 });
    await expectAllTrue(t, s);

    const again = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {
      confirm: "BACKFILL",
    });
    expect(again).toMatchObject({
      filled: 0,
      disagreed: 0,
      repaired: 0,
      waiting: 0,
      flagsSet: 0,
      flagsCleared: 0,
      staleCountsCleared: 0,
    });
  });

  test("NEO-364: unsets a flag with nothing below and clears the old counts above the set", async () => {
    vi.stubEnv("ALLOW_SUBTREE_CARD_COUNT_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await insertCounted(t, s.base, "1");
    // As NEO-358 left them: subtree counts on the sport, year and brands, and
    // a stray flag on the empty Bowman brand.
    await t.run(async (ctx) => {
      for (const id of [s.sport, s.year, s.brand, s.bowman]) {
        await ctx.db.patch(id, { subtreeCardCount: 1, subtreeNonVariationCardCount: 1 });
      }
      await ctx.db.patch(s.bowman, { hasCards: true });
    });
    const dry = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {});
    expect(dry).toMatchObject({ flagsSet: 0, flagsCleared: 1, staleCountsCleared: 4 });
    expect(await flag(t, s.bowman)).toBe(true);

    const run = await t.action(internal.cardCounts.backfillSubtreeCardCounts, { confirm: "BACKFILL" });
    expect(run).toMatchObject({ flagsSet: 0, flagsCleared: 1, staleCountsCleared: 4, filled: 0 });
    expect(await flagRow(t, s.bowman)).toEqual(UNFLAGGED);
    for (const id of ABOVE(s)) expect(await flagRow(t, id)).toEqual(FLAGGED);
    await expectAllTrue(t, s);
  });

  test("pages across levels one row at a time and resumes from the cursor it returns", async () => {
    vi.stubEnv("ALLOW_SUBTREE_CARD_COUNT_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const s = await legacy(t);
    const result = await t.action(internal.cardCounts.backfillSubtreeCardCounts, {
      confirm: "BACKFILL",
      numItems: 1,
    });
    expect(result).toMatchObject({ complete: true, scanned: 12, filled: 8, flagsSet: 3 });
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
