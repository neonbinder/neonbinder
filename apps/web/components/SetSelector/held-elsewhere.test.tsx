/**
 * NEO-300 — folding the store's own "left alone" list into the client's.
 *
 * `.test.tsx` although nothing renders: the `components` vitest project
 * collects only `.test.tsx`.
 */

import { describe, expect, it } from "vitest";
import {
  mergeServerHeld,
  parallelsInTree,
  rowsOutsideInsert,
  storeHoldsOf,
  type HeldRow,
} from "./held-elsewhere";
import { savedSetsMessage } from "./HeldElsewhereNote";

const CLIENT: HeldRow[] = [
  {
    key: "p1",
    name: "Anime Kanji",
    parentName: "Anime",
    bsc: ["b1"],
    sportlots: [],
  },
];

function entry(
  id: string,
  value: string,
  level: "insert" | "parallel",
  parentValue: string,
) {
  return { id: id as never, value, level, parentId: "x" as never, parentValue };
}

describe("mergeServerHeld", () => {
  it("adds nothing when the store only confirms what the client skipped", () => {
    const out = mergeServerHeld(CLIENT, {
      heldElsewhere: [entry("p1", "Anime Kanji", "parallel", "Anime")],
      heldElsewhereTotal: 1,
    });
    expect(out.extra).toBe(0);
    expect(out.total).toBe(1);
    expect(out.rows).toEqual(CLIENT);
  });

  it("appends a row the client missed, named by NB values", () => {
    const out = mergeServerHeld(CLIENT, {
      heldElsewhere: [
        entry("p2", "Refractor", "parallel", "Chrome"),
        entry("i9", "Chrome Stars", "insert", "Insert"),
      ],
      heldElsewhereTotal: 2,
    });
    expect(out.extra).toBe(2);
    expect(out.total).toBe(3);
    expect(out.rows.map((r) => [r.name, r.parentName])).toEqual([
      ["Anime Kanji", "Anime"],
      ["Refractor", "Chrome"],
      // An insert's parent is the variant type — not named.
      ["Chrome Stars", undefined],
    ]);
  });

  it("NEO-312: carries the store's path, and flags a holder outside the caller's scope", () => {
    const out = mergeServerHeld(
      [],
      {
        heldElsewhere: [
          { ...entry("p2", "Red Ink", "parallel", "Chrome"), path: ["Bowman", "Insert", "Chrome"] },
          {
            id: "vt9" as never,
            value: "Base",
            level: "variantType" as const,
            parentId: "set9" as never,
            parentValue: "Bowman Blue",
            path: ["Bowman Blue"],
          },
          // A set holder: empty path, named on its own.
          {
            id: "s9" as never,
            value: "Bowman Blue",
            level: "setName" as const,
            parentId: "m1" as never,
            parentValue: "Bowman",
            path: [],
          },
        ],
        heldElsewhereTotal: 3,
      },
      (e) => e.level === "parallel",
    );
    expect(out.rows.map((r) => [r.name, r.path, r.parentName, r.elsewhere])).toEqual([
      ["Red Ink", ["Bowman", "Insert", "Chrome"], undefined, undefined],
      ["Base", ["Bowman Blue"], undefined, true],
      ["Bowman Blue", undefined, undefined, true],
    ]);
  });

  it("counts past the store's capped sample", () => {
    const out = mergeServerHeld([], {
      heldElsewhere: [entry("p2", "Refractor", "parallel", "Chrome")],
      heldElsewhereTotal: 73,
    });
    expect(out.rows).toHaveLength(1);
    expect(out.total).toBe(73);
    expect(out.extra).toBe(73);
  });

  it("reads an older store result with neither field as nothing extra", () => {
    expect(mergeServerHeld(CLIENT, {})).toEqual({
      rows: CLIENT,
      total: 1,
      extra: 0,
    });
    expect(mergeServerHeld(CLIENT, undefined).extra).toBe(0);
  });
});

describe("savedSetsMessage", () => {
  it("pluralises", () => {
    expect(savedSetsMessage(1)).toBe("Saved 1 set.");
    expect(savedSetsMessage(0)).toBe("Saved 0 sets.");
    expect(savedSetsMessage(3)).toBe("Saved 3 sets.");
  });
});

/**
 * The client mirror of the store's "elsewhere" rule (convex/selectorSyncStore
 * `variantTypeSubtreeElsewhere`):
 *   insert sync   → every insert's parallels;
 *   parallel sync under P → every OTHER insert and its parallels; P itself and
 *   P's own parallels (the sync's siblings) are not elsewhere.
 */
describe("the elsewhere rule matches the store's", () => {
  const TREE = [
    {
      insert: {
        _id: "P",
        value: "Anime",
        platformData: { bsc: { b0: "bsc-p" } },
      },
      parallels: [
        {
          _id: "p1",
          value: "Anime Gold",
          platformData: { bsc: { b0: "bsc-p1" } },
        },
      ],
    },
    {
      insert: {
        _id: "Q",
        value: "Chrome",
        platformData: { bsc: { b0: "bsc-q" } },
      },
      parallels: [
        {
          _id: "q1",
          value: "Chrome Kanji",
          platformData: { bsc: { b0: "bsc-q1" } },
        },
      ],
    },
  ];

  it("insert sync: every insert's parallels, and no insert", () => {
    expect(parallelsInTree(TREE).map((r) => [r.key, r.parentName])).toEqual([
      ["p1", "Anime"],
      ["q1", "Chrome"],
    ]);
  });

  it("parallel sync under P: the other inserts and their parallels; never P or P's own", () => {
    const rows = rowsOutsideInsert(TREE, "P");
    expect(rows.map((r) => r.key)).toEqual(["Q", "q1"]);
    expect(rows.find((r) => r.key === "Q")?.parentName).toBeUndefined();
    expect(rows.find((r) => r.key === "q1")?.parentName).toBe("Chrome");
  });
});

describe("storeHoldsOf", () => {
  it("is null when the store withheld nothing and walked the subtree", () => {
    expect(storeHoldsOf({})).toBeNull();
    expect(storeHoldsOf(undefined)).toBeNull();
    expect(
      storeHoldsOf({
        withheldElsewhere: [],
        withheldElsewhereTotal: 0,
        subtreeWalkSkipped: false,
      }),
    ).toBeNull();
  });

  it("carries a skipped walk on its own", () => {
    expect(storeHoldsOf({ subtreeWalkSkipped: true })).toEqual({
      withheld: [],
      withheldTotal: 0,
      subtreeWalkSkipped: true,
    });
  });

  it("counts past the capped withheld list", () => {
    const out = storeHoldsOf({
      withheldElsewhere: [
        { label: "Refractor", reason: "heldByMany", holders: [] },
      ],
      withheldElsewhereTotal: 70,
    });
    expect(out?.withheld).toHaveLength(1);
    expect(out?.withheldTotal).toBe(70);
  });
});
