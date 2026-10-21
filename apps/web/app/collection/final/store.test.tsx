import { describe, expect, it } from "vitest";
import {
  MAIN_BINDER_ID,
  NO_BROWSE_FILTER,
  TRADE_BINDER_ID,
  WANT_BINDER_ID,
  collectionReducer,
  copyScope,
  initialCollectionState,
  movedFrom,
  sameLineItem,
  targetFor,
  type CollectionState,
} from "./store";
import { emptyCopyDetails, type Copy } from "../prototypes/_shared/data";

const SLAB = "binder-slab-case";

function withCopy(state: CollectionState, binderIds: string[]): [CollectionState, Copy] {
  const copy: Copy = { ...emptyCopyDetails(), id: "t-copy", cardId: state.copies[0].cardId, binderIds };
  return [collectionReducer(state, { type: "addCopy", copy }), copy];
}

describe("final collection store", () => {
  it("seeds every copy into at least one binder, system binders first", () => {
    const s = initialCollectionState();
    expect(s.copies.every((c) => c.binderIds.length > 0)).toBe(true);
    expect(s.binders.slice(0, 3).map((b) => b.system)).toEqual(["main", "trade", "want"]);
    expect(s.binders.find((b) => b.id === TRADE_BINDER_ID)?.name).toBe("Up for Trade");
  });

  it("never leaves a copy with zero binders", () => {
    let [s, copy] = withCopy(initialCollectionState(), []);
    expect(s.copies.find((c) => c.id === copy.id)?.binderIds).toEqual([MAIN_BINDER_ID]);
    s = collectionReducer(s, { type: "updateCopy", id: copy.id, patch: { binderIds: [SLAB] } });
    s = collectionReducer(s, { type: "removeFromBinder", copyId: copy.id, binderId: SLAB });
    expect(s.copies.find((c) => c.id === copy.id)?.binderIds).toEqual([MAIN_BINDER_ID]);
  });

  it("never files a copy in the Want List", () => {
    const [s, copy] = withCopy(initialCollectionState(), [WANT_BINDER_ID]);
    expect(s.copies.find((c) => c.id === copy.id)?.binderIds).toEqual([MAIN_BINDER_ID]);
  });

  it("refuses to rename or delete a system binder", () => {
    const s = initialCollectionState();
    expect(collectionReducer(s, { type: "renameBinder", binderId: MAIN_BINDER_ID, name: "X" })).toBe(s);
    expect(collectionReducer(s, { type: "deleteBinder", binderId: TRADE_BINDER_ID })).toBe(s);
  });

  it("deleting a binder sends its only-copies to Main and unscopes its wants", () => {
    let [s, copy] = withCopy(initialCollectionState(), [SLAB]);
    s = collectionReducer(s, { type: "setWants", wants: [{ cardId: copy.cardId, binderId: SLAB }] });
    s = collectionReducer(s, { type: "select", selection: SLAB });
    s = collectionReducer(s, { type: "deleteBinder", binderId: SLAB });
    expect(s.copies.find((c) => c.id === copy.id)?.binderIds).toEqual([MAIN_BINDER_ID]);
    expect(s.wants).toEqual([{ cardId: copy.cardId, binderId: null }]);
    expect(s.selectedBinderId).toBe("all");
  });

  it("scopes to a picked binder and adds there; All and Want List add to Main", () => {
    let s = initialCollectionState();
    expect(targetFor(s)).toBe(MAIN_BINDER_ID);
    expect(copyScope(s)).toBeNull();
    s = collectionReducer(s, { type: "select", selection: SLAB });
    expect(targetFor(s)).toBe(SLAB);
    expect(copyScope(s)).toBe(SLAB);
    s = collectionReducer(s, { type: "select", selection: WANT_BINDER_ID });
    expect(targetFor(s)).toBe(MAIN_BINDER_ID);
    expect(copyScope(s)).toBeNull();
  });

  it("folds identical line items but never one with a cert or serial", () => {
    const a = { ...emptyCopyDetails(), condition: "Mint" as const, binderIds: [MAIN_BINDER_ID] };
    expect(sameLineItem(a, { ...a, quantity: 4 })).toBe(true);
    expect(sameLineItem(a, { ...a, condition: "Near Mint" })).toBe(false);
    expect(sameLineItem(a, { ...a, serialNumber: "3/50" })).toBe(false);
    const slab = { ...a, condition: undefined, graded: { grader: "PSA" as const, grade: "10", cert: "1" } };
    expect(sameLineItem(slab, slab)).toBe(false);
  });
});

describe("moving a copy", () => {
  const CONTENDERS = "binder-contenders-96";
  const copyIn = (s: CollectionState, id: string) => s.copies.find((c) => c.id === id)!;
  const slotsOf = (s: CollectionState, binderId: string) => {
    const b = s.binders.find((x) => x.id === binderId);
    return b?.kind === "manual" ? (b.layout ?? []).flatMap((p) => p.slots) : [];
  };

  it("files it in the destination instead, and empties its old pocket", () => {
    const s0 = initialCollectionState();
    const copyId = slotsOf(s0, CONTENDERS).find(Boolean)!;
    const s = collectionReducer(s0, { type: "moveCopy", copyId, to: SLAB });
    expect(copyIn(s, copyId).binderIds).toEqual([SLAB]);
    expect(slotsOf(s, CONTENDERS)).not.toContain(copyId);
  });

  it("puts it in the pocket asked for", () => {
    const [s0, copy] = withCopy(initialCollectionState(), [MAIN_BINDER_ID]);
    const s = collectionReducer(s0, { type: "moveCopy", copyId: copy.id, to: CONTENDERS, slot: { page: 6, slot: 2 } });
    expect(copyIn(s, copy.id).binderIds).toEqual([CONTENDERS]);
    const b = s.binders.find((x) => x.id === CONTENDERS);
    expect(b?.kind === "manual" && b.layout?.[6]?.slots[2]).toBe(copy.id);
  });

  it("leaves Up for Trade alone, unless that is where it goes or all it has", () => {
    const base = { ...emptyCopyDetails(), id: "c", cardId: "x" };
    expect(movedFrom({ ...base, binderIds: [MAIN_BINDER_ID, TRADE_BINDER_ID] }, SLAB)).toEqual([MAIN_BINDER_ID]);
    expect(movedFrom({ ...base, binderIds: [TRADE_BINDER_ID] }, SLAB)).toEqual([TRADE_BINDER_ID]);
    expect(movedFrom({ ...base, binderIds: [MAIN_BINDER_ID] }, TRADE_BINDER_ID)).toEqual([MAIN_BINDER_ID]);
    expect(movedFrom({ ...base, binderIds: [SLAB, MAIN_BINDER_ID] }, SLAB)).toEqual([]);
  });

  it("never moves into the Want List", () => {
    const [s0, copy] = withCopy(initialCollectionState(), [MAIN_BINDER_ID]);
    expect(collectionReducer(s0, { type: "moveCopy", copyId: copy.id, to: WANT_BINDER_ID })).toBe(s0);
  });

  it("restorePlacement puts the copy and the pages back as they were", () => {
    const s0 = initialCollectionState();
    const copyId = slotsOf(s0, CONTENDERS).find(Boolean)!;
    const before = s0.binders.find((b) => b.id === CONTENDERS);
    const moved = collectionReducer(s0, { type: "moveCopy", copyId, to: SLAB });
    const back = collectionReducer(moved, {
      type: "restorePlacement",
      copyId,
      binderIds: copyIn(s0, copyId).binderIds,
      layouts: [[CONTENDERS, before?.kind === "manual" ? before.layout : undefined]],
    });
    expect(copyIn(back, copyId).binderIds).toEqual(copyIn(s0, copyId).binderIds);
    expect(slotsOf(back, CONTENDERS)).toEqual(slotsOf(s0, CONTENDERS));
  });
});

describe("spine labels and the Browse shelf's filters", () => {
  it("sets a label on a binder and clears it back to the default", () => {
    const label = { background: "#203731", text: "#FFB612", fontId: "anton" };
    let s = collectionReducer(initialCollectionState(), { type: "setLabel", binderId: SLAB, label });
    expect(s.binders.find((b) => b.id === SLAB)?.label).toEqual(label);
    s = collectionReducer(s, { type: "setLabel", binderId: SLAB, label: null });
    expect(s.binders.find((b) => b.id === SLAB)).not.toHaveProperty("label");
  });

  it("merges filter changes and starts unfiltered", () => {
    let s = initialCollectionState();
    expect(s.browseFilter).toEqual(NO_BROWSE_FILTER);
    s = collectionReducer(s, { type: "setBrowseFilter", patch: { sport: "hockey" } });
    s = collectionReducer(s, { type: "setBrowseFilter", patch: { from: 1990 } });
    expect(s.browseFilter).toEqual({ ...NO_BROWSE_FILTER, sport: "hockey", from: 1990 });
  });
});
