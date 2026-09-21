/**
 * NEO-237 — `isSlAllBrandsBrandId`, the adapter-boundary predicate that
 * recognises SportLots' all-brands option by ITS id, never by an NB display
 * value. Small and self-contained, mirroring `bscFacets.test.ts`'s coverage
 * of `isBscBaseVariantId` for the same reason: a marketplace-vocabulary
 * predicate is worth pinning on its own, since every caller (the adapter, the
 * manufacturer sync, the suggestion doors) trusts it completely.
 */

import { describe, expect, test } from "vitest";
import { isSlAllBrandsBrandId, SL_ALL_BRANDS_BRAND_ID } from "./slBrandAxis";

describe("isSlAllBrandsBrandId", () => {
  test("matches the exact literal", () => {
    expect(isSlAllBrandsBrandId(SL_ALL_BRANDS_BRAND_ID)).toBe(true);
    expect(isSlAllBrandsBrandId("All Brands")).toBe(true);
  });

  test("folds case and surrounding whitespace", () => {
    expect(isSlAllBrandsBrandId("  ALL brands ")).toBe(true);
    expect(isSlAllBrandsBrandId("all BRANDS")).toBe(true);
  });

  test("a real brand id does not match", () => {
    expect(isSlAllBrandsBrandId("Topps")).toBe(false);
    expect(isSlAllBrandsBrandId("17")).toBe(false);
  });

  test("undefined is not the sentinel", () => {
    expect(isSlAllBrandsBrandId(undefined)).toBe(false);
  });

  test("empty string is not the sentinel", () => {
    expect(isSlAllBrandsBrandId("")).toBe(false);
  });

  test("a string merely containing the literal does not match", () => {
    expect(isSlAllBrandsBrandId("All Brands Wax")).toBe(false);
    expect(isSlAllBrandsBrandId("Not All Brands")).toBe(false);
  });
});
