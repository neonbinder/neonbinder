import { describe, expect, test } from "vitest";
import { unaskedSideCopy, unaskedSideName } from "./unasked-side";

describe("unaskedSideCopy", () => {
  test("names the side and the set", () => {
    expect(unaskedSideCopy("SportLots", "2026 Donruss")).toBe(
      "SportLots wasn't asked: 2026 Donruss has no SportLots link.",
    );
    expect(unaskedSideCopy("BSC", "2026 Donruss")).toBe(
      "BSC wasn't asked: 2026 Donruss has no BSC link.",
    );
  });

  test("with no set name it says this set, never a blank", () => {
    expect(unaskedSideCopy("SportLots", "")).toBe(
      "SportLots wasn't asked: this set has no SportLots link.",
    );
    expect(unaskedSideCopy("BSC", undefined)).toBe("BSC wasn't asked: this set has no BSC link.");
  });

  test("a slot side maps to the pane's short name", () => {
    expect(unaskedSideName("bsc")).toBe("BSC");
    expect(unaskedSideName("sportlots")).toBe("SportLots");
  });
});
