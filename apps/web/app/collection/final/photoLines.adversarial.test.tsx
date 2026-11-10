/**
 * NEO-431 adversarial pass over the demo reducer's photo-line rules
 * (`demoOps.setBoxQuantity`, `restoreLines`, `addLine` with `keepsOwnLine`).
 */
import { describe, expect, it } from "vitest";
import { DemoRefusal, MAIN_BINDER_ID, UNSORTED_BOX_ID, demoOps, initialCollectionState, isPlainLine, type CollectionState } from "./store";
import { emptyCopyDetails } from "../prototypes/_shared/data";
import type { CopyDetails } from "./data/types";

const TODAY = "2026-10-25";
const CARD = "card-quick-1";
const details = (over: Partial<CopyDetails> = {}): CopyDetails => ({ ...emptyCopyDetails(), ...over });
const base = () => initialCollectionState();
const inBox = (s: CollectionState) => s.copies.filter((c) => c.cardId === CARD && c.homeId === UNSORTED_BOX_ID);
const put = (s: CollectionState, over: Partial<CopyDetails>) =>
  demoOps.addLine(s, CARD, details({ homeId: UNSORTED_BOX_ID, acquiredAt: "2026-01-01", ...over }), false);
const photoLine = (s: CollectionState, over: Partial<CopyDetails> = {}) => {
  const made = put(s, over);
  return { state: demoOps.setHasPhotos(made.state, made.result.copyId, true).state, id: made.result.copyId };
};
const copyIn = (s: CollectionState, id: string) => s.copies.find((c) => c.id === id)!;
const total = (s: CollectionState) => inBox(s).filter((c) => isPlainLine(c)).reduce((n, c) => n + c.quantity, 0);

describe("demo: mixed lines through repeated lower and restore", () => {
  it("bare, photo, photo: lower to each number then restore, four times over, is exact every time", () => {
    const bare = put(base(), { quantity: 2 });
    const p1 = photoLine(bare.state, { quantity: 1, acquiredAt: "2026-01-02" });
    const p2 = photoLine(p1.state, { quantity: 3, acquiredAt: "2026-01-03" });
    let s = p2.state;
    for (let round = 0; round < 4; round += 1) {
      for (const target of [0, 1, 2, 3, 4, 5, 6, 9]) {
        const done = demoOps.setBoxQuantity(s, CARD, UNSORTED_BOX_ID, target, TODAY);
        expect(total(done.state)).toBe(target);
        const back = demoOps.restoreLines(done.state, done.result.undo).state;
        expect(back.copies).toEqual(s.copies);
      }
      s = demoOps.setBoxQuantity(s, CARD, UNSORTED_BOX_ID, 4, TODAY).state;
      s = demoOps.setBoxQuantity(s, CARD, UNSORTED_BOX_ID, 6, TODAY).state;
    }
    expect(inBox(s).filter((c) => c.hasPhotos).length).toBe(2);
  });

  it("a raise of exactly one onto a photo line, repeated, never makes a second line", () => {
    const { state, id } = photoLine(base(), { quantity: 1 });
    let s = state;
    for (let n = 2; n <= 6; n += 1) s = demoOps.setBoxQuantity(s, CARD, UNSORTED_BOX_ID, n, TODAY).state;
    expect(inBox(s)).toHaveLength(1);
    expect(copyIn(s, id)).toMatchObject({ quantity: 6, hasPhotos: true });
  });
});

describe("demo: an undo meets a line that changed", () => {
  it("an undo of a raise onto a photo line, after the photos were removed, leaves the line unmarked", () => {
    const { state, id } = photoLine(base(), { quantity: 1 });
    const up = demoOps.setBoxQuantity(state, CARD, UNSORTED_BOX_ID, 3, TODAY);
    // The collector removes the last photo (the store clears the marker) ...
    const stripped = demoOps.setHasPhotos(up.state, id, false).state;
    // ... then taps Undo. The snapshot it restores still says hasPhotos.
    const back = demoOps.restoreLines(stripped, up.result.undo).state;
    expect(copyIn(back, id)).toMatchObject({ quantity: 1 });
    expect(copyIn(back, id).hasPhotos).toBeFalsy();
  });

  it("an undo of a lower, after the line was photographed, keeps the photos", () => {
    const made = put(base(), { quantity: 3 });
    const down = demoOps.setBoxQuantity(made.state, CARD, UNSORTED_BOX_ID, 1, TODAY);
    const photographed = demoOps.setHasPhotos(down.state, made.result.copyId, true).state;
    const back = demoOps.restoreLines(photographed, down.result.undo).state;
    expect(copyIn(back, made.result.copyId)).toMatchObject({ quantity: 3, hasPhotos: true });
  });

  it("an undo of a raise that made a line, after that line was photographed, is refused and changes nothing", () => {
    const up = demoOps.setBoxQuantity(base(), CARD, UNSORTED_BOX_ID, 2, TODAY);
    const [madeId] = up.result.undo.made;
    const photographed = demoOps.setHasPhotos(up.state, madeId, true).state;
    const before = structuredClone(photographed);
    expect(() => demoOps.restoreLines(photographed, up.result.undo)).toThrow(DemoRefusal);
    expect(() => demoOps.restoreLines(photographed, up.result.undo)).toThrow(/changed since/);
    expect(photographed).toEqual(before);
  });

  it("an undo of a count to 0 brings a photo line that is gone back as it was", () => {
    const { state, id } = photoLine(base(), { quantity: 2 });
    const zero = demoOps.setBoxQuantity(state, CARD, UNSORTED_BOX_ID, 0, TODAY);
    expect(zero.result.tookPhotos).toBe(true);
    const back = demoOps.restoreLines(zero.state, zero.result.undo).state;
    expect(copyIn(back, id)).toMatchObject({ quantity: 2, hasPhotos: true });
  });
});

describe("demo: whether a count took photos", () => {
  it("only when a line with photos went: part of one, or a bare line, is not it", () => {
    const { state } = photoLine(base(), { quantity: 3 });
    expect(demoOps.setBoxQuantity(state, CARD, UNSORTED_BOX_ID, 1, TODAY).result.tookPhotos).toBeUndefined();
    expect(demoOps.setBoxQuantity(state, CARD, UNSORTED_BOX_ID, 5, TODAY).result.tookPhotos).toBeUndefined();
    const bare = put(base(), { quantity: 2 }).state;
    expect(demoOps.setBoxQuantity(bare, CARD, UNSORTED_BOX_ID, 0, TODAY).result.tookPhotos).toBeUndefined();
  });
});

describe("demo: addLine with keepsOwnLine", () => {
  it("two own-line adds into the main binder get two pockets, and a plain add after them stacks on neither photo line", () => {
    const one = demoOps.addLine(base(), CARD, details({ homeId: MAIN_BINDER_ID, acquiredAt: "2026-01-01" }), false);
    const two = demoOps.addLine(one.state, CARD, details({ homeId: MAIN_BINDER_ID, acquiredAt: "2026-01-01" }), false);
    expect(two.result.merged).toBe(false);
    const a = copyIn(two.state, one.result.copyId);
    const b = copyIn(two.state, two.result.copyId);
    expect(a.slot).not.toBeUndefined();
    expect(b.slot).not.toBe(a.slot);
    const marked = demoOps.setHasPhotos(demoOps.setHasPhotos(two.state, a.id, true).state, b.id, true).state;
    const plain = demoOps.addLine(marked, CARD, details({ homeId: MAIN_BINDER_ID, acquiredAt: "2026-01-01" }));
    expect(plain.result.merged).toBe(false);
  });
});
