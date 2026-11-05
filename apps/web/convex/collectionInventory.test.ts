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
import { api, internal } from "./_generated/api";
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
    // NEO-380: a raw line always has a condition; never set, the default is Excellent.
    expect(lines[0].condition).toBe("Excellent");
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
    await expect(setQty(s, s.fx.gooden1, s.boxA, 1)).rejects.toThrow(
      "You already have 200 lines of this card. Remove one, or stack any without photos, to make room.",
    );
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

  test("another collector naming their OWN Unsorted with my copyIds is refused, and my lines are untouched", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2);
    const lowered = await setQty(s, s.fx.gooden1, s.boxA, 1); // a set step on my line
    const raised = await setQty(s, s.fx.strawberry2, s.sys.unsortedId, 3); // a remove step on my line
    const theirs = await s.them.mutation(api.collectionContainers.ensureSystem, {});
    const before = await rowsOf(s);
    for (const inverse of [lowered.inverse, raised.inverse]) {
      expect(inverse.steps.some((step) => step.op !== "restore")).toBe(true);
      await expect(
        s.them.mutation(api.collectionInventory.undoBoxQuantity, {
          inverse: { ...inverse, boxId: theirs.unsortedId },
        }),
      ).rejects.toThrow(/changed since/);
    }
    expect(await rowsOf(s)).toEqual(before);
    expect(await rowsOf(s, THEM.subject)).toEqual([]);
    await exact(s);
  });

  test("restores that fold into each other see the earlier steps' writes", async () => {
    const s = await setup();
    // Two restores of the same day: the second folds into the line the first made.
    const undone = await s.me.mutation(api.collectionInventory.undoBoxQuantity, {
      inverse: {
        cardId: s.fx.gooden1,
        boxId: s.boxA,
        steps: [
          { op: "restore", quantity: 2, acquiredOn: TODAY },
          { op: "restore", quantity: 3, acquiredOn: TODAY },
          { op: "restore", quantity: 1, acquiredOn: "2001-02-03" },
        ],
      },
    });
    expect(undone).toMatchObject({ before: 0, after: 6 });
    expect(shape(await linesIn(s, s.fx.gooden1, s.boxA))).toEqual(["1@2001-02-03", `5@${TODAY}`]);
    await exact(s);
    // Its inverse takes them all back off.
    const redone = await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: undone.inverse });
    expect(redone).toMatchObject({ before: 6, after: 0 });
    expect(await linesIn(s, s.fx.gooden1, s.boxA)).toEqual([]);
    await exact(s);
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

describe("a line with photos (NEO-431)", () => {
  const undoOf = (s: S, inverse: unknown) => s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: inverse as never });
  /** Steps 1 and 3 of an upload, without R2 in between. */
  async function photograph(s: S, copyId: Id<"collectionCopies">, side: "front" | "back" = "front") {
    const { photoId } = await s.t.mutation(internal.copyPhotos.reserveUpload, {
      ownerId: ME.subject,
      copyId,
      side,
      contentType: "image/jpeg",
      imageBytes: 300_000,
      thumbBytes: 20_000,
    });
    await s.t.mutation(internal.copyPhotos.commitUpload, { ownerId: ME.subject, photoId });
    return photoId;
  }
  const photoStatus = (s: S, id: Id<"collectionCopyPhotos">) => s.t.run(async (ctx) => (await ctx.db.get(id))?.status);
  /** A line in Box A with a front photo. */
  async function photoLine(s: S, details: Record<string, unknown> = {}) {
    const { copyId } = await add(s, s.fx.gooden1, { homeId: s.boxA, ...details });
    const photoId = await photograph(s, copyId);
    return { copyId, photoId };
  }
  const lines = (s: S) => linesIn(s, s.fx.gooden1, s.boxA);
  const count = (rows: Array<{ _id: string; quantity: number }>) => rows.map((r) => [r._id, r.quantity]);

  test("counts as plain: the number it already holds writes nothing", async () => {
    const s = await setup();
    await photoLine(s);
    const same = await setQty(s, s.fx.gooden1, s.boxA, 1);
    expect(same).toMatchObject({ before: 1, after: 1 });
    expect(same.inverse.steps).toEqual([]);
  });

  test("with another detail it stays aside: not counted, not touched", async () => {
    const s = await setup();
    const { copyId } = await photoLine(s, { notes: "corner ding" });
    const raised = await setQty(s, s.fx.gooden1, s.boxA, 1);
    expect(raised.before).toBe(0);
    const zero = await setQty(s, s.fx.gooden1, s.boxA, 0);
    expect(zero.before).toBe(1);
    expect((await lines(s)).map((r) => r._id)).toEqual([copyId]);
  });

  describe("raising", () => {
    test("with only a photo line, stacks onto it, sharing its photos; the Undo takes the copies back off it, the redo puts them on again", async () => {
      const s = await setup();
      const { copyId, photoId } = await photoLine(s, { acquiredOn: "2026-01-01" });
      const raised = await setQty(s, s.fx.gooden1, s.boxA, 3);
      expect(raised).toMatchObject({ before: 1, after: 3 });
      expect(await lines(s)).toEqual([expect.objectContaining({ _id: copyId, quantity: 3, hasPhotos: true, acquiredOn: "2026-01-01" })]);
      expect(await photoStatus(s, photoId)).toBe("live");
      await exact(s);

      const undone = await undoOf(s, raised.inverse);
      expect(undone).toMatchObject({ before: 3, after: 1 });
      expect(count(await lines(s))).toEqual([[copyId, 1]]);
      expect(await photoStatus(s, photoId)).toBe("live");
      await exact(s);

      await undoOf(s, undone.inverse);
      expect(count(await lines(s))).toEqual([[copyId, 3]]);
      await exact(s);
    });

    test("with two photo lines and nothing else, stacks onto the newest", async () => {
      const s = await setup();
      const older = await photoLine(s);
      const newer = await photoLine(s);
      await s.t.run((ctx) => ctx.db.patch(older.copyId, { lastUpdated: 1 }));
      await setQty(s, s.fx.gooden1, s.boxA, 3);
      const rows = await lines(s);
      expect(rows.find((r) => r._id === newer.copyId)?.quantity).toBe(2);
      expect(rows.find((r) => r._id === older.copyId)?.quantity).toBe(1);
      await exact(s);
    });

    test("with a line without photos dated today, folds there; the photo line stays as it was", async () => {
      const s = await setup();
      const { copyId } = await photoLine(s, { acquiredOn: TODAY });
      const bare = (await add(s, s.fx.gooden1, { homeId: s.boxA, acquiredOn: TODAY })).copyId;
      await setQty(s, s.fx.gooden1, s.boxA, 4);
      const rows = await lines(s);
      expect(rows.find((r) => r._id === bare)?.quantity).toBe(3);
      expect(rows.find((r) => r._id === copyId)?.quantity).toBe(1);
      expect(rows).toHaveLength(2);
      await exact(s);
    });

    test("with an older line without photos, starts today's line, as today; never onto the photo line", async () => {
      const s = await setup();
      const { copyId } = await photoLine(s, { acquiredOn: TODAY });
      await add(s, s.fx.gooden1, { homeId: s.boxA, acquiredOn: "2026-01-01" });
      await setQty(s, s.fx.gooden1, s.boxA, 3);
      const rows = await lines(s);
      expect(rows).toHaveLength(3);
      expect(rows.find((r) => r._id === copyId)?.quantity).toBe(1);
      expect(shape(rows.filter((r) => r._id !== copyId))).toEqual(["1@2026-01-01", `1@${TODAY}`].sort());
      await exact(s);
    });

    test("a photo line beside a line with other details still takes the raise: only plain lines decide", async () => {
      const s = await setup();
      const { copyId } = await photoLine(s);
      await add(s, s.fx.gooden1, { homeId: s.boxA, notes: "corner ding" });
      await setQty(s, s.fx.gooden1, s.boxA, 2);
      const rows = await lines(s);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r._id === copyId)?.quantity).toBe(2);
    });

    test("a photo line in another box is no target: this box starts its own line", async () => {
      const s = await setup();
      const { copyId } = await photoLine(s);
      await setQty(s, s.fx.gooden1, s.boxB, 1);
      expect(count(await lines(s))).toEqual([[copyId, 1]]);
      expect(await linesIn(s, s.fx.gooden1, s.boxB)).toEqual([expect.objectContaining({ quantity: 1 })]);
      expect((await linesIn(s, s.fx.gooden1, s.boxB))[0].hasPhotos).toBeUndefined();
    });

    test("the cap holds on the stack", async () => {
      const s = await setup();
      await photoLine(s, { quantity: MAX_COPY_QUANTITY });
      await expect(setQty(s, s.fx.gooden1, s.boxA, MAX_COPY_QUANTITY + 1)).rejects.toThrow();
      expect(sum(await lines(s))).toBe(MAX_COPY_QUANTITY);
    });

    test("a plain add and an undone lower still never stack onto it", async () => {
      const s = await setup();
      const { copyId } = await photoLine(s, { acquiredOn: "2026-01-01" });
      const bare = await add(s, s.fx.gooden1, { homeId: s.boxA, acquiredOn: "2026-01-01" });
      expect(bare.merged).toBeFalsy();
      const lowered = await setQty(s, s.fx.gooden1, s.boxA, 1);
      await undoOf(s, lowered.inverse);
      const rows = await lines(s);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r._id === copyId)?.quantity).toBe(1);
      await exact(s);
    });
  });

  describe("lowering", () => {
    test("takes the lines without photos first, even when the photo line is newer", async () => {
      const s = await setup();
      const bare = (await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 2, acquiredOn: "2026-01-01" })).copyId;
      await s.t.run((ctx) => ctx.db.patch(bare, { lastUpdated: 1 }));
      const { copyId, photoId } = await photoLine(s, { quantity: 2 });
      await setQty(s, s.fx.gooden1, s.boxA, 3);
      expect(count(await lines(s)).sort()).toEqual([[bare, 1], [copyId, 2]].sort());
      await setQty(s, s.fx.gooden1, s.boxA, 2);
      expect(count(await lines(s))).toEqual([[copyId, 2]]);
      expect(await photoStatus(s, photoId)).toBe("live");
      await exact(s);
    });

    test("takes newest first within each group", async () => {
      const s = await setup();
      const bareOld = (await add(s, s.fx.gooden1, { homeId: s.boxA, acquiredOn: "2026-01-01" })).copyId;
      const bareNew = (await add(s, s.fx.gooden1, { homeId: s.boxA, acquiredOn: "2026-01-02" })).copyId;
      const photoOld = await photoLine(s);
      const photoNew = await photoLine(s);
      await s.t.run(async (ctx) => {
        await ctx.db.patch(bareOld, { lastUpdated: 10 });
        await ctx.db.patch(bareNew, { lastUpdated: 20 });
        await ctx.db.patch(photoOld.copyId, { lastUpdated: 1 });
        await ctx.db.patch(photoNew.copyId, { lastUpdated: 2 });
      });
      await setQty(s, s.fx.gooden1, s.boxA, 3);
      expect((await lines(s)).some((r) => r._id === bareNew)).toBe(false);
      await setQty(s, s.fx.gooden1, s.boxA, 2);
      expect((await lines(s)).some((r) => r._id === bareOld)).toBe(false);
      await setQty(s, s.fx.gooden1, s.boxA, 1);
      expect(count(await lines(s))).toEqual([[photoOld.copyId, 1]]);
      expect(await photoStatus(s, photoNew.photoId)).toBe("detached");
      expect(await photoStatus(s, photoOld.photoId)).toBe("live");
    });

    test("part of a photo line keeps its photos; the Undo sets it back", async () => {
      const s = await setup();
      const { copyId, photoId } = await photoLine(s, { quantity: 3 });
      const lowered = await setQty(s, s.fx.gooden1, s.boxA, 2);
      expect(await lines(s)).toEqual([expect.objectContaining({ _id: copyId, quantity: 2, hasPhotos: true })]);
      expect(await photoStatus(s, photoId)).toBe("live");
      await undoOf(s, lowered.inverse);
      expect(count(await lines(s))).toEqual([[copyId, 3]]);
      await exact(s);
    });
  });

  describe("a count to 0, its Undo and its redo", () => {
    test("the line goes, its photos wait, and the Undo brings it back with both sides, its row and its date", async () => {
      const s = await setup();
      const { copyId, photoId } = await photoLine(s, { quantity: 2, acquiredOn: "2026-01-01", slot: 3 });
      const back = await photograph(s, copyId, "back");
      const zero = await setQty(s, s.fx.gooden1, s.boxA, 0);
      expect(zero).toMatchObject({ before: 2, after: 0 });
      expect(await lines(s)).toEqual([]);
      expect(await photoStatus(s, photoId)).toBe("detached");
      expect(await photoStatus(s, back)).toBe("detached");
      await exact(s);

      const undone = await undoOf(s, zero.inverse);
      expect(undone).toMatchObject({ before: 0, after: 2 });
      const [row] = await lines(s);
      expect(row).toMatchObject({ quantity: 2, hasPhotos: true, acquiredOn: "2026-01-01", slot: 3 });
      expect(await photoStatus(s, photoId)).toBe("live");
      expect(await photoStatus(s, back)).toBe("live");
      const [urls] = await s.me.query(api.copyPhotos.photosOf, { copyIds: [row._id] });
      expect(urls.front).toBeDefined();
      expect(urls.back).toBeDefined();
      await exact(s);
    });

    test("redo and undo again never strand or lose the photos", async () => {
      const s = await setup();
      const { photoId } = await photoLine(s);
      const zero = await setQty(s, s.fx.gooden1, s.boxA, 0);
      const undone = await undoOf(s, zero.inverse);
      const redone = await undoOf(s, undone.inverse);
      expect(redone).toMatchObject({ before: 1, after: 0 });
      expect(await lines(s)).toEqual([]);
      expect(await photoStatus(s, photoId)).toBe("detached");
      await exact(s);
      const again = await undoOf(s, redone.inverse);
      expect(again).toMatchObject({ before: 0, after: 1 });
      expect(await lines(s)).toEqual([expect.objectContaining({ quantity: 1, hasPhotos: true })]);
      expect(await photoStatus(s, photoId)).toBe("live");
      await exact(s);
    });

    test("a bare line and a photo line of the same date both come back apart, the photos on the right one", async () => {
      const s = await setup();
      // The photo line first: a plain add would fold, and the photo land on the stack.
      const { photoId } = await photoLine(s, { acquiredOn: "2026-01-01" });
      await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 2, acquiredOn: "2026-01-01" });
      const zero = await setQty(s, s.fx.gooden1, s.boxA, 0);
      await undoOf(s, zero.inverse);
      const rows = await lines(s);
      expect(rows.map((r) => [r.quantity, r.hasPhotos === true]).sort()).toEqual([[1, true], [2, false]]);
      expect(await photoStatus(s, photoId)).toBe("live");
      await exact(s);
    });

    test("a restore with photos never folds into a bare line that has appeared since", async () => {
      const s = await setup();
      const { photoId } = await photoLine(s, { acquiredOn: "2026-01-01" });
      const zero = await setQty(s, s.fx.gooden1, s.boxA, 0);
      await add(s, s.fx.gooden1, { homeId: s.boxA, acquiredOn: "2026-01-01" });
      await undoOf(s, zero.inverse);
      const rows = await lines(s);
      expect(rows.map((r) => [r.quantity, r.hasPhotos === true]).sort()).toEqual([[1, false], [1, true]]);
      expect(await photoStatus(s, photoId)).toBe("live");
      await exact(s);
    });

    test("photos already swept: the line comes back bare, and its redo removes it", async () => {
      const s = await setup();
      const { photoId } = await photoLine(s);
      const zero = await setQty(s, s.fx.gooden1, s.boxA, 0);
      await s.t.run((ctx) => ctx.db.delete(photoId));
      const undone = await undoOf(s, zero.inverse);
      const [row] = await lines(s);
      expect(row.quantity).toBe(1);
      expect(row.hasPhotos).toBeUndefined();
      await undoOf(s, undone.inverse);
      expect(await lines(s)).toEqual([]);
      await exact(s);
    });

    test("another collector's forged restore can't take detached photos", async () => {
      const s = await setup();
      const { photoId } = await photoLine(s);
      const zero = await setQty(s, s.fx.gooden1, s.boxA, 0);
      const step = zero.inverse.steps[0];
      expect(step.op === "restore" && step.photoIds).toEqual([photoId]);
      const theirBox = (await s.them.mutation(api.collectionContainers.create, { kind: "box", name: "Theirs" })).containerId;
      await s.them.mutation(api.collectionInventory.undoBoxQuantity, {
        inverse: { cardId: s.fx.gooden1, boxId: theirBox, steps: [step] },
      });
      const theirs = await rowsOf(s, THEM.subject);
      expect(theirs).toEqual([expect.objectContaining({ quantity: 1 })]);
      expect(theirs[0].hasPhotos).toBeUndefined();
      expect(await photoStatus(s, photoId)).toBe("detached");
    });
  });

  describe("changed since", () => {
    test("a line a raise made and the collector then photographed is theirs: the Undo refuses and it stands", async () => {
      const s = await setup();
      const raised = await setQty(s, s.fx.gooden1, s.boxA, 1);
      const [row] = await lines(s);
      const photoId = await photograph(s, row._id);
      await expect(undoOf(s, raised.inverse)).rejects.toThrow(/changed since/i);
      expect(await lines(s)).toEqual([expect.objectContaining({ _id: row._id, hasPhotos: true })]);
      expect(await photoStatus(s, photoId)).toBe("live");
    });

    test("a redo whose line lost its photos since refuses, and the line stands", async () => {
      const s = await setup();
      await photoLine(s);
      const zero = await setQty(s, s.fx.gooden1, s.boxA, 0);
      const undone = await undoOf(s, zero.inverse);
      const [row] = await lines(s);
      await s.me.mutation(api.copyPhotos.remove, { copyId: row._id, side: "front" });
      await expect(undoOf(s, undone.inverse)).rejects.toThrow(/changed since/i);
      expect(count(await lines(s))).toEqual([[row._id, 1]]);
    });

    test("a stack the collector changed since refuses, and keeps its photos", async () => {
      const s = await setup();
      const { copyId, photoId } = await photoLine(s);
      const raised = await setQty(s, s.fx.gooden1, s.boxA, 2);
      await s.me.mutation(api.collection.updateCopy, { copyId, details: { quantity: 5, homeId: s.boxA, acquiredOn: TODAY } as never });
      await expect(undoOf(s, raised.inverse)).rejects.toThrow(/changed since/i);
      expect(await photoStatus(s, photoId)).toBe("live");
    });

    test("a photo line since given another detail is out of the count: the Undo refuses", async () => {
      const s = await setup();
      const { copyId } = await photoLine(s);
      const raised = await setQty(s, s.fx.gooden1, s.boxA, 2);
      await s.me.mutation(api.collection.updateCopy, { copyId, details: { quantity: 2, homeId: s.boxA, notes: "corner ding" } as never });
      await expect(undoOf(s, raised.inverse)).rejects.toThrow(/changed since/i);
      expect(count(await lines(s))).toEqual([[copyId, 2]]);
    });
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
    expect(g).toMatchObject({ quantity: 10, lines: 4, graded: true, gradedQuantity: 1, upForTrade: true });
    expect(g.boxes).toEqual([
      { boxId: s.sys.unsortedId, quantity: 4, gradedQuantity: 0 },
      { boxId: s.boxA, quantity: 4, gradedQuantity: 1 },
      { boxId: s.boxB, quantity: 2, gradedQuantity: 0 },
    ]);
    const st = r.items.find((i) => i.cardId === s.fx.strawberry2)!;
    expect(st).toMatchObject({
      quantity: 1,
      lines: 1,
      graded: false,
      gradedQuantity: 0,
      upForTrade: false,
      boxes: [{ boxId: s.boxB, quantity: 1, gradedQuantity: 0 }],
    });
  });

  test("counts slabs apart from raw copies: 1 PSA 9 + 2 raw in one box is gradedQuantity 1, there and overall", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 1, grading: { grader: "PSA", grade: "9" } });
    await add(s, s.fx.gooden1, { homeId: s.boxA, quantity: 2 });
    await add(s, s.fx.gooden1, { homeId: s.boxB, quantity: 1, grading: { grader: "BGS", grade: "9.5" } });
    await add(s, s.fx.gooden1, { homeId: s.binder, quantity: 1, grading: { grader: "SGC", grade: "10" } });
    const r = await s.me.query(api.collectionInventory.inventoryCards, {});
    const g = r.items.find((i) => i.cardId === s.fx.gooden1)!;
    // The binder slab is collection, never counted here.
    expect(g).toMatchObject({ quantity: 4, lines: 3, graded: true, gradedQuantity: 2 });
    expect(g.boxes).toEqual([
      { boxId: s.boxA, quantity: 3, gradedQuantity: 1 },
      { boxId: s.boxB, quantity: 1, gradedQuantity: 1 },
    ]);
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
    expect(r.items[0].boxes).toEqual([{ boxId: s.boxA, quantity: 2, gradedQuantity: 0 }]);
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
