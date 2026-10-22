import { describe, expect, test } from "vitest";
import { LISTING_TITLE_MAX } from "../../convex/features/listingLimits";
import { BLANK_LISTING_TITLE_MESSAGE, listingTitleRefusal } from "./listing-title-gate";

describe("listingTitleRefusal — the title rule updateCard, the fixer, the drawer and the tool share (NEO-339)", () => {
  test("blank and whitespace-only are refused", () => {
    expect(listingTitleRefusal("")).toBe(BLANK_LISTING_TITLE_MESSAGE);
    expect(listingTitleRefusal("   \t ")).toBe(BLANK_LISTING_TITLE_MESSAGE);
  });
  test("measured trimmed: the cap counts what is stored", () => {
    expect(listingTitleRefusal(` ${"a".repeat(LISTING_TITLE_MAX)} `)).toBeNull();
    expect(listingTitleRefusal("a".repeat(LISTING_TITLE_MAX + 1))).toBe(
      `Listing title is ${LISTING_TITLE_MAX + 1} characters; the limit is ${LISTING_TITLE_MAX}.`,
    );
  });
  test("an ordinary title passes", () => {
    expect(listingTitleRefusal("2024 Topps #17 Shohei Ohtani")).toBeNull();
  });
});
