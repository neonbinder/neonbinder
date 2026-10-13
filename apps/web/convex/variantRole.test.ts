/**
 * NEO-334 — a variant type's TITLE is its kind.
 *
 * `variantTypeKindFromTitle` / `variantTypeKind` / `sameTitleWord` /
 * `derivedVariantFlags` / `subVariantsAllowedUnder` / `variantTypeRenameOutcome`
 * are the pure rules. There is no flag to read: the title is the only input.
 * See the header of convex/variantRole.ts for the fuller "why".
 */

import { describe, expect, test } from "vitest";
import {
  VARIANT_TYPE_RENAME_MESSAGES,
  VARIANT_TYPE_RENAME_REFUSED,
  derivedVariantFlags,
  sameTitleWord,
  sameWordSiblingMessage,
  subVariantsAllowedUnder,
  variantTypeKind,
  variantTypeKindFromTitle,
  variantTypeRenameOutcome,
  type VariantTypeRenameFacts,
} from "./variantRole";

// ===========================================================================
// variantTypeKindFromTitle — the exact word, nothing else
// ===========================================================================

describe("variantTypeKindFromTitle", () => {
  test.each([
    ["Base", "base"],
    ["Bases", "base"],
    ["base", "base"],
    ["BASE", "base"],
    ["Insert", "insert"],
    ["Inserts", "insert"],
    ["INSERTS", "insert"],
    ["Parallel", "parallel"],
    ["Parallels", "parallel"],
    ["pArAlLeLs", "parallel"],
  ] as const)("%j is the %s kind", (title, kind) => {
    expect(variantTypeKindFromTitle(title)).toBe(kind);
  });

  test.each([
    ["  Insert  ", "insert"],
    ["\tBase\n", "base"],
    ["Inserts ", "insert"],
  ] as const)("surrounding whitespace is trimmed: %j", (title, kind) => {
    expect(variantTypeKindFromTitle(title)).toBe(kind);
  });

  test("a title that is the word plus anything else has no kind", () => {
    for (const title of [
      "Insert Set",
      "Inserts & Autographs",
      "Base Set",
      "Base Parallels",
      "Parallel Inserts",
      "Rookie Base",
      "Autograph Inserts",
      "Bases and Inserts",
    ]) {
      expect(variantTypeKindFromTitle(title), title).toBeUndefined();
    }
  });

  test("another title carrying a kind word as a substring has no kind", () => {
    for (const title of ["Basement", "Reinserts", "Nonparallel", "Baseball"]) {
      expect(variantTypeKindFromTitle(title), title).toBeUndefined();
    }
  });

  test("a plain title (Promo, Gold) has no kind", () => {
    expect(variantTypeKindFromTitle("Promo")).toBeUndefined();
    expect(variantTypeKindFromTitle("Gold")).toBeUndefined();
  });

  test("an empty, blank or missing title has no kind", () => {
    expect(variantTypeKindFromTitle(undefined)).toBeUndefined();
    expect(variantTypeKindFromTitle("")).toBeUndefined();
    expect(variantTypeKindFromTitle("   ")).toBeUndefined();
  });

  test("inner whitespace is collapsed before comparing, so a split word is not the word", () => {
    expect(variantTypeKindFromTitle("In sert")).toBeUndefined();
    expect(variantTypeKindFromTitle("Insert  Set")).toBeUndefined();
  });

  test("object-prototype names are not kinds", () => {
    for (const title of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(variantTypeKindFromTitle(title), title).toBeUndefined();
    }
  });
});

describe("variantTypeKind", () => {
  test("null and undefined rows have no kind", () => {
    expect(variantTypeKind(null)).toBeUndefined();
    expect(variantTypeKind(undefined)).toBeUndefined();
    expect(variantTypeKind({})).toBeUndefined();
  });

  test("reads the row's value", () => {
    expect(variantTypeKind({ value: "Inserts" })).toBe("insert");
    expect(variantTypeKind({ value: "Base" })).toBe("base");
  });
});

// ===========================================================================
// sameTitleWord
// ===========================================================================

describe("sameTitleWord", () => {
  test.each([
    ["Promo", "Promos"],
    ["Promos", "Promo"],
    ["Insert", "Inserts"],
    ["Rated Rookie", "Rated Rookies"],
    ["  promo ", "PROMOS"],
    ["Rated   Rookie", "rated rookie"],
    ["Gold", "gold"],
  ])("%j and %j are the same word", (a, b) => {
    expect(sameTitleWord(a, b)).toBe(true);
  });

  test.each([
    ["Promo", "Promotion"],
    ["Gold", "Silver"],
    ["Insert", "Insert Set"],
    ["Promo", "Promoss"],
    ["Base", "Basement"],
  ])("%j and %j are different words", (a, b) => {
    expect(sameTitleWord(a, b)).toBe(false);
  });

  test("blank titles only match each other", () => {
    expect(sameTitleWord("", "  ")).toBe(true);
    expect(sameTitleWord("", "s")).toBe(false);
    expect(sameTitleWord("s", "")).toBe(false);
  });
});

describe("sameWordSiblingMessage", () => {
  test("names the existing row", () => {
    expect(sameWordSiblingMessage("Promos")).toContain('"Promos"');
  });
});

// ===========================================================================
// derivedVariantFlags — transient, read from the parent's TITLE
// ===========================================================================

describe("derivedVariantFlags", () => {
  test("a parallel-level row is always a parallel, whatever the parent", () => {
    expect(derivedVariantFlags("parallel", undefined)).toEqual({ isParallel: true });
    expect(derivedVariantFlags("parallel", { value: "Inserts" })).toEqual({
      isParallel: true,
    });
  });

  test("an insert-level row under an Insert-titled parent is an insert", () => {
    expect(derivedVariantFlags("insert", { value: "Inserts" })).toEqual({
      isInsert: true,
    });
  });

  test("an insert-level row under a Parallel-titled parent is a parallel", () => {
    expect(derivedVariantFlags("insert", { value: "Parallels" })).toEqual({
      isParallel: true,
    });
  });

  test("an insert-level row under the Base gets no flag", () => {
    expect(derivedVariantFlags("insert", { value: "Base" })).toBeUndefined();
  });

  test("an insert-level row under a plain-titled or missing parent gets no flag", () => {
    expect(derivedVariantFlags("insert", { value: "Promo" })).toBeUndefined();
    expect(derivedVariantFlags("insert", { value: "Insert Set" })).toBeUndefined();
    expect(derivedVariantFlags("insert", undefined)).toBeUndefined();
  });

  test("any other level gets no flag", () => {
    for (const level of ["sport", "year", "manufacturer", "setName", "variantType"]) {
      expect(derivedVariantFlags(level, { value: "Inserts" }), level).toBeUndefined();
    }
  });
});

// ===========================================================================
// subVariantsAllowedUnder
// ===========================================================================

describe("subVariantsAllowedUnder (NEO-334)", () => {
  test("an Insert-titled type admits sub-variants, plural or singular", () => {
    expect(subVariantsAllowedUnder({ value: "Inserts" })).toBe(true);
    expect(subVariantsAllowedUnder({ value: "insert" })).toBe(true);
  });

  test("a Parallel type, the Base and every other title do not", () => {
    expect(subVariantsAllowedUnder({ value: "Parallels" })).toBe(false);
    expect(subVariantsAllowedUnder({ value: "Base" })).toBe(false);
    expect(subVariantsAllowedUnder({ value: "Promo" })).toBe(false);
    expect(subVariantsAllowedUnder({ value: "Insert Set" })).toBe(false);
    expect(subVariantsAllowedUnder({})).toBe(false);
    expect(subVariantsAllowedUnder(null)).toBe(false);
    expect(subVariantsAllowedUnder(undefined)).toBe(false);
  });
});

// ===========================================================================
// variantTypeRenameOutcome — every branch, and the order
// ===========================================================================

const EMPTY: VariantTypeRenameFacts = {
  hasRowsBeneath: false,
  subVariants: 0,
  cards: 0,
  siblingBase: false,
};
const ROWS: VariantTypeRenameFacts = { ...EMPTY, hasRowsBeneath: true };

function refusal(
  current: string,
  next: string,
  facts: VariantTypeRenameFacts,
): string | null {
  const out = variantTypeRenameOutcome(current, next, facts);
  if (out.ok) return null;
  expect(out.code).toBe(VARIANT_TYPE_RENAME_REFUSED);
  return out.message;
}

describe("variantTypeRenameOutcome", () => {
  test("a rename that keeps the kind is allowed even with rows beneath", () => {
    expect(
      variantTypeRenameOutcome("Inserts", "Insert", { ...ROWS, subVariants: 4 }),
    ).toEqual({ ok: true });
    expect(
      variantTypeRenameOutcome("Base", "Bases", { ...ROWS, cards: 90 }),
    ).toEqual({ ok: true });
  });

  test("a no-kind title becoming another no-kind title is allowed with rows beneath", () => {
    expect(variantTypeRenameOutcome("Promo", "Gold", { ...ROWS, cards: 5 })).toEqual({
      ok: true,
    });
  });

  test("an EMPTY type may change kind freely", () => {
    expect(variantTypeRenameOutcome("Promo", "Inserts", EMPTY)).toEqual({ ok: true });
    expect(variantTypeRenameOutcome("Inserts", "Promo", EMPTY)).toEqual({ ok: true });
    expect(variantTypeRenameOutcome("Promo", "Parallels", EMPTY)).toEqual({ ok: true });
  });

  test("Insert -> other with sub-variants is refused with the Jason-approved sentence", () => {
    expect(refusal("Inserts", "Promo", { ...ROWS, subVariants: 2 })).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.insertHasSubVariants,
    );
    expect(VARIANT_TYPE_RENAME_MESSAGES.insertHasSubVariants).toBe(
      "Not so fast — some inserts under this type still have sub-variants, and sub-variants only live under an Insert type. Move them out first, then rename.",
    );
  });

  test("Insert -> other with inserts but no sub-variants gets the general kind-change sentence", () => {
    expect(refusal("Inserts", "Promo", ROWS)).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows,
    );
  });

  test("any type with rows beneath renamed Base is refused", () => {
    expect(refusal("Promo", "Base", ROWS)).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.toBaseWithRows,
    );
    expect(refusal("Parallels", "Bases", { ...ROWS, cards: 1 })).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.toBaseWithRows,
    );
  });

  test("the Base renamed to another kind with cards off it is refused", () => {
    expect(refusal("Base", "Promo", { ...ROWS, cards: 100 })).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.baseHasCards,
    );
    expect(refusal("Base", "Inserts", { ...EMPTY, cards: 1 })).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.baseHasCards,
    );
  });

  test("the Base with inserts beneath but no cards gets the general sentence", () => {
    expect(refusal("Base", "Promo", ROWS)).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows,
    );
  });

  test("Parallel -> Insert and none -> Parallel with rows get the general sentence", () => {
    expect(refusal("Parallels", "Inserts", ROWS)).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows,
    );
    expect(refusal("Promo", "Parallels", ROWS)).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows,
    );
  });

  test("a second Base is refused whatever else is true, even for an empty type", () => {
    const facts = { ...EMPTY, siblingBase: true };
    expect(refusal("Promo", "Base", facts)).toBe(VARIANT_TYPE_RENAME_MESSAGES.secondBase);
    expect(refusal("Promo", "Bases", facts)).toBe(VARIANT_TYPE_RENAME_MESSAGES.secondBase);
    expect(VARIANT_TYPE_RENAME_MESSAGES.secondBase).toBe("This set already has a Base.");
  });

  test("the second-Base refusal outranks the rows-beneath sentences", () => {
    expect(refusal("Promo", "Base", { ...ROWS, siblingBase: true })).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.secondBase,
    );
  });

  test("a sibling Base does not matter to a title that is not Base", () => {
    expect(
      variantTypeRenameOutcome("Promo", "Gold", { ...EMPTY, siblingBase: true }),
    ).toEqual({ ok: true });
    expect(
      variantTypeRenameOutcome("Promo", "Inserts", { ...EMPTY, siblingBase: true }),
    ).toEqual({ ok: true });
  });

  test("the sub-variant sentence outranks the to-Base sentence", () => {
    // An Insert type with sub-variants renamed Base: the sub-variants are the
    // more specific reason.
    expect(refusal("Inserts", "Base", { ...ROWS, subVariants: 1 })).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.insertHasSubVariants,
    );
  });

  test("the to-Base sentence outranks the Base-has-cards one (only reachable from a non-Base)", () => {
    expect(refusal("Promo", "Base", { ...ROWS, cards: 3 })).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.toBaseWithRows,
    );
  });

  test("cards or sub-variants alone count as rows beneath", () => {
    expect(refusal("Promo", "Parallels", { ...EMPTY, cards: 1 })).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows,
    );
    expect(refusal("Inserts", "Promo", { ...EMPTY, subVariants: 1 })).toBe(
      VARIANT_TYPE_RENAME_MESSAGES.insertHasSubVariants,
    );
  });
});
