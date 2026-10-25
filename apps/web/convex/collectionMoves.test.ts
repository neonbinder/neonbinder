/**
 * NEO-359 — moving, placing and flagging copies, and the container counts
 * and owner tally every write path keeps.
 *
 * moveCopy (whole, split, fold, undo, one-of-a-kind), placeCopy, setTrade,
 * updateCopy's home guard, the scoped reads, and an exactness check after
 * every write path.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { expectCountsExact, tallyTruth, truthByContainer } from "../lib/testing/collection-counts";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const me = t.withIdentity(ME);
  const them = t.withIdentity(THEM);
  const sys = await me.mutation(api.collectionContainers.ensureSystem, {});
  const binderA = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "A" })).containerId;
  const binderB = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "B" })).containerId;
  const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box" })).containerId;
  return { t, fx, me, them, sys, binderA, binderB, box };
}
type S = Awaited<ReturnType<typeof setup>>;

async function copies(t: S["t"], owner = ME.subject) {
  return t.run(async (ctx) =>
    (await ctx.db.query("collectionCopies").collect()).filter((r) => r.ownerId === owner),
  );
}
const exact = (s: S, owner = ME.subject) => expectCountsExact(s.t, owner, expect as never);
async function tallyIsExact(s: S) {
  const { stored, truth } = await tallyTruth(s.t, ME.subject);
  expect(stored).toEqual(truth);
}
async function add(s: S, cardId: Id<"cardChecklist">, details: Record<string, unknown> = {}) {
  return s.me.mutation(api.collection.addLineItem, {
    cardId,
    details: { quantity: 1, ...details } as never,
  });
}

describe("moveCopy", () => {
  test("a whole move re-points the row, clears its slot and keeps the id", async () => {
    const s = await setup();
    const { copyId } = await add(s, s.fx.gooden1, { quantity: 3, homeId: s.binderA, slot: 4 });
    const r = await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: s.binderB });
    expect(r).toEqual({ copyId, folded: false, split: false, from: { homeId: s.binderA, slot: 4, quantity: 3 } });
    const [row] = await copies(s.t);
    expect(row).toMatchObject({ _id: copyId, homeId: s.binderB, quantity: 3 });
    expect(row.slot).toBeUndefined();
    await exact(s);
    await tallyIsExact(s);
  });

  test("a whole move lands in the named slot", async () => {
    const s = await setup();
    const { copyId } = await add(s, s.fx.gooden1, { homeId: s.binderA });
    await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: s.binderB, slot: 7 });
    expect((await copies(s.t))[0]).toMatchObject({ homeId: s.binderB, slot: 7 });
  });

  test("a partial move splits: the source keeps the rest, the new line is a new row", async () => {
    const s = await setup();
    const { copyId } = await add(s, s.fx.gooden1, { quantity: 5, homeId: s.binderA, notes: "n" });
    const r = await s.me.mutation(api.collection.moveCopy, {
      copyId, toHomeId: s.box, quantity: 2, slot: 1,
    });
    expect(r.split).toBe(true);
    expect(r.folded).toBe(false);
    expect(r.copyId).not.toBe(copyId);
    const rows = await copies(s.t);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x._id === copyId)).toMatchObject({ homeId: s.binderA, quantity: 3 });
    expect(rows.find((x) => x._id === r.copyId)).toMatchObject({ homeId: s.box, quantity: 2, slot: 1, notes: "n" });
    await exact(s);
    await tallyIsExact(s);
  });

  test("a split keeps the trade flag on both halves and both counts", async () => {
    const s = await setup();
    const { copyId } = await add(s, s.fx.gooden1, { quantity: 4, homeId: s.binderA, upForTrade: true });
    await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: s.binderB, quantity: 1 });
    const rows = await copies(s.t);
    expect(rows.map((r) => r.upForTrade)).toEqual([true, true]);
    const map = await exact(s);
    const trade = [...map.values()].find((c) => c.system === "trade")!;
    expect(trade.stored).toEqual({ copies: 4, lines: 2 });
  });

  test("a whole move folds into an identical twin, which keeps its id and gains the copies", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 2, homeId: s.binderA });
    const b = await add(s, s.fx.gooden1, { quantity: 3, homeId: s.binderB });
    const r = await s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.binderB });
    expect(r).toMatchObject({ copyId: b.copyId, folded: true, split: false });
    const rows = await copies(s.t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: b.copyId, quantity: 5 });
    await exact(s);
    await tallyIsExact(s);
  });

  test("a partial move folds into the twin and leaves the remainder behind", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 4, homeId: s.binderA });
    const b = await add(s, s.fx.gooden1, { quantity: 1, homeId: s.binderB });
    const r = await s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.binderB, quantity: 3 });
    expect(r).toMatchObject({ copyId: b.copyId, folded: true, split: true });
    const rows = await copies(s.t);
    expect(rows.find((x) => x._id === a.copyId)!.quantity).toBe(1);
    expect(rows.find((x) => x._id === b.copyId)!.quantity).toBe(4);
    await exact(s);
    await tallyIsExact(s);
  });

  test("a twin that differs in any field (trade flag, cost, notes, slot) does not fold", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.binderA });
    await add(s, s.fx.gooden1, { homeId: s.box, upForTrade: true });
    await add(s, s.fx.gooden1, { homeId: s.box, costCents: 5, slot: 2 });
    await add(s, s.fx.gooden1, { homeId: s.box, notes: "x", slot: 3 });
    const r = await s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.box });
    expect(r.folded).toBe(false);
    expect(await copies(s.t)).toHaveLength(4);
    await exact(s);
  });

  test("the undo (the inverse move) splits the cards back out of a fold", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 2, homeId: s.binderA, slot: 5 });
    const b = await add(s, s.fx.gooden1, { quantity: 3, homeId: s.binderB });
    const fwd = await s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.binderB });
    const back = await s.me.mutation(api.collection.moveCopy, {
      copyId: fwd.copyId, toHomeId: fwd.from.homeId, quantity: fwd.from.quantity, slot: fwd.from.slot,
    });
    expect(back).toMatchObject({ split: true, folded: false });
    const rows = await copies(s.t);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x._id === b.copyId)!.quantity).toBe(3);
    expect(rows.find((x) => x._id === back.copyId)).toMatchObject({ homeId: s.binderA, slot: 5, quantity: 2 });
    await exact(s);
    await tallyIsExact(s);
  });

  test("a cert or serial row only re-points and never folds into a twin", async () => {
    const s = await setup();
    const g = await add(s, s.fx.gooden1, { homeId: s.binderA, grading: { grader: "PSA", grade: "10", cert: "C1" } });
    await add(s, s.fx.gooden1, { homeId: s.binderB, grading: { grader: "PSA", grade: "10", cert: "C1" } });
    const sr = await add(s, s.fx.gooden1, { homeId: s.binderA, serialNumber: "1/50" });
    const r1 = await s.me.mutation(api.collection.moveCopy, { copyId: g.copyId, toHomeId: s.binderB });
    expect(r1).toMatchObject({ copyId: g.copyId, folded: false, split: false });
    const r2 = await s.me.mutation(api.collection.moveCopy, { copyId: sr.copyId, toHomeId: s.binderB });
    expect(r2.folded).toBe(false);
    expect(await copies(s.t)).toHaveLength(3);
    await exact(s);
  });

  test("a one-of-a-kind row moves whole even when quantity 1 is named", async () => {
    const s = await setup();
    const g = await add(s, s.fx.gooden1, { serialNumber: "1/50" });
    await expect(
      s.me.mutation(api.collection.moveCopy, { copyId: g.copyId, toHomeId: s.binderA, quantity: 1 }),
    ).resolves.toMatchObject({ split: false });
  });

  test("a move to where the cards already are changes nothing", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 2, homeId: s.binderA, slot: 3 });
    const before = await copies(s.t);
    const r = await s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.binderA, slot: 3 });
    expect(r).toMatchObject({ copyId: a.copyId, folded: false, split: false });
    expect(await copies(s.t)).toEqual(before);
    // even a partial quantity is a no-op at the same slot
    await s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.binderA, slot: 3, quantity: 1 });
    expect(await copies(s.t)).toEqual(before);
  });

  test("refuses bad quantities and moves nothing", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 3, homeId: s.binderA });
    const before = await copies(s.t);
    for (const quantity of [0, -1, 1.5, 4, Number.NaN]) {
      await expect(
        s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.binderB, quantity }),
      ).rejects.toThrow(/whole number of cards from 1 to 3/);
    }
    expect(await copies(s.t)).toEqual(before);
    await exact(s);
  });

  test("refuses the Want List, Up for Trade, a smart binder, a foreign container and a bad slot", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.binderA });
    const smart = await s.t.run(async (ctx) =>
      ctx.db.insert("collectionContainers", {
        ownerId: ME.subject, kind: "binder", name: "Smart", lastUpdated: 0, count: { copies: 0, lines: 0 },
        rule: { version: 1, match: "all", terms: [{ test: { kind: "hallOfFame" } }] },
      }),
    );
    const theirs = await s.them.mutation(api.collectionContainers.create, { kind: "binder", name: "Theirs" });
    const move = (toHomeId: Id<"collectionContainers">, slot?: number) =>
      s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId, ...(slot !== undefined ? { slot } : {}) });
    await expect(move(s.sys.wantId)).rejects.toThrow(/Want List/);
    await expect(move(s.sys.tradeId)).rejects.toThrow(/Up for Trade/);
    await expect(move(smart)).rejects.toThrow(/smart binder/i);
    await expect(move(theirs.containerId)).rejects.toThrow(/isn't in your collection/);
    await expect(move(s.box, 5)).rejects.toThrow(/rows 1 to 5/);
    await expect(move(s.binderB, 9000)).rejects.toThrow(/pocket/);
    await expect(move(s.binderB, -1)).rejects.toThrow();
    await expect(move(s.binderB, 1.5)).rejects.toThrow();
    expect((await copies(s.t))[0].homeId).toBe(s.binderA);
    await exact(s);
  });

  test("refuses an occupied binder pocket, even for a split or a fold target elsewhere", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 2, homeId: s.binderA });
    await add(s, s.fx.strawberry2, { homeId: s.binderB, slot: 0 });
    await expect(
      s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.binderB, slot: 0 }),
    ).rejects.toThrow(/pocket already holds/);
    await expect(
      s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.binderB, slot: 0, quantity: 1 }),
    ).rejects.toThrow(/pocket already holds/);
    expect(await copies(s.t)).toHaveLength(2);
    await exact(s);
  });

  test("a box row holds many lines", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.binderA });
    const b = await add(s, s.fx.strawberry2, { homeId: s.binderA });
    await s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.box, slot: 2 });
    await s.me.mutation(api.collection.moveCopy, { copyId: b.copyId, toHomeId: s.box, slot: 2 });
    expect((await copies(s.t)).map((r) => r.slot)).toEqual([2, 2]);
  });

  test("a stack passing 999 on a fold is refused and nothing moves", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 600, homeId: s.binderA });
    await add(s, s.fx.gooden1, { quantity: 500, homeId: s.binderB });
    await expect(
      s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.binderB }),
    ).rejects.toThrow(/999/);
    await exact(s);
  });

  test("a move onto the Main binder works and Main counts it", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 2, homeId: s.binderA });
    await s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.sys.mainId });
    const map = await exact(s);
    expect(map.get(s.sys.mainId)!.stored).toEqual({ copies: 2, lines: 1 });
  });
});

describe("placeCopy", () => {
  test("sets, changes and clears the slot in the same home", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.binderA });
    await s.me.mutation(api.collection.placeCopy, { copyId: a.copyId, slot: 4 });
    expect((await copies(s.t))[0].slot).toBe(4);
    await s.me.mutation(api.collection.placeCopy, { copyId: a.copyId, slot: 5 });
    expect((await copies(s.t))[0].slot).toBe(5);
    const r = await s.me.mutation(api.collection.placeCopy, { copyId: a.copyId, slot: null });
    expect(r).toMatchObject({ copyId: a.copyId, folded: false, split: false, from: { homeId: s.binderA, slot: 5, quantity: 1 } });
    expect((await copies(s.t))[0].slot).toBeUndefined();
    await exact(s);
  });

  test("folds into an identical twin already in that row, and the undo splits back", async () => {
    const s = await setup();
    const twin = await add(s, s.fx.gooden1, { homeId: s.box, slot: 1, quantity: 2 });
    const a = await add(s, s.fx.gooden1, { homeId: s.box, quantity: 1 });
    const r = await s.me.mutation(api.collection.placeCopy, { copyId: a.copyId, slot: 1 });
    expect(r).toMatchObject({ copyId: twin.copyId, folded: true });
    const rows = await copies(s.t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantity: 3, slot: 1 });
    const back = await s.me.mutation(api.collection.moveCopy, {
      copyId: r.copyId, toHomeId: r.from.homeId, quantity: r.from.quantity, slot: r.from.slot,
    });
    expect(back.split).toBe(true);
    expect(await copies(s.t)).toHaveLength(2);
    await exact(s);
    await tallyIsExact(s);
  });

  test("a binder pocket holds one line; a differing line in it is refused", async () => {
    const s = await setup();
    await add(s, s.fx.strawberry2, { homeId: s.binderA, slot: 2 });
    const a = await add(s, s.fx.gooden1, { homeId: s.binderA });
    await expect(s.me.mutation(api.collection.placeCopy, { copyId: a.copyId, slot: 2 })).rejects.toThrow(/pocket already holds/);
  });

  test("a binder pocket may be taken by an identical twin (fold) but not by a differing one", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binderA, slot: 2 });
    const diff = await add(s, s.fx.gooden1, { homeId: s.binderA, notes: "differs" });
    await expect(s.me.mutation(api.collection.placeCopy, { copyId: diff.copyId, slot: 2 })).rejects.toThrow(/pocket already holds/);
    const same = await add(s, s.fx.gooden1, { homeId: s.binderA });
    const r = await s.me.mutation(api.collection.placeCopy, { copyId: same.copyId, slot: 2 });
    expect(r.folded).toBe(true);
  });

  test("refuses a bad slot for the home's kind", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.box });
    await expect(s.me.mutation(api.collection.placeCopy, { copyId: a.copyId, slot: 5 })).rejects.toThrow(/rows 1 to 5/);
    await expect(s.me.mutation(api.collection.placeCopy, { copyId: a.copyId, slot: 0.5 })).rejects.toThrow();
  });
});

describe("setTrade and updateCopy", () => {
  test("setTrade flags a copy in place, never folds, and is idempotent", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 2, homeId: s.binderA });
    const flagged = await add(s, s.fx.gooden1, { quantity: 1, homeId: s.binderA, upForTrade: true, notes: "t" });
    expect(await s.me.mutation(api.collection.setTrade, { copyId: a.copyId, on: true })).toEqual({ previous: false });
    expect(await s.me.mutation(api.collection.setTrade, { copyId: a.copyId, on: true })).toEqual({ previous: true });
    // The stored value is only ever `true`; off is absent, never false.
    await s.me.mutation(api.collection.setTrade, { copyId: flagged.copyId, on: false });
    const rows = await copies(s.t);
    expect(rows.find((r) => r._id === a.copyId)!.upForTrade).toBe(true);
    expect("upForTrade" in rows.find((r) => r._id === flagged.copyId)!).toBe(false);
    // Turning the flag off on a row identical to an unflagged sibling does not fold.
    await s.me.mutation(api.collection.setTrade, { copyId: a.copyId, on: false });
    expect(await copies(s.t)).toHaveLength(2);
    await exact(s);
  });

  test("an add with upForTrade: false stores no flag, and the flag is part of the fold key", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { upForTrade: false });
    expect("upForTrade" in (await copies(s.t))[0]).toBe(false);
    const flagged = await add(s, s.fx.gooden1, { upForTrade: true });
    expect(flagged.merged).toBe(false);
    const again = await add(s, s.fx.gooden1, { upForTrade: true });
    expect(again).toMatchObject({ merged: true, copyId: flagged.copyId });
    const plain = await add(s, s.fx.gooden1);
    expect(plain).toMatchObject({ merged: true, copyId: a.copyId });
    await exact(s);
  });

  test("slot is part of the fold key on add (same slot folds in a box, different does not)", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.box, slot: 1 });
    expect((await add(s, s.fx.gooden1, { homeId: s.box, slot: 1 })).copyId).toBe(a.copyId);
    expect((await add(s, s.fx.gooden1, { homeId: s.box, slot: 2 })).merged).toBe(false);
    expect((await add(s, s.fx.gooden1, { homeId: s.box })).merged).toBe(false);
    await exact(s);
  });

  test("a binder pocket refuses a second line on add", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binderA, slot: 0 });
    await expect(add(s, s.fx.strawberry2, { homeId: s.binderA, slot: 0 })).rejects.toThrow(/pocket already holds/);
    await exact(s);
  });

  test("updateCopy refuses a home change but accepts its own home or none", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.binderA });
    await expect(
      s.me.mutation(api.collection.updateCopy, { copyId: a.copyId, details: { quantity: 1, homeId: s.binderB } }),
    ).rejects.toThrow(/move it/);
    await s.me.mutation(api.collection.updateCopy, { copyId: a.copyId, details: { quantity: 2, homeId: s.binderA } });
    await s.me.mutation(api.collection.updateCopy, { copyId: a.copyId, details: { quantity: 3 } });
    expect((await copies(s.t))[0]).toMatchObject({ homeId: s.binderA, quantity: 3 });
    await exact(s);
    await tallyIsExact(s);
  });

  test("updateCopy never folds into an identical sibling, clears slot and flag when absent", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.box, slot: 1, upForTrade: true });
    await add(s, s.fx.gooden1, { homeId: s.box });
    await s.me.mutation(api.collection.updateCopy, { copyId: a.copyId, details: { quantity: 1 } });
    const rows = await copies(s.t);
    expect(rows).toHaveLength(2);
    const row = rows.find((r) => r._id === a.copyId)!;
    expect(row.slot).toBeUndefined();
    expect("upForTrade" in row).toBe(false);
    await exact(s);
  });

  test("updateCopy to an occupied pocket is refused; to its own pocket is fine", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.binderA, slot: 1 });
    await add(s, s.fx.strawberry2, { homeId: s.binderA, slot: 2 });
    await expect(
      s.me.mutation(api.collection.updateCopy, { copyId: a.copyId, details: { quantity: 1, slot: 2 } }),
    ).rejects.toThrow(/pocket already holds/);
    await s.me.mutation(api.collection.updateCopy, { copyId: a.copyId, details: { quantity: 2, slot: 1 } });
  });

  test("updateCopy changing quantity of a flagged copy moves the Trade count", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { upForTrade: true });
    await s.me.mutation(api.collection.updateCopy, { copyId: a.copyId, details: { quantity: 4, upForTrade: true } });
    const map = await exact(s);
    expect([...map.values()].find((c) => c.system === "trade")!.stored).toEqual({ copies: 4, lines: 1 });
  });
});

describe("counts and tally after every write path", () => {
  test("add, addHaves with homeId, remove, removeCopies, restore, move, place, trade", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    await s.me.mutation(api.collection.addHaves, {
      cardIds: [s.fx.gooden1, s.fx.strawberry2, s.fx.gooden1], homeId: s.binderA,
    });
    await exact(s); await tallyIsExact(s);
    const [g, st] = (await copies(s.t)).filter((r) => r.homeId === s.binderA);
    const x = await add(s, s.fx.gold1, { quantity: 3, homeId: s.box, slot: 0, upForTrade: true });
    await exact(s);
    const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId: x.copyId });
    await exact(s); await tallyIsExact(s);
    await s.me.mutation(api.collection.restoreCopy, { cardId: removed.cardId, details: removed.details });
    await exact(s); await tallyIsExact(s);
    await s.me.mutation(api.collection.moveCopy, { copyId: g._id, toHomeId: s.binderB, quantity: 1 });
    await s.me.mutation(api.collection.placeCopy, { copyId: st._id, slot: 8 });
    await s.me.mutation(api.collection.setTrade, { copyId: st._id, on: true });
    await exact(s); await tallyIsExact(s);
    const all = (await copies(s.t)).map((r) => r._id);
    await s.me.mutation(api.collection.removeCopies, { copyIds: all.slice(0, 3) });
    await exact(s); await tallyIsExact(s);
  });

  test("restore into a since-filled pocket comes back to the same binder, unplaced, counted", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.binderA, slot: 3, quantity: 2 });
    const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId: a.copyId });
    await add(s, s.fx.strawberry2, { homeId: s.binderA, slot: 3 });
    const { copyId } = await s.me.mutation(api.collection.restoreCopy, { cardId: removed.cardId, details: removed.details });
    const row = (await copies(s.t)).find((r) => r._id === copyId)!;
    expect(row.homeId).toBe(s.binderA);
    expect(row.slot).toBeUndefined();
    const map = await exact(s);
    expect(map.get(s.binderA)!.stored).toEqual({ copies: 3, lines: 2 });
  });

  test("restore keeps the slot when the pocket is still free, and refuses a deleted home", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.binderA, slot: 3 });
    const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId: a.copyId });
    const r = await s.me.mutation(api.collection.restoreCopy, { cardId: removed.cardId, details: removed.details });
    expect((await copies(s.t)).find((x) => x._id === r.copyId)!.slot).toBe(3);
    const b = await add(s, s.fx.strawberry2, { homeId: s.binderB });
    const gone = await s.me.mutation(api.collection.removeCopy, { copyId: b.copyId });
    await s.me.mutation(api.collectionContainers.remove, { containerId: s.binderB });
    await expect(
      s.me.mutation(api.collection.restoreCopy, { cardId: gone.removed.cardId, details: gone.removed.details }),
    ).rejects.toThrow(/isn't in your collection/);
  });

  test("a drifted count (would go negative) is recounted by hand; an absent one too", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 3, homeId: s.binderA });
    await add(s, s.fx.strawberry2, { quantity: 2, homeId: s.binderA });
    await s.t.run(async (ctx) => ctx.db.patch(s.binderA, { count: { copies: 0, lines: 0 } }));
    await s.me.mutation(api.collection.removeCopy, { copyId: a.copyId });
    await exact(s);
    await s.t.run(async (ctx) => ctx.db.patch(s.binderA, { count: undefined }));
    await add(s, s.fx.gooden1, { homeId: s.binderA });
    const map = await exact(s);
    expect(map.get(s.binderA)!.stored).toEqual({ copies: 3, lines: 2 });
  });

  test("a stale-high count is not noticed until it would go negative (documented limit), but a recount fixes it", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binderA });
    await s.t.run(async (ctx) => ctx.db.patch(s.binderA, { count: undefined }));
    // absent -> recounted on the next write
    await add(s, s.fx.strawberry2, { homeId: s.binderA });
    expect((await truthByContainer(s.t, ME.subject)).get(s.binderA)!.stored).toEqual({ copies: 2, lines: 2 });
  });

  test("a recount past the 5,000 bound leaves the count absent, never a floor", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 5001; i++) {
        await ctx.db.insert("collectionCopies", {
          ownerId: ME.subject, cardId: s.fx.gooden1, variantId: s.fx.baseId, setId: s.fx.setId,
          homeId: s.box, quantity: 1, slot: i % 5, lastUpdated: 0,
        });
      }
      await ctx.db.patch(s.box, { count: undefined });
    });
    const listed = await s.me.query(api.collectionContainers.list, {});
    expect(listed.find((c) => c._id === s.box)!.count).toBeNull();
    await add(s, s.fx.strawberry2, { homeId: s.box });
    expect((await s.t.run(async (ctx) => ctx.db.get(s.box)))!.count).toBeUndefined();
    // Exactly at the bound it counts.
    await s.t.run(async (ctx) => {
      const rows = await ctx.db.query("collectionCopies").collect();
      const extra = rows.filter((r) => r.homeId === s.box).slice(0, 2);
      for (const r of extra) await ctx.db.delete(r._id);
    });
    const again = await s.me.query(api.collectionContainers.list, {});
    expect(again.find((c) => c._id === s.box)!.count).toEqual({ copies: 5000, lines: 5000 });
  });

  test("Main's count is derived from the tally minus the other containers when every one is counted", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { quantity: 2 });
    await add(s, s.fx.strawberry2, { quantity: 3, homeId: s.binderA });
    await s.t.run(async (ctx) => ctx.db.patch(s.sys.mainId, { count: undefined }));
    const listed = await s.me.query(api.collectionContainers.list, {});
    expect(listed.find((c) => c._id === s.sys.mainId)!.count).toEqual({ copies: 2, lines: 1 });
    // A lying tally proves it is the derivation, not a hand count.
    await s.t.run(async (ctx) => ctx.db.patch(s.sys.mainId, { tally: { copies: 10, lines: 5, cards: 5 } }));
    const lied = await s.me.query(api.collectionContainers.list, {});
    expect(lied.find((c) => c._id === s.sys.mainId)!.count).toEqual({ copies: 7, lines: 4 });
  });

  test("Main falls back to a hand count when a collector-made container is uncounted, or the derivation goes negative", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { quantity: 2 });
    await add(s, s.fx.strawberry2, { homeId: s.binderA });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.sys.mainId, { count: undefined, tally: { copies: 99, lines: 99, cards: 99 } });
      await ctx.db.patch(s.binderA, { count: undefined });
    });
    const a = await s.me.query(api.collectionContainers.list, {});
    expect(a.find((c) => c._id === s.sys.mainId)!.count).toEqual({ copies: 2, lines: 1 });
    expect(a.find((c) => c._id === s.binderA)!.count).toEqual({ copies: 1, lines: 1 });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.binderA, { count: { copies: 500, lines: 500 } });
      await ctx.db.patch(s.sys.mainId, { tally: { copies: 1, lines: 1, cards: 1 } });
    });
    const b = await s.me.query(api.collectionContainers.list, {});
    expect(b.find((c) => c._id === s.sys.mainId)!.count).toEqual({ copies: 2, lines: 1 });
  });

  test("a NEO-358 Main with no count and a kept tally is derived by ensureSystem, not left absent", async () => {
    const t = convexTest(schema, modules);
    const fx = await seedCollectionCatalog(t);
    const me = t.withIdentity(ME);
    const mainId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("collectionContainers", {
        ownerId: ME.subject, kind: "binder", system: "main", name: "Main", lastUpdated: 0,
        tally: { copies: 2, lines: 1, cards: 1 },
      });
      await ctx.db.insert("collectionCopies", {
        ownerId: ME.subject, cardId: fx.gooden1, variantId: fx.baseId, setId: fx.setId,
        homeId: id, quantity: 2, lastUpdated: 0,
      });
      return id;
    });
    await me.mutation(api.collectionContainers.ensureSystem, {});
    expect((await t.run(async (ctx) => ctx.db.get(mainId)))!.count).toEqual({ copies: 2, lines: 1 });
  });

  test("a write to a collector with an uncounted NEO-358 Main recounts Main in place", async () => {
    const t = convexTest(schema, modules);
    const fx = await seedCollectionCatalog(t);
    const me = t.withIdentity(ME);
    const mainId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("collectionContainers", {
        ownerId: ME.subject, kind: "binder", system: "main", name: "Main", lastUpdated: 0,
        tally: { copies: 2, lines: 1, cards: 1 },
      });
      await ctx.db.insert("collectionCopies", {
        ownerId: ME.subject, cardId: fx.gooden1, variantId: fx.baseId, setId: fx.setId,
        homeId: id, quantity: 2, lastUpdated: 0,
      });
      return id;
    });
    await me.mutation(api.collection.addHave, { cardId: fx.strawberry2 });
    expect((await t.run(async (ctx) => ctx.db.get(mainId)))!.count).toEqual({ copies: 3, lines: 2 });
  });

  test("a refused write moves no count", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { quantity: 2, homeId: s.binderA });
    const before = await truthByContainer(s.t, ME.subject);
    await expect(s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: s.sys.wantId })).rejects.toThrow();
    await expect(add(s, s.fx.gooden1, { homeId: s.sys.tradeId })).rejects.toThrow();
    expect(await truthByContainer(s.t, ME.subject)).toEqual(before);
  });
});

describe("scoped reads", () => {
  test("copiesInVariant, variantCompletion and setCompletion with homeId read only that home", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binderA });
    await add(s, s.fx.strawberry2, { homeId: s.binderB });
    await add(s, s.fx.futureStar, { homeId: s.binderA });
    const inA = await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.baseId, homeId: s.binderA });
    expect(inA.map((c) => c.cardId)).toEqual([s.fx.gooden1]);
    const all = await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.baseId });
    expect(all).toHaveLength(2);
    const vc = await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId, homeId: s.binderB });
    expect(vc).toMatchObject({ owned: 1, ownedAll: 1, total: 2, totalAll: 3 });
    const sc = await s.me.query(api.collection.setCompletion, { setId: s.fx.setId, homeId: s.binderA });
    expect(sc.owned).toBe(2);
    expect(sc.variants).toHaveLength(2);
    const scAll = await s.me.query(api.collection.setCompletion, { setId: s.fx.setId });
    expect(scAll.owned).toBe(3);
  });

  test("a bad, foreign, Want, Trade or deleted homeId reads empty, never the unscoped answer", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binderA });
    const theirs = await s.them.mutation(api.collectionContainers.create, { kind: "binder", name: "T" });
    const bad = ["garbage", "", theirs.containerId as string, s.sys.wantId as string, s.sys.tradeId as string, s.fx.baseId as string];
    for (const homeId of bad) {
      expect(await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.baseId, homeId })).toEqual([]);
      expect(await s.me.query(api.collection.variantCompletion, { variantId: s.fx.baseId, homeId })).toMatchObject({ owned: 0, ownedAll: 0 });
      expect(await s.me.query(api.collection.setCompletion, { setId: s.fx.setId, homeId })).toEqual({ owned: 0, ownedAll: 0, variants: [], truncated: false });
    }
  });

  test("a smart binder scope reads empty", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1);
    const smart = await s.t.run(async (ctx) =>
      ctx.db.insert("collectionContainers", {
        ownerId: ME.subject, kind: "binder", name: "Smart", lastUpdated: 0,
        rule: { version: 1, match: "all", terms: [{ test: { kind: "hallOfFame" } }] },
      }),
    );
    expect(await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.baseId, homeId: smart })).toEqual([]);
  });

  test("copiesInContainer pages in slot order; Trade lists the flagged; Want and foreign read empty", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.box, slot: 3 });
    await add(s, s.fx.strawberry2, { homeId: s.box });
    await add(s, s.fx.futureStar, { homeId: s.box, slot: 1, upForTrade: true });
    const page = await s.me.query(api.collection.copiesInContainer, {
      containerId: s.box, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.map((c) => c.slot)).toEqual([undefined, 1, 3]);
    const trade = await s.me.query(api.collection.copiesInContainer, {
      containerId: s.sys.tradeId, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(trade.page.map((c) => c.cardId)).toEqual([s.fx.futureStar]);
    for (const containerId of [s.sys.wantId as string, "junk"]) {
      const r = await s.me.query(api.collection.copiesInContainer, { containerId, paginationOpts: { numItems: 10, cursor: null } });
      expect(r.page).toEqual([]);
    }
    const theirs = await s.them.query(api.collection.copiesInContainer, {
      containerId: s.box, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(theirs.page).toEqual([]);
  });
});

describe("caller isolation", () => {
  test("another collector cannot move, place, flag or update my copies, nor file into my containers", async () => {
    const s = await setup();
    const a = await add(s, s.fx.gooden1, { homeId: s.binderA, quantity: 2 });
    const mine = await copies(s.t);
    const snapshot = await truthByContainer(s.t, ME.subject);
    const theirBinder = (await s.them.mutation(api.collectionContainers.create, { kind: "binder", name: "T" })).containerId;
    await expect(s.them.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: theirBinder })).rejects.toThrow(/isn't in your collection/);
    await expect(s.them.mutation(api.collection.placeCopy, { copyId: a.copyId, slot: 1 })).rejects.toThrow(/isn't in your collection/);
    await expect(s.them.mutation(api.collection.setTrade, { copyId: a.copyId, on: true })).rejects.toThrow(/isn't in your collection/);
    await expect(s.them.mutation(api.collection.updateCopy, { copyId: a.copyId, details: { quantity: 1 } })).rejects.toThrow();
    await expect(s.them.mutation(api.collection.removeCopy, { copyId: a.copyId })).rejects.toThrow();
    await expect(s.them.mutation(api.collection.addHave, { cardId: s.fx.gooden1, homeId: s.binderA })).rejects.toThrow(/isn't in your collection/);
    // My own copy into THEIR container is refused for me too.
    await expect(s.me.mutation(api.collection.moveCopy, { copyId: a.copyId, toHomeId: theirBinder })).rejects.toThrow(/isn't in your collection/);
    expect(await copies(s.t)).toEqual(mine);
    expect(await truthByContainer(s.t, ME.subject)).toEqual(snapshot);
  });

  test("two collectors with identical copies keep separate counts and tallies", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { quantity: 2, homeId: s.binderA });
    await s.them.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    await s.them.mutation(api.collection.setTrade, {
      copyId: (await copies(s.t, THEM.subject))[0]._id, on: true,
    });
    await s.them.mutation(api.collectionContainers.ensureSystem, {});
    await exact(s);
    await expectCountsExact(s.t, THEM.subject, expect as never);
  });
});
