/**
 * NEO-25: unit tests for the pure feature-derivation helpers. No Convex
 * runtime needed — these are plain functions over the ancestor-chain inputs
 * and card columns.
 */

import { describe, expect, test } from "vitest";
import {
  deriveSetLevelFeatures,
  deriveCardObservedFeatures,
  deriveBackfillFeatures,
  eraForYear,
  validateFeatureValue,
  ERA_BUCKET_OPTIONS,
  LEAGUE_OPTIONS,
} from "./features/deriveCardFeatures";

describe("deriveSetLevelFeatures", () => {
  test("modern Baseball base card derives the full set", () => {
    expect(
      deriveSetLevelFeatures({
        sport: "Baseball",
        year: "2024",
        manufacturer: "Topps",
        leafLevel: "variantType",
      }),
    ).toEqual({
      league: "MLB",
      era: "Modern (1980-Now)",
      vintage: "false",
      season: "2024",
      manufacturer: "Topps",
      cardType: "Base",
      parallelName: "Base",
      isReprint: "false",
      autographed: "None",
      cardSize: "Standard",
      cardMaterial: "Card Stock",
      cardThickness: "20pt",
      language: "English",
      countryOfOrigin: "USA",
    });
  });

  test("league maps per sport; unmapped sport gets none", () => {
    expect(deriveSetLevelFeatures({ sport: "Basketball" }).league).toBe("NBA");
    expect(deriveSetLevelFeatures({ sport: "Football" }).league).toBe("NFL");
    expect(deriveSetLevelFeatures({ sport: "Hockey" }).league).toBe("NHL");
    expect(deriveSetLevelFeatures({ sport: "Pokémon" }).league).toBeUndefined();
  });

  test("cardType from leaf level / metadata", () => {
    expect(deriveSetLevelFeatures({ leafLevel: "insert" }).cardType).toBe("Insert");
    expect(deriveSetLevelFeatures({ leafLevel: "parallel" }).cardType).toBe("Parallel");
    expect(
      deriveSetLevelFeatures({ leafLevel: "variantType", leafIsParallel: true })
        .cardType,
    ).toBe("Parallel");
    expect(deriveSetLevelFeatures({ leafLevel: "variantType" }).cardType).toBe("Base");
  });

  test("parallelName defaults to Base only at variantType level, never insert/parallel", () => {
    expect(
      deriveSetLevelFeatures({ leafLevel: "variantType" }).parallelName,
    ).toBe("Base");
    expect(
      deriveSetLevelFeatures({ leafLevel: "insert" }).parallelName,
    ).toBeUndefined();
    expect(
      deriveSetLevelFeatures({ leafLevel: "parallel" }).parallelName,
    ).toBeUndefined();
  });

  test("isReprint, autographed, cardSize, cardMaterial, language default unconditionally", () => {
    // No inputs at all — all still seed, matching the "unconditional on
    // every call" contract LEVEL_HEURISTIC_KEYS relies on to filter per level.
    const f = deriveSetLevelFeatures({});
    expect(f.isReprint).toBe("false");
    expect(f.autographed).toBe("None");
    expect(f.cardSize).toBe("Standard");
    expect(f.cardMaterial).toBe("Card Stock");
    expect(f.language).toBe("English");
  });

  test("season mirrors the year value verbatim, including season-style strings", () => {
    expect(deriveSetLevelFeatures({ year: "2024" }).season).toBe("2024");
    expect(deriveSetLevelFeatures({ year: "2023-24" }).season).toBe("2023-24");
    expect(deriveSetLevelFeatures({}).season).toBeUndefined();
  });

  test("season-style year parses the leading year", () => {
    const f = deriveSetLevelFeatures({ sport: "Hockey", year: "2023-24" });
    expect(f.era).toBe("Modern (1980-Now)");
    expect(f.vintage).toBe("false");
  });

  test("ignores a non-year value", () => {
    const f = deriveSetLevelFeatures({ year: "n/a" });
    expect(f.era).toBeUndefined();
    expect(f.vintage).toBeUndefined();
  });
});

describe("eraForYear (eBay-standard buckets)", () => {
  test.each([
    [1930, "Pre-WWII (Pre-1942)"],
    [1941, "Pre-WWII (Pre-1942)"],
    [1942, "Post-WWII (1942-69)"],
    [1969, "Post-WWII (1942-69)"],
    [1970, "Vintage (1970-79)"],
    [1979, "Vintage (1970-79)"],
    [1980, "Modern (1980-Now)"],
    [2024, "Modern (1980-Now)"],
  ])("%i → %s", (year, expected) => {
    expect(eraForYear(year)).toBe(expected);
  });

  test("vintage flag flips at 1979/1980", () => {
    expect(deriveSetLevelFeatures({ year: "1979" }).vintage).toBe("true");
    expect(deriveSetLevelFeatures({ year: "1980" }).vintage).toBe("false");
  });

  test("ERA_BUCKET_OPTIONS has exactly the 4 known bucket strings", () => {
    expect(ERA_BUCKET_OPTIONS).toEqual([
      "Pre-WWII (Pre-1942)",
      "Post-WWII (1942-69)",
      "Vintage (1970-79)",
      "Modern (1980-Now)",
    ]);
  });
});

describe("validateFeatureValue (NEO-72/73 server-side guard)", () => {
  test("accepts every LEAGUE_OPTIONS value", () => {
    for (const league of LEAGUE_OPTIONS) {
      expect(() => validateFeatureValue("league", league)).not.toThrow();
    }
  });

  test("accepts every ERA_BUCKET_OPTIONS value", () => {
    for (const era of ERA_BUCKET_OPTIONS) {
      expect(() => validateFeatureValue("era", era)).not.toThrow();
    }
  });

  test("rejects an off-list era value", () => {
    expect(() => validateFeatureValue("era", "Junk Wax")).toThrow();
  });

  // league is intentionally NOT validated against LEAGUE_OPTIONS server-side
  // (unlike era's closed bucket taxonomy): operators legitimately override it
  // to values outside the 4-primary-league frontend <select> for
  // international/niche sets (e.g. "NPB" for Japanese releases — see
  // cardFeatureDerivation.test.ts's operator-override test, which predates
  // this file). Hard-rejecting here broke that real, tested capability.
  test("does NOT reject an off-list league value", () => {
    expect(() => validateFeatureValue("league", "NPB")).not.toThrow();
    expect(() => validateFeatureValue("league", "XFL")).not.toThrow();
  });

  test("is a no-op for every other key, even nonsense values", () => {
    expect(() => validateFeatureValue("manufacturer", "anything")).not.toThrow();
    expect(() => validateFeatureValue("isReprint", "true")).not.toThrow();
  });
});

describe("deriveCardObservedFeatures", () => {
  test("typed booleans and strings", () => {
    expect(
      deriveCardObservedFeatures({
        isRookie: true,
        isRelic: true,
        autographType: "On-Card",
        cardVariation: "Gold Refractor",
      }),
    ).toEqual({
      isRookie: "true",
      isRelic: "true",
      // autographType maps to the closed autographed vocabulary now — it no
      // longer sets signedBy directly (that was the auto FORMAT, not a
      // signer's name; signedBy is now resolved from playerIds by the caller).
      autographed: "On Card",
      parallelName: "Gold Refractor",
    });
  });

  test("autographType containing 'sticker' maps to Sticker/Label", () => {
    expect(
      deriveCardObservedFeatures({ autographType: "Sticker" }).autographed,
    ).toBe("Sticker/Label");
    expect(
      deriveCardObservedFeatures({ autographType: "Sticker Auto" }).autographed,
    ).toBe("Sticker/Label");
  });

  test("autographType not mentioning sticker maps to On Card", () => {
    expect(
      deriveCardObservedFeatures({ autographType: "Cut" }).autographed,
    ).toBe("On Card");
    expect(
      deriveCardObservedFeatures({ autographType: "On-Card" }).autographed,
    ).toBe("On Card");
  });

  test("falls back to attributes array (custom cards)", () => {
    expect(
      deriveCardObservedFeatures({ attributes: ["RC", "RELIC"] }),
    ).toEqual({ isRookie: "true", isRelic: "true" });
  });

  test("empty card yields no observed features", () => {
    expect(deriveCardObservedFeatures({})).toEqual({});
  });

  test("shortPrint derives SP/SSP from the attributes array, preferring SSP", () => {
    expect(deriveCardObservedFeatures({ attributes: ["SP"] })).toEqual({
      shortPrint: "SP",
    });
    expect(deriveCardObservedFeatures({ attributes: ["SSP"] })).toEqual({
      shortPrint: "SSP",
    });
    // Both tokens present (data-quality edge case) — SSP is the stronger claim.
    expect(deriveCardObservedFeatures({ attributes: ["SP", "SSP"] })).toEqual({
      shortPrint: "SSP",
    });
    expect(deriveCardObservedFeatures({ attributes: ["RC"] })).toEqual({
      isRookie: "true",
    });
  });
});

describe("deriveBackfillFeatures (gap-fill, existing wins)", () => {
  test("fills missing keys but preserves operator overrides", () => {
    const result = deriveBackfillFeatures(
      { sport: "Baseball", year: "2024", manufacturer: "Topps", leafLevel: "variantType" },
      { attributes: ["RC"] },
      // Operator previously overrode cardType and already has isRookie.
      { cardType: "Short Print", isRookie: "true" },
    );
    expect(result.league).toBe("MLB"); // gap-filled
    expect(result.era).toBe("Modern (1980-Now)"); // gap-filled
    expect(result.cardType).toBe("Short Print"); // override preserved, NOT "Base"
    expect(result.isRookie).toBe("true");
  });

  test("idempotent — re-running over the result is a no-op", () => {
    const inputs = [
      { sport: "Baseball", year: "1975", manufacturer: "Topps", leafLevel: "variantType" as const },
      { attributes: [] as string[] },
    ] as const;
    const first = deriveBackfillFeatures(inputs[0], inputs[1], undefined);
    const second = deriveBackfillFeatures(inputs[0], inputs[1], first);
    expect(second).toEqual(first);
    expect(first.vintage).toBe("true");
    expect(first.era).toBe("Vintage (1970-79)");
  });
});
