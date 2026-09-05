/**
 * NEO-239 — Base is an NB ROLE on the row, never a name match.
 *
 * The negative cases are the point of this file. Base used to be detected by
 * comparing the display value to the literal `"base"` — a string that came from
 * BuySportsCards' variant facet — which made NB behaviour key on a marketplace
 * value and made a variantType row unrenameable, since renaming "Base" silently
 * broke terminal detection, column hiding and the Base mapping panel. Anyone
 * re-adding an "…or the value says base" fallback for convenience would restore
 * exactly that coupling, so the test says out loud that a row named "Base"
 * without the flag is NOT the base set.
 *
 * `.test.tsx`, not `.test.ts`: `vitest.include.mjs` collects components tests as
 * `components/ ** / *.test.tsx` only, and a `.test.ts` here would never run.
 */

import { describe, expect, it } from "vitest";
import { isBaseRole } from "./baseRole";

describe("isBaseRole", () => {
  it("reads the flag off the row's metadata", () => {
    expect(isBaseRole({ isBase: true })).toBe(true);
  });

  it("is false for a row named 'Base' that does not carry the flag", () => {
    // The whole reason this helper exists. `isBaseRole` is only ever handed
    // METADATA, so the name is not even in scope here — which is the design:
    // there is no argument a caller could pass that would let a display value
    // decide the role.
    expect(isBaseRole({ isInsert: true })).toBe(false);
    expect(isBaseRole({})).toBe(false);
  });

  it("is false for a row with no metadata at all", () => {
    // Every row written before the flag existed. They are not the base set
    // until the backfill or an operator says so, and treating "unknown" as
    // "yes" would make the wrong variantType terminal.
    expect(isBaseRole(undefined)).toBe(false);
    expect(isBaseRole(null)).toBe(false);
  });

  it("demands the boolean true, not a truthy value", () => {
    // `metadata` arrives untyped from EntitySelector's loose SelectorItem
    // index signature, so a stray string or number must not read as the role.
    expect(isBaseRole({ isBase: "true" })).toBe(false);
    expect(isBaseRole({ isBase: 1 })).toBe(false);
    expect(isBaseRole({ isBase: false })).toBe(false);
    expect(isBaseRole("Base")).toBe(false);
  });
});
