/**
 * NEO-189 — facet bucketing and BSC fan-out planning.
 *
 * These are the two pure decisions the N:M set mapping rests on:
 *
 *   1. Which BSC facet does each attached id filter on? Before this ticket the
 *      answer came from the NB LEVEL of the row holding the id, which is wrong
 *      for the whole point of the feature — BSC files Topps Series 1 and
 *      Series 2 as two `setName` sets where SportLots files one, so a
 *      **setName** id has to hang off an NB Base (`variantType`) row. Level
 *      bucketing dropped it silently.
 *
 *   2. How many requests does that turn into? BSC does not OR a multi-value
 *      facet — it answers 200 OK with an EMPTY body (measured live on dev
 *      2026-08-12) — so no outgoing request may carry two values for one
 *      facet, on any axis.
 *
 * Tested here rather than only through the adapter because these are total
 * functions over small inputs: the legacy/tagged matrix is exhaustible in a
 * way an HTTP-stubbed integration test never is.
 */

import { describe, expect, test } from "vitest";
import {
  BSC_SOURCE_FACETS,
  MAX_BSC_FAN_OUT,
  legacyBscFacetForLevel,
  planBscFanOut,
  resolveBscFacetFilters,
  syncWrittenBscFacet,
  type BscFacet,
  type FacetBearingRow,
} from "./bscFacets";

/** A chain node. `facets` maps slot → tag; omit it for a legacy row. */
function node(
  level: string,
  bscSlots: Record<string, string>,
  facets?: Record<string, BscFacet>,
): FacetBearingRow {
  return {
    level,
    platformData: { bsc: bscSlots },
    ...(facets ? { platformFacets: { bsc: facets } } : {}),
  };
}

/** sport → year → manufacturer → setName, the scope every chain shares. */
const SCOPE: FacetBearingRow[] = [
  node("sport", { b0: "baseball" }),
  node("year", { b0: "2024" }),
  // No BSC facet for manufacturer — SL only.
  node("manufacturer", {}),
  node("setName", { b0: "topps" }),
];

describe("legacyBscFacetForLevel — what an UNTAGGED slot filters on", () => {
  test("maps the levels it always mapped", () => {
    expect(legacyBscFacetForLevel("sport")).toBe("sport");
    expect(legacyBscFacetForLevel("year")).toBe("year");
    expect(legacyBscFacetForLevel("setName")).toBe("setName");
    expect(legacyBscFacetForLevel("insert")).toBe("variantName");
  });

  test("variantType and parallel resolve to nothing — deliberately", () => {
    // variantType is skipped because `variant` is re-derived from the row's
    // DISPLAY value (a mis-saved BaseSetPicker mapping once pointed the slug
    // at the parent setName). parallel never had a BSC facet at all. Both
    // mean "an untagged id here contributes nothing", which is what shipped.
    expect(legacyBscFacetForLevel("variantType")).toBeUndefined();
    expect(legacyBscFacetForLevel("parallel")).toBeUndefined();
    expect(legacyBscFacetForLevel("manufacturer")).toBeUndefined();
  });
});

describe("resolveBscFacetFilters — backward compatibility", () => {
  test("an UNTAGGED Base row is inert, exactly as before", () => {
    // THE COMPATIBILITY GUARANTEE. Every row attached before NEO-189 carries
    // no tag. Inferring `setName` for this id would start sourcing cards from
    // a set the operator never chose, on every reconciled row in production —
    // the precise mis-sourcing this surface exists to prevent.
    const chain = [...SCOPE, node("variantType", { b0: "base" })];
    const plan = resolveBscFacetFilters(chain);

    expect(plan.filters).toEqual({
      sport: ["baseball"],
      year: ["2024"],
      setName: ["topps"],
    });
    expect(plan.filters.variant).toBeUndefined();
    expect(plan.sourceFacet).toBe("setName"); // the setName ANCESTOR, not the leaf
  });

  test("an UNTAGGED Parallel row is inert, exactly as before", () => {
    const chain = [
      ...SCOPE,
      node("variantType", { b0: "parallel" }),
      node("parallel", { b0: "gold-foil" }),
    ];
    const plan = resolveBscFacetFilters(chain);

    expect(plan.filters).toEqual({
      sport: ["baseball"],
      year: ["2024"],
      setName: ["topps"],
    });
  });

  test("an UNTAGGED Insert row still filters on variantName", () => {
    const chain = [
      ...SCOPE,
      node("variantType", { b0: "insert" }),
      node("insert", { b0: "dugout-s1", b1: "dugout-s2" }),
    ];
    const plan = resolveBscFacetFilters(chain);

    expect(plan.filters.variantName).toEqual(["dugout-s1", "dugout-s2"]);
    expect(plan.sourceFacet).toBe("variantName");
  });
});

describe("resolveBscFacetFilters — tagged slots", () => {
  test("a Base row tagged with two setName ids sources from BOTH — the N:M case", () => {
    // The product owner's example. BSC: 2024 → Topps → Topps Series 1 → Base
    // and 2024 → Topps → Topps Series 2 → Base. SportLots: one set.
    const chain = [
      ...SCOPE,
      node(
        "variantType",
        { b0: "base", b1: "topps-series-1", b2: "topps-series-2" },
        { b1: "setName", b2: "setName" },
      ),
    ];
    const plan = resolveBscFacetFilters(chain);

    // The reconciler's untagged `base` slug is still ignored; the two tagged
    // setName ids OVERRIDE the ancestor's `topps`.
    expect(plan.filters.setName).toEqual(["topps-series-1", "topps-series-2"]);
    expect(plan.sourceFacet).toBe("setName");
  });

  test("a Parallel row tagged with a setName id is no longer discarded", () => {
    const chain = [
      ...SCOPE,
      node("variantType", { b0: "parallel" }),
      node("parallel", { b0: "topps-series-2" }, { b0: "setName" }),
    ];
    const plan = resolveBscFacetFilters(chain);

    expect(plan.filters.setName).toEqual(["topps-series-2"]);
  });

  test("a deeper row OVERRIDES an ancestor's contribution to the same facet", () => {
    // Unioning instead would hand BSC a three-value setName facet, which it
    // answers 200 OK with an empty body — the silent failure this fixes.
    const chain = [
      ...SCOPE,
      node("variantType", { b0: "topps-series-1" }, { b0: "setName" }),
    ];
    expect(resolveBscFacetFilters(chain).filters.setName).toEqual([
      "topps-series-1",
    ]);
  });

  test("within ONE row, a legacy id and a tagged id on the same facet UNION", () => {
    // An insert row attached before NEO-189 (untagged, bucketed to variantName
    // by level) that the operator then adds a second variant to must query
    // both, not replace one with the other.
    const chain = [
      ...SCOPE,
      node("variantType", { b0: "insert" }),
      node("insert", { b0: "dugout-s1", b1: "dugout-s2" }, { b1: "variantName" }),
    ];
    expect(resolveBscFacetFilters(chain).filters.variantName).toEqual([
      "dugout-s1",
      "dugout-s2",
    ]);
  });

  test("setName and variantName tagged on one row both apply — an insert in a sibling set", () => {
    const chain = [
      ...SCOPE,
      node("variantType", { b0: "insert" }),
      node(
        "insert",
        { b0: "topps-series-2", b1: "stars-of-mlb" },
        { b0: "setName", b1: "variantName" },
      ),
    ];
    const plan = resolveBscFacetFilters(chain);

    expect(plan.filters.setName).toEqual(["topps-series-2"]);
    expect(plan.filters.variantName).toEqual(["stars-of-mlb"]);
    // variantName is the deeper-listed facet on this row, so it names the source.
    expect(plan.sourceFacet).toBe("variantName");
  });

  test("sport and year are scope, never a source facet", () => {
    const plan = resolveBscFacetFilters([
      node("sport", { b0: "baseball" }),
      node("year", { b0: "2024" }),
    ]);
    expect(plan.sourceFacet).toBeUndefined();
  });
});

describe("planBscFanOut", () => {
  test("no multi-valued facet — ONE request, filters sent as-is", () => {
    const plan = planBscFanOut({
      sport: ["baseball"],
      year: ["2024"],
      setName: ["topps"],
      variant: ["base"],
    });
    expect(plan.combos).toEqual([{}]);
    expect(plan.multiFacets).toEqual([]);
  });

  test("two setName ids produce TWO requests, one value each — the whole bug", () => {
    const plan = planBscFanOut({
      sport: ["baseball"],
      setName: ["topps-series-1", "topps-series-2"],
    });
    expect(plan.combos).toEqual([
      { setName: "topps-series-1" },
      { setName: "topps-series-2" },
    ]);
    expect(plan.multiFacets).toEqual(["setName"]);
  });

  test("two variantName ids still fan out — the case that already worked", () => {
    const plan = planBscFanOut({ variantName: ["dugout-s1", "dugout-s2"] });
    expect(plan.combos).toEqual([
      { variantName: "dugout-s1" },
      { variantName: "dugout-s2" },
    ]);
  });

  test("two multi-valued facets fan out over the CROSS PRODUCT", () => {
    // Picking one axis and sending the other whole is not an option: that
    // request carries a multi-value facet and BSC returns nothing. The
    // combinations that do not exist just return no rows.
    const plan = planBscFanOut({
      setName: ["s1", "s2"],
      variantName: ["v1", "v2"],
    });
    expect(plan.combos).toEqual([
      { setName: "s1", variantName: "v1" },
      { setName: "s1", variantName: "v2" },
      { setName: "s2", variantName: "v1" },
      { setName: "s2", variantName: "v2" },
    ]);
    expect(plan.multiFacets).toEqual(["setName", "variantName"]);
  });

  test("no combination ever carries two values for one facet", () => {
    const plan = planBscFanOut({
      setName: ["s1", "s2", "s3"],
      variantName: ["v1", "v2"],
    });
    for (const combo of plan.combos) {
      for (const value of Object.values(combo)) {
        expect(Array.isArray(value)).toBe(false);
      }
    }
  });

  test("caps the request count and says it was capped", () => {
    const plan = planBscFanOut(
      { setName: ["a", "b", "c", "d"], variantName: ["x", "y", "z"] },
      MAX_BSC_FAN_OUT,
    );
    expect(plan.totalBeforeCap).toBe(12);
    expect(plan.capped).toBe(true);
    expect(plan.combos).toHaveLength(MAX_BSC_FAN_OUT);
  });

  test("a plan exactly at the cap is not reported as capped", () => {
    const plan = planBscFanOut({ setName: ["a", "b"] }, 2);
    expect(plan.capped).toBe(false);
    expect(plan.combos).toHaveLength(2);
  });
});

// ===========================================================================
// NEO-239 — `variant` joins the facet union, but not as a card SOURCE
// ===========================================================================

describe("the `variant` facet (NEO-239)", () => {
  test("a `variant`-tagged slot filters on the variant axis", () => {
    // This is what replaced deriving `filters.variant` from the row's DISPLAY
    // value in `fetchBscChecklist`. BSC's variant set is not the closed
    // base/insert/parallel enum that shortcut assumed ("Promo", "Mail In"
    // occur), which is exactly why the id has to drive it.
    const plan = resolveBscFacetFilters([
      node("sport", { b0: "baseball" }),
      node("year", { b0: "2024" }),
      node("setName", { b0: "2024-topps" }),
      node("variantType", { b0: "promo" }, { b0: "variant" }),
    ]);
    expect(plan.filters.variant).toEqual(["promo"]);
  });

  test("`variant` is NEVER the sourceFacet — it scopes, it does not source", () => {
    // `sourceFacet` decides what each returned card is ATTRIBUTED to, so that
    // `resolveCardSlots` can bind it to the slot it came from. A variant value
    // is not a set; cards attributed to one would bind to nothing.
    const plan = resolveBscFacetFilters([
      node("sport", { b0: "baseball" }),
      node("variantType", { b0: "base" }, { b0: "variant" }),
    ]);
    expect(plan.sourceFacet).toBeUndefined();
    expect([...BSC_SOURCE_FACETS].sort()).toEqual(["setName", "variantName"]);
  });

  test("a row carrying BOTH a variant tag and setName tags contributes both", () => {
    // NEO-189's motivating row, now fully expressible: an NB Base drawing from
    // two BSC setName sets AND scoping them to the base variant. The deepest
    // SOURCE facet still names the source.
    const plan = resolveBscFacetFilters([
      node("sport", { b0: "baseball" }),
      node("setName", { b0: "2024-topps" }),
      node(
        "variantType",
        { b0: "base", b1: "series-1", b2: "series-2" },
        { b0: "variant", b1: "setName", b2: "setName" },
      ),
    ]);
    expect(plan.filters.variant).toEqual(["base"]);
    // The setName ancestor's own slug is OVERRIDDEN, not unioned — BSC answers
    // a three-value facet with 200 OK and no rows.
    expect(plan.filters.setName).toEqual(["series-1", "series-2"]);
    expect(plan.sourceFacet).toBe("setName");
  });
});

describe("syncWrittenBscFacet", () => {
  test("only the variantType sync knows the facet of the ids it stores", () => {
    // It asked BSC for its `variant` facet values and is storing what came
    // back, so the tag is a fact the writer holds. Every other level returns
    // undefined: NEO-189's rule is that a slot is tagged deliberately or not
    // at all, and a second source of truth for setName would only be able to
    // disagree with the level rule.
    expect(syncWrittenBscFacet("variantType")).toBe("variant");
    for (const level of [
      "sport",
      "year",
      "manufacturer",
      "setName",
      "insert",
      "parallel",
    ]) {
      expect(syncWrittenBscFacet(level)).toBeUndefined();
    }
  });
});
