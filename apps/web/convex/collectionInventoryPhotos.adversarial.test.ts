/**
 * NEO-431 adversarial pass: the quick count (`setBoxQuantity`) and its undo
 * (`undoBoxQuantity`) around lines with photos.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { MAX_COPY_QUANTITY } from "./collection";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { expectCountsExact } from "../lib/testing/collection-counts";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const me = t.withIdentity(ME);
  await me.mutation(api.collectionContainers.ensureSystem, {});
  const boxA = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box A" })).containerId;
  const boxB = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box B" })).containerId;
  return { t, fx, me, boxA, boxB };
}
type S = Awaited<ReturnType<typeof setup>>;

const exact = (s: S) => expectCountsExact(s.t, ME.subject, expect as never);
const rowsIn = async (s: S, boxId: Id<"collectionContainers">) =>
  (await s.t.run((ctx) => ctx.db.query("collectionCopies").collect())).filter((r) => r.homeId === boxId);
const setQty = (s: S, boxId: Id<"collectionContainers">, quantity: number) =>
  s.me.mutation(api.collectionInventory.setBoxQuantity, { cardId: s.fx.gooden1, boxId, quantity });
const undoOf = (s: S, inverse: unknown) =>
  s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: inverse as never });
const add = (s: S, details: Record<string, unknown>) =>
  s.me.mutation(api.collection.addLineItem, {
    cardId: s.fx.gooden1,
    details: { quantity: 1, ...details } as never,
  });
const ownLine = (s: S, details: Record<string, unknown>) =>
  s.me.mutation(api.collection.addLineItem, {
    cardId: s.fx.gooden1,
    details: { quantity: 1, ...details } as never,
    keepsOwnLine: true,
  });
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
const photoRow = (s: S, id: Id<"collectionCopyPhotos">) => s.t.run((ctx) => ctx.db.get(id));
const total = (rows: Array<{ quantity: number }>) => rows.reduce((n, r) => n + r.quantity, 0);

describe("mixed bare and photo lines through lower, undo and redo", () => {
  async function mixed(s: S) {
    // bare x2, photo line P1 (front) x1, photo line P2 (front + back) x3, all with distinct dates.
    const bare = (await add(s, { homeId: s.boxA, quantity: 2, acquiredOn: "2026-01-01" })).copyId;
    const p1 = (await ownLine(s, { homeId: s.boxA, quantity: 1, acquiredOn: "2026-01-02" })).copyId;
    const p1Photo = await photograph(s, p1);
    const p2 = (await ownLine(s, { homeId: s.boxA, quantity: 3, acquiredOn: "2026-01-03" })).copyId;
    const p2Front = await photograph(s, p2, "front");
    const p2Back = await photograph(s, p2, "back");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(bare, { lastUpdated: 100 });
      await ctx.db.patch(p1, { lastUpdated: 200 });
      await ctx.db.patch(p2, { lastUpdated: 300 });
    });
    return { bare, p1, p2, p1Photo, p2Front, p2Back };
  }

  test("a count to 0 and its undo put each photo back on a line of the same size and date", async () => {
    const s = await setup();
    const m = await mixed(s);
    const zero = await setQty(s, s.boxA, 0);
    expect(zero).toMatchObject({ before: 6, after: 0 });
    await exact(s);
    const undone = await undoOf(s, zero.inverse);
    expect(undone).toMatchObject({ before: 0, after: 6 });
    const rows = await rowsIn(s, s.boxA);
    expect(rows).toHaveLength(3);
    const onLine = async (id: Id<"collectionCopyPhotos">) => {
      const p = await photoRow(s, id);
      return rows.find((r) => r._id === p!.copyId)!;
    };
    expect((await onLine(m.p1Photo)).quantity).toBe(1);
    expect((await onLine(m.p1Photo)).acquiredOn).toBe("2026-01-02");
    expect((await onLine(m.p2Front)).quantity).toBe(3);
    expect((await onLine(m.p2Back)).quantity).toBe(3);
    expect((await onLine(m.p2Front))._id).toBe((await onLine(m.p2Back))._id);
    expect(rows.filter((r) => r.hasPhotos).length).toBe(2);
    expect(rows.find((r) => !r.hasPhotos)).toMatchObject({ quantity: 2, acquiredOn: "2026-01-01" });
    await exact(s);
  });

  test("three undo and redo cycles of a partial lower neither add nor lose a copy, a line or a photo", async () => {
    const s = await setup();
    const m = await mixed(s);
    // 6 -> 2: takes the bare line (2) and P2's... lowerOrder: bare first, then newest photo line P2.
    let result = await setQty(s, s.boxA, 2);
    expect(result).toMatchObject({ before: 6, after: 2 });
    for (let i = 0; i < 3; i += 1) {
      result = await undoOf(s, result.inverse); // back to 6
      expect(result).toMatchObject({ before: 2, after: 6 });
      expect(total(await rowsIn(s, s.boxA))).toBe(6);
      result = await undoOf(s, result.inverse); // down to 2 again
      expect(result).toMatchObject({ before: 6, after: 2 });
      expect(total(await rowsIn(s, s.boxA))).toBe(2);
      await exact(s);
    }
    expect((await photoRow(s, m.p1Photo))!.status).toBe("live");
    result = await undoOf(s, result.inverse);
    const rows = await rowsIn(s, s.boxA);
    expect(total(rows)).toBe(6);
    expect(rows).toHaveLength(3);
    for (const id of [m.p1Photo, m.p2Front, m.p2Back]) expect((await photoRow(s, id))!.status).toBe("live");
    await exact(s);
  });

  test("a raise onto a photo line, then a lower of the same number, then both undone in turn, ends where it began", async () => {
    const s = await setup();
    const { copyId } = await ownLine(s, { homeId: s.boxA, quantity: 2, acquiredOn: "2026-01-02" });
    await photograph(s, copyId);
    const up = await setQty(s, s.boxA, 5);
    const down = await setQty(s, s.boxA, 2);
    // Undo the lower first (back to 5), then the raise (back to 2).
    const backUp = await undoOf(s, down.inverse);
    expect(backUp).toMatchObject({ before: 2, after: 5 });
    const backDown = await undoOf(s, up.inverse);
    expect(backDown).toMatchObject({ before: 5, after: 2 });
    expect(await rowsIn(s, s.boxA)).toEqual([expect.objectContaining({ _id: copyId, quantity: 2, hasPhotos: true })]);
    await exact(s);
  });
});

describe("changed since: the guards around a stack on a photo line", () => {
  async function stacked(s: S) {
    const { copyId } = await ownLine(s, { homeId: s.boxA, quantity: 1, acquiredOn: "2026-01-02" });
    const photoId = await photograph(s, copyId);
    const raised = await setQty(s, s.boxA, 3);
    return { copyId, photoId, raised };
  }

  test("undo after the line was edited (quantity) refuses and writes nothing", async () => {
    const s = await setup();
    const { copyId, raised } = await stacked(s);
    await s.me.mutation(api.collection.updateCopy, { copyId, details: { quantity: 7, homeId: s.boxA, acquiredOn: "2026-01-02" } as never });
    await expect(undoOf(s, raised.inverse)).rejects.toThrow(/changed since/i);
    expect((await rowsIn(s, s.boxA))[0].quantity).toBe(7);
  });

  test("undo after the line got a note (no longer plain) refuses and writes nothing", async () => {
    const s = await setup();
    const { copyId, raised } = await stacked(s);
    await s.me.mutation(api.collection.updateCopy, { copyId, details: { quantity: 3, homeId: s.boxA, acquiredOn: "2026-01-02", notes: "ding" } as never });
    await expect(undoOf(s, raised.inverse)).rejects.toThrow(/changed since/i);
    expect((await rowsIn(s, s.boxA))[0].quantity).toBe(3);
  });

  test("undo after the whole line moved to another box refuses", async () => {
    const s = await setup();
    const { copyId, raised } = await stacked(s);
    await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: s.boxB } as never);
    await expect(undoOf(s, raised.inverse)).rejects.toThrow(/changed since/i);
    expect((await rowsIn(s, s.boxB))[0].quantity).toBe(3);
  });

  test("undo after the line was removed refuses", async () => {
    const s = await setup();
    const { copyId, raised } = await stacked(s);
    await s.me.mutation(api.collection.removeCopy, { copyId });
    await expect(undoOf(s, raised.inverse)).rejects.toThrow(/changed since/i);
  });

  test("undo of a raise that STARTED a line, after photos were put on that line, refuses and keeps the line (remove guard)", async () => {
    const s = await setup();
    const raised = await setQty(s, s.boxA, 2);
    const [row] = await rowsIn(s, s.boxA);
    await photograph(s, row._id);
    await expect(undoOf(s, raised.inverse)).rejects.toThrow(/changed since/i);
    expect((await rowsIn(s, s.boxA))[0].quantity).toBe(2);
  });

  test("undo of a lower that took part of a photo line, after the photos were removed, still applies (set has no photo guard)", async () => {
    const s = await setup();
    const { copyId } = await ownLine(s, { homeId: s.boxA, quantity: 3, acquiredOn: "2026-01-02" });
    await photograph(s, copyId);
    const lowered = await setQty(s, s.boxA, 1);
    await s.me.mutation(api.copyPhotos.remove, { copyId, side: "front" });
    const undone = await undoOf(s, lowered.inverse);
    expect(undone).toMatchObject({ before: 1, after: 3 });
  });
});

describe("a replayed inverse", () => {
  // A `restore` step names no line and tolerates a changed plain count
  // (`collectionInventory.test.ts`, the Undo that folds into a line that appeared
  // since), so a count guard would refuse a legitimate Undo. A bare restore's
  // replay is therefore a second plain add, and only a hand-made call gets here.
  test("replaying a bare line's restore is a second plain add", async () => {
    const s = await setup();
    await add(s, { homeId: s.boxA, quantity: 2, acquiredOn: "2026-01-01" });
    const zero = await setQty(s, s.boxA, 0);
    await undoOf(s, zero.inverse);
    await undoOf(s, zero.inverse);
    const rows = await rowsIn(s, s.boxA);
    expect(total(rows)).toBe(4);
    expect(rows).toHaveLength(1);
    await exact(s);
  });

  test("replaying a photo line's restore is refused: its photos are already back, and nothing is written", async () => {
    const s = await setup();
    const { copyId } = await ownLine(s, { homeId: s.boxA, quantity: 1, acquiredOn: "2026-01-01" });
    await photograph(s, copyId);
    const zero = await setQty(s, s.boxA, 0);
    await undoOf(s, zero.inverse);
    await expect(undoOf(s, zero.inverse)).rejects.toThrow(/already back on a line/);
    const rows = await rowsIn(s, s.boxA);
    expect(total(rows)).toBe(1);
    expect(rows[0].hasPhotos).toBe(true);
  });

  test("replaying a set step is refused", async () => {
    const s = await setup();
    const { copyId } = await ownLine(s, { homeId: s.boxA, quantity: 3 });
    await photograph(s, copyId);
    const lowered = await setQty(s, s.boxA, 1);
    await undoOf(s, lowered.inverse);
    await expect(undoOf(s, lowered.inverse)).rejects.toThrow(/changed since/i);
    expect((await rowsIn(s, s.boxA))[0].quantity).toBe(3);
  });
});

describe("caps and forged inverses", () => {
  test("the client's cap constant (999) is the server's", () => {
    expect(MAX_COPY_QUANTITY).toBe(999);
  });


  test("a forged set step past the cap is refused", async () => {
    const s = await setup();
    const { copyId } = await ownLine(s, { homeId: s.boxA, quantity: 1 });
    await photograph(s, copyId);
    await expect(
      undoOf(s, {
        cardId: s.fx.gooden1,
        boxId: s.boxA,
        steps: [{ op: "set", copyId, from: 1, to: MAX_COPY_QUANTITY + 1 }],
      }),
    ).rejects.toThrow();
    expect((await rowsIn(s, s.boxA))[0].quantity).toBe(1);
  });

  test("a forged restore of the maximum quantity with photoIds beside a full photo line is allowed only as its own line (no stack past the cap)", async () => {
    const s = await setup();
    const { copyId } = await ownLine(s, { homeId: s.boxA, quantity: MAX_COPY_QUANTITY });
    await photograph(s, copyId);
    await undoOf(s, {
      cardId: s.fx.gooden1,
      boxId: s.boxA,
      steps: [{ op: "restore", quantity: 1, photoIds: [] }],
    });
    const rows = await rowsIn(s, s.boxA);
    expect(rows.every((r) => r.quantity <= MAX_COPY_QUANTITY)).toBe(true);
  });

  test("a raise onto a full photo line one over the cap is refused, then the same count after lowering works", async () => {
    const s = await setup();
    const { copyId } = await ownLine(s, { homeId: s.boxA, quantity: MAX_COPY_QUANTITY - 1 });
    await photograph(s, copyId);
    await expect(setQty(s, s.boxA, MAX_COPY_QUANTITY + 1)).rejects.toThrow();
    const ok = await setQty(s, s.boxA, MAX_COPY_QUANTITY);
    expect(ok.after).toBe(MAX_COPY_QUANTITY);
    expect((await rowsIn(s, s.boxA))[0].quantity).toBe(MAX_COPY_QUANTITY);
  });

  test("a redo of a raise onto a photo line whose photo was swept still applies (the line is just bare now)", async () => {
    const s = await setup();
    const { copyId } = await ownLine(s, { homeId: s.boxA, quantity: 1 });
    const photoId = await photograph(s, copyId);
    const raised = await setQty(s, s.boxA, 3);
    const undone = await undoOf(s, raised.inverse);
    await s.t.run(async (ctx) => {
      await ctx.db.delete(photoId);
      await ctx.db.patch(copyId, { hasPhotos: undefined });
    });
    const redone = await undoOf(s, undone.inverse);
    expect(redone).toMatchObject({ after: 3 });
  });
});

describe("addLineItem keepsOwnLine", () => {
  test("two keepsOwnLine adds of identical copies make two lines, each in its own pocket, in a binder", async () => {
    const s = await setup();
    const binder = (await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "B" })).containerId;
    const a = await ownLine(s, { homeId: binder, acquiredOn: "2026-01-01" });
    const b = await ownLine(s, { homeId: binder, acquiredOn: "2026-01-01" });
    expect(a.merged).toBe(false);
    expect(b.merged).toBe(false);
    const rows = await rowsIn(s, binder);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.slot)).size).toBe(2);
    await exact(s);
  });

  test("a keepsOwnLine add into a binder with a hole takes the first open pocket, not past the end", async () => {
    const s = await setup();
    const binder = (await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "B" })).containerId;
    const first = await ownLine(s, { homeId: binder, acquiredOn: "2026-01-01" });
    const second = await ownLine(s, { homeId: binder, acquiredOn: "2026-01-02" });
    await ownLine(s, { homeId: binder, acquiredOn: "2026-01-03" });
    await s.me.mutation(api.collection.removeCopy, { copyId: second.copyId });
    const again = await ownLine(s, { homeId: binder, acquiredOn: "2026-01-04" });
    const rows = await rowsIn(s, binder);
    const slots = rows.map((r) => r.slot).sort();
    expect(slots).toEqual([0, 1, 2]);
    expect(rows.find((r) => r._id === again.copyId)?.slot).toBe(
      (await s.t.run((ctx) => ctx.db.get(first.copyId)))!.slot! + 1,
    );
  });

  test("a keepsOwnLine add to a pocket that is held is refused, and writes nothing", async () => {
    const s = await setup();
    const binder = (await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "B" })).containerId;
    await ownLine(s, { homeId: binder, slot: 0 });
    await expect(ownLine(s, { homeId: binder, slot: 0 })).rejects.toThrow();
    expect(await rowsIn(s, binder)).toHaveLength(1);
  });
});
