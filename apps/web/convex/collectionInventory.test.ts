/**
 * NEO-364 — the inventory (`convex/collectionInventory.ts`): the quick count
 * (`setBoxQuantity`), its exact undo (`undoBoxQuantity`) and the Inventory
 * list (`inventoryCards`).
 *
 * The hard line: nothing here reads or writes a binder copy, and no write
 * here moves the collection tally. Every write is followed by an exact
 * container-count check.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { MAX_COPY_QUANTITY, MAX_LINES_PER_CARD } from "./collection";
import { MAX_INVENTORY_LINES } from "./collectionInventory";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { expectCountsExact, tallyTruth } from "../lib/testing/collection-counts";
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
  const boxA = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box A" })).containerId;
  const boxB = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box B" })).containerId;
  const binder = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "Binder" })).containerId;
  return { t, fx, me, them, sys, boxA, boxB, binder };
}
type S = Awaited<ReturnType<typeof setup>>;

const TODAY = new Date().toISOString().slice(0, 10);

async function rowsOf(s: S, owner = ME.subject) {
  return s.t.run(async (ctx) =>
    (await ctx.db.query("collectionCopies").collect()).filter((r) => r.ownerId === owner),
  );
}
async function linesIn(s: S, cardId: Id<"cardChecklist">, boxId: Id<"collectionContainers">) {
  return (await rowsOf(s)).filter((r) => r.cardId === cardId && r.homeId === boxId);
}
const setQty = (s: S, cardId: Id<"cardChecklist">, boxId: Id<"collectionContainers">, quantity: number, acquiredOn?: string) =>
  s.me.mutation(api.collectionInventory.setBoxQuantity, { cardId, boxId, quantity, ...(acquiredOn ? { acquiredOn } : {}) });
const add = (s: S, cardId: Id<"cardChecklist">, details: Record<string, unknown>) =>
  s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, ...details } as never });
const exact = (s: S) => expectCountsExact(s.t, ME.subject, expect as never);
const sum = (rows: Array<{ quantity: number }>) => rows.reduce((n, r) => n + r.quantity, 0);
/** Lines as the undo should find them again: quantity + date, order-free. */
const shape = (rows: Array<{ quantity: number; acquiredOn?: string }>) =>
  rows.map((r) => `${r.quantity}@${r.acquiredOn ?? "-"}`).sort();

describe("setBoxQuantity: raise", () => {
  test("raising from none adds one raw line acquired today, unplaced, in that box only", async () => {
    const s = await setup();
    const r = await setQty(s, s.fx.gooden1, s.boxA, 3);
    expect(r).toMatchObject({ before: 0, after: 3 });
    const lines = await linesIn(s, s.fx.gooden1, s.boxA);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 3, acquiredOn: TODAY, homeId: s.boxA });
    expect(lines[0].condition).toBeUndefined();
    expect(lines[0].grading).toBeUndefined();
    expect(lines[0].slot).toBeUndefined();
    expect(await rowsOf(s)).toHaveLength(1);
    await exact(s);
  });

  test("a raise the same day folds into today's plain line instead of adding another", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2);
    const r = await setQty(s, s.fx.gooden1, s.boxA, 5);
    expect(r).toMatchObject({ before: 2, after: 5 });
    const lines = await linesIn(s, s.fx.gooden1, s.boxA);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(5);
    await exact(s);
  });

  test("acquiredOn stamps the new line, and a different day makes a second line", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2, "2026-01-05");
    await setQty(s, s.fx.gooden1, s.boxA, 3, "2026-02-06");
    const lines = await linesIn(s, s.fx.gooden1, s.boxA);
    expect(shape(lines)).toEqual(["1@2026-02-06", "2@2026-01-05"]);
    await exact(s);
  });

  test("a blank acquiredOn falls back to today; a bad date is refused and writes nothing", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 1, "   ");
    expect((await linesIn(s, s.fx.gooden1, s.boxA))[0].acquiredOn).toBe(TODAY);
    await expect(setQty(s, s.fx.strawberry2, s.boxA, 1, "2026-13-45")).rejects.toThrow(/date/i);
    await expect(setQty(s, s.fx.strawberry2, s.boxA, 1, "yesterday")).rejects.toThrow(/date/i);
    expect(await linesIn(s, s.fx.strawberry2, s.boxA)).toEqual([]);
  });

  test("the quantity is the card's plain copies in THAT box; another box is untouched", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2);
    await setQty(s, s.fx.gooden1, s.boxB, 4);
    expect(sum(await linesIn(s, s.fx.gooden1, s.boxA))).toBe(2);
    expect(sum(await linesIn(s, s.fx.gooden1, s.boxB))).toBe(4);
    await setQty(s, s.fx.gooden1, s.boxA, 1);
    expect(sum(await linesIn(s, s.fx.gooden1, s.boxB))).toBe(4);
    await exact(s);
  });

  test("the box and Unsorted both take a quick count; Unsorted's count moves", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.sys.unsortedId, 3);
    const map = await exact(s);
    expect(map.get(s.sys.unsortedId)!.stored).toEqual({ copies: 3, lines: 1 });
  });
});

describe("setBoxQuantity: lower, no-op and delete", () => {
  test("lowering takes copies off the line; at 0 the line is deleted", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 5);
    const lowered = await setQty(s, s.fx.gooden1, s.boxA, 2);
    expect(lowered).toMatchObject({ before: 5, after: 2 });
    expect((await linesIn(s, s.fx.gooden1, s.boxA))[0].quantity).toBe(2);
    await exact(s);
    const gone = await setQty(s, s.fx.gooden1, s.boxA, 0);
    expect(gone).toMatchObject({ before: 2, after: 0 });
    expect(await linesIn(s, s.fx.gooden1, s.boxA)).toEqual([]);
    await exact(s);
  });

  test("lowering takes the newest plain line first (lastUpdated), then the next", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2, "2026-01-01");
    await setQty(s, s.fx.gooden1, s.boxA, 5, "2026-02-02"); // a second line of 3
    const [older, newer] = await (async () => {
      const lines = await linesIn(s, s.fx.gooden1, s.boxA);
      return [lines.find((l) => l.acquiredOn === "2026-01-01")!, lines.find((l) => l.acquiredOn === "2026-02-02")!];
    })();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(older._id, { lastUpdated: 1_000 });
      await ctx.db.patch(newer._id, { lastUpdated: 2_000 });
    });
    // 5 -> 4: one off the newest line only.
    await setQty(s, s.fx.gooden1, s.boxA, 4);
    expect(shape(await linesIn(s, s.fx.gooden1, s.boxA))).toEqual(["2@2026-01-01", "2@2026-02-02"]);
    // 4 -> 1: the newest line goes whole, one more comes off the older one.
    await setQty(s, s.fx.gooden1, s.boxA, 1);
    expect(shape(await linesIn(s, s.fx.gooden1, s.boxA))).toEqual(["1@2026-01-01"]);
    await exact(s);
  });

  test("the same number writes nothing and returns an empty undo", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2);
    const before = await rowsOf(s);
    const r = await setQty(s, s.fx.gooden1, s.boxA, 2);
    expect(r).toMatchObject({ before: 2, after: 2 });
    expect(r.inverse.steps).toEqual([]);
    expect(await rowsOf(s)).toEqual(before);
    const none = await setQty(s, s.fx.strawberry2, s.boxA, 0);
    expect(none).toMatchObject({ before: 0, after: 0 });
    expect(none.inverse.steps).toEqual([]);
    expect(await rowsOf(s)).toEqual(before);
  });
});

describe("setBoxQuantity: plain lines only", () => {
  test("graded, noted, conditioned, costed, serial, located and up-for-trade lines are neither counted nor touched", async () => {
    const s = await setup();
    const card = s.fx.gooden1;
    const other = [
      { quantity: 1, grading: { grader: "PSA", grade: "9" } },
      { quantity: 2, notes: "keep this" },
      { quantity: 3, condition: "Mint" },
      { quantity: 4, costCents: 500 },
      { quantity: 1, serialNumber: "07/25" },
      { quantity: 6, location: "Row 2" },
      { quantity: 7, upForTrade: true },
    ];
    for (const details of other) await add(s, card, { homeId: s.boxA, ...details });
    const before = await linesIn(s, card, s.boxA);
    expect(before).toHaveLength(7);

    // None of them is "plain", so the quick count reads 0 and a raise adds its own line.
    const up = await setQty(s, card, s.boxA, 2);
    expect(up).toMatchObject({ before: 0, after: 2 });
    const mid = await linesIn(s, card, s.boxA);
    expect(mid).toHaveLength(8);
    for (const row of before) expect(mid.find((m) => m._id === row._id)).toEqual(row);

    // Lowering to 0 removes only the plain line.
    const down = await setQty(s, card, s.boxA, 0);
    expect(down).toMatchObject({ before: 2, after: 0 });
    const after = await linesIn(s, card, s.boxA);
    expect(after.map((r) => r._id).sort()).toEqual(before.map((r) => r._id).sort());
    for (const row of before) expect(after.find((m) => m._id === row._id)).toEqual(row);
    await exact(s);
  });

  test("a plain line placed in a row or acquired another day still counts and is the one lowered", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 3, slot: 2, acquiredOn: "2020-05-05" });
    const r = await setQty(s, s.fx.gooden1, s.boxA, 1);
    expect(r).toMatchObject({ before: 3, after: 1 });
    expect(await linesIn(s, s.fx.gooden1, s.boxA)).toMatchObject([{ quantity: 1, slot: 2, acquiredOn: "2020-05-05" }]);
    await exact(s);
  });

  test("a raise does not fold into a placed line (its row would change); it makes its own", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 1, slot: 2, acquiredOn: TODAY });
    await setQty(s, s.fx.gooden1, s.boxA, 3);
    const lines = await linesIn(s, s.fx.gooden1, s.boxA);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.slot === 2)!.quantity).toBe(1);
    expect(lines.find((l) => l.slot === undefined)!.quantity).toBe(2);
  });
});

describe("setBoxQuantity: the hard line and the counts", () => {
  test("never touches a binder line of the same card, and never the collection tally", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binder, quantity: 4 });
    const tallyBefore = await tallyTruth(s.t, ME.subject);
    const binderLine = (await rowsOf(s)).find((r) => r.homeId === s.binder)!;
    await setQty(s, s.fx.gooden1, s.boxA, 2);
    await setQty(s, s.fx.gooden1, s.boxA, 0);
    expect((await rowsOf(s)).find((r) => r.homeId === s.binder)).toEqual(binderLine);
    expect(await tallyTruth(s.t, ME.subject)).toEqual(tallyBefore);
    expect(tallyBefore.stored).toEqual(tallyBefore.truth);
    await exact(s);
  });

  test("a quick count does not change the card count of a set build either", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.setBuilding, { setId: s.fx.setId, building: true });
    await setQty(s, s.fx.gooden1, s.boxA, 2);
    const rows = await s.t.run(async (ctx) => ctx.db.query("collectionBuildingSets").collect());
    expect(rows[0].cards ?? 0).toBe(0);
    expect(await s.me.query(api.collection.summary, {})).toMatchObject({ copies: 0, distinctCards: 0, offBuildCards: 0 });
  });
});

describe("setBoxQuantity: refusals", () => {
  test("a binder, the Main binder, Up for Trade and the Want List are not places for a quick count", async () => {
    const s = await setup();
    for (const boxId of [s.binder, s.sys.mainId, s.sys.tradeId, s.sys.wantId]) {
      await expect(setQty(s, s.fx.gooden1, boxId, 1)).rejects.toThrow();
    }
    expect(await rowsOf(s)).toEqual([]);
  });

  test("another collector's box reads as not found and writes nothing", async () => {
    const s = await setup();
    await expect(
      s.them.mutation(api.collectionInventory.setBoxQuantity, { cardId: s.fx.gooden1, boxId: s.boxA, quantity: 1 }),
    ).rejects.toThrow(/isn't in your collection/);
    const theirs = await s.them.mutation(api.collectionContainers.create, { kind: "box", name: "Theirs" });
    await expect(setQty(s, s.fx.gooden1, theirs.containerId, 1)).rejects.toThrow(/isn't in your collection/);
    expect(await s.t.run(async (ctx) => ctx.db.query("collectionCopies").collect())).toEqual([]);
  });

  test("a quantity outside 0 to 999, or not whole, is refused and writes nothing", async () => {
    const s = await setup();
    for (const bad of [-1, 1.5, MAX_COPY_QUANTITY + 1, Number.NaN]) {
      await expect(setQty(s, s.fx.gooden1, s.boxA, bad)).rejects.toThrow();
    }
    expect(await rowsOf(s)).toEqual([]);
  });

  test("999 is accepted: the highest count, split across lines when a fold would pass it", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 500, "2026-01-01");
    const r = await setQty(s, s.fx.gooden1, s.boxA, MAX_COPY_QUANTITY, "2026-02-02");
    expect(r).toMatchObject({ before: 500, after: MAX_COPY_QUANTITY });
    expect(sum(await linesIn(s, s.fx.gooden1, s.boxA))).toBe(MAX_COPY_QUANTITY);
    await exact(s);
  });

  test("a card with 200 lines already refuses a new line, and writes nothing", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < MAX_LINES_PER_CARD; i++) {
        await ctx.db.insert("collectionCopies", {
          ownerId: ME.subject, cardId: s.fx.gooden1, variantId: s.fx.baseId, setId: s.fx.setId,
          homeId: s.binder, quantity: 1, notes: `n${i}`, lastUpdated: i,
        });
      }
    });
    await expect(setQty(s, s.fx.gooden1, s.boxA, 1)).rejects.toThrow(/lines of this card/);
    expect(await linesIn(s, s.fx.gooden1, s.boxA)).toEqual([]);
  });
});

describe("undoBoxQuantity", () => {
  test("undoes a raise to nothing, and its own result redoes it", async () => {
    const s = await setup();
    const raised = await setQty(s, s.fx.gooden1, s.boxA, 3);
    const undone = await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: raised.inverse });
    expect(undone).toMatchObject({ before: 3, after: 0 });
    expect(await linesIn(s, s.fx.gooden1, s.boxA)).toEqual([]);
    await exact(s);
    const redone = await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: undone.inverse });
    expect(redone).toMatchObject({ before: 0, after: 3 });
    expect(shape(await linesIn(s, s.fx.gooden1, s.boxA))).toEqual([`3@${TODAY}`]);
    await exact(s);
  });

  test("undoes a fold-in raise by taking the copies back off the same line", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2);
    const [line] = await linesIn(s, s.fx.gooden1, s.boxA);
    const raised = await setQty(s, s.fx.gooden1, s.boxA, 6);
    await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: raised.inverse });
    const after = await linesIn(s, s.fx.gooden1, s.boxA);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ _id: line._id, quantity: 2 });
    await exact(s);
  });

  test("undoes a lower that deleted lines and cut another: every line is back as it was", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2, "2026-01-01");
    await setQty(s, s.fx.gooden1, s.boxA, 5, "2026-02-02");
    await setQty(s, s.fx.gooden1, s.boxA, 9, "2026-03-03");
    const lines = await linesIn(s, s.fx.gooden1, s.boxA);
    await s.t.run(async (ctx) => {
      for (const [i, l] of lines.sort((a, b) => (a.acquiredOn! < b.acquiredOn! ? -1 : 1)).entries()) {
        await ctx.db.patch(l._id, { lastUpdated: 100 * (i + 1) });
      }
    });
    const before = shape(await linesIn(s, s.fx.gooden1, s.boxA));
    const lowered = await setQty(s, s.fx.gooden1, s.boxA, 1);
    expect(shape(await linesIn(s, s.fx.gooden1, s.boxA))).toEqual(["1@2026-01-01"]);
    const undone = await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: lowered.inverse });
    expect(undone).toMatchObject({ before: 1, after: 9 });
    expect(shape(await linesIn(s, s.fx.gooden1, s.boxA))).toEqual(before);
    await exact(s);
    // And the redo lowers it again.
    const redone = await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: undone.inverse });
    expect(redone).toMatchObject({ before: 9, after: 1 });
    expect(shape(await linesIn(s, s.fx.gooden1, s.boxA))).toEqual(["1@2026-01-01"]);
    await exact(s);
  });

  test("an undo of a deleted line folds into an identical line that appeared since", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2);
    const lowered = await setQty(s, s.fx.gooden1, s.boxA, 0);
    await setQty(s, s.fx.gooden1, s.boxA, 1); // a new plain line, same day
    await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: lowered.inverse });
    const lines = await linesIn(s, s.fx.gooden1, s.boxA);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(3);
    await exact(s);
  });

  test("refuses everything when the count changed since, and writes nothing", async () => {
    const s = await setup();
    const raised = await setQty(s, s.fx.gooden1, s.boxA, 2);
    await setQty(s, s.fx.gooden1, s.boxA, 4); // folded into the same line
    const before = await rowsOf(s);
    await expect(
      s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: raised.inverse }),
    ).rejects.toThrow(/changed since/);
    expect(await rowsOf(s)).toEqual(before);
    await exact(s);
  });

  test("refuses when the line it names was deleted, or is no longer plain", async () => {
    const s = await setup();
    const raised = await setQty(s, s.fx.gooden1, s.boxA, 2);
    const [line] = await linesIn(s, s.fx.gooden1, s.boxA);
    await s.t.run(async (ctx) => ctx.db.patch(line._id, { notes: "now it has a note" }));
    await expect(
      s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: raised.inverse }),
    ).rejects.toThrow(/changed since/);
    await s.t.run(async (ctx) => ctx.db.delete(line._id));
    await expect(
      s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: raised.inverse }),
    ).rejects.toThrow(/changed since/);
  });

  test("a step that fails rolls back the steps before it", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2);
    const [line] = await linesIn(s, s.fx.gooden1, s.boxA);
    const before = await rowsOf(s);
    await expect(
      s.me.mutation(api.collectionInventory.undoBoxQuantity, {
        inverse: {
          cardId: s.fx.gooden1,
          boxId: s.boxA,
          steps: [
            { op: "restore", quantity: 1, acquiredOn: TODAY },
            { op: "set", copyId: line._id, from: 99, to: 1 },
          ],
        },
      }),
    ).rejects.toThrow(/changed since/);
    expect(await rowsOf(s)).toEqual(before);
    await exact(s);
  });

  test("steps for a binder, a shelf row, or another collector's box are refused", async () => {
    const s = await setup();
    const raised = await setQty(s, s.fx.gooden1, s.boxA, 2);
    for (const boxId of [s.binder, s.sys.mainId, s.sys.tradeId]) {
      await expect(
        s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: { ...raised.inverse, boxId } }),
      ).rejects.toThrow();
    }
    await expect(
      s.them.mutation(api.collectionInventory.undoBoxQuantity, { inverse: raised.inverse }),
    ).rejects.toThrow(/isn't in your collection/);
    expect(sum(await linesIn(s, s.fx.gooden1, s.boxA))).toBe(2);
  });

  test("an undo cannot touch a binder line even when a step names it", async () => {
    const s = await setup();
    const { copyId } = await add(s, s.fx.gooden1, { homeId: s.binder, quantity: 3 });
    await expect(
      s.me.mutation(api.collectionInventory.undoBoxQuantity, {
        inverse: { cardId: s.fx.gooden1, boxId: s.boxA, steps: [{ op: "remove", copyId, quantity: 3 }] },
      }),
    ).rejects.toThrow(/changed since/);
    expect((await rowsOf(s)).find((r) => r._id === copyId)).toMatchObject({ quantity: 3, homeId: s.binder });
  });

  test("more than 200 steps are refused up front", async () => {
    const s = await setup();
    const steps = Array.from({ length: MAX_LINES_PER_CARD + 1 }, () => ({ op: "restore" as const, quantity: 1 }));
    await expect(
      s.me.mutation(api.collectionInventory.undoBoxQuantity, {
        inverse: { cardId: s.fx.gooden1, boxId: s.boxA, steps },
      }),
    ).rejects.toThrow(/changed since/);
    expect(await rowsOf(s)).toEqual([]);
  });
});

describe("inventoryCards", () => {
  test("one item per card across every box: quantity, lines, flags, and the boxes it sits in (Unsorted first)", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 3 });
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 1, grading: { grader: "PSA", grade: "9" } });
    await add(s, s.fx.gooden1, { homeId: s.boxB, quantity: 2, upForTrade: true });
    await add(s, s.fx.gooden1, { homeId: s.sys.unsortedId, quantity: 4 });
    await add(s, s.fx.strawberry2, { homeId: s.boxB, quantity: 1 });
    const r = await s.me.query(api.collectionInventory.inventoryCards, {});
    expect(r.truncated).toBe(false);
    expect(r.goneCardIds).toEqual([]);
    expect(r.items).toHaveLength(2);
    const g = r.items.find((i) => i.cardId === s.fx.gooden1)!;
    expect(g).toMatchObject({ quantity: 10, lines: 4, graded: true, upForTrade: true });
    expect(g.boxes).toEqual([
      { boxId: s.sys.unsortedId, quantity: 4 },
      { boxId: s.boxA, quantity: 4 },
      { boxId: s.boxB, quantity: 2 },
    ]);
    const st = r.items.find((i) => i.cardId === s.fx.strawberry2)!;
    expect(st).toMatchObject({ quantity: 1, lines: 1, graded: false, upForTrade: false, boxes: [{ boxId: s.boxB, quantity: 1 }] });
  });

  test("items are newest first by the card's newest box line", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.boxA });
    await add(s, s.fx.strawberry2, { homeId: s.boxA });
    await add(s, s.fx.gold1, { homeId: s.boxA });
    await s.t.run(async (ctx) => {
      for (const row of await ctx.db.query("collectionCopies").collect()) {
        const stamp = row.cardId === s.fx.strawberry2 ? 3000 : row.cardId === s.fx.gold1 ? 2000 : 1000;
        await ctx.db.patch(row._id, { lastUpdated: stamp });
      }
    });
    const r = await s.me.query(api.collectionInventory.inventoryCards, {});
    expect(r.items.map((i) => i.cardId)).toEqual([s.fx.strawberry2, s.fx.gold1, s.fx.gooden1]);
    expect(r.items.map((i) => i.lastUpdated)).toEqual([3000, 2000, 1000]);
  });

  test("never lists a binder line, and a card in both sides counts its box copies only", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.binder, quantity: 9 });
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.strawberry2 }); // Main
    await add(s, s.fx.gold1, { homeId: s.binder, quantity: 2, upForTrade: true });
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 2 });
    const r = await s.me.query(api.collectionInventory.inventoryCards, {});
    expect(r.items.map((i) => i.cardId)).toEqual([s.fx.gooden1]);
    expect(r.items[0]).toMatchObject({ quantity: 2, lines: 1, upForTrade: false });
    expect(r.items[0].boxes).toEqual([{ boxId: s.boxA, quantity: 2 }]);
  });

  test("is empty for a collector with no boxes, and never shows another collector's lines", async () => {
    const s = await setup();
    await s.them.mutation(api.collectionContainers.ensureSystem, {});
    const theirs = await s.them.mutation(api.collectionContainers.create, { kind: "box", name: "Theirs" });
    await s.them.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 5, homeId: theirs.containerId } });
    expect(await s.me.query(api.collectionInventory.inventoryCards, {})).toEqual({ items: [], goneCardIds: [], truncated: false });
    const mine = await s.them.query(api.collectionInventory.inventoryCards, {});
    expect(mine.items).toHaveLength(1);
  });

  test("a card that has left the catalog is reported in goneCardIds, not listed and not a crash", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 2 });
    await add(s, s.fx.strawberry2, { homeId: s.boxA });
    await s.t.run(async (ctx) => ctx.db.delete(s.fx.gooden1));
    const r = await s.me.query(api.collectionInventory.inventoryCards, {});
    expect(r.goneCardIds).toEqual([s.fx.gooden1]);
    expect(r.items.map((i) => i.cardId)).toEqual([s.fx.strawberry2]);
  });

  test("truncated is honest: true when the budget stops short, false when it exactly fits", async () => {
    const s = await setup();
    for (const card of [s.fx.gooden1, s.fx.strawberry2, s.fx.gold1, s.fx.futureStar]) {
      await add(s, card, { homeId: s.boxA });
    }
    const short = await s.me.query(api.collectionInventory.inventoryCards, { limit: 3 });
    expect(short.truncated).toBe(true);
    expect(short.items).toHaveLength(3);
    const exactFit = await s.me.query(api.collectionInventory.inventoryCards, { limit: 4 });
    expect(exactFit.truncated).toBe(false);
    expect(exactFit.items).toHaveLength(4);
    // Any silly limit is clamped to at least one line, never an error.
    const tiny = await s.me.query(api.collectionInventory.inventoryCards, { limit: 0 });
    expect(tiny.truncated).toBe(true);
    expect(tiny.items).toHaveLength(1);
  });

  test("a budget that ends exactly at a box's last line is not truncated when no later box holds lines", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.boxA });
    await add(s, s.fx.strawberry2, { homeId: s.boxA });
    // Box B is empty, Unsorted is empty; budget used up inside Box A.
    const r = await s.me.query(api.collectionInventory.inventoryCards, { limit: 2 });
    expect(r.truncated).toBe(false);
    // With a line in a later box, the same budget is short.
    await add(s, s.fx.gold1, { homeId: s.boxB });
    const r2 = await s.me.query(api.collectionInventory.inventoryCards, { limit: 2 });
    expect(r2.truncated).toBe(true);
  });

  test("the default budget is MAX_INVENTORY_LINES lines: one more is truncated", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < MAX_INVENTORY_LINES + 1; i++) {
        await ctx.db.insert("collectionCopies", {
          ownerId: ME.subject, cardId: s.fx.gooden1, variantId: s.fx.baseId, setId: s.fx.setId,
          homeId: s.boxA, quantity: 1, notes: `n${i}`, lastUpdated: i,
        });
      }
    });
    const r = await s.me.query(api.collectionInventory.inventoryCards, {});
    expect(r.truncated).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].lines).toBe(MAX_INVENTORY_LINES);
    // A caller cannot ask for more than the cap.
    const greedy = await s.me.query(api.collectionInventory.inventoryCards, { limit: MAX_INVENTORY_LINES * 5 });
    expect(greedy.items[0].lines).toBe(MAX_INVENTORY_LINES);
  }, 60_000);

  test("carries NB data only", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 2, costCents: 100, notes: "private" });
    const text = JSON.stringify(await s.me.query(api.collectionInventory.inventoryCards, {}));
    expect(text).not.toMatch(/platform|isCustom|"sku"|bsc|ownerId|costCents|private/i);
  });
});
