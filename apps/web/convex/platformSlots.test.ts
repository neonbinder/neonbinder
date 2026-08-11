/**
 * NEO-137: slot-map readers.
 *
 * These helpers exist because `platformData.bsc` / `.sportlots` changed from
 * `string | string[]` to a slot-keyed `Record<string, string>`. Every legacy
 * way of asking "is anything attached?" is still TYPE-LEGAL against a Record
 * and silently wrong:
 *
 *   !!platformData.sportlots            // ALWAYS true — `!!{}` is true
 *   typeof platformData.bsc === "string" // never true  -> undefined
 *   Array.isArray(platformData.bsc)      // never true  -> undefined
 *
 * The first reports an unmapped row as mapped; the other two silently drop a
 * mapping that is there. Both shipped in this ticket and had to be found by
 * hand, so these tests pin the readers that replace them. `slotIds(...).length`
 * is the only correct emptiness test.
 */

import { describe, expect, it } from "vitest";
import { slotEntries, slotIds, slotForId, idForSlot } from "./platformSlots";

describe("slotIds / slotEntries", () => {
  it("returns nothing when the side is absent", () => {
    expect(slotIds({ platformData: {} }, "sportlots")).toEqual([]);
    expect(slotEntries({ platformData: {} }, "bsc")).toEqual([]);
  });

  it("returns nothing for an EMPTY slot map — the `!!{}` trap", () => {
    // A side that was attached and then fully detached leaves `{}` behind:
    // only pruneEmptySides removes the key. `!!{}` is true, so a truthiness
    // test reports this row as mapped and the UI offers "Re-map" instead of
    // the picker, with the mapping silently looking done. This is the exact
    // bug fixed in SetSelector.tsx (baseHasMapping).
    const row = { platformData: { sportlots: {}, bsc: {} } };

    expect(!!row.platformData.sportlots).toBe(true); // why truthiness is wrong
    expect(slotIds(row, "sportlots")).toEqual([]); // why slotIds is right
    expect(slotIds(row, "bsc")).toEqual([]);
    expect(slotIds(row, "sportlots").length > 0).toBe(false);
  });

  it("reads ids that the legacy string / array narrowings would drop", () => {
    const row = { platformData: { bsc: { b0: "2024-topps-chrome" } } };

    // Both legacy narrowings miss a Record entirely.
    expect(typeof row.platformData.bsc === "string").toBe(false);
    expect(Array.isArray(row.platformData.bsc)).toBe(false);

    expect(slotIds(row, "bsc")).toEqual(["2024-topps-chrome"]);
  });

  it("orders slots numerically, not lexicographically", () => {
    // Insertion order is not slot order, and "s10" sorts before "s2" as text.
    const row = {
      platformData: {
        sportlots: { s10: "ten", s2: "two", s0: "zero" },
      },
    };

    expect(slotIds(row, "sportlots")).toEqual(["zero", "two", "ten"]);
    expect(slotEntries(row, "sportlots").map((e) => e.slot)).toEqual([
      "s0",
      "s2",
      "s10",
    ]);
  });

  it("keeps two rows sharing one marketplace set id independent (the N:M case)", () => {
    // M NB rows -> 1 marketplace set: each row holds the SAME id in its own
    // slot. Nothing dedupes across rows, deliberately.
    const series1 = { platformData: { sportlots: { s0: "884412" } } };
    const series2 = { platformData: { sportlots: { s3: "884412" } } };

    expect(slotIds(series1, "sportlots")).toEqual(["884412"]);
    expect(slotIds(series2, "sportlots")).toEqual(["884412"]);
    expect(slotForId(series1, "sportlots", "884412")).toBe("s0");
    expect(slotForId(series2, "sportlots", "884412")).toBe("s3");
  });

  it("resolves a detached slot to nothing rather than to a neighbour", () => {
    // The reason slot keys are never reused: a card pointing at a retired slot
    // must resolve to nothing (reported as orphaned), never silently to a
    // different marketplace set.
    const row = { platformData: { sportlots: { s0: "884412", s2: "990001" } } };

    expect(idForSlot(row, "sportlots", "s1")).toBeUndefined();
    expect(idForSlot(row, "sportlots", "s2")).toBe("990001");
  });
});
