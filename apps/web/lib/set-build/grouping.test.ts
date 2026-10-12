/**
 * The Group Parallels reducer, tree builder and diff (NEO-300, moved here
 * from ParallelGroupingModal.test.tsx by NEO-339 with the code they pin).
 * The modal's own component tests still drive the same functions through the
 * UI.
 */
import { describe, expect, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  buildInitialState,
  computeDiff,
  emptyGroupingState,
  groupingReducer,
  type GroupingState,
  type InsertTree,
  type Placement,
  type RowInfo,
} from "./grouping";

/**
 * NEO-300 — the reducer on its own: states the UI keeps out of reach, which
 * is exactly why they need a backstop.
 */
describe("groupingReducer — a move of several rows is all or nothing", () => {
  const id = (s: string) => s as Id<"selectorOptions">;
  function state(): GroupingState {
    const rows = new Map<Id<"selectorOptions">, RowInfo>();
    const placement = new Map<Id<"selectorOptions">, Placement>();
    const add = (
      key: string,
      kind: "insert" | "parallel",
      parent: string | null,
    ) => {
      rows.set(id(key), {
        _id: id(key),
        value: key,
        originalKind: kind,
        originalParentId: parent ? id(parent) : null,
        originalHadParallels: false,
      });
      placement.set(
        id(key),
        parent ? { kind: "child", parentId: id(parent) } : { kind: "ungrouped" },
      );
    };
    add("target", "insert", null);
    add("a", "insert", null);
    add("holder", "insert", null);
    add("b", "insert", null);
    add("held", "parallel", "holder");
    return groupingReducer(emptyGroupingState, {
      type: "INIT",
      rows,
      placement,
      suggested: new Set(),
    });
  }

  test("a valid row and one holding parallels: nothing moves", () => {
    const before = state();
    const after = groupingReducer(before, {
      type: "MOVE",
      rowIds: [id("a"), id("holder")],
      placement: { kind: "child", parentId: id("target") },
      fromSelection: true,
    });
    expect(after).toBe(before);
  });

  test("the target inside the rows: nothing moves", () => {
    const before = state();
    const after = groupingReducer(before, {
      type: "MOVE",
      rowIds: [id("a"), id("b"), id("target")],
      placement: { kind: "child", parentId: id("target") },
      fromSelection: true,
    });
    expect(after).toBe(before);
  });

  test("all valid: one action moves them all and spends the selection", () => {
    let s = state();
    s = groupingReducer(s, { type: "TOGGLE", rowId: id("a") });
    s = groupingReducer(s, { type: "TOGGLE", rowId: id("b") });
    const after = groupingReducer(s, {
      type: "MOVE",
      rowIds: s.selected,
      placement: { kind: "child", parentId: id("target") },
      fromSelection: true,
    });
    expect(after.placement.get(id("a"))).toEqual({ kind: "child", parentId: "target" });
    expect(after.placement.get(id("b"))).toEqual({ kind: "child", parentId: "target" });
    expect(after.selected).toEqual([]);
  });

  test("a row holding parallels can't be picked by any path", () => {
    const s = state();
    for (const action of [
      { type: "SELECT_ONLY" as const, rowId: id("holder") },
      { type: "TOGGLE" as const, rowId: id("holder") },
    ]) {
      expect(groupingReducer(s, action).selected).toEqual([]);
    }
    const ranged = groupingReducer(s, {
      type: "SELECT_RANGE",
      rowId: id("b"),
      list: [id("a"), id("holder"), id("b")],
      from: id("a"),
    });
    expect(ranged.selected).toEqual(["a", "b"]);
  });
});

describe("buildInitialState — what the session opens on", () => {
  const id = (s: string) => s as Id<"selectorOptions">;
  const r = (s: string) => ({ _id: id(s), value: s });
  // "Stars" prefixes "Stars Gold"; "Chrome" already holds "Chrome Red".
  const tree: InsertTree = [
    { insert: r("Stars"), parallels: [] },
    { insert: r("Stars Gold"), parallels: [] },
    { insert: r("Chrome"), parallels: [r("Chrome Red")] },
  ];

  test("by default the prefix suggestions are placed and marked, as the modal opens", () => {
    const init = buildInitialState(tree);
    expect(init.placement.get(id("Stars Gold"))).toEqual({ kind: "child", parentId: "Stars" });
    expect([...init.suggested]).toEqual(["Stars Gold"]);
    expect(init.rows.get(id("Chrome"))).toMatchObject({ originalKind: "insert", originalHadParallels: true });
    expect(init.rows.get(id("Chrome Red"))).toMatchObject({ originalKind: "parallel", originalParentId: "Chrome" });
  });

  test("suggest: false leaves every row where it stands, so the diff is empty", () => {
    const init = buildInitialState(tree, { suggest: false });
    expect(init.placement.get(id("Stars Gold"))).toEqual({ kind: "ungrouped" });
    expect(init.suggested.size).toBe(0);
    const state = groupingReducer(emptyGroupingState, { type: "INIT", ...init });
    expect(computeDiff(state)).toEqual({ promotions: [], demotions: [], reparentings: [] });
  });

  test("the diff names a promotion, a reparenting and a demotion by class", () => {
    const init = buildInitialState(
      [...tree, { insert: r("Prizm"), parallels: [] }],
      { suggest: false },
    );
    let s = groupingReducer(emptyGroupingState, { type: "INIT", ...init });
    const move = (rowIds: string[], placement: Placement) =>
      groupingReducer(s, { type: "MOVE", rowIds: rowIds.map(id), placement, fromSelection: false });
    s = move(["Stars Gold"], { kind: "child", parentId: id("Stars") });
    s = move(["Chrome Red"], { kind: "child", parentId: id("Prizm") });
    expect(computeDiff(s)).toEqual({
      promotions: [{ insertId: "Stars Gold", targetInsertId: "Stars" }],
      demotions: [],
      reparentings: [{ parallelId: "Chrome Red", newInsertId: "Prizm" }],
    });
    s = move(["Chrome Red"], { kind: "ungrouped" });
    expect(computeDiff(s).demotions).toEqual([{ parallelId: "Chrome Red" }]);
  });
});
