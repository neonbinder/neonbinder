import { describe, expect, it } from "vitest";
import { parseEbayLines } from "./parseEbayLines";

describe("parseEbayLines", () => {
  it("returns quantity and title for a titled line", () => {
    expect(parseEbayLines(["1:2024 Topps Chrome #7 Thing"])).toEqual([
      { quantity: 1, title: "2024 Topps Chrome #7 Thing" },
    ]);
  });

  it("splits at the first colon only, keeping later colons in the title", () => {
    expect(parseEbayLines(["2:Set: Chrome: Refractor"])).toEqual([
      { quantity: 2, title: "Set: Chrome: Refractor" },
    ]);
  });

  it("omits the title when the part after the colon is empty", () => {
    expect(parseEbayLines(["1:"])).toEqual([{ quantity: 1 }]);
  });

  it("omits the title when it is only whitespace", () => {
    expect(parseEbayLines(["1:   "])).toEqual([{ quantity: 1 }]);
  });

  it("parses several lines in order", () => {
    expect(parseEbayLines(["1:A", "3:"])).toEqual([{ quantity: 1, title: "A" }, { quantity: 3 }]);
  });

  it("returns null when there is no colon", () => {
    expect(parseEbayLines(["3"])).toBeNull();
  });

  it("returns null when the quantity is not an integer", () => {
    expect(parseEbayLines(["x:y"])).toBeNull();
    expect(parseEbayLines(["1.5:y"])).toBeNull();
  });

  it("returns null when the quantity is missing", () => {
    expect(parseEbayLines([":title"])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(parseEbayLines([])).toBeNull();
  });

  it("returns null when any one line is malformed", () => {
    expect(parseEbayLines(["1:ok", "x:bad"])).toBeNull();
  });
});
