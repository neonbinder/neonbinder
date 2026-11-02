import { describe, expect, test } from "vitest";
import {
  BSC_MODERN_RAW_CONDITIONS,
  BSC_VINTAGE_CUTOFF_YEAR,
  BSC_VINTAGE_RAW_CONDITIONS,
  bscConditionFor,
  bscConditionsForEra,
  bscEraForYear,
  isBscConditionOfEra,
  isBscRawCondition,
  nbConditionsFor,
  type NbCondition,
} from "./bscConditions";

const NB: NbCondition[] = ["Mint", "Near Mint", "Excellent", "Very Good", "Good", "Poor"];

describe("bscConditions (NEO-370)", () => {
  test("modern mapping: Mint and Near Mint fold to near_mint, Good to very_good", () => {
    expect(NB.map((c) => bscConditionFor(c, "modern"))).toEqual([
      "near_mint",
      "near_mint",
      "excellent",
      "very_good",
      "very_good",
      "poor",
    ]);
  });

  test("vintage mapping is one to one", () => {
    expect(NB.map((c) => bscConditionFor(c, "vintage"))).toEqual(["mint", "nm", "ex", "vg", "good", "poor-v"]);
  });

  test("every mapped key is in BSC's vocabulary for that era", () => {
    for (const c of NB) {
      expect(isBscConditionOfEra(bscConditionFor(c, "modern"), "modern")).toBe(true);
      expect(isBscConditionOfEra(bscConditionFor(c, "vintage"), "vintage")).toBe(true);
    }
  });

  test("the vocabularies are BSC's seller keys, not the buyer filter's", () => {
    expect([...BSC_MODERN_RAW_CONDITIONS]).toEqual(["near_mint", "excellent", "very_good", "poor"]);
    expect([...BSC_VINTAGE_RAW_CONDITIONS]).toEqual([
      "mint",
      "nm-mt",
      "nm",
      "ex-mt",
      "ex",
      "vg-ex",
      "vg",
      "good",
      "fair",
      "poor-v",
    ]);
    expect(isBscRawCondition("nm-mint")).toBe(false);
    expect(isBscRawCondition("good-v")).toBe(false);
    expect(isBscRawCondition("Near Mint")).toBe(false);
    expect(isBscRawCondition("poor-v")).toBe(true);
    expect(isBscRawCondition("near_mint")).toBe(true);
  });

  test("era keys do not cross: a vintage key is not modern and back", () => {
    expect(isBscConditionOfEra("nm", "modern")).toBe(false);
    expect(isBscConditionOfEra("near_mint", "vintage")).toBe(false);
    expect(bscConditionsForEra("modern")).toBe(BSC_MODERN_RAW_CONDITIONS);
    expect(bscConditionsForEra("vintage")).toBe(BSC_VINTAGE_RAW_CONDITIONS);
  });

  test("inverse: the NB conditions a BSC row folds", () => {
    expect(nbConditionsFor("near_mint", "modern")).toEqual(["Mint", "Near Mint"]);
    expect(nbConditionsFor("very_good", "modern")).toEqual(["Very Good", "Good"]);
    expect(nbConditionsFor("poor", "modern")).toEqual(["Poor"]);
    expect(nbConditionsFor("nm", "vintage")).toEqual(["Near Mint"]);
    expect(nbConditionsFor("nm-mt", "vintage")).toEqual([]);
    expect(nbConditionsFor("near_mint", "vintage")).toEqual([]);
    expect(nbConditionsFor("bogus", "modern")).toEqual([]);
  });

  test("era: year <= 1980 is vintage, inclusive", () => {
    expect(BSC_VINTAGE_CUTOFF_YEAR).toBe(1980);
    expect(bscEraForYear("1980")).toBe("vintage");
    expect(bscEraForYear("1952")).toBe("vintage");
    expect(bscEraForYear("1981")).toBe("modern");
    expect(bscEraForYear("1988")).toBe("modern");
    expect(bscEraForYear("2024")).toBe("modern");
  });

  test("era reads the leading year of a season", () => {
    expect(bscEraForYear("1980-81")).toBe("vintage");
    expect(bscEraForYear("2020-21")).toBe("modern");
    expect(bscEraForYear(" 1979 ")).toBe("vintage");
  });

  test("era is null when there is no leading four-digit year", () => {
    expect(bscEraForYear("")).toBeNull();
    expect(bscEraForYear("Unknown")).toBeNull();
    expect(bscEraForYear("88")).toBeNull();
    expect(bscEraForYear("19800")).toBeNull();
    expect(bscEraForYear("Series 1 1975")).toBeNull();
  });
});
