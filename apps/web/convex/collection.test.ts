/**
 * NEO-358 — a collector's copies (`convex/collection.ts`).
 *
 * Add (with the lazy Main binder), the server-side fold (identical in every
 * field folds; a cert or serial never does), edit, remove, restore, ownership
 * refusals, the batch cap, building sets, and both completion pairs
 * (regular cards by default, every card including variations).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  MAX_LINES_PER_CARD,
  MAX_OWNED_PAGE_LINES,
  MAX_TALLY_RECOUNT_LINES,
  foldsInto,
  isIsoDate,
} from "./collection";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME), them: t.withIdentity(THEM) };
}

async function copiesOwnedBy(t: ReturnType<typeof convexTest>, ownerId: string) {
  return t.run(async (ctx) =>
    (await ctx.db.query("collectionCopies").collect()).filter((r) => r.ownerId === ownerId),
  );
}

describe("auth", () => {
  test("every collection function refuses a signed-out caller", async () => {
    const { t, fx } = await setup();
    const calls: Array<() => Promise<unknown>> = [
      () => t.query(api.collection.summary, {}),
      () => t.query(api.collection.copiesOf, { cardId: fx.gooden1 }),
      () => t.query(api.collection.copiesInVariant, { variantId: fx.baseId }),
      () => t.query(api.collection.variantCompletion, { variantId: fx.baseId }),
      () => t.query(api.collection.setCompletion, { setId: fx.setId }),
      () => t.query(api.collection.buildingSets, {}),
      () => t.mutation(api.collection.addHave, { cardId: fx.gooden1 }),
      () => t.mutation(api.collection.addHaves, { cardIds: [fx.gooden1] }),
      () => t.mutation(api.collection.addLineItem, { cardId: fx.gooden1, details: { quantity: 1 } }),
      () => t.mutation(api.collection.setBuilding, { setId: fx.setId, building: true }),
      () => t.mutation(api.collection.restoreCopy, { cardId: fx.gooden1, details: { quantity: 1 } }),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(/Not authenticated/);
    expect(await t.run(async (ctx) => ctx.db.query("collectionCopies").collect())).toEqual([]);
  });
});

describe("add", () => {
  test("addHave makes the Main binder once and files the copy under its variant and set", async () => {
    const { t, fx, me } = await setup();
    const first = await me.mutation(api.collection.addHave, {
      cardId: fx.gooden1,
      acquiredOn: "2026-10-23",
    });
    expect(first.merged).toBe(false);
    const [copy] = await copiesOwnedBy(t, ME.subject);
    expect(copy).toMatchObject({
      cardId: fx.gooden1,
      variantId: fx.baseId,
      setId: fx.setId,
      quantity: 1,
      acquiredOn: "2026-10-23",
    });
    const containers = await t.run(async (ctx) => ctx.db.query("collectionContainers").collect());
    expect(containers).toEqual([
      expect.objectContaining({ ownerId: ME.subject, kind: "binder", system: "main", name: "Main" }),
    ]);
    expect(copy.homeId).toBe(containers[0]._id);

    // A second add of another card reuses Main.
    await me.mutation(api.collection.addHave, { cardId: fx.strawberry2 });
    expect(await t.run(async (ctx) => ctx.db.query("collectionContainers").collect())).toHaveLength(1);
  });

  test("addHaves adds a batch in order and refuses more than 200", async () => {
    const { fx, me } = await setup();
    const results = await me.mutation(api.collection.addHaves, {
      cardIds: [fx.gooden1, fx.strawberry2, fx.gooden1],
    });
    expect(results.map((r) => [r.cardId, r.merged])).toEqual([
      [fx.gooden1, false],
      [fx.strawberry2, false],
      [fx.gooden1, true],
    ]);
    await expect(
      me.mutation(api.collection.addHaves, { cardIds: Array(201).fill(fx.gooden1) }),
    ).rejects.toThrow(/more than 200/);
  });

  test("a card that left the catalog is refused", async () => {
    const { t, fx, me } = await setup();
    await t.run(async (ctx) => ctx.db.delete(fx.strawberry2));
    await expect(me.mutation(api.collection.addHave, { cardId: fx.strawberry2 })).rejects.toThrow(
      /isn't in the catalog anymore/,
    );
  });

  test("details are checked: quantity, dates, cost, a grade, one-of-a-kind quantity", async () => {
    const { fx, me } = await setup();
    const add = (details: Record<string, unknown>) =>
      me.mutation(api.collection.addLineItem, {
        cardId: fx.gooden1,
        details: { quantity: 1, ...details } as never,
      });
    await expect(add({ quantity: 0 })).rejects.toThrow(/Quantity/);
    await expect(add({ quantity: 1.5 })).rejects.toThrow(/Quantity/);
    await expect(add({ acquiredOn: "2026-02-30" })).rejects.toThrow(/real date/);
    await expect(add({ costCents: -1 })).rejects.toThrow(/Cost/);
    await expect(add({ costCents: 1.25 })).rejects.toThrow(/Cost/);
    await expect(add({ grading: { grader: "PSA", grade: "  " } })).rejects.toThrow(/grade/);
    await expect(add({ quantity: 2, serialNumber: "23/50" })).rejects.toThrow(/one of a kind/);
    await expect(
      add({ quantity: 2, grading: { grader: "PSA", grade: "10", cert: "123" } }),
    ).rejects.toThrow(/one of a kind/);
  });

  test("a want-list style system container is never a home, and another's binder is not found", async () => {
    const { t, fx, me } = await setup();
    const theirs = await t.run(async (ctx) =>
      ctx.db.insert("collectionContainers", {
        ownerId: THEM.subject,
        kind: "box",
        name: "Their box",
        lastUpdated: 0,
      }),
    );
    await expect(
      me.mutation(api.collection.addLineItem, {
        cardId: fx.gooden1,
        details: { quantity: 1, homeId: theirs },
      }),
    ).rejects.toThrow(/isn't in your collection/);
    expect(await copiesOwnedBy(t, ME.subject)).toEqual([]);
  });
});

describe("fold", () => {
  test("identical in every field folds; any difference makes a new line", async () => {
    const { t, fx, me } = await setup();
    const details = {
      quantity: 2,
      condition: "Near Mint" as const,
      costCents: 150,
      acquiredOn: "2026-10-01",
      location: "Box 3",
      notes: "  pack pulled  ",
    };
    const a = await me.mutation(api.collection.addLineItem, { cardId: fx.gooden1, details });
    const b = await me.mutation(api.collection.addLineItem, {
      cardId: fx.gooden1,
      details: { ...details, quantity: 3, notes: "pack pulled" },
    });
    expect(b).toEqual({
      copyId: a.copyId,
      merged: true,
      previous: expect.objectContaining({ quantity: 2, notes: "pack pulled" }),
    });
    expect((await copiesOwnedBy(t, ME.subject)).map((c) => c.quantity)).toEqual([5]);

    // Each single difference starts its own line.
    for (const change of [
      { condition: "Mint" as const },
      { costCents: 151 },
      { acquiredOn: "2026-10-02" },
      { location: "Box 4" },
      { notes: "different" },
      { grading: { grader: "PSA" as const, grade: "9" } },
    ]) {
      const r = await me.mutation(api.collection.addLineItem, {
        cardId: fx.gooden1,
        details: { ...details, ...change },
      });
      expect(r.merged).toBe(false);
    }
    expect(await copiesOwnedBy(t, ME.subject)).toHaveLength(7);
  });

  test("a different home never folds", async () => {
    const { t, fx, me } = await setup();
    await me.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    const box = await t.run(async (ctx) =>
      ctx.db.insert("collectionContainers", {
        ownerId: ME.subject,
        kind: "box",
        name: "For sale",
        lastUpdated: 0,
      }),
    );
    const r = await me.mutation(api.collection.addLineItem, {
      cardId: fx.gooden1,
      details: { quantity: 1, homeId: box },
    });
    expect(r.merged).toBe(false);
    expect(await copiesOwnedBy(t, ME.subject)).toHaveLength(2);
  });

  test("a cert or a serial never folds, even into an identical row", async () => {
    const { t, fx, me } = await setup();
    const slab = { quantity: 1, grading: { grader: "PSA" as const, grade: "10", cert: "4400123" } };
    await me.mutation(api.collection.addLineItem, { cardId: fx.gold1, details: slab });
    const again = await me.mutation(api.collection.addLineItem, { cardId: fx.gold1, details: slab });
    expect(again.merged).toBe(false);
    const serial = { quantity: 1, serialNumber: "23/50" };
    await me.mutation(api.collection.addLineItem, { cardId: fx.gold1, details: serial });
    const twice = await me.mutation(api.collection.addLineItem, { cardId: fx.gold1, details: serial });
    expect(twice.merged).toBe(false);
    expect(await copiesOwnedBy(t, ME.subject)).toHaveLength(4);
  });

  test("foldsInto, directly", () => {
    const home = "h1" as Id<"collectionContainers">;
    const raw = { quantity: 1, homeId: home, condition: "Mint" as const };
    expect(foldsInto(raw, { ...raw, quantity: 4 })).toBe(true);
    expect(foldsInto(raw, { ...raw, serialNumber: "1/1" })).toBe(false);
    expect(foldsInto({ ...raw, grading: { grader: "BGS", grade: "9.5", cert: "x" } }, raw)).toBe(false);
    expect(foldsInto(raw, { ...raw, homeId: "h2" as Id<"collectionContainers"> })).toBe(false);
  });

  test("isIsoDate accepts real dates only", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2023-02-29")).toBe(false);
    expect(isIsoDate("2024-2-1")).toBe(false);
  });
});

describe("edit, remove, restore", () => {
  test("updateCopy replaces the details and returns the previous ones for undo", async () => {
    const { t, fx, me } = await setup();
    const { copyId } = await me.mutation(api.collection.addLineItem, {
      cardId: fx.gooden1,
      details: { quantity: 2, condition: "Good", notes: "first" },
    });
    const { previous } = await me.mutation(api.collection.updateCopy, {
      copyId,
      details: { quantity: 3, condition: "Mint", location: "Shelf" },
    });
    expect(previous).toMatchObject({ quantity: 2, condition: "Good", notes: "first" });
    const [row] = await copiesOwnedBy(t, ME.subject);
    expect(row).toMatchObject({ quantity: 3, condition: "Mint", location: "Shelf" });
    expect(row.notes).toBeUndefined();
    expect(row.homeId).toBe(previous.homeId);

    // Undo puts it back exactly.
    await me.mutation(api.collection.updateCopy, { copyId, details: previous });
    const [undone] = await copiesOwnedBy(t, ME.subject);
    expect(undone).toMatchObject({ quantity: 2, condition: "Good", notes: "first" });
    expect(undone.location).toBeUndefined();
  });

  test("removeCopy hard-deletes and restoreCopy re-inserts the same details", async () => {
    const { t, fx, me } = await setup();
    const { copyId } = await me.mutation(api.collection.addLineItem, {
      cardId: fx.gold1,
      details: { quantity: 1, serialNumber: "07/50", costCents: 2500, acquiredOn: "2026-01-05" },
    });
    const { removed } = await me.mutation(api.collection.removeCopy, { copyId });
    expect(await copiesOwnedBy(t, ME.subject)).toEqual([]);
    expect(removed.cardId).toBe(fx.gold1);

    const { copyId: restored } = await me.mutation(api.collection.restoreCopy, removed);
    const [row] = await copiesOwnedBy(t, ME.subject);
    expect(row._id).toBe(restored);
    expect(row).toMatchObject({
      cardId: fx.gold1,
      variantId: fx.goldId,
      setId: fx.setId,
      serialNumber: "07/50",
      costCents: 2500,
      acquiredOn: "2026-01-05",
      homeId: removed.details.homeId,
    });
  });

  test("removeCopies checks every row before removing any", async () => {
    const { t, fx, me, them } = await setup();
    const mine = await me.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    const theirs = await them.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    await expect(
      me.mutation(api.collection.removeCopies, { copyIds: [mine.copyId, theirs.copyId] }),
    ).rejects.toThrow(/isn't in your collection/);
    expect(await copiesOwnedBy(t, ME.subject)).toHaveLength(1);
    const { removed } = await me.mutation(api.collection.removeCopies, { copyIds: [mine.copyId] });
    expect(removed).toHaveLength(1);
    expect(await copiesOwnedBy(t, ME.subject)).toEqual([]);
  });

  test("another collector's copy cannot be read, edited or removed", async () => {
    const { t, fx, me, them } = await setup();
    const { copyId } = await them.mutation(api.collection.addLineItem, {
      cardId: fx.gooden1,
      details: { quantity: 1, notes: "theirs" },
    });
    await expect(
      me.mutation(api.collection.updateCopy, { copyId, details: { quantity: 9 } }),
    ).rejects.toThrow(/isn't in your collection/);
    await expect(me.mutation(api.collection.removeCopy, { copyId })).rejects.toThrow(
      /isn't in your collection/,
    );
    expect(await me.query(api.collection.copiesOf, { cardId: fx.gooden1 })).toEqual([]);
    const [row] = await copiesOwnedBy(t, THEM.subject);
    expect(row).toMatchObject({ quantity: 1, notes: "theirs" });
    // Their home is not mine to restore into either.
    await expect(
      me.mutation(api.collection.restoreCopy, {
        cardId: fx.gooden1,
        details: { quantity: 1, homeId: row.homeId },
      }),
    ).rejects.toThrow(/isn't in your collection/);
  });
});

describe("reads", () => {
  test("copiesOf, copiesInVariant and summary see only the caller's rows", async () => {
    const { fx, me, them } = await setup();
    await me.mutation(api.collection.addLineItem, { cardId: fx.gooden1, details: { quantity: 2 } });
    await me.mutation(api.collection.addHave, { cardId: fx.strawberry2 });
    await me.mutation(api.collection.addHave, { cardId: fx.gold1 });
    await them.mutation(api.collection.addHave, { cardId: fx.gooden1 });

    expect((await me.query(api.collection.copiesOf, { cardId: fx.gooden1 })).map((c) => c.quantity)).toEqual([2]);
    const inBase = await me.query(api.collection.copiesInVariant, { variantId: fx.baseId });
    expect(inBase.map((c) => c.cardId).sort()).toEqual([fx.gooden1, fx.strawberry2].sort());
    expect(await me.query(api.collection.copiesInVariant, { variantId: "nope" })).toEqual([]);

    const summary = await me.query(api.collection.summary, {});
    expect(summary).toEqual({ copies: 4, lines: 3, distinctCards: 3, buildingSets: 0, exact: true });
    const owned = await me.query(api.collection.ownedCards, { paginationOpts: { numItems: 10, cursor: null } });
    expect(owned.page.map((c) => c.cardId).sort()).toEqual([fx.gooden1, fx.strawberry2, fx.gold1].sort());
  });

  test("results carry NB data only", async () => {
    const { fx, me } = await setup();
    await me.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    await me.mutation(api.collection.setBuilding, { setId: fx.setId, building: true });
    const text = JSON.stringify([
      await me.query(api.collection.copiesOf, { cardId: fx.gooden1 }),
      await me.query(api.collection.summary, {}),
      await me.query(api.collection.ownedCards, { paginationOpts: { numItems: 10, cursor: null } }),
      await me.query(api.collection.buildingSets, {}),
    ]);
    expect(text).not.toMatch(/platform|isCustom|"sku"|bsc|ownerId/i);
  });
});

describe("completion: regular cards by default, every card as the second pair", () => {
  test("variantCompletion counts distinct cards both ways", async () => {
    const { fx, me } = await setup();
    expect(await me.query(api.collection.variantCompletion, { variantId: fx.baseId })).toEqual({
      owned: 0,
      total: 2,
      ownedAll: 0,
      totalAll: 3,
    });
    // Two copies of #1 count once.
    await me.mutation(api.collection.addLineItem, { cardId: fx.gooden1, details: { quantity: 2 } });
    await me.mutation(api.collection.addLineItem, {
      cardId: fx.gooden1,
      details: { quantity: 1, condition: "Mint" },
    });
    expect(await me.query(api.collection.variantCompletion, { variantId: fx.baseId })).toEqual({
      owned: 1,
      total: 2,
      ownedAll: 1,
      totalAll: 3,
    });
    // The Sliding variation counts only in the "every card" pair.
    await me.mutation(api.collection.addHave, { cardId: fx.gooden1Sliding });
    expect(await me.query(api.collection.variantCompletion, { variantId: fx.baseId })).toEqual({
      owned: 1,
      total: 2,
      ownedAll: 2,
      totalAll: 3,
    });
    await me.mutation(api.collection.addHave, { cardId: fx.strawberry2 });
    expect(await me.query(api.collection.variantCompletion, { variantId: fx.baseId })).toEqual({
      owned: 2,
      total: 2,
      ownedAll: 3,
      totalAll: 3,
    });
  });

  test("an uncounted variant is counted by hand; a non-variant id is null", async () => {
    const { fx, me } = await setup();
    expect(await me.query(api.collection.variantCompletion, { variantId: fx.futureStarsId })).toEqual({
      owned: 0,
      total: 1,
      ownedAll: 0,
      totalAll: 1,
    });
    expect(await me.query(api.collection.variantCompletion, { variantId: fx.setId })).toBeNull();
    expect(await me.query(api.collection.variantCompletion, { variantId: "x" })).toBeNull();
  });

  test("setCompletion gives both owned counts per variant and for the set", async () => {
    const { fx, me } = await setup();
    await me.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    await me.mutation(api.collection.addHave, { cardId: fx.gooden1Sliding });
    await me.mutation(api.collection.addHave, { cardId: fx.gold1 });
    const result = await me.query(api.collection.setCompletion, { setId: fx.setId });
    expect(result.owned).toBe(2);
    expect(result.ownedAll).toBe(3);
    const byVariant = Object.fromEntries(result.variants.map((r) => [r.variantId, [r.owned, r.ownedAll]]));
    expect(byVariant).toEqual({ [fx.baseId]: [1, 2], [fx.goldId]: [1, 1] });
  });
});

describe("building sets", () => {
  test("setBuilding is explicit, idempotent and only takes a set row", async () => {
    const { fx, me, them } = await setup();
    expect(await me.mutation(api.collection.setBuilding, { setId: fx.setId, building: true })).toEqual({ changed: true });
    expect(await me.mutation(api.collection.setBuilding, { setId: fx.setId, building: true })).toEqual({ changed: false });
    await expect(
      me.mutation(api.collection.setBuilding, { setId: fx.baseId, building: true }),
    ).rejects.toThrow(/isn't in the catalog/);

    const mine = await me.query(api.collection.buildingSets, {});
    expect(mine.map((r) => [r.setId, r.set?.name])).toEqual([[fx.setId, "Topps Chrome"]]);
    expect(await them.query(api.collection.buildingSets, {})).toEqual([]);

    expect(await me.mutation(api.collection.setBuilding, { setId: fx.setId, building: false })).toEqual({ changed: true });
    expect(await me.mutation(api.collection.setBuilding, { setId: fx.setId, building: false })).toEqual({ changed: false });
    expect(await me.query(api.collection.buildingSets, {})).toEqual([]);
  });

  test("owning a card never marks its set as building", async () => {
    const { fx, me } = await setup();
    await me.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    expect(await me.query(api.collection.buildingSets, {})).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// No cap on a collection (Jason, 2026-10-23): a tally, and paged ownership
// ───────────────────────────────────────────────────────────────────────────

type T = ReturnType<typeof convexTest>;

/** The caller's collection counted by hand, the way the tally must read. */
async function truth(t: T, ownerId: string) {
  const rows = await copiesOwnedBy(t, ownerId);
  return {
    copies: rows.reduce((n, r) => n + r.quantity, 0),
    lines: rows.length,
    cards: new Set(rows.map((r) => r.cardId)).size,
  };
}

/** The tally stored on the caller's Main binder (null = not counted). */
async function storedTally(t: T, ownerId: string) {
  return t.run(async (ctx) => {
    const main = (await ctx.db.query("collectionContainers").collect()).find(
      (c) => c.ownerId === ownerId && c.system === "main",
    );
    return main?.tally ?? null;
  });
}

/** Every card `ownedCards` lists, walking the pages `numItems` lines at a time. */
async function walkOwned(me: ReturnType<T["withIdentity"]>, numItems: number) {
  const out: Array<{ cardId: string; quantity: number; lines: number; lastUpdated: number }> = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const result: { page: typeof out; isDone: boolean; continueCursor: string } = await me.query(
      api.collection.ownedCards,
      { paginationOpts: { numItems, cursor } },
    );
    out.push(...result.page);
    pages += 1;
    if (result.isDone) return { cards: out, pages };
    cursor = result.continueCursor;
  }
}

describe("the tally: every write moves it in the same transaction", () => {
  test("adds, folds, edits, removes and restores all keep the tally equal to a hand count", async () => {
    const { t, fx, me, them } = await setup();
    const check = async () => {
      const want = await truth(t, ME.subject);
      expect(await storedTally(t, ME.subject)).toEqual(want);
      expect(await me.query(api.collection.summary, {})).toMatchObject({
        copies: want.copies,
        lines: want.lines,
        distinctCards: want.cards,
        exact: true,
      });
    };

    const first = await me.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    await check();
    await me.mutation(api.collection.addHave, { cardId: fx.gooden1 }); // folds
    await check();
    const graded = await me.mutation(api.collection.addLineItem, {
      cardId: fx.gooden1,
      details: { quantity: 1, grading: { grader: "PSA", grade: "10", cert: "123" } },
    }); // a second line, same card
    await check();
    await me.mutation(api.collection.addHaves, { cardIds: [fx.strawberry2, fx.gold1, fx.strawberry2] });
    await check();
    await me.mutation(api.collection.updateCopy, { copyId: first.copyId, details: { quantity: 5 } });
    await check();
    const removed = await me.mutation(api.collection.removeCopy, { copyId: graded.copyId });
    await check(); // the card still has its raw stack
    await me.mutation(api.collection.restoreCopy, removed.removed);
    await check();
    const goldLine = (await copiesOwnedBy(t, ME.subject)).find((r) => r.cardId === fx.gold1)!;
    await me.mutation(api.collection.removeCopy, { copyId: goldLine._id });
    await check(); // the card is gone from the collection
    const left = await copiesOwnedBy(t, ME.subject);
    await me.mutation(api.collection.removeCopies, { copyIds: left.map((r) => r._id) });
    await check();
    expect(await storedTally(t, ME.subject)).toEqual({ copies: 0, lines: 0, cards: 0 });

    // Another collector's writes never touch mine.
    await them.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    await check();
  });

  test("a refused write moves nothing", async () => {
    const { t, fx, me } = await setup();
    await me.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    const before = await storedTally(t, ME.subject);
    await expect(
      me.mutation(api.collection.addHaves, { cardIds: [fx.strawberry2, "nope" as never] }),
    ).rejects.toThrow();
    expect(await storedTally(t, ME.subject)).toEqual(before);
  });

  test("a collector with no tally yet is counted by hand, and their next write keeps one", async () => {
    const { t, fx, me } = await setup();
    await me.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    await me.mutation(api.collection.addHave, { cardId: fx.strawberry2 });
    await t.run(async (ctx) => {
      const main = (await ctx.db.query("collectionContainers").collect())[0];
      await ctx.db.patch(main._id, { tally: undefined });
    });
    expect(await me.query(api.collection.summary, {})).toMatchObject({ copies: 2, distinctCards: 2, exact: true });
    await me.mutation(api.collection.addHave, { cardId: fx.gold1 });
    expect(await storedTally(t, ME.subject)).toEqual({ copies: 3, lines: 3, cards: 3 });
  });

  test("a tally that drifted below zero is counted again by hand", async () => {
    const { t, fx, me } = await setup();
    const added = await me.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    await me.mutation(api.collection.addHave, { cardId: fx.strawberry2 });
    await t.run(async (ctx) => {
      const main = (await ctx.db.query("collectionContainers").collect())[0];
      await ctx.db.patch(main._id, { tally: { copies: 0, lines: 0, cards: 0 } });
    });
    await me.mutation(api.collection.removeCopy, { copyId: added.copyId });
    expect(await storedTally(t, ME.subject)).toEqual({ copies: 1, lines: 1, cards: 1 });
  });
});

describe("everything I own, paged", () => {
  test("newest first, each card once at its newest line, with the whole card's counts on any page", async () => {
    const { t, fx, me } = await setup();
    await me.mutation(api.collection.addLineItem, { cardId: fx.gooden1, details: { quantity: 2 } });
    await me.mutation(api.collection.addHave, { cardId: fx.strawberry2 });
    await me.mutation(api.collection.addLineItem, {
      cardId: fx.gooden1,
      details: { quantity: 1, serialNumber: "07/25" },
    });
    await me.mutation(api.collection.addHave, { cardId: fx.gold1 });
    // One line per page: Gooden's older line lands on a page of its own and
    // must not list him a second time.
    const { cards, pages } = await walkOwned(me, 1);
    expect(pages).toBeGreaterThanOrEqual(4);
    expect(cards.map((c) => c.cardId)).toEqual([fx.gold1, fx.gooden1, fx.strawberry2]);
    expect(cards.find((c) => c.cardId === fx.gooden1)).toMatchObject({ quantity: 3, lines: 2 });

    // A Have stamps the line, so that card moves to the top.
    await me.mutation(api.collection.addHave, { cardId: fx.strawberry2 });
    expect((await walkOwned(me, 2)).cards.map((c) => c.cardId)).toEqual([fx.strawberry2, fx.gold1, fx.gooden1]);
    void t;
  });

  test("a page reads at most MAX_OWNED_PAGE_LINES lines, whatever it is asked", async () => {
    const { t, fx, me } = await setup();
    await insertManyOwned(t, fx, ME.subject, { cards: MAX_OWNED_PAGE_LINES + 10, linesPerCard: 1, keepTally: true });
    const page = await me.query(api.collection.ownedCards, { paginationOpts: { numItems: 10_000, cursor: null } });
    expect(page.page).toHaveLength(MAX_OWNED_PAGE_LINES);
    expect(page.isDone).toBe(false);
  });

  test("pages past the old 5,000-line read to the very last line: every card listed once, the tally exact", async () => {
    const { t, fx, me } = await setup();
    // 26 cards x 200 lines = 5,200 lines, past the 5,000 the old summary read.
    // Each card's lines run across several pages; it is listed once, on the
    // page holding its newest line, with all 200 lines counted.
    const cardsHeld = 26;
    const lines = MAX_LINES_PER_CARD;
    expect(cardsHeld * lines).toBeGreaterThan(MAX_TALLY_RECOUNT_LINES);
    const ids = await insertManyOwned(t, fx, ME.subject, { cards: cardsHeld, linesPerCard: lines, keepTally: true });
    const { cards, pages } = await walkOwned(me, MAX_OWNED_PAGE_LINES);
    expect(pages).toBeGreaterThan(MAX_TALLY_RECOUNT_LINES / MAX_OWNED_PAGE_LINES);
    // Newest first: the last card inserted was touched last.
    expect(cards.map((c) => c.cardId)).toEqual([...ids].reverse());
    for (const card of cards) expect(card).toMatchObject({ quantity: lines, lines });
    expect(await me.query(api.collection.summary, {})).toMatchObject({
      distinctCards: cardsHeld,
      lines: cardsHeld * lines,
      copies: cardsHeld * lines,
      exact: true,
    });
  }, 60_000);

  test("an uncounted collection past the hand-count read says it is a floor, never the answer", async () => {
    const { t, fx, me } = await setup();
    const count = MAX_TALLY_RECOUNT_LINES + 50;
    await insertManyOwned(t, fx, ME.subject, { cards: count, linesPerCard: 1, keepTally: false });
    expect(await me.query(api.collection.summary, {})).toMatchObject({
      distinctCards: MAX_TALLY_RECOUNT_LINES,
      exact: false,
    });
    // A write cannot finish the count either, so it leaves the tally unset
    // rather than storing a floor as if it were the answer.
    await me.mutation(api.collection.addHave, { cardId: fx.gooden1 });
    expect(await storedTally(t, ME.subject)).toBeNull();
    expect((await me.query(api.collection.summary, {})).exact).toBe(false);
  }, 60_000);
});

/**
 * `cards` distinct cards on the fixture's Base, each with `linesPerCard` raw
 * one-copy lines, owned by `ownerId`; every line is touched one millisecond
 * after the one before, a card's lines together. `keepTally` stores the tally
 * a collector who added them one by one would have. Returns the card ids in
 * insertion order.
 */
async function insertManyOwned(
  t: T,
  fx: Awaited<ReturnType<typeof seedCollectionCatalog>>,
  ownerId: string,
  { cards, linesPerCard, keepTally }: { cards: number; linesPerCard: number; keepTally: boolean },
) {
  return t.run(async (ctx) => {
    const lines = cards * linesPerCard;
    const homeId = await ctx.db.insert("collectionContainers", {
      ownerId,
      kind: "binder",
      system: "main",
      name: "Main",
      ...(keepTally ? { tally: { copies: lines, lines, cards } } : {}),
      lastUpdated: 1,
    });
    const ids: Array<Id<"cardChecklist">> = [];
    let stamp = 1_000_000;
    for (let i = 0; i < cards; i++) {
      const cardId = await ctx.db.insert("cardChecklist", {
        selectorOptionId: fx.baseId,
        cardNumber: `M${i}`,
        cardName: "",
        platformData: {},
        sortOrder: 1000 + i,
        lastUpdated: 1,
      });
      ids.push(cardId);
      for (let j = 0; j < linesPerCard; j++) {
        await ctx.db.insert("collectionCopies", {
          ownerId,
          cardId,
          variantId: fx.baseId,
          setId: fx.setId,
          homeId,
          quantity: 1,
          notes: `line ${j}`,
          lastUpdated: stamp++,
        });
      }
    }
    return ids;
  });
}
