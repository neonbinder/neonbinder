/**
 * The Group Parallels reducer, tree builder and diff (NEO-300, moved here
 * from ParallelGroupingModal.test.tsx by NEO-339 with the code they pin).
 * The modal's own component tests still drive the same functions through the
 * UI.
 */
import { describe, expect, test } from "vitest";
import { detectGroupings, normalizeName } from "../../components/SetSelector/parallelDetection";
import type { Id } from "../../convex/_generated/dataModel";
import {
  applyFamilyRootEvidence,
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

describe("buildInitialState — a row that roots its own family (NEO-339, 2023 Topps Chrome)", () => {
  const id = (s: string) => s as Id<"selectorOptions">;
  const r = (s: string) => ({ _id: id(s), value: s });
  const flat = (...names: string[]): InsertTree => names.map((n) => ({ insert: r(n), parallels: [] }));
  const childrenOf = (init: ReturnType<typeof buildInitialState>, parent: string) =>
    [...init.placement].filter(([, p]) => p.kind === "child" && p.parentId === parent).map(([c]) => c).sort();
  const family = flat(
    "Future Stars",
    "Future Stars Red",
    "Future Stars Autographs",
    "Future Stars Autographs SuperFractor",
    "Future Stars Autographs Red",
    "Future Stars Autographs Orange",
  );

  test("by default the plain prefix rule places every row, and the family root is only reported", () => {
    const init = buildInitialState(family);
    expect(childrenOf(init, "Future Stars")).toHaveLength(5);
    expect([...init.familyRoots]).toEqual([["Future Stars Autographs", "Future Stars"]]);
  });

  test("X / X Orange / X Orange Wave: both are parallels of X (Jason, 2026-10-19)", () => {
    const init = buildInitialState(flat("X", "X Orange", "X Orange Wave"));
    expect(childrenOf(init, "X")).toEqual(["X Orange", "X Orange Wave"]);
  });

  test("holdFamilyRoots (evidence: no shared card number) keeps the root top level, parent of its own family", () => {
    const init = buildInitialState(family, { holdFamilyRoots: new Set([id("Future Stars Autographs")]) });
    expect(init.placement.get(id("Future Stars Autographs"))).toEqual({ kind: "ungrouped" });
    expect(childrenOf(init, "Future Stars")).toEqual(["Future Stars Red"]);
    expect(childrenOf(init, "Future Stars Autographs")).toEqual([
      "Future Stars Autographs Orange",
      "Future Stars Autographs Red",
      "Future Stars Autographs SuperFractor",
    ]);
    expect(init.familyRoots.size).toBe(0);
  });

  test("one family is one level: inside a held family, a deeper extension joins the root", () => {
    const init = buildInitialState(flat("Stars", "Stars Autographs", "Stars Autographs Gold", "Stars Autographs Gold Wave"), {
      holdFamilyRoots: new Set([id("Stars Autographs")]),
    });
    expect(childrenOf(init, "Stars Autographs")).toEqual(["Stars Autographs Gold", "Stars Autographs Gold Wave"]);
    expect(init.familyRoots.size).toBe(0);
  });

  test("a lone extension roots no family: never reported", () => {
    const init = buildInitialState(flat("Radiating Rookies", "Radiating Rookies Autographs"));
    expect(init.placement.get(id("Radiating Rookies Autographs"))).toEqual({ kind: "child", parentId: "Radiating Rookies" });
    expect(init.familyRoots.size).toBe(0);
  });

  test("suggest: false reports no family roots", () => {
    expect(buildInitialState(family, { suggest: false }).familyRoots.size).toBe(0);
  });
});

describe("buildInitialState — a tied parent suggests nothing (NEO-339, invariant 8)", () => {
  const r = (id: string, value: string) => ({ _id: id as Id<"selectorOptions">, value });

  test("two inserts carrying the parent's name: the rows that would go under it stay put, unsuggested", () => {
    const init = buildInitialState([
      { insert: r("g1", "Gold"), parallels: [] },
      { insert: r("g2", "gold"), parallels: [] },
      { insert: r("gr", "Gold Refractor"), parallels: [] },
      { insert: r("s", "Stars"), parallels: [] },
      { insert: r("sr", "Stars Red"), parallels: [] },
    ]);
    expect(init.placement.get("gr" as Id<"selectorOptions">)).toEqual({ kind: "ungrouped" });
    expect(init.suggested.has("gr" as Id<"selectorOptions">)).toBe(false);
    expect([...init.tiedParents]).toEqual([["g1", { children: ["gr"], sharers: ["g1", "g2"] }]]);
    // An untied parent in the same tree is suggested as before.
    expect(init.placement.get("sr" as Id<"selectorOptions">)).toEqual({ kind: "child", parentId: "s" });
    expect([...init.suggested]).toEqual(["sr"]);
  });

  test("a parallel elsewhere carrying the name ties it too (every row of the tree counts)", () => {
    const init = buildInitialState([
      { insert: r("g", "Gold"), parallels: [] },
      { insert: r("gw", "Gold Wave"), parallels: [] },
      { insert: r("c", "Chrome"), parallels: [r("cg", "Gold")] },
    ]);
    expect(init.placement.get("gw" as Id<"selectorOptions">)).toEqual({ kind: "ungrouped" });
    expect(init.tiedParents.get("g" as Id<"selectorOptions">)?.sharers).toEqual(["g", "cg"]);
  });

  test("suggest: false reports no tie", () => {
    const init = buildInitialState(
      [
        { insert: r("g1", "Gold"), parallels: [] },
        { insert: r("g2", "Gold"), parallels: [] },
        { insert: r("gr", "Gold Refractor"), parallels: [] },
      ],
      { suggest: false },
    );
    expect(init.tiedParents.size).toBe(0);
  });
});

describe("applyFamilyRootEvidence — the card-number answer folded into an open session (NEO-339)", () => {
  const id = (s: string) => s as Id<"selectorOptions">;
  const flat = (...names: string[]): InsertTree => names.map((n) => ({ insert: { _id: id(n), value: n }, parallels: [] }));
  const family = flat("Future Stars", "Future Stars Red", "Future Stars Autographs", "Future Stars Autographs Red", "Future Stars Autographs Orange");
  const open = () => groupingReducer(emptyGroupingState, { type: "INIT", ...buildInitialState(family) });
  const evidence = {
    placement: buildInitialState(family, { holdFamilyRoots: new Set([id("Future Stars Autographs")]) }).placement,
    held: [{ root: id("Future Stars Autographs"), parent: id("Future Stars") }],
  };
  const parentOf = (s: GroupingState, n: string) => {
    const p = s.placement.get(id(n));
    return p?.kind === "child" ? p.parentId : null;
  };

  test("untouched: the root comes up, its family moves under it and stays suggested", () => {
    const { state, applied } = applyFamilyRootEvidence(open(), evidence);
    expect(applied).toEqual(["Future Stars Autographs"]);
    expect(parentOf(state, "Future Stars Autographs")).toBeNull();
    expect(state.suggested.has(id("Future Stars Autographs"))).toBe(false);
    expect(parentOf(state, "Future Stars Autographs Red")).toBe("Future Stars Autographs");
    expect(state.suggested.has(id("Future Stars Autographs Red"))).toBe(true);
    expect(parentOf(state, "Future Stars Red")).toBe("Future Stars");
  });

  test("a root the operator already handled keeps their call, and so does its family", () => {
    let s = open();
    s = groupingReducer(s, { type: "MOVE", rowIds: [id("Future Stars Autographs")], placement: { kind: "child", parentId: id("Future Stars") }, fromSelection: false });
    const { state, applied } = applyFamilyRootEvidence(s, evidence);
    expect(applied).toEqual([]);
    expect(state).toBe(s);
  });

  test("a family row the operator moved stays where they put it", () => {
    let s = open();
    s = groupingReducer(s, { type: "MOVE", rowIds: [id("Future Stars Autographs Red")], placement: { kind: "ungrouped" }, fromSelection: false });
    const { state } = applyFamilyRootEvidence(s, evidence);
    expect(parentOf(state, "Future Stars Autographs Red")).toBeNull();
    expect(parentOf(state, "Future Stars Autographs Orange")).toBe("Future Stars Autographs");
  });

  test("a selected root that comes up holding parallels leaves the selection", () => {
    let s = open();
    s = groupingReducer(s, { type: "TOGGLE", rowId: id("Future Stars Autographs") });
    s = groupingReducer(s, { type: "TOGGLE", rowId: id("Future Stars Red") });
    const next = groupingReducer(s, { type: "APPLY_FAMILY_ROOT_EVIDENCE", grouping: evidence });
    expect(next.selected).toEqual(["Future Stars Red"]);
  });
});

/**
 * The modal's suggestions must stay exactly what main shipped: this is
 * main's `detectGroupings`, verbatim but for its types, run against the
 * current one with no `holdFamilyRoots`.
 */
function mainDetectGroupings(inserts: ReadonlyArray<{ _id: string; value: string }>, excludeAsChild: ReadonlySet<string>) {
  const normalized = inserts.map((it) => ({ _id: it._id, norm: normalizeName(it.value) }));
  const byLength = [...normalized].sort((a, b) => a.norm.length - b.norm.length);
  const suggestions = new Map<string, string[]>();
  const parents = new Set<string>();
  const claimedAsChild = new Set<string>();
  for (const child of byLength) {
    if (excludeAsChild.has(child._id)) continue;
    let bestParent: string | null = null;
    let bestLen = -1;
    for (const candidate of byLength) {
      if (candidate._id === child._id) continue;
      if (candidate.norm.length >= child.norm.length) continue;
      const prefix = candidate.norm + " ";
      if (!child.norm.startsWith(prefix)) continue;
      if (claimedAsChild.has(candidate._id)) continue;
      if (candidate.norm.length > bestLen) {
        bestLen = candidate.norm.length;
        bestParent = candidate._id;
      }
    }
    if (bestParent) {
      const list = suggestions.get(bestParent) ?? [];
      list.push(child._id);
      suggestions.set(bestParent, list);
      parents.add(bestParent);
      claimedAsChild.add(child._id);
    }
  }
  const ungroupedSelfStanding = new Set<string>();
  for (const it of normalized) {
    if (parents.has(it._id) || claimedAsChild.has(it._id)) continue;
    ungroupedSelfStanding.add(it._id);
  }
  return { suggestions, ungroupedSelfStanding, parents };
}

describe("detectGroupings with no evidence is main's rule, unchanged", () => {
  test("same suggestions, parents and standing rows over many generated name lists", () => {
    const words = ["Stars", "Autographs", "Red", "Gold", "Wave", "Orange", "Refractor", "Future"];
    let seed = 339;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 400; run++) {
      // Mostly names that extend another by a word, so families form often.
      const names = new Set<string>();
      const count = 2 + rand(9);
      for (let i = 0; i < count; i++) {
        const existing = [...names];
        const word = words[rand(words.length)];
        names.add(existing.length > 0 && rand(10) < 7 ? `${existing[rand(existing.length)]} ${word}` : word);
      }
      const inserts = [...names].map((value, i) => ({ _id: `r${i}`, value }));
      const exclude = new Set(inserts.filter(() => rand(5) === 0).map((x) => x._id));
      const now = detectGroupings(inserts, exclude);
      const was = mainDetectGroupings(inserts, exclude);
      expect([...now.suggestions]).toEqual([...was.suggestions]);
      expect([...now.parents]).toEqual([...was.parents]);
      expect([...now.ungroupedSelfStanding]).toEqual([...was.ungroupedSelfStanding]);
      expect(now.heldFamilyRoots.size).toBe(0);
    }
  });
});
