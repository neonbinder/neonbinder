/**
 * NEO-300 — folding the store's own "left alone" list into the client's.
 *
 * `.test.tsx` although nothing renders: the `components` vitest project
 * collects only `.test.tsx`.
 */

import { describe, expect, it } from "vitest";
import { mergeServerHeld, type HeldRow } from "./held-elsewhere";

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
