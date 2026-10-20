/**
 * NEO-339 — Group Parallels' card-number rule, shared by the modal and the
 * set-building draft: what counts as evidence, and the hold loop.
 */
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  cardsStandApart,
  familyRootStandsApart,
  groupWithFamilyRootEvidence,
  previewCardNumbers,
  rowCardNumbers,
  sharesACardNumber,
  type RowCardSource,
} from "./family-roots";
import type { InsertTree } from "./grouping";

const id = (s: string) => s as Id<"selectorOptions">;
const flat = (...names: string[]): InsertTree => names.map((n) => ({ insert: { _id: id(n), value: n }, parallels: [] }));

describe("the evidence", () => {
  test("numbers are folded as a parallel build matches them, and only overlap counts", () => {
    expect(sharesACardNumber([" fs-1 "], ["FS-1"])).toBe(true);
    expect(sharesACardNumber(["FS-1", "FS-2"], ["FSA-1"])).toBe(false);
    expect(sharesACardNumber([""], [""])).toBe(false);
  });

  test("a preview's numbers: matched, BSC-only and SportLots-only", () => {
    expect(
      previewCardNumbers({ matched: [{ card: { cardNumber: "1" } }], bscOnly: [{ cardNumber: "2" }], slOnly: [{ cardNumber: "3" }] }),
    ).toEqual(["1", "2", "3"]);
  });

  test("stands apart only when both sides have cards and share none; nothing to compare is no evidence", () => {
    expect(cardsStandApart(["FS-1"], ["FSA-1"])).toBe(true);
    expect(cardsStandApart(["FS-1"], ["fs-1"])).toBe(false);
    expect(cardsStandApart(undefined, ["FSA-1"])).toBeUndefined();
    expect(cardsStandApart(["FS-1"], [])).toBeUndefined();
    expect(cardsStandApart([" "], ["FSA-1"])).toBeUndefined();
  });

  test("a row already holding cards is no evidence, and is not previewed", async () => {
    const preview = vi.fn(async () => ({ matched: [], bscOnly: [{ cardNumber: "1" }], slOnly: [] }));
    expect(await rowCardNumbers("r", { cardsHeld: async () => 3, preview })).toBeUndefined();
    expect(preview).not.toHaveBeenCalled();
    expect(await rowCardNumbers("r", { cardsHeld: async () => 0, preview })).toEqual(["1"]);
    expect(await rowCardNumbers("r", { cardsHeld: async () => 0, preview: async () => undefined })).toBeUndefined();
  });

  test("the parent is read first, and the root not at all when the parent gives no evidence", async () => {
    const preview = vi.fn(async (r: string) => (r === "parent" ? undefined : { matched: [], bscOnly: [{ cardNumber: "1" }], slOnly: [] }));
    const source: RowCardSource<string> = { cardsHeld: async () => 0, preview };
    expect(await familyRootStandsApart("parent", "root", source)).toBeUndefined();
    expect(preview.mock.calls.map(([r]) => r)).toEqual(["parent"]);
    expect(await familyRootStandsApart(undefined, "root", source)).toBeUndefined();
  });
});

describe("groupWithFamilyRootEvidence — the hold loop", () => {
  const family = flat(
    "Future Stars",
    "Future Stars Red",
    "Future Stars Autographs",
    "Future Stars Autographs SuperFractor",
    "Future Stars Autographs Red",
  );
  const childrenOf = (g: { placement: Map<string, { kind: string; parentId?: string }> }, parent: string) =>
    [...g.placement].filter(([, p]) => p.kind === "child" && p.parentId === parent).map(([c]) => c).sort();

  test("a root its evidence holds apart parents its own family; each root is weighed once", async () => {
    const standsApart = vi.fn(async () => true);
    const g = await groupWithFamilyRootEvidence(family, standsApart);
    expect(g.held).toEqual([{ root: "Future Stars Autographs", parent: "Future Stars" }]);
    expect(childrenOf(g, "Future Stars")).toEqual(["Future Stars Red"]);
    expect(childrenOf(g, "Future Stars Autographs")).toEqual(["Future Stars Autographs Red", "Future Stars Autographs SuperFractor"]);
    expect(standsApart.mock.calls).toEqual([["Future Stars Autographs", "Future Stars"]]);
  });

  test("false or no evidence leaves the plain prefix rule", async () => {
    for (const verdict of [false, undefined]) {
      const g = await groupWithFamilyRootEvidence(family, async () => verdict);
      expect(g.held).toEqual([]);
      expect(childrenOf(g, "Future Stars")).toHaveLength(4);
    }
  });

  test("rooting nothing, it asks nothing", async () => {
    const standsApart = vi.fn(async () => true);
    const g = await groupWithFamilyRootEvidence(flat("X", "X Orange"), standsApart);
    expect(standsApart).not.toHaveBeenCalled();
    expect(childrenOf(g, "X")).toEqual(["X Orange"]);
  });
});
