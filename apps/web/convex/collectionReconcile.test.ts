/**
 * NEO-364 — the reconcile suite. After EVERY kind of write, the stored
 * numbers equal the hand count:
 *
 *   - Main's tally (copies, lines, distinct cards) is the COLLECTION side
 *     only: rows whose home is a binder. A box line never moves it;
 *   - every container's own count is its rows (box counts included);
 *   - each set build's kept `cards` is the distinct binder cards in the set;
 *   - the owner's `summary` reads the same numbers back.
 *
 * Drift here is how a collector's counts go wrong silently, so each write
 * path (binder, box, and the crossings between them) has its own test.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { buildingTruth, expectCountsExact, tallyTruth } from "../lib/testing/collection-counts";
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
  const binderA = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "A" })).containerId;
  const binderB = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "B" })).containerId;
  const boxA = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box A" })).containerId;
  const boxB = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box B" })).containerId;
  // The set is a build, and Main has taken a write, so every number is kept.
  await me.mutation(api.collection.setBuilding, { setId: fx.setId, building: true });
  await me.mutation(api.collection.addHave, { cardId: fx.gold1 });
  return { t, fx, me, sys, binderA, binderB, boxA, boxB };
}
type S = Awaited<ReturnType<typeof setup>>;

const add = (s: S, cardId: Id<"cardChecklist">, details: Record<string, unknown> = {}) =>
  s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, ...details } as never });
const rows = (s: S) =>
  s.t.run(async (ctx) => (await ctx.db.query("collectionCopies").collect()).filter((r) => r.ownerId === ME.subject));
const line = async (s: S, cardId: Id<"cardChecklist">, homeId: Id<"collectionContainers">) =>
  (await rows(s)).find((r) => r.cardId === cardId && r.homeId === homeId)!;

/** Every stored number equals the hand count; `label` names the step that broke it. */
async function reconciled(s: S, label: string) {
  await expectCountsExact(s.t, ME.subject, expect as never);
  const tally = await tallyTruth(s.t, ME.subject);
  expect(tally.stored, `${label}: Main tally`).toEqual(tally.truth);
  const main = await s.t.run(async (ctx) => ctx.db.get(s.sys.mainId));
  expect(main!.tallyScope, `${label}: tally stamp`).toBe("collection");
  for (const b of await buildingTruth(s.t, ME.subject)) {
    expect(b.kept, `${label}: set build cards`).toBe(b.truth);
    expect(b.scope, `${label}: set build stamp`).toBe("collection");
  }
  const summary = await s.me.query(api.collection.summary, {});
  expect({ copies: summary.copies, lines: summary.lines, cards: summary.distinctCards }, `${label}: summary`).toEqual(
    tally.truth,
  );
  expect(summary.exact, `${label}: summary exact`).toBe(true);
  return tally.truth;
}

describe("adds", () => {
  test("binder, Main, box and Unsorted adds: only the binder side moves the tally", async () => {
    const s = await setup();
    expect(await reconciled(s, "start")).toEqual({ copies: 1, lines: 1, cards: 1 });
    await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2 });
    expect(await reconciled(s, "binder add")).toEqual({ copies: 3, lines: 2, cards: 2 });
    await add(s, s.fx.strawberry2, { homeId: s.boxA, quantity: 3 });
    expect(await reconciled(s, "box add")).toEqual({ copies: 3, lines: 2, cards: 2 });
    await add(s, s.fx.futureStar, { homeId: s.sys.unsortedId, quantity: 5 });
    expect(await reconciled(s, "Unsorted add")).toEqual({ copies: 3, lines: 2, cards: 2 });
    await add(s, s.fx.gooden1, { homeId: s.boxB, quantity: 7 }); // a card also in the collection
    expect(await reconciled(s, "second side add")).toEqual({ copies: 3, lines: 2, cards: 2 });
  });

  test("folds: the same line again in a binder and in a box", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binderA });
    await add(s, s.fx.gooden1, { homeId: s.binderA });
    await reconciled(s, "binder fold");
    await add(s, s.fx.gooden1, { homeId: s.boxA });
    await add(s, s.fx.gooden1, { homeId: s.boxA });
    expect(await reconciled(s, "box fold")).toEqual({ copies: 3, lines: 2, cards: 2 });
  });

  test("addHave and addHaves with a box home; without one they land in Main", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1, homeId: s.boxA });
    await reconciled(s, "addHave box");
    await s.me.mutation(api.collection.addHaves, { cardIds: [s.fx.strawberry2, s.fx.futureStar], homeId: s.boxB });
    expect(await reconciled(s, "addHaves box")).toEqual({ copies: 1, lines: 1, cards: 1 });
    await s.me.mutation(api.collection.addHaves, { cardIds: [s.fx.strawberry2, s.fx.futureStar] });
    expect(await reconciled(s, "addHaves Main")).toEqual({ copies: 3, lines: 3, cards: 3 });
  });
});

describe("edits", () => {
  test("updateCopy: quantity in a binder, in a box, and the trade flag on each", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2 });
    const x = await add(s, s.fx.strawberry2, { homeId: s.boxA, quantity: 2 });
    await s.me.mutation(api.collection.updateCopy, { copyId: b.copyId, details: { quantity: 5, homeId: s.binderA } });
    expect(await reconciled(s, "binder qty")).toEqual({ copies: 6, lines: 2, cards: 2 });
    await s.me.mutation(api.collection.updateCopy, { copyId: x.copyId, details: { quantity: 9, homeId: s.boxA } });
    expect(await reconciled(s, "box qty")).toEqual({ copies: 6, lines: 2, cards: 2 });
    await s.me.mutation(api.collection.updateCopy, { copyId: b.copyId, details: { quantity: 5, homeId: s.binderA, upForTrade: true } });
    await s.me.mutation(api.collection.updateCopy, { copyId: x.copyId, details: { quantity: 9, homeId: s.boxA, upForTrade: true } });
    await reconciled(s, "trade via update");
    await s.me.mutation(api.collection.updateCopy, { copyId: b.copyId, details: { quantity: 1, homeId: s.binderA, condition: "Mint" } });
    expect(await reconciled(s, "binder detail edit")).toEqual({ copies: 2, lines: 2, cards: 2 });
  });

  test("setTrade on a binder copy and on a box copy; Up for Trade counts both", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2 });
    const x = await add(s, s.fx.strawberry2, { homeId: s.boxA, quantity: 3 });
    await s.me.mutation(api.collection.setTrade, { copyId: b.copyId, on: true });
    await s.me.mutation(api.collection.setTrade, { copyId: x.copyId, on: true });
    await reconciled(s, "trade on");
    const map = await expectCountsExact(s.t, ME.subject, expect as never);
    expect([...map.values()].find((c) => c.system === "trade")!.stored).toEqual({ copies: 5, lines: 2 });
    await s.me.mutation(api.collection.setTrade, { copyId: b.copyId, on: false });
    await s.me.mutation(api.collection.setTrade, { copyId: x.copyId, on: false });
    await reconciled(s, "trade off");
  });

  test("placeCopy within a binder and within a box", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA });
    const x = await add(s, s.fx.strawberry2, { homeId: s.boxA });
    await s.me.mutation(api.collection.placeCopy, { copyId: b.copyId, slot: 4 });
    await s.me.mutation(api.collection.placeCopy, { copyId: x.copyId, slot: 2 });
    await reconciled(s, "place");
    await s.me.mutation(api.collection.placeCopy, { copyId: b.copyId, slot: null });
    await s.me.mutation(api.collection.placeCopy, { copyId: x.copyId, slot: null });
    await reconciled(s, "unplace");
  });
});

describe("remove and restore", () => {
  test("removeCopy and restoreCopy of a binder line and of a box line", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2 });
    const x = await add(s, s.fx.strawberry2, { homeId: s.boxA, quantity: 4 });
    const rb = await s.me.mutation(api.collection.removeCopy, { copyId: b.copyId });
    expect(await reconciled(s, "remove binder")).toEqual({ copies: 1, lines: 1, cards: 1 });
    const rx = await s.me.mutation(api.collection.removeCopy, { copyId: x.copyId });
    await reconciled(s, "remove box");
    await s.me.mutation(api.collection.restoreCopy, { cardId: rb.removed.cardId, details: rb.removed.details });
    expect(await reconciled(s, "restore binder")).toEqual({ copies: 3, lines: 2, cards: 2 });
    await s.me.mutation(api.collection.restoreCopy, { cardId: rx.removed.cardId, details: rx.removed.details });
    expect(await reconciled(s, "restore box")).toEqual({ copies: 3, lines: 2, cards: 2 });
  });

  test("removeCopies across both sides at once", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binderA });
    await add(s, s.fx.strawberry2, { homeId: s.boxA });
    await add(s, s.fx.futureStar, { homeId: s.sys.unsortedId });
    await s.me.mutation(api.collection.removeCopies, { copyIds: (await rows(s)).map((r) => r._id) });
    expect(await reconciled(s, "remove all")).toEqual({ copies: 0, lines: 0, cards: 0 });
  });

  test("removing a card's last binder line while a box line stays loses the card from the collection only", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA });
    await add(s, s.fx.gooden1, { homeId: s.boxA });
    await reconciled(s, "both");
    await s.me.mutation(api.collection.removeCopy, { copyId: b.copyId });
    expect(await reconciled(s, "binder line gone")).toEqual({ copies: 1, lines: 1, cards: 1 });
    const [build] = await buildingTruth(s.t, ME.subject);
    expect(build.truth).toBe(1); // gold1 only
  });
});

describe("crossings: Sell and Take off sale", () => {
  test("a whole binder line sold into a box leaves the collection; taken off sale it returns", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 3 });
    await reconciled(s, "before sell");
    const sold = await s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.boxA });
    expect(sold).toMatchObject({ folded: false, split: false });
    expect(await reconciled(s, "sold whole")).toEqual({ copies: 1, lines: 1, cards: 1 });
    const back = await s.me.mutation(api.collection.moveCopy, { copyId: sold.copyId, toHomeId: s.binderB });
    expect(back).toMatchObject({ split: false });
    expect(await reconciled(s, "taken off sale whole")).toEqual({ copies: 4, lines: 2, cards: 2 });
  });

  test("a split sell keeps the card in the collection; selling the rest takes it out", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 3 });
    const part = await s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.boxA, quantity: 1 });
    expect(part.split).toBe(true);
    expect(await reconciled(s, "split sell")).toEqual({ copies: 3, lines: 2, cards: 2 });
    await s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.boxA });
    expect(await reconciled(s, "sell the rest (folds)")).toEqual({ copies: 1, lines: 1, cards: 1 });
    expect((await line(s, s.fx.gooden1, s.boxA)).quantity).toBe(3);
  });

  test("a split take-off-sale from a box into a binder", async () => {
    const s = await setup();
    const x = await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 4 });
    await reconciled(s, "before");
    const part = await s.me.mutation(api.collection.moveCopy, { copyId: x.copyId, toHomeId: s.binderA, quantity: 1 });
    expect(part.split).toBe(true);
    expect(await reconciled(s, "split off sale")).toEqual({ copies: 2, lines: 2, cards: 2 });
    expect((await line(s, s.fx.gooden1, s.boxA)).quantity).toBe(3);
  });

  test("selling into a box that holds an identical twin folds, and the tally still falls", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2 });
    const twin = await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 5 });
    await reconciled(s, "twin in place");
    const r = await s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.boxA });
    expect(r).toMatchObject({ copyId: twin.copyId, folded: true });
    expect(await reconciled(s, "sell folds")).toEqual({ copies: 1, lines: 1, cards: 1 });
    expect((await line(s, s.fx.gooden1, s.boxA)).quantity).toBe(7);
  });

  test("taking off sale into a binder that holds an identical twin folds, and the tally rises", async () => {
    const s = await setup();
    const x = await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 2 });
    const twin = await add(s, s.fx.gooden1, { homeId: s.sys.mainId, quantity: 5 });
    await reconciled(s, "twin in Main");
    const r = await s.me.mutation(api.collection.moveCopy, { copyId: x.copyId, toHomeId: s.sys.mainId });
    expect(r).toMatchObject({ copyId: twin.copyId, folded: true });
    expect(await reconciled(s, "off-sale folds")).toEqual({ copies: 8, lines: 2, cards: 2 });
  });

  test("a partial sell folding into a box twin, then the undo splitting it back", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 4 });
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 1 });
    const r = await s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.boxA, quantity: 3 });
    expect(r).toMatchObject({ folded: true });
    expect(await reconciled(s, "partial sell folds")).toEqual({ copies: 2, lines: 2, cards: 2 });
    await s.me.mutation(api.collection.moveCopy, {
      copyId: r.copyId, toHomeId: r.from.homeId, quantity: 3,
    });
    expect(await reconciled(s, "undo")).toEqual({ copies: 5, lines: 2, cards: 2 });
  });

  test("moves that stay on one side leave the tally alone: binder to binder, box to box, box to Unsorted", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2 });
    const x = await add(s, s.fx.strawberry2, { homeId: s.boxA, quantity: 2 });
    const before = await reconciled(s, "before");
    await s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.binderB });
    expect(await reconciled(s, "binder to binder")).toEqual(before);
    await s.me.mutation(api.collection.moveCopy, { copyId: x.copyId, toHomeId: s.boxB, quantity: 1 });
    expect(await reconciled(s, "box to box split")).toEqual(before);
    await s.me.mutation(api.collection.moveCopy, { copyId: x.copyId, toHomeId: s.sys.unsortedId });
    expect(await reconciled(s, "box to Unsorted")).toEqual(before);
  });

  test("a flagged copy sold keeps its flag and the Up for Trade count", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2, upForTrade: true });
    await s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.boxA });
    await reconciled(s, "flagged sell");
    const map = await expectCountsExact(s.t, ME.subject, expect as never);
    expect([...map.values()].find((c) => c.system === "trade")!.stored).toEqual({ copies: 2, lines: 1 });
  });

  test("a refused crossing moves no number", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2 });
    const before = await reconciled(s, "before");
    await expect(s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.sys.tradeId })).rejects.toThrow();
    await expect(s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.boxA, quantity: 9 })).rejects.toThrow();
    expect(await reconciled(s, "after refusals")).toEqual(before);
  });
});

describe("empty and delete", () => {
  test("a deleted box (emptied first) drops its copies into Unsorted; the tally never moves", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2 });
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 3 });
    await add(s, s.fx.strawberry2, { homeId: s.boxA, quantity: 1, notes: "keep" });
    const before = await reconciled(s, "before");
    expect(await s.me.mutation(api.collectionContainers.empty, { containerId: s.boxA })).toEqual({ moved: 4, remaining: 0 });
    expect(await reconciled(s, "box emptied")).toEqual(before);
    await s.me.mutation(api.collectionContainers.remove, { containerId: s.boxA });
    expect(await reconciled(s, "box removed")).toEqual(before);
    const unsorted = await s.t.run(async (ctx) => ctx.db.get(s.sys.unsortedId));
    expect(unsorted!.count).toEqual({ copies: 4, lines: 2 });
    const homes = (await rows(s)).filter((r) => r.homeId === s.sys.unsortedId);
    expect(homes).toHaveLength(2);
  });

  test("a deleted binder drops its copies into Main: the tally keeps them", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2, slot: 3 });
    const before = await reconciled(s, "before");
    await s.me.mutation(api.collectionContainers.empty, { containerId: s.binderA });
    expect(await reconciled(s, "binder emptied")).toEqual(before);
    await s.me.mutation(api.collectionContainers.remove, { containerId: s.binderA });
    expect(await reconciled(s, "binder removed")).toEqual(before);
    expect((await line(s, s.fx.gooden1, s.sys.mainId)).quantity).toBe(2);
  });

  test("a box emptied into an Unsorted that already holds a twin folds there", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.sys.unsortedId, quantity: 2 });
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 3 });
    await s.me.mutation(api.collectionContainers.empty, { containerId: s.boxA });
    await reconciled(s, "folded into Unsorted");
    expect(await rows(s).then((r) => r.filter((x) => x.cardId === s.fx.gooden1))).toHaveLength(1);
    expect((await line(s, s.fx.gooden1, s.sys.unsortedId)).quantity).toBe(5);
  });
});

describe("the quick count", () => {
  test("setBoxQuantity raise, lower, delete and undo never move the tally", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2 });
    const before = await reconciled(s, "before");
    const q = (n: number, boxId = s.boxA) =>
      s.me.mutation(api.collectionInventory.setBoxQuantity, { cardId: s.fx.gooden1, boxId, quantity: n });
    const up = await q(4);
    expect(await reconciled(s, "raise")).toEqual(before);
    await q(1);
    expect(await reconciled(s, "lower")).toEqual(before);
    const gone = await q(0);
    expect(await reconciled(s, "to zero")).toEqual(before);
    await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: gone.inverse });
    expect(await reconciled(s, "undo delete")).toEqual(before);
    await q(6, s.sys.unsortedId);
    expect(await reconciled(s, "Unsorted")).toEqual(before);
    void up;
  });
});

describe("set builds", () => {
  test("a build's card count follows binder copies only, through sell, take off sale and remove", async () => {
    const s = await setup();
    const b = await add(s, s.fx.gooden1, { homeId: s.binderA });
    await add(s, s.fx.strawberry2, { homeId: s.boxA });
    let [build] = await buildingTruth(s.t, ME.subject);
    expect(build).toMatchObject({ kept: 2, truth: 2 }); // gold1 + gooden1; strawberry2 is a box card
    const sold = await s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.boxA });
    [build] = await buildingTruth(s.t, ME.subject);
    expect(build).toMatchObject({ kept: 1, truth: 1 });
    await s.me.mutation(api.collection.moveCopy, { copyId: sold.copyId, toHomeId: s.binderA });
    [build] = await buildingTruth(s.t, ME.subject);
    expect(build).toMatchObject({ kept: 2, truth: 2 });
    await reconciled(s, "round trip");
  });

  test("turning a build on counts the binder cards only, ignoring the same set's box cards", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.setBuilding, { setId: s.fx.setId, building: false });
    await add(s, s.fx.gooden1, { homeId: s.binderA });
    await add(s, s.fx.strawberry2, { homeId: s.boxA });
    await add(s, s.fx.futureStar, { homeId: s.sys.unsortedId });
    await s.me.mutation(api.collection.setBuilding, { setId: s.fx.setId, building: true });
    const [build] = await buildingTruth(s.t, ME.subject);
    expect(build).toMatchObject({ kept: 2, truth: 2, scope: "collection" }); // gold1 + gooden1
    await reconciled(s, "build on");
    expect(await s.me.query(api.collection.summary, {})).toMatchObject({ offBuildCards: 0, buildingSets: 1 });
  });

  test("offBuildCards is the collection's cards off a build, never a box card", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.setBuilding, { setId: s.fx.setId, building: false });
    await s.me.mutation(api.collection.setBuilding, { setId: s.fx.set86Id, building: true });
    await add(s, s.fx.gooden1, { homeId: s.binderA }); // in Topps Chrome, which is no longer a build
    await add(s, s.fx.strawberry2, { homeId: s.boxA });
    expect(await s.me.query(api.collection.summary, {})).toMatchObject({
      distinctCards: 2,
      offBuildCards: 2,
      offBuildExact: true,
    });
  });
});

describe("the check itself", () => {
  test("goes red when a box line leaks into Main's tally (it can fail)", async () => {
    const s = await setup();
    await add(s, s.fx.strawberry2, { homeId: s.boxA, quantity: 2 });
    await reconciled(s, "clean");
    await s.t.run(async (ctx) => {
      const main = (await ctx.db.get(s.sys.mainId))!;
      const tally = main.tally!;
      await ctx.db.patch(s.sys.mainId, { tally: { copies: tally.copies + 2, lines: tally.lines + 1, cards: tally.cards + 1 } });
    });
    await expect(reconciled(s, "leak")).rejects.toThrow();
  });
});
