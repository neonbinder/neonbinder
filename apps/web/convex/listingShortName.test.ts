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
  // NEO-334: a row's role is its level plus its variant type's KIND, and the
  // kind is the variant type's title (`variantTypeKind`). No flag is read.
  test("an insert-level row under an Insert type puts its name in", () => {
    for (const title of ["Inserts", "Insert", "  inserts "]) {
      expect(
        titleChainFacts([
          row("insert", "Dugout Collection"),
          row("variantType", title),
          row("setName", "Score"),
        ]),
      ).toEqual({ insertNameValue: "Dugout Collection", insertIsRole: true });
    }
  });

  test("an insert-level row under a type with no kind contributes nothing — never by level or name", () => {
    for (const title of ["Insert Set", "Promo", "Inserts & Autographs"]) {
      expect(
        titleChainFacts([
          row("insert", "Dugout Collection"),
          row("variantType", title),
          row("setName", "Score"),
        ]),
      ).toEqual({});
    }
    // The insert's OWN name is never the role.
    expect(
      titleChainFacts([
        row("insert", "Inserts"),
        row("variantType", "Promo"),
        row("setName", "Score"),
      ]),
    ).toEqual({});
    // No variant type in the chain: no kind, no role.
    expect(
      titleChainFacts([row("insert", "Dugout Collection"), row("setName", "Score")]),
    ).toEqual({});
  });

  test("a stored retired flag is ignored: the title decides", () => {
    const stale = { isInsert: true, isParallel: true } as unknown as TitleChainRow["metadata"];
    expect(
      titleChainFacts([
        row("insert", "Dugout Collection", stale),
        row("variantType", "Promo"),
        row("setName", "Score"),
      ]),
    ).toEqual({});
  });

  test("an insert-level row under a Parallel type is a parallel, not an insert", () => {
    expect(
      titleChainFacts([
        row("insert", "Artist's Proof"),
        row("variantType", "Parallels"),
        row("setName", "Score"),
      ]),
    ).toEqual({ parallelLeafValue: "Artist's Proof" });
  });

  test("a parallel leaf under an insert: both the insert and the leaf", () => {
    expect(
      titleChainFacts([
        row("parallel", "Artist's Proof"),
        row("insert", "Dugout Collection"),
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
    // Refractor is a parallel of base (insert-level under Parallels) but not
    // the leaf: it is neither the insert name nor the parallel token.
    expect(
      titleChainFacts([
        row("parallel", "Gold"),
        row("insert", "Refractor"),
        row("variantType", "Parallels"),
        row("setName", "Chrome"),
      ]),
    ).toEqual({ parallelLeafValue: "Gold" });
    // A variant type is never a parallel leaf, whatever its title.
    expect(
      titleChainFacts([row("variantType", "Parallels"), row("setName", "Chrome")]),
    ).toEqual({});
  });

  test("the NEAREST short name wins, self first", () => {
    expect(
      titleChainFacts([
        row("insert", "Hologram", { listingShortName: "UD Hologram" }),
        row("variantType", "Inserts"),
        row("setName", "Collector's Choice", { listingShortName: "UD Choice" }),
      ]).listingShortName,
    ).toBe("UD Hologram");
    expect(
      titleChainFacts([
        row("insert", "Hologram"),
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
        row("insert", "Stray"),
        row("variantType", "Inserts"),
      ]),
    ).toEqual({});
    // A variant type past the setName row confers no kind.
    expect(
      titleChainFacts([
        row("insert", "Stray"),
        row("setName", "Score"),
        row("variantType", "Inserts"),
      ]),
    ).toEqual({});
  });

  test("the first (nearest) insert-level row is the one named", () => {
    expect(
      titleChainFacts([
        row("insert", "Child"),
        row("insert", "Parent"),
        row("variantType", "Inserts"),
        row("setName", "Score"),
      ]),
    ).toEqual({ insertNameValue: "Child", insertIsRole: true });
  });

  test("an empty or broken chain says nothing", () => {
    expect(titleChainFacts([])).toEqual({});
    expect(titleChainFacts([null])).toEqual({});
    expect(titleChainFacts([row("variantType", "Base"), null, row("setName", "x", { listingShortName: "y" })])).toEqual({});
    // A break before the variant type: the insert has no kind to read.
    expect(
      titleChainFacts([row("insert", "Hologram"), null, row("variantType", "Inserts")]),
    ).toEqual({});
  });
});
