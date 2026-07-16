/**
 * NEO-71–74: coverage for the typed-field metadata on EXPECTED_FEATURES —
 * mainly a drift guard so `options` always tracks the derivation module's
 * source-of-truth constants rather than a hand-copied literal.
 */

import { describe, expect, test } from "vitest";
import { EXPECTED_FEATURES } from "./expectedFeatures";
import { LEAGUE_OPTIONS, ERA_BUCKET_OPTIONS } from "./deriveCardFeatures";

function feature(key: string) {
  const f = EXPECTED_FEATURES.find((f) => f.key === key);
  if (!f) throw new Error(`no EXPECTED_FEATURES entry for "${key}"`);
  return f;
}

describe("EXPECTED_FEATURES typed entries", () => {
  test("league is a select sourced from LEAGUE_OPTIONS", () => {
    const league = feature("league");
    expect(league.inputType).toBe("select");
    expect(league.options).toBe(LEAGUE_OPTIONS);
  });

  test("era is a select sourced from ERA_BUCKET_OPTIONS", () => {
    const era = feature("era");
    expect(era.inputType).toBe("select");
    expect(era.options).toBe(ERA_BUCKET_OPTIONS);
  });

  test("isRookie is a boolean bound to cardChecklist.isRookie, hidden at set level", () => {
    const isRookie = feature("isRookie");
    expect(isRookie.inputType).toBe("boolean");
    expect(isRookie.boundColumn).toBe("isRookie");
    expect(isRookie.hiddenAtLevels).toContain("set");
  });

  test("vintage is derived (read-only, not user-selected)", () => {
    const vintage = feature("vintage");
    expect(vintage.inputType).toBe("derived");
  });

  test("autographed is a select with exactly None/On Card/Sticker-Label", () => {
    const autographed = feature("autographed");
    expect(autographed.inputType).toBe("select");
    expect(autographed.options).toEqual(["None", "On Card", "Sticker/Label"]);
  });

  test("isReprint, isRelic, isProspect are checkboxes stored in the features map", () => {
    expect(feature("isReprint").inputType).toBe("checkbox");
    expect(feature("isRelic").inputType).toBe("checkbox");
    expect(feature("isProspect").inputType).toBe("checkbox");
  });

  test("shortPrint is a select with exactly None/SP/SSP", () => {
    const shortPrint = feature("shortPrint");
    expect(shortPrint.inputType).toBe("select");
    expect(shortPrint.options).toEqual(["None", "SP", "SSP"]);
  });

  test("season, upc, countryOfOrigin, cardSize, cardMaterial, cardThickness, language, eventTournament, conventionEvent are free text (no inputType override)", () => {
    for (const key of [
      "season",
      "upc",
      "countryOfOrigin",
      "cardSize",
      "cardMaterial",
      "cardThickness",
      "language",
      "eventTournament",
      "conventionEvent",
    ]) {
      expect(feature(key).inputType).toBeUndefined();
    }
  });

  // NEO-24 follow-up: authenticator/in-person/customized are per-physical-copy
  // facts (a factory-packaged auto needs no third-party authenticator; a
  // private in-person signing does — that varies by which copy you own, not
  // by the catalog card), so they were removed from this set/card-level list
  // in favor of the future `cardInventory` table, not brought back here.
  test("autographAuthenticator, autographAuthenticationNumber, inPersonAuto, isCustomized are not set/card-level features", () => {
    for (const key of [
      "autographAuthenticator",
      "autographAuthenticationNumber",
      "inPersonAuto",
      "isCustomized",
    ]) {
      expect(EXPECTED_FEATURES.some((f) => f.key === key)).toBe(false);
    }
  });
});
