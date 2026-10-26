/**
 * NEO-364 — the hard line, both directions: Collection = binders, Inventory =
 * boxes. A collection read never sees a box copy; an inventory read never sees
 * a binder copy; Up for Trade (`tradeCopies`) and the per-card reads
 * (`copiesOf`, `copiesOfMany`) are the only reads that span both.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const me = t.withIdentity(ME);
  const sys = await me.mutation(api.collectionContainers.ensureSystem, {});
  const binder = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "Binder" })).containerId;
  const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box" })).containerId;
  const add = (cardId: Id<"cardChecklist">, details: Record<string, unknown>) =>
    me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, ...details } as never });
  return { t, fx, me, sys, binder, box, add };
}
type S = Awaited<ReturnType<typeof setup>>;

/**
 * The shared pile:
 *   gooden1   binder x2 (Binder)  + box x3 (Box, graded slab x1 too)
 *   strawberry2  box x1 only
 *   gold1     Main x1 only
 *   futureStar  Unsorted x4 only
 */
async function stock(s: S) {
  const { fx, add } = s;
  await add(fx.gooden1, { homeId: s.binder, quantity: 2 });
  await add(fx.gooden1, { homeId: s.box, quantity: 3 });
  await add(fx.gooden1, { homeId: s.box, quantity: 1, grading: { grader: "PSA", grade: "10" } });
  await add(fx.strawberry2, { homeId: s.box, quantity: 1 });
  await add(fx.gold1, { homeId: s.sys.mainId, quantity: 1 });
  await add(fx.futureStar, { homeId: s.sys.unsortedId, quantity: 4 });
}

const copiesIn = (s: S, side: "collection" | "inventory", homeId?: string) =>
  s.me.query(api.collection.copiesInVariant, { variantId: s.fx.baseId, side, ...(homeId ? { homeId } : {}) });

describe("copiesInVariant", () => {
  test("collection reads only binder lines; inventory reads only box lines", async () => {
    const s = await setup();
    await stock(s);
    const col = await copiesIn(s, "collection");
    expect(col.map((c) => [c.cardId, c.quantity])).toEqual([[s.fx.gooden1, 2]]);
    expect(col.every((c) => c.homeId === s.binder)).toBe(true);
    const inv = await copiesIn(s, "inventory");
    expect(inv.map((c) => c.homeId).every((id) => id === s.box)).toBe(true);
    expect(inv.map((c) => c.quantity).sort()).toEqual([1, 1, 3]);
    expect(new Set(inv.map((c) => c.cardId))).toEqual(new Set([s.fx.gooden1, s.fx.strawberry2]));
  });

  test("Main counts as the collection side and Unsorted as the inventory side", async () => {
    const s = await setup();
    await stock(s);
    const goldVariant = s.fx.goldId;
    const col = await s.me.query(api.collection.copiesInVariant, { variantId: goldVariant, side: "collection" });
    expect(col.map((c) => c.cardId)).toEqual([s.fx.gold1]);
    expect(await s.me.query(api.collection.copiesInVariant, { variantId: goldVariant, side: "inventory" })).toEqual([]);
    const fs = s.fx.futureStarsId;
    expect(await s.me.query(api.collection.copiesInVariant, { variantId: fs, side: "collection" })).toEqual([]);
    expect(
      (await s.me.query(api.collection.copiesInVariant, { variantId: fs, side: "inventory" })).map((c) => c.quantity),
    ).toEqual([4]);
  });

  test("a home on the other side reads as empty, in both directions", async () => {
    const s = await setup();
    await stock(s);
    expect(await copiesIn(s, "collection", s.box)).toEqual([]);
    expect(await copiesIn(s, "collection", s.sys.unsortedId)).toEqual([]);
    expect(await copiesIn(s, "inventory", s.binder)).toEqual([]);
    expect(await copiesIn(s, "inventory", s.sys.mainId)).toEqual([]);
    expect(await copiesIn(s, "collection", s.binder)).toHaveLength(1);
    expect(await copiesIn(s, "inventory", s.box)).toHaveLength(3);
  });
});

describe("variantCompletion and setCompletion", () => {
  test("each side counts only its own cards", async () => {
    const s = await setup();
    await stock(s);
    const col = await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId, side: "collection" });
    expect(col).toMatchObject({ owned: 1, ownedAll: 1 });
    const inv = await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId, side: "inventory" });
    expect(inv).toMatchObject({ owned: 2, ownedAll: 2 });
    // A scope on the other side is empty.
    expect(
      await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId, side: "collection", homeId: s.box }),
    ).toMatchObject({ owned: 0, ownedAll: 0 });
    expect(
      await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId, side: "inventory", homeId: s.binder }),
    ).toMatchObject({ owned: 0, ownedAll: 0 });
  });

  test("setCompletion per variant and for the set, per side", async () => {
    const s = await setup();
    await stock(s);
    const col = await s.me.query(api.collection.setCompletion, { setId: s.fx.setId, side: "collection" });
    expect(col.owned).toBe(2); // gooden1 (Base) + gold1 (Gold)
    const inv = await s.me.query(api.collection.setCompletion, { setId: s.fx.setId, side: "inventory" });
    expect(inv.owned).toBe(3); // gooden1 + strawberry2 (Base) + futureStar
    const byVariant = (r: typeof col) => Object.fromEntries(r.variants.map((v) => [v.variantId, v.owned]));
    expect(byVariant(col)).toEqual({ [s.fx.baseId]: 1, [s.fx.goldId]: 1 });
    expect(byVariant(inv)[s.fx.baseId]).toBe(2);
    expect(byVariant(inv)[s.fx.goldId] ?? 0).toBe(0);
    expect(
      await s.me.query(api.collection.setCompletion, { setId: s.fx.setId, side: "collection", homeId: s.box }),
    ).toEqual({ owned: 0, ownedAll: 0, variants: [], truncated: false });
    expect(
      await s.me.query(api.collection.setCompletion, { setId: s.fx.setId, side: "inventory", homeId: s.binder }),
    ).toEqual({ owned: 0, ownedAll: 0, variants: [], truncated: false });
  });

  test("a card held only in a box does not complete the collection, and the reverse", async () => {
    const s = await setup();
    await s.add(s.fx.strawberry2, { homeId: s.box });
    await s.add(s.fx.gooden1, { homeId: s.binder });
    const col = await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId, side: "collection" });
    const inv = await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId, side: "inventory" });
    expect(col.owned).toBe(1);
    expect(inv.owned).toBe(1);
    const colCards = await s.me.query(api.collection.setCompletion, { setId: s.fx.setId, side: "collection" });
    expect(colCards.owned).toBe(1);
  });
});

describe("side omitted (a tab still on the pre-NEO-364 bundle) reads as the collection", () => {
  test("copiesInVariant without side equals side collection, and never returns a box copy", async () => {
    const s = await setup();
    await stock(s);
    const bare = await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.baseId });
    expect(bare).toEqual(await copiesIn(s, "collection"));
    expect(bare.map((c) => [c.cardId, c.quantity, c.homeId])).toEqual([[s.fx.gooden1, 2, s.binder]]);
    // Unsorted is a box: its only copies are invisible without a side.
    expect(await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.futureStarsId })).toEqual([]);
    // A box scope without a side is the other side: empty.
    expect(await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.baseId, homeId: s.box })).toEqual([]);
    expect(
      await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.futureStarsId, homeId: s.sys.unsortedId }),
    ).toEqual([]);
    expect(await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.baseId, homeId: s.binder })).toHaveLength(1);
  });

  test("variantCompletion without side equals side collection; a box-only card owns nothing", async () => {
    const s = await setup();
    await stock(s);
    const bare = await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId });
    expect(bare).toEqual(
      await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId, side: "collection" }),
    );
    expect(bare).toMatchObject({ owned: 1, ownedAll: 1 }); // gooden1 only; strawberry2 is box-only
    expect(
      await s.me.query(api.collection.variantCompletion, { variantId: s.fx.futureStarsId }),
    ).toMatchObject({ owned: 0, ownedAll: 0 });
    expect(
      await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId, homeId: s.box }),
    ).toMatchObject({ owned: 0, ownedAll: 0 });
  });

  test("setCompletion without side equals side collection; no box card is counted", async () => {
    const s = await setup();
    await stock(s);
    const bare = await s.me.query(api.collection.setCompletion, { setId: s.fx.setId });
    expect(bare).toEqual(await s.me.query(api.collection.setCompletion, { setId: s.fx.setId, side: "collection" }));
    expect(bare.owned).toBe(2); // gooden1 (binder) + gold1 (Main)
    expect(Object.fromEntries(bare.variants.map((v) => [v.variantId, v.owned]))).toEqual({
      [s.fx.baseId]: 1,
      [s.fx.goldId]: 1,
    });
    expect(await s.me.query(api.collection.setCompletion, { setId: s.fx.setId, homeId: s.box })).toEqual({
      owned: 0, ownedAll: 0, variants: [], truncated: false,
    });
  });

  test("a collector with only box copies sees nothing without a side", async () => {
    const s = await setup();
    await s.add(s.fx.gooden1, { homeId: s.box, quantity: 5 });
    await s.add(s.fx.futureStar, { homeId: s.sys.unsortedId, quantity: 2 });
    expect(await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.baseId })).toEqual([]);
    expect(await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId })).toMatchObject({ owned: 0 });
    expect((await s.me.query(api.collection.setCompletion, { setId: s.fx.setId })).owned).toBe(0);
  });
});

describe("ownedCards and summary (collection side only)", () => {
  test("ownedCards never lists a box-only card; a card in both counts its binder lines only", async () => {
    const s = await setup();
    await stock(s);
    const page = await s.me.query(api.collection.ownedCards, { paginationOpts: { numItems: 50, cursor: null } });
    const ids = page.page.map((c) => c.cardId).sort();
    expect(ids).toEqual([s.fx.gooden1, s.fx.gold1].sort());
    const g = page.page.find((c) => c.cardId === s.fx.gooden1)!;
    expect(g).toMatchObject({ quantity: 2, lines: 1, graded: false });
  });

  test("a card is listed at its newest BINDER line, however new its box lines are", async () => {
    const s = await setup();
    await stock(s);
    await s.t.run(async (ctx) => {
      for (const row of await ctx.db.query("collectionCopies").collect()) {
        await ctx.db.patch(row._id, { lastUpdated: row.homeId === s.binder ? 1_000 : 9_000 });
      }
    });
    const page = await s.me.query(api.collection.ownedCards, { paginationOpts: { numItems: 50, cursor: null } });
    const g = page.page.find((c) => c.cardId === s.fx.gooden1)!;
    expect(g.lastUpdated).toBe(1_000);
    // gold1 (Main, 9_000) sorts above gooden1 (binder, 1_000): the box lines gave gooden1 no lift.
    expect(page.page[0].cardId).toBe(s.fx.gold1);
  });

  test("a graded box slab does not make the collection card graded", async () => {
    const s = await setup();
    await stock(s);
    const page = await s.me.query(api.collection.ownedCards, { paginationOpts: { numItems: 50, cursor: null } });
    expect(page.page.every((c) => c.graded === false)).toBe(true);
  });

  test("summary counts binder lines only", async () => {
    const s = await setup();
    await stock(s);
    expect(await s.me.query(api.collection.summary, {})).toMatchObject({
      copies: 3, // gooden1 binder x2 + gold1 Main x1
      lines: 2,
      distinctCards: 2,
      exact: true,
    });
  });

  test("a collector with only box copies has an empty collection", async () => {
    const s = await setup();
    await s.add(s.fx.gooden1, { homeId: s.box, quantity: 5 });
    expect(await s.me.query(api.collection.summary, {})).toMatchObject({ copies: 0, lines: 0, distinctCards: 0 });
    const page = await s.me.query(api.collection.ownedCards, { paginationOpts: { numItems: 50, cursor: null } });
    expect(page.page).toEqual([]);
  });
});

describe("what spans both sides", () => {
  test("tradeCopies lists flagged copies from binders AND boxes", async () => {
    const s = await setup();
    await s.add(s.fx.gooden1, { homeId: s.binder, upForTrade: true, quantity: 2 });
    await s.add(s.fx.gooden1, { homeId: s.box, upForTrade: true, quantity: 3 });
    await s.add(s.fx.strawberry2, { homeId: s.box });
    const trade = await s.me.query(api.collection.tradeCopies, { paginationOpts: { numItems: 10, cursor: null } });
    expect(trade.page.map((c) => c.homeId).sort()).toEqual([s.binder, s.box].sort());
    expect(trade.page.every((c) => c.upForTrade === true)).toBe(true);
    const shelf = await s.me.query(api.collection.copiesInContainer, {
      containerId: s.sys.tradeId, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(shelf.page).toHaveLength(2);
    const rows = await s.me.query(api.collectionContainers.list, {});
    expect(rows.find((r) => r._id === s.sys.tradeId)!.count).toEqual({ copies: 5, lines: 2 });
  });

  test("copiesOf and copiesOfMany return every line, binder and box", async () => {
    const s = await setup();
    await stock(s);
    const of = await s.me.query(api.collection.copiesOf, { cardId: s.fx.gooden1 });
    expect(of.map((c) => c.homeId).sort()).toEqual([s.binder, s.box, s.box].sort());
    const many = await s.me.query(api.collection.copiesOfMany, { cardIds: [s.fx.gooden1, s.fx.futureStar] });
    expect(many[0].copies).toHaveLength(3);
    expect(many[1].copies.map((c) => c.homeId)).toEqual([s.sys.unsortedId]);
  });

  test("copiesInContainer reads a box or a binder by id, whichever side", async () => {
    const s = await setup();
    await stock(s);
    const inBox = await s.me.query(api.collection.copiesInContainer, {
      containerId: s.box, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(inBox.page).toHaveLength(3);
    const inBinder = await s.me.query(api.collection.copiesInContainer, {
      containerId: s.binder, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(inBinder.page).toHaveLength(1);
  });
});

describe("another collector", () => {
  test("never sees my box or binder copies on either side", async () => {
    const s = await setup();
    await stock(s);
    const them = s.t.withIdentity({ subject: "collector_them_002" });
    for (const side of ["collection", "inventory"] as const) {
      expect(await them.query(api.collection.copiesInVariant, { variantId: s.fx.baseId, side })).toEqual([]);
      expect(await them.query(api.collection.variantCompletion, { variantId: s.fx.baseId, side })).toMatchObject({ owned: 0 });
    }
    // And with no side (the pre-NEO-364 bundle).
    expect(await them.query(api.collection.copiesInVariant, { variantId: s.fx.baseId })).toEqual([]);
    expect(await them.query(api.collection.variantCompletion, { variantId: s.fx.baseId })).toMatchObject({ owned: 0 });
    expect((await them.query(api.collection.setCompletion, { setId: s.fx.setId })).owned).toBe(0);
    expect((await them.query(api.collectionInventory.inventoryCards, {})).items).toEqual([]);
  });
});
