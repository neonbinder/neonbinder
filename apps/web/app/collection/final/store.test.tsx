import { describe, expect, it } from "vitest";
import {
  DemoRefusal,
  MAIN_BINDER_ID,
  NO_BROWSE_FILTER,
  SHOW_BOX_ID,
  TRADE_BINDER_ID,
  WANT_BINDER_ID,
  collectionReducer,
  demoOps,
  homeFor,
  initialCollectionState,
  sameLineItem,
  type CollectionState,
  type DemoCopy,
} from "./store";
import { emptyCopyDetails } from "../prototypes/_shared/data";
import { BOX_ROWS, POCKETS_PER_PAGE, MAX_WANTS, type CopyDetails } from "./data/types";

const SLAB = "binder-slab-case";
const CONTENDERS = "binder-contenders-96";
const OHTANI = "binder-ohtani-rainbow";

const details = (over: Partial<CopyDetails> = {}): CopyDetails => ({ ...emptyCopyDetails(), ...over });
const copyIn = (s: CollectionState, id: string) => s.copies.find((c) => c.id === id)!;
const inHome = (s: CollectionState, homeId: string) => s.copies.filter((c) => c.homeId === homeId);

/** Adds a fresh unfoldable-by-accident copy of the seed's first card to `homeId`. */
function withCopy(state: CollectionState, over: Partial<CopyDetails> = {}): [CollectionState, DemoCopy] {
  const { state: next, result } = demoOps.addLine(state, state.copies[0].cardId, details({ notes: "t", ...over }), false);
  return [next, copyIn(next, result.copyId)];
}

describe("the demo's seed", () => {
  it("gives every copy exactly one home that is a binder or a box, never a system pile", () => {
    const s = initialCollectionState();
    for (const c of s.copies) {
      const home = s.containers.find((x) => x.id === c.homeId);
      expect(home, c.id).toBeDefined();
      expect(home?.system === "trade" || home?.system === "want", c.id).toBe(false);
    }
  });

  it("lists the system containers first and the Show box among the collector's own", () => {
    const s = initialCollectionState();
    expect(s.containers.slice(0, 3).map((b) => b.system)).toEqual(["main", "trade", "want"]);
    expect(s.containers.find((b) => b.id === TRADE_BINDER_ID)?.name).toBe("Up for Trade");
    expect(s.containers.find((b) => b.id === SHOW_BOX_ID)?.kind).toBe("box");
  });

  it("puts the Show box's copies in rows, with one left unsorted", () => {
    const s = initialCollectionState();
    const box = inHome(s, SHOW_BOX_ID);
    expect(box.length).toBeGreaterThan(1);
    expect(box.some((c) => c.slot === undefined)).toBe(true);
    expect(box.some((c) => c.slot !== undefined && c.slot < BOX_ROWS)).toBe(true);
  });

  it("carries the Contenders binder's pockets as slots, one line per pocket", () => {
    const s = initialCollectionState();
    const slots = inHome(s, CONTENDERS).map((c) => c.slot).filter((x) => x !== undefined);
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("keeps wants to one per card", () => {
    const s = initialCollectionState();
    expect(new Set(s.wants.map((w) => w.cardId)).size).toBe(s.wants.length);
  });
});

describe("addLine", () => {
  it("files a copy with no home into Main", () => {
    const [s, copy] = withCopy(initialCollectionState());
    expect(copy.homeId).toBe(MAIN_BINDER_ID);
  });

  it("falls back to Main for a home that is the Want List, the trade pile or a smart binder", () => {
    const s = initialCollectionState();
    const smart = s.containers.find((c) => c.rule)!;
    expect(homeFor(s, WANT_BINDER_ID)).toBe(MAIN_BINDER_ID);
    expect(homeFor(s, TRADE_BINDER_ID)).toBe(MAIN_BINDER_ID);
    expect(homeFor(s, smart.id)).toBe(MAIN_BINDER_ID);
    expect(homeFor(s, SLAB)).toBe(SLAB);
  });

  it("folds into an identical line in the same home and says so", () => {
    const s0 = initialCollectionState();
    const card = s0.copies[0].cardId;
    const a = demoOps.addLine(s0, card, details({ quantity: 1, notes: "fresh" }));
    const b = demoOps.addLine(a.state, card, details({ quantity: 2, notes: "fresh" }));
    expect(b.result).toMatchObject({ merged: true, copyId: a.result.copyId });
    expect(copyIn(b.state, a.result.copyId).quantity).toBe(3);
  });

  it("does not fold the same card into a different home", () => {
    const s0 = initialCollectionState();
    const card = s0.copies[0].cardId;
    const a = demoOps.addLine(s0, card, details({ notes: "fresh" }));
    const b = demoOps.addLine(a.state, card, details({ notes: "fresh", homeId: SLAB }));
    expect(b.result.merged).toBe(false);
    expect(b.state.copies.length).toBe(a.state.copies.length + 1);
  });

  it("refuses a pocket another card already holds", () => {
    const s = initialCollectionState();
    const held = inHome(s, CONTENDERS).find((c) => c.slot !== undefined)!;
    expect(() =>
      demoOps.addLine(s, held.cardId, details({ notes: "other", homeId: CONTENDERS, slot: held.slot }), false),
    ).toThrow(/pocket already holds/i);
  });

  it("refuses a row past the box's last", () => {
    const s = initialCollectionState();
    expect(() =>
      demoOps.addLine(s, s.copies[0].cardId, details({ homeId: SHOW_BOX_ID, slot: BOX_ROWS })),
    ).toThrow(DemoRefusal);
  });
});

describe("folding", () => {
  const a = { ...emptyCopyDetails(), condition: "Mint" as const, homeId: MAIN_BINDER_ID };

  it("treats lines differing only in quantity as one stack", () => {
    expect(sameLineItem(a, { ...a, quantity: 4 })).toBe(true);
  });
  it("keeps different conditions apart", () => {
    expect(sameLineItem(a, { ...a, condition: "Near Mint" })).toBe(false);
  });
  it("never folds a serial-numbered line", () => {
    expect(sameLineItem(a, { ...a, serialNumber: "3/50" })).toBe(false);
  });
  it("never folds a cert, even against itself", () => {
    const slab = { ...a, condition: undefined, graded: { grader: "PSA" as const, grade: "10", cert: "1" } };
    expect(sameLineItem(slab, slab)).toBe(false);
  });
  it("keeps different homes apart", () => {
    expect(sameLineItem(a, { ...a, homeId: SLAB })).toBe(false);
  });
  it("keeps different pockets or rows apart", () => {
    expect(sameLineItem({ ...a, slot: 1 }, { ...a, slot: 2 })).toBe(false);
    expect(sameLineItem({ ...a, slot: 1 }, { ...a, slot: 1 })).toBe(true);
  });
  it("keeps a trade-flagged line apart from an unflagged one", () => {
    expect(sameLineItem(a, { ...a, upForTrade: true })).toBe(false);
  });
});

describe("moveCopy", () => {
  it("gives the copy the new home and clears its old pocket", () => {
    const s0 = initialCollectionState();
    const held = inHome(s0, CONTENDERS).find((c) => c.slot !== undefined)!;
    const { state, result } = demoOps.moveCopy(s0, held.id, SLAB);
    expect(result).toMatchObject({ copyId: held.id, folded: false, split: false });
    expect(result.from).toEqual({ homeId: CONTENDERS, slot: held.slot, quantity: held.quantity });
    expect(copyIn(state, held.id)).toMatchObject({ homeId: SLAB });
    expect(copyIn(state, held.id).slot).toBeUndefined();
  });

  it("never shows the copy in two homes: one row, one home", () => {
    const s0 = initialCollectionState();
    const held = inHome(s0, CONTENDERS)[0];
    const { state } = demoOps.moveCopy(s0, held.id, SLAB);
    expect(state.copies.filter((c) => c.id === held.id)).toHaveLength(1);
    expect(inHome(state, CONTENDERS).map((c) => c.id)).not.toContain(held.id);
  });

  it("lands it in the pocket asked for", () => {
    const [s0, copy] = withCopy(initialCollectionState());
    const { state } = demoOps.moveCopy(s0, copy.id, CONTENDERS, undefined, 6 * POCKETS_PER_PAGE + 2);
    expect(copyIn(state, copy.id)).toMatchObject({ homeId: CONTENDERS, slot: 6 * POCKETS_PER_PAGE + 2 });
  });

  it("refuses an occupied pocket and leaves the state alone", () => {
    const s0 = initialCollectionState();
    const held = inHome(s0, CONTENDERS).find((c) => c.slot !== undefined)!;
    const [s1, copy] = withCopy(s0);
    expect(() => demoOps.moveCopy(s1, copy.id, CONTENDERS, undefined, held.slot)).toThrow(/pocket already holds/i);
  });

  it("lets a box row hold many lines", () => {
    let [s, a] = withCopy(initialCollectionState(), { notes: "a" });
    let b: DemoCopy;
    [s, b] = withCopy(s, { notes: "b" });
    s = demoOps.moveCopy(s, a.id, SHOW_BOX_ID, undefined, 3).state;
    s = demoOps.moveCopy(s, b.id, SHOW_BOX_ID, undefined, 3).state;
    expect(inHome(s, SHOW_BOX_ID).filter((c) => c.slot === 3).map((c) => c.id)).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
  });

  it.each([
    ["the Want List", WANT_BINDER_ID, /Want List holds wants/i],
    ["the Up for Trade pile", TRADE_BINDER_ID, /Up for Trade/i],
  ])("refuses %s as a destination", (_n, to, message) => {
    const [s0, copy] = withCopy(initialCollectionState());
    expect(() => demoOps.moveCopy(s0, copy.id, to)).toThrow(message);
  });

  it("refuses a smart binder, which fills itself", () => {
    const s0 = initialCollectionState();
    const smart = s0.containers.find((c) => c.rule)!;
    const [s1, copy] = withCopy(s0);
    expect(() => demoOps.moveCopy(s1, copy.id, smart.id)).toThrow(/fills itself/i);
  });

  it("refuses a destination that is gone", () => {
    const [s0, copy] = withCopy(initialCollectionState());
    expect(() => demoOps.moveCopy(s0, copy.id, "nope")).toThrow(DemoRefusal);
  });

  it("moving into a box makes it for sale; moving out makes it not (home kind is the truth)", () => {
    const [s0, copy] = withCopy(initialCollectionState());
    const inBox = demoOps.moveCopy(s0, copy.id, SHOW_BOX_ID).state;
    expect(s0.containers.find((c) => c.id === copyIn(inBox, copy.id).homeId)?.kind).toBe("box");
    const out = demoOps.moveCopy(inBox, copy.id, SLAB).state;
    expect(s0.containers.find((c) => c.id === copyIn(out, copy.id).homeId)?.kind).toBe("binder");
  });
});

describe("moveCopy: split and fold", () => {
  it("splits part of a stack: the source keeps the rest, the destination gets a new row", () => {
    const [s0, copy] = withCopy(initialCollectionState(), { quantity: 5 });
    const { state, result } = demoOps.moveCopy(s0, copy.id, SLAB, 2);
    expect(result).toMatchObject({ split: true, folded: false });
    expect(result.copyId).not.toBe(copy.id);
    expect(copyIn(state, copy.id)).toMatchObject({ quantity: 3, homeId: MAIN_BINDER_ID });
    expect(copyIn(state, result.copyId)).toMatchObject({ quantity: 2, homeId: SLAB, cardId: copy.cardId });
  });

  it("clamps a quantity past the stack to the whole stack, which is not a split", () => {
    const [s0, copy] = withCopy(initialCollectionState(), { quantity: 2 });
    const { state, result } = demoOps.moveCopy(s0, copy.id, SLAB, 99);
    expect(result.split).toBe(false);
    expect(copyIn(state, copy.id)).toMatchObject({ quantity: 2, homeId: SLAB });
  });

  it("folds a whole move into an identical line already in the destination", () => {
    let [s, a] = withCopy(initialCollectionState(), { quantity: 1, notes: "twin" });
    s = demoOps.moveCopy(s, a.id, SLAB).state;
    let b: DemoCopy;
    [s, b] = withCopy(s, { quantity: 2, notes: "twin" });
    const { state, result } = demoOps.moveCopy(s, b.id, SLAB);
    expect(result).toMatchObject({ folded: true, copyId: a.id });
    expect(copyIn(state, a.id).quantity).toBe(3);
    expect(state.copies.find((c) => c.id === b.id)).toBeUndefined();
  });

  it("folds a split into the twin and keeps the remainder at the source", () => {
    let [s, a] = withCopy(initialCollectionState(), { quantity: 1, notes: "twin" });
    s = demoOps.moveCopy(s, a.id, SLAB).state;
    let b: DemoCopy;
    [s, b] = withCopy(s, { quantity: 4, notes: "twin" });
    const { state, result } = demoOps.moveCopy(s, b.id, SLAB, 1);
    expect(result).toMatchObject({ folded: true, split: true, copyId: a.id });
    expect(copyIn(state, a.id).quantity).toBe(2);
    expect(copyIn(state, b.id).quantity).toBe(3);
  });

  it("does not fold a cert-bearing line into its twin", () => {
    const graded = { grader: "PSA" as const, grade: "10", cert: "99" };
    let [s, a] = withCopy(initialCollectionState(), { graded, notes: "slab" });
    s = demoOps.moveCopy(s, a.id, SLAB).state;
    let b: DemoCopy;
    [s, b] = withCopy(s, { graded, notes: "slab" });
    const { result } = demoOps.moveCopy(s, b.id, SLAB);
    expect(result.folded).toBe(false);
  });

  it("undo by the inverse move puts the split quantity back into one stack", () => {
    const [s0, copy] = withCopy(initialCollectionState(), { quantity: 5 });
    const moved = demoOps.moveCopy(s0, copy.id, SLAB, 2);
    const back = demoOps.moveCopy(moved.state, moved.result.copyId, MAIN_BINDER_ID, moved.result.from.quantity);
    expect(back.result.folded).toBe(true);
    expect(copyIn(back.state, copy.id).quantity).toBe(5);
    expect(back.state.copies.length).toBe(s0.copies.length);
  });
});

describe("placeCopy", () => {
  it("sets a row in the copy's own home without changing the home", () => {
    const [s0, copy] = withCopy(initialCollectionState(), { homeId: SHOW_BOX_ID });
    const { state } = demoOps.placeCopy(s0, copy.id, 2);
    expect(copyIn(state, copy.id)).toMatchObject({ homeId: SHOW_BOX_ID, slot: 2 });
  });

  it("clears the slot with null, which sends a box line to the unsorted strip", () => {
    const sorted = inHome(initialCollectionState(), SHOW_BOX_ID).find((c) => c.slot !== undefined)!;
    const { state } = demoOps.placeCopy(initialCollectionState(), sorted.id, null);
    expect(copyIn(state, sorted.id).slot).toBeUndefined();
  });

  it("folds into an identical line already in that row", () => {
    let [s, a] = withCopy(initialCollectionState(), { homeId: SHOW_BOX_ID, slot: 4, notes: "x" });
    let b: DemoCopy;
    [s, b] = withCopy(s, { homeId: SHOW_BOX_ID, notes: "x" });
    const { state, result } = demoOps.placeCopy(s, b.id, 4);
    expect(result).toMatchObject({ folded: true, copyId: a.id });
    expect(state.copies.find((c) => c.id === b.id)).toBeUndefined();
  });

  it("refuses a row past the box's last", () => {
    const [s0, copy] = withCopy(initialCollectionState(), { homeId: SHOW_BOX_ID });
    expect(() => demoOps.placeCopy(s0, copy.id, BOX_ROWS)).toThrow(DemoRefusal);
  });
});

describe("setTrade", () => {
  it("flags a copy without moving it, and reports the flag it had", () => {
    const [s0, copy] = withCopy(initialCollectionState(), { homeId: SLAB });
    const { state, result } = demoOps.setTrade(s0, copy.id, true);
    expect(result).toBe(false);
    expect(copyIn(state, copy.id)).toMatchObject({ upForTrade: true, homeId: SLAB });
  });

  it("is a no-op returning the same state when the flag already matches", () => {
    const [s0, copy] = withCopy(initialCollectionState());
    expect(demoOps.setTrade(s0, copy.id, false).state).toBe(s0);
  });

  it("unflagging then restoring is the undo", () => {
    const [s0, copy] = withCopy(initialCollectionState());
    const on = demoOps.setTrade(s0, copy.id, true);
    const off = demoOps.setTrade(on.state, copy.id, on.result);
    expect(copyIn(off.state, copy.id).upForTrade).toBe(false);
  });

  it("refuses a copy that is gone", () => {
    expect(() => demoOps.setTrade(initialCollectionState(), "nope", true)).toThrow(DemoRefusal);
  });
});

describe("updateCopy", () => {
  it("never changes the home", () => {
    const [s0, copy] = withCopy(initialCollectionState());
    expect(() => demoOps.updateCopy(s0, copy.id, { homeId: SLAB })).toThrow(/Move the card/i);
  });

  it("never folds, even when the edit makes it identical to a neighbour", () => {
    let [s, a] = withCopy(initialCollectionState(), { notes: "same" });
    let b: DemoCopy;
    [s, b] = withCopy(s, { notes: "different" });
    const { state } = demoOps.updateCopy(s, b.id, { notes: "same" });
    expect(state.copies.filter((c) => c.id === a.id || c.id === b.id)).toHaveLength(2);
  });

  it("returns the previous values so the edit can be undone", () => {
    const [s0, copy] = withCopy(initialCollectionState(), { quantity: 2 });
    const { result } = demoOps.updateCopy(s0, copy.id, { quantity: 7 });
    expect(result).toEqual({ quantity: 2 });
  });
});

describe("removeCopy and restoreCopy", () => {
  it("restores a removed copy as its own row, at its old place in the list", () => {
    const s0 = initialCollectionState();
    const target = s0.copies[2];
    const removed = demoOps.removeCopy(s0, target.id);
    expect(removed.state.copies.some((c) => c.id === target.id)).toBe(false);
    const back = demoOps.restoreCopy(removed.state, removed.result.removed, removed.result.index);
    expect(back.state.copies[2].id).toBe(target.id);
  });

  it("drops a slot that someone took meanwhile instead of double-filling the pocket", () => {
    const s0 = initialCollectionState();
    const held = inHome(s0, CONTENDERS).find((c) => c.slot !== undefined)!;
    const removed = demoOps.removeCopy(s0, held.id);
    const [s1] = withCopy(removed.state, { homeId: CONTENDERS, slot: held.slot });
    const back = demoOps.restoreCopy(s1, removed.result.removed);
    expect(copyIn(back.state, held.id).slot).toBeUndefined();
  });

  it("is idempotent for a copy that is already back", () => {
    const s0 = initialCollectionState();
    expect(demoOps.restoreCopy(s0, s0.copies[0]).state).toBe(s0);
  });
});

describe("wants", () => {
  it("keeps one want per card: wanting it for another binder moves the want", () => {
    const s0 = initialCollectionState();
    const card = s0.wants[0].cardId;
    const { state } = demoOps.setWant(s0, card, SLAB, true);
    expect(state.wants.filter((w) => w.cardId === card)).toEqual([{ cardId: card, binderId: SLAB }]);
  });

  it("is a no-op when the want already matches", () => {
    const s0 = initialCollectionState();
    const w = s0.wants[0];
    expect(demoOps.setWant(s0, w.cardId, w.binderId, true)).toMatchObject({ state: s0, result: false });
  });

  it("clears the want with off, and reports nothing changed when there was none", () => {
    const s0 = initialCollectionState();
    const w = s0.wants[0];
    const off = demoOps.setWant(s0, w.cardId, null, false);
    expect(off.state.wants.some((x) => x.cardId === w.cardId)).toBe(false);
    expect(demoOps.setWant(off.state, w.cardId, null, false).result).toBe(false);
  });

  it("refuses a want scoped to the trade pile or a missing binder", () => {
    const s0 = initialCollectionState();
    const fresh = s0.copies.find((c) => !s0.wants.some((w) => w.cardId === c.cardId))!.cardId;
    expect(() => demoOps.setWant(s0, fresh, TRADE_BINDER_ID, true)).toThrow(DemoRefusal);
    expect(() => demoOps.setWant(s0, fresh, "nope", true)).toThrow(DemoRefusal);
  });

  it("refuses a new want past the cap with words that say what to do", () => {
    const s0 = initialCollectionState();
    const wants = Array.from({ length: MAX_WANTS }, (_, i) => ({ cardId: `pad-${i}`, binderId: null }));
    const full = { ...s0, wants };
    expect(() => demoOps.setWant(full, "one-more", null, true)).toThrow(/full at 2,000/);
    // Moving an existing want is still allowed at the cap.
    expect(demoOps.setWant(full, "pad-0", OHTANI, true).result).toBe(true);
  });
});

describe("containers", () => {
  it("creates a box and lists it after the system containers", () => {
    const { state, result } = demoOps.createContainer(initialCollectionState(), { kind: "box", name: "  Dime box " });
    const made = state.containers.find((c) => c.id === result)!;
    expect(made).toMatchObject({ kind: "box", name: "Dime box" });
    expect(state.containers.slice(0, 3).every((c) => c.system)).toBe(true);
  });

  it("refuses a blank name", () => {
    expect(() => demoOps.createContainer(initialCollectionState(), { kind: "binder", name: "  " })).toThrow(/name/i);
  });

  it("refuses to rename a system container but lets its label change", () => {
    const s = initialCollectionState();
    expect(() => demoOps.updateContainer(s, MAIN_BINDER_ID, { name: "X" })).toThrow(/keeps its name/i);
    const label = { background: "#203731", text: "#FFB612", fontId: "anton" };
    const { state } = demoOps.updateContainer(s, MAIN_BINDER_ID, { label });
    expect(state.containers.find((c) => c.id === MAIN_BINDER_ID)?.label).toEqual(label);
  });

  it("sets a label and clears it back to the default, returning the patch that undoes it", () => {
    const label = { background: "#203731", text: "#FFB612", fontId: "anton" };
    const set = demoOps.updateContainer(initialCollectionState(), SLAB, { label: null });
    const on = demoOps.updateContainer(set.state, SLAB, { label });
    expect(on.result).toEqual({ label: null });
    const off = demoOps.updateContainer(on.state, SLAB, { label: null });
    expect(off.state.containers.find((b) => b.id === SLAB)).not.toHaveProperty("label");
  });

  it("refuses to delete a system container", () => {
    expect(() => demoOps.deleteContainer(initialCollectionState(), TRADE_BINDER_ID)).toThrow(/can't be deleted/i);
  });

  it("deleting sends its copies to Main with their slots cleared and unscopes its wants", () => {
    const s0 = initialCollectionState();
    const inside = inHome(s0, SHOW_BOX_ID);
    const { state, result } = demoOps.deleteContainer(s0, SHOW_BOX_ID);
    expect(result).toBe(inside.length);
    for (const c of inside) {
      expect(copyIn(state, c.id)).toMatchObject({ homeId: MAIN_BINDER_ID });
      expect(copyIn(state, c.id).slot).toBeUndefined();
    }
    const scoped = demoOps.setWant(s0, s0.wants[0].cardId, SLAB, true).state;
    const after = demoOps.deleteContainer(scoped, SLAB).state;
    expect(after.wants.find((w) => w.cardId === s0.wants[0].cardId)?.binderId).toBeNull();
    expect(after.containers.some((c) => c.id === SLAB)).toBe(false);
  });
});

describe("reducer and browse filter", () => {
  it("replaces the state and resets to the seed", () => {
    const s0 = initialCollectionState();
    const changed = demoOps.setBuilding(s0, "x-set", true).state;
    expect(collectionReducer(s0, { type: "replace", state: changed })).toBe(changed);
    expect(collectionReducer(changed, { type: "reset" }).buildingSetIds).toEqual(s0.buildingSetIds);
  });

  it("merges filter changes and starts unfiltered", () => {
    let s = initialCollectionState();
    expect(s.browseFilter).toEqual(NO_BROWSE_FILTER);
    s = demoOps.setBrowseFilter(s, { sport: "hockey" }).state;
    s = demoOps.setBrowseFilter(s, { from: 1990 }).state;
    expect(s.browseFilter).toEqual({ ...NO_BROWSE_FILTER, sport: "hockey", from: 1990 });
  });
});
