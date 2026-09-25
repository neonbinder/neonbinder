/**
 * NEO-291 / NEO-306 — `variantTypeRole` / `bscVariantEvidence` /
 * `conferredVariantRole` / `derivedVariantFlags` / `withVariantFlags`.
 *
 * These are the pure rules that replaced the Insert/Parallel checkboxes: what
 * NB role a variant-type row plays, and what flags a fresh row beneath it is
 * born with. Since NEO-306 the role is an NB FLAG (`metadata.isBase`, then
 * `metadata.variantRole`) and the BSC slot is read only at write time, by
 * `bscVariantEvidence` through `conferredVariantRole`. See the file-level
 * comment in convex/variantRole.ts for the fuller "why".
 */

import { describe, expect, test } from "vitest";
import {
  bscVariantEvidence,
  conferredVariantRole,
  derivedVariantFlags,
  variantTypeRole,
  withVariantFlags,
  type VariantEvidenceRow,
} from "./variantRole";

/** A variant-type row's slots. `bsc` slot → id; `facets` slot → tag (omit for untagged). */
function slots(
  bsc: Record<string, string>,
  facets?: Record<string, "setName" | "variantName" | "variant">,
): VariantEvidenceRow {
  return {
    platformData: { bsc },
    platformFacets: facets ? { bsc: facets } : undefined,
  };
}

// ===========================================================================
// variantTypeRole — flags only (NEO-306)
// ===========================================================================

describe("variantTypeRole", () => {
  test("null/undefined row is undefined", () => {
    expect(variantTypeRole(null)).toBeUndefined();
    expect(variantTypeRole(undefined)).toBeUndefined();
  });

  test("metadata.isBase wins outright, over a variantRole too", () => {
    expect(
      variantTypeRole({ metadata: { isBase: true, variantRole: "insert" } }),
    ).toBe("base");
  });

  test("metadata.variantRole is the role", () => {
    expect(variantTypeRole({ metadata: { variantRole: "insert" } })).toBe("insert");
    expect(variantTypeRole({ metadata: { variantRole: "parallel" } })).toBe(
      "parallel",
    );
  });

  test("a tagged BSC slot with no flag is NOT read at runtime — no role", () => {
    // The shape every pre-NEO-306 row has until a sync or the backfill
    // confers the flag. Reading the slot here would key NB behaviour on a
    // marketplace id (invariant 4); the answer is fail-closed.
    expect(
      variantTypeRole({ ...slots({ b0: "insert" }, { b0: "variant" }), metadata: undefined }),
    ).toBeUndefined();
    expect(
      variantTypeRole({ ...slots({ b0: "parallel" }, { b0: "variant" }), metadata: undefined }),
    ).toBeUndefined();
  });

  test("the flag wins over a slot that says otherwise", () => {
    expect(
      variantTypeRole({
        ...slots({ b0: "insert" }, { b0: "variant" }),
        metadata: { variantRole: "parallel" },
      }),
    ).toBe("parallel");
  });

  test("no metadata is no role", () => {
    expect(variantTypeRole({})).toBeUndefined();
    expect(variantTypeRole({ metadata: {} })).toBeUndefined();
  });
});

// ===========================================================================
// bscVariantEvidence — write time only
// ===========================================================================

describe("bscVariantEvidence", () => {
  test("null/undefined row is undefined", () => {
    expect(bscVariantEvidence(null)).toBeUndefined();
    expect(bscVariantEvidence(undefined)).toBeUndefined();
  });

  test("a `variant`-tagged slot whose id carries the insert token reads as insert", () => {
    expect(bscVariantEvidence(slots({ b0: "insert" }, { b0: "variant" }))).toBe(
      "insert",
    );
  });

  test("Insert-Cards (mixed case, hyphenated) still reads as insert", () => {
    expect(
      bscVariantEvidence(slots({ b0: "Insert-Cards" }, { b0: "variant" })),
    ).toBe("insert");
  });

  test("a `variant`-tagged slot whose id carries the parallel token reads as parallel", () => {
    expect(
      bscVariantEvidence(slots({ b0: "parallel" }, { b0: "variant" })),
    ).toBe("parallel");
  });

  test("an id carrying BOTH the insert and parallel tokens is ambiguous", () => {
    expect(
      bscVariantEvidence(slots({ b0: "base-parallel-insert" }, { b0: "variant" })),
    ).toBe("ambiguous");
    expect(
      bscVariantEvidence(slots({ b0: "insert-parallel" }, { b0: "variant" })),
    ).toBe("ambiguous");
  });

  test("`base-parallel` reads as parallel — base is not this function's question", () => {
    expect(
      bscVariantEvidence(slots({ b0: "base-parallel" }, { b0: "variant" })),
    ).toBe("parallel");
  });

  test("BSC's `base` and `promo` ids name neither role", () => {
    expect(bscVariantEvidence(slots({ b0: "base" }, { b0: "variant" }))).toBeUndefined();
    expect(bscVariantEvidence(slots({ b0: "promo" }, { b0: "variant" }))).toBeUndefined();
  });

  test("an untagged slot is no evidence, whatever the id says", () => {
    expect(bscVariantEvidence(slots({ b0: "insert" }))).toBeUndefined();
  });

  test("a row with no BSC ids at all is no evidence", () => {
    expect(bscVariantEvidence(slots({}))).toBeUndefined();
  });

  test("a `setName`-tagged extra slot is ignored, not read as the role", () => {
    expect(
      bscVariantEvidence(
        slots(
          { b0: "insert", b1: "topps-series-1" },
          { b0: "variant", b1: "setName" },
        ),
      ),
    ).toBe("insert");
  });

  test("two disagreeing `variant`-tagged slots are ambiguous", () => {
    expect(
      bscVariantEvidence(
        slots({ b0: "insert", b1: "parallel" }, { b0: "variant", b1: "variant" }),
      ),
    ).toBe("ambiguous");
  });

  test("two AGREEING `variant`-tagged slots still resolve", () => {
    expect(
      bscVariantEvidence(
        slots(
          { b0: "insert-set-a", b1: "insert-set-b" },
          { b0: "variant", b1: "variant" },
        ),
      ),
    ).toBe("insert");
  });
});

// ===========================================================================
// conferredVariantRole — the adds-only guard every writer shares
// ===========================================================================

describe("conferredVariantRole", () => {
  const insertSlot = slots({ b0: "insert" }, { b0: "variant" });

  test("an unflagged row with single evidence gets the role", () => {
    expect(conferredVariantRole(undefined, insertSlot)).toBe("insert");
    expect(
      conferredVariantRole({}, slots({ b0: "parallel" }, { b0: "variant" })),
    ).toBe("parallel");
  });

  test("never over a role already there — even a different one", () => {
    expect(
      conferredVariantRole({ variantRole: "parallel" }, insertSlot),
    ).toBeUndefined();
    expect(conferredVariantRole({ variantRole: "insert" }, insertSlot)).toBeUndefined();
  });

  test("never on the Base", () => {
    expect(conferredVariantRole({ isBase: true }, insertSlot)).toBeUndefined();
  });

  test("ambiguous or absent evidence confers nothing", () => {
    expect(
      conferredVariantRole(
        undefined,
        slots({ b0: "insert-parallel" }, { b0: "variant" }),
      ),
    ).toBeUndefined();
    expect(conferredVariantRole(undefined, slots({ b0: "insert" }))).toBeUndefined();
    expect(conferredVariantRole(undefined, null)).toBeUndefined();
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
      derivedVariantFlags("parallel", { metadata: { variantRole: "insert" } }),
    ).toEqual({ isParallel: true });
  });

  test("an insert-level row under an insert-role parent is an insert", () => {
    expect(
      derivedVariantFlags("insert", { metadata: { variantRole: "insert" } }),
    ).toEqual({ isInsert: true });
  });

  test("an insert-level row under a parallel-role parent is a parallel (a parallel of the base set)", () => {
    expect(
      derivedVariantFlags("insert", { metadata: { variantRole: "parallel" } }),
    ).toEqual({ isParallel: true });
  });

  test("an insert-level row under a base-role parent gets no flag", () => {
    expect(
      derivedVariantFlags("insert", { metadata: { isBase: true } }),
    ).toBeUndefined();
  });

  test("an insert-level row under an unflagged parent gets no flag, whatever its BSC slot says", () => {
    expect(
      derivedVariantFlags("insert", {
        ...slots({ b0: "insert" }, { b0: "variant" }),
        metadata: undefined,
      }),
    ).toBeUndefined();
    expect(derivedVariantFlags("insert", undefined)).toBeUndefined();
  });

  test("any other level gets no flag", () => {
    for (const level of ["sport", "year", "manufacturer", "setName", "variantType"]) {
      expect(
        derivedVariantFlags(level, { metadata: { variantRole: "insert" } }),
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
