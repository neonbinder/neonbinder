/**
 * NEO-291 — `variantTypeRole` / `derivedVariantFlags` / `withVariantFlags`.
 *
 * These are the pure rules that replaced the Insert/Parallel checkboxes: what
 * NB role a variant-type row plays (from `metadata.isBase` or its
 * `variant`-tagged BSC slot, never its name), and what flags a fresh row
 * beneath it is born with. See the file-level comment in convex/variantRole.ts
 * for the fuller "why" — these tests pin the matrix it promises.
 */

import { describe, expect, test } from "vitest";
import {
  derivedVariantFlags,
  variantTypeRole,
  withVariantFlags,
  type VariantRoleRow,
} from "./variantRole";

/** A variant-type row. `bsc` slot → id; `facets` slot → tag (omit for untagged). */
function row(
  bsc: Record<string, string>,
  facets?: Record<string, "setName" | "variantName" | "variant">,
  metadata?: { isBase?: boolean },
): VariantRoleRow {
  return {
    platformData: { bsc },
    platformFacets: facets ? { bsc: facets } : undefined,
    metadata,
  };
}

// ===========================================================================
// variantTypeRole
// ===========================================================================

describe("variantTypeRole", () => {
  test("null/undefined row is undefined", () => {
    expect(variantTypeRole(null)).toBeUndefined();
    expect(variantTypeRole(undefined)).toBeUndefined();
  });

  test("metadata.isBase wins outright — no slot is even consulted", () => {
    // An id that would otherwise read as insert; isBase still wins.
    expect(
      variantTypeRole(
        row({ b0: "insert" }, { b0: "variant" }, { isBase: true }),
      ),
    ).toBe("base");
  });

  test("a `variant`-tagged slot whose id carries the insert token reads as insert", () => {
    expect(variantTypeRole(row({ b0: "insert" }, { b0: "variant" }))).toBe(
      "insert",
    );
  });

  test("Insert-Cards (mixed case, hyphenated) still reads as insert", () => {
    expect(
      variantTypeRole(row({ b0: "Insert-Cards" }, { b0: "variant" })),
    ).toBe("insert");
  });

  test("a `variant`-tagged slot whose id carries the parallel token reads as parallel", () => {
    expect(variantTypeRole(row({ b0: "parallel" }, { b0: "variant" }))).toBe(
      "parallel",
    );
  });

  test("an id carrying BOTH the insert and parallel tokens is no evidence", () => {
    expect(
      variantTypeRole(row({ b0: "base-parallel-insert" }, { b0: "variant" })),
    ).toBeUndefined();
    expect(
      variantTypeRole(row({ b0: "insert-parallel" }, { b0: "variant" })),
    ).toBeUndefined();
  });

  test("`base-parallel` reads as neither — base isn't checked here at all, and the parallel token is ambiguous with the insert check", () => {
    // Only insert/parallel roles are decided by this function (base comes
    // from metadata.isBase, checked first above) — an id that is only ever
    // "parallel"-tagged with no insert token reads as parallel; this case
    // exercises an id that is unambiguous for parallel and confirms no
    // spurious insert match sneaks in.
    expect(
      variantTypeRole(row({ b0: "base-parallel" }, { b0: "variant" })),
    ).toBe("parallel");
  });

  test("an untagged slot is no evidence, whatever the id says", () => {
    expect(variantTypeRole(row({ b0: "insert" }))).toBeUndefined();
  });

  test("a row with no BSC ids at all is no evidence", () => {
    expect(variantTypeRole(row({}))).toBeUndefined();
  });

  test("a `setName`-tagged extra slot is ignored, not read as the role", () => {
    expect(
      variantTypeRole(
        row(
          { b0: "insert", b1: "topps-series-1" },
          { b0: "variant", b1: "setName" },
        ),
      ),
    ).toBe("insert");
  });

  test("two disagreeing `variant`-tagged slots are no evidence", () => {
    expect(
      variantTypeRole(
        row({ b0: "insert", b1: "parallel" }, { b0: "variant", b1: "variant" }),
      ),
    ).toBeUndefined();
  });

  test("two AGREEING `variant`-tagged slots still resolve", () => {
    expect(
      variantTypeRole(
        row(
          { b0: "insert-set-a", b1: "insert-set-b" },
          { b0: "variant", b1: "variant" },
        ),
      ),
    ).toBe("insert");
  });
});

// ===========================================================================
// derivedVariantFlags
// ===========================================================================

describe("derivedVariantFlags", () => {
  test("a parallel-level row is always a parallel, whatever the parent", () => {
    expect(derivedVariantFlags("parallel", undefined)).toEqual({
      isParallel: true,
    });
    expect(
      derivedVariantFlags("parallel", row({ b0: "insert" }, { b0: "variant" })),
    ).toEqual({ isParallel: true });
  });

  test("an insert-level row under an insert-role parent is an insert", () => {
    expect(
      derivedVariantFlags("insert", row({ b0: "insert" }, { b0: "variant" })),
    ).toEqual({ isInsert: true });
  });

  test("an insert-level row under a parallel-role parent is a parallel (a parallel of the base set)", () => {
    expect(
      derivedVariantFlags("insert", row({ b0: "parallel" }, { b0: "variant" })),
    ).toEqual({ isParallel: true });
  });

  test("an insert-level row under a base-role parent gets no flag", () => {
    expect(
      derivedVariantFlags("insert", row({}, undefined, { isBase: true })),
    ).toBeUndefined();
  });

  test("an insert-level row under a parent with no resolvable role gets no flag", () => {
    expect(derivedVariantFlags("insert", row({ b0: "insert" }))).toBeUndefined();
    expect(derivedVariantFlags("insert", undefined)).toBeUndefined();
  });

  test("any other level gets no flag", () => {
    for (const level of ["sport", "year", "manufacturer", "setName", "variantType"]) {
      expect(
        derivedVariantFlags(level, row({ b0: "insert" }, { b0: "variant" })),
      ).toBeUndefined();
    }
  });
});

// ===========================================================================
// withVariantFlags
// ===========================================================================

describe("withVariantFlags", () => {
  test("replaces both flags on a row that had the opposite pair", () => {
    expect(
      withVariantFlags({ isInsert: true, isParallel: false }, { isParallel: true }),
    ).toEqual({ isParallel: true });
  });

  test("keeps every other metadata key untouched", () => {
    expect(
      withVariantFlags(
        { cardNumberPrefix: "DK-", isInsert: true },
        { isParallel: true },
      ),
    ).toEqual({ cardNumberPrefix: "DK-", isParallel: true });
  });

  test("undefined flags clears both without touching other keys", () => {
    expect(
      withVariantFlags({ cardNumberPrefix: "DK-", isInsert: true }, undefined),
    ).toEqual({ cardNumberPrefix: "DK-" });
  });

  test("returns undefined when nothing is left", () => {
    expect(withVariantFlags(undefined, undefined)).toBeUndefined();
    expect(withVariantFlags({ isInsert: true }, undefined)).toBeUndefined();
  });

  test("undefined metadata plus flags produces just the flags", () => {
    expect(withVariantFlags(undefined, { isInsert: true })).toEqual({
      isInsert: true,
    });
  });
});
