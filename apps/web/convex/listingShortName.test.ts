/**
 * NEO-335 — the short-name rule and the chain's title facts, as pure
 * functions. The doors that call them are pinned in
 * `setSelectorOptionListingShortName.test.ts` and
 * `commitCardChecklist.listingShortName.test.ts`.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import {
  MAX_LISTING_SHORT_NAME_LENGTH,
  normalizeListingShortName,
  titleChainFacts,
  type TitleChainRow,
} from "./listingShortName";

describe("normalizeListingShortName", () => {
  test("trims", () => {
    expect(normalizeListingShortName("  Upper Deck Hologram ")).toBe("Upper Deck Hologram");
  });

  test("blank and whitespace-only are no short name", () => {
    expect(normalizeListingShortName("")).toBeUndefined();
    expect(normalizeListingShortName(" \t ")).toBeUndefined();
  });

  test("the cap is inclusive", () => {
    const atCap = "s".repeat(MAX_LISTING_SHORT_NAME_LENGTH);
    expect(MAX_LISTING_SHORT_NAME_LENGTH).toBe(60);
    expect(normalizeListingShortName(atCap)).toBe(atCap);
    expect(() => normalizeListingShortName(`${atCap}s`)).toThrow(ConvexError);
    expect(() => normalizeListingShortName(`${atCap}s`)).toThrow(
      /at most 60 characters/,
    );
  });

  test("a cap is measured after the trim", () => {
    const atCap = "s".repeat(MAX_LISTING_SHORT_NAME_LENGTH);
    expect(normalizeListingShortName(`  ${atCap}  `)).toBe(atCap);
  });

  test.each([
    ["a newline", "Upper\nDeck"],
    ["a tab inside", "Upper\tDeck"],
    ["DEL", "Upper\u007FDeck"],
    ["a C1 control (NEL)", "Upper\u0085Deck"],
    ["a line separator", "Upper\u2028Deck"],
    ["a paragraph separator", "Upper\u2029Deck"],
  ])("refuses %s", (_label, raw) => {
    expect(() => normalizeListingShortName(raw)).toThrow(/line breaks or control characters/);
  });

  test.each([
    ["a zero-width space", "Upper\u200BDeck"],
    ["a word joiner", "Upper\u2060Deck"],
    ["a BOM", "Upper\uFEFFDeck"],
    ["a right-to-left override", "Upper\u202EDeck"],
    ["a bidi isolate", "Upper\u2066Deck"],
    ["a left-to-right mark", "Upper\u200EDeck"],
    ["a soft hyphen", "Upper\u00ADDeck"],
    ["an Arabic letter mark", "Upper\u061CDeck"],
    ["a tag character", "Upper\u{E0041}Deck"],
  ])("refuses %s", (_label, raw) => {
    expect(() => normalizeListingShortName(raw)).toThrow(/zero-width or invisible/);
  });
});

/** Rows LEAF FIRST, as every walk hands them over. */
function row(
  level: string,
  value: string,
  metadata?: TitleChainRow["metadata"],
): TitleChainRow {
  return { level, value, ...(metadata ? { metadata } : {}) };
}

describe("titleChainFacts", () => {
  test("an insert-level row carrying the insert ROLE puts its name in", () => {
    expect(
      titleChainFacts([
        row("insert", "Dugout Collection", { isInsert: true }),
        row("variantType", "Inserts"),
        row("setName", "Score"),
      ]),
    ).toEqual({ insertNameValue: "Dugout Collection", insertIsRole: true });
  });

  test("an insert-level row WITHOUT the role contributes nothing — never by level or name", () => {
    expect(
      titleChainFacts([
        row("insert", "Dugout Collection"),
        row("variantType", "Inserts"),
        row("setName", "Score"),
      ]),
    ).toEqual({});
    expect(
      titleChainFacts([
        row("insert", "Dugout Collection", { isInsert: false }),
        row("setName", "Score"),
      ]),
    ).toEqual({});
  });

  test("an insert-level row under a parallels type is a parallel, not an insert", () => {
    expect(
      titleChainFacts([
        row("insert", "Artist's Proof", { isParallel: true }),
        row("variantType", "Parallels"),
        row("setName", "Score"),
      ]),
    ).toEqual({ parallelLeafValue: "Artist's Proof" });
  });

  test("a parallel leaf under an insert: both the insert and the leaf", () => {
    expect(
      titleChainFacts([
        row("parallel", "Artist's Proof", { isParallel: true }),
        row("insert", "Dugout Collection", { isInsert: true }),
        row("variantType", "Inserts"),
        row("setName", "Score"),
      ]),
    ).toEqual({
      insertNameValue: "Dugout Collection",
      insertIsRole: true,
      parallelLeafValue: "Artist's Proof",
    });
  });

  test("the parallel role counts on the LEAF only", () => {
    expect(
      titleChainFacts([
        row("parallel", "Gold", { isParallel: false }),
        row("insert", "Refractor", { isParallel: true }),
        row("setName", "Chrome"),
      ]),
    ).toEqual({});
  });

  test("the NEAREST short name wins, self first", () => {
    expect(
      titleChainFacts([
        row("insert", "Hologram", { isInsert: true, listingShortName: "UD Hologram" }),
        row("setName", "Collector's Choice", { listingShortName: "UD Choice" }),
      ]).listingShortName,
    ).toBe("UD Hologram");
    expect(
      titleChainFacts([
        row("insert", "Hologram", { isInsert: true }),
        row("variantType", "Inserts"),
        row("setName", "Collector's Choice", { listingShortName: " UD Choice " }),
      ]).listingShortName,
    ).toBe("UD Choice");
  });

  test("nothing past the setName row is read", () => {
    expect(
      titleChainFacts([
        row("variantType", "Base"),
        row("setName", "Score"),
        row("manufacturer", "Score", { listingShortName: "Nope" }),
        row("insert", "Stray", { isInsert: true }),
      ]),
    ).toEqual({});
  });

  test("the first insert-level row decides; a deeper one is not consulted", () => {
    expect(
      titleChainFacts([
        row("insert", "Child", {}),
        row("insert", "Parent", { isInsert: true }),
        row("setName", "Score"),
      ]),
    ).toEqual({});
  });

  test("an empty or broken chain says nothing", () => {
    expect(titleChainFacts([])).toEqual({});
    expect(titleChainFacts([null])).toEqual({});
    expect(titleChainFacts([row("variantType", "Base"), null, row("setName", "x", { listingShortName: "y" })])).toEqual({});
  });
});
