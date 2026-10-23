import { describe, expect, it } from "vitest";
import { checklistCount } from "./format";

/** NEO-358 — the checklist's count line reads base first, variations second. */
describe("checklistCount", () => {
  it("reads the base count, with the variations on a second line", () => {
    expect(checklistCount({ shownBase: 300, shownAll: 335, base: 300, all: 335 })).toEqual({
      base: "300 cards",
      withVariations: "335 with variations",
    });
  });

  it("has no second line when the checklist has no variations", () => {
    expect(checklistCount({ shownBase: 51, shownAll: 51, base: 51, all: 51 })).toEqual({
      base: "51 cards",
      withVariations: null,
    });
    expect(checklistCount({ shownBase: 1, shownAll: 1, base: 1, all: 1 }).base).toBe("1 card");
  });

  it("counts a filter's rows against each total, the same two ways", () => {
    expect(checklistCount({ shownBase: 2, shownAll: 3, base: 300, all: 335 })).toEqual({
      base: "2 of 300 cards",
      withVariations: "3 of 335 with variations",
    });
    expect(checklistCount({ shownBase: 2, shownAll: 2, base: 51, all: 51 })).toEqual({
      base: "2 of 51 cards",
      withVariations: null,
    });
  });

  it("a search that keeps only a variation still reads both totals", () => {
    expect(checklistCount({ shownBase: 0, shownAll: 1, base: 300, all: 335 })).toEqual({
      base: "0 of 300 cards",
      withVariations: "1 of 335 with variations",
    });
  });

  it("reads unfiltered once every row is showing", () => {
    expect(checklistCount({ shownBase: 0, shownAll: 0, base: 0, all: 0 })).toEqual({
      base: "0 cards",
      withVariations: null,
    });
  });
});
