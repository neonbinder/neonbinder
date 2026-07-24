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

  test("vintage is an editable checkbox toggle, not a read-only derived display", () => {
    // NEO-71-74 redesign: the "derived" inputType (a read-only <span>) was
    // deleted from the ExpectedFeature type entirely — vintage was its only
    // user. It's still auto-populated at creation time from the year's era
    // bucket, but now renders as an actual toggle pill so an operator can
    // correct the odd edge case (e.g. a reprint/throwback set) per-node.
    const vintage = feature("vintage");
    expect(vintage.inputType).toBe("checkbox");
  });

  test("isCaseHit is a new checkbox toggle, same pattern as isReprint/isProspect/isRelic", () => {
    const isCaseHit = feature("isCaseHit");
    expect(isCaseHit.inputType).toBe("checkbox");
  });

  test("manufacturer, cardType, and set-level parallelName have been removed entirely", () => {
    // Confirmed-redundant: manufacturer duplicates the panel's own
    // breadcrumb, cardType just restates the breadcrumb's leaf level, and
    // set-level parallelName is never actually populated by the derivation
    // code for insert/parallel levels (the real per-card variation comes
    // from that card's own cardVariation field). Removed rather than hidden.
    for (const key of ["manufacturer", "cardType", "parallelName"]) {
      expect(EXPECTED_FEATURES.find((f) => f.key === key)).toBeUndefined();
    }
  });

  test("block and upc have been removed entirely (case/box-level facts, not set- or card-level ones)", () => {
    for (const key of ["block", "upc"]) {
      expect(EXPECTED_FEATURES.find((f) => f.key === key)).toBeUndefined();
    }
  });

  test("autographed is a toggleOptions control with exactly None/On Card/Sticker-Label, displayed as None/Auto (On Card)/Auto (Sticker)", () => {
    const autographed = feature("autographed");
    expect(autographed.inputType).toBe("toggleOptions");
    expect(autographed.options).toEqual(["None", "On Card", "Sticker/Label"]);
    // toggleLabels overrides the pill button TEXT only — the stored value
    // (options[1]/[2], "On Card"/"Sticker/Label") is unchanged. The "Auto"
    // prefix makes the pills unambiguous sitting in the shared toggle row
    // alongside unrelated toggles like Reprint/Case Hit.
    expect(autographed.toggleLabels).toEqual([
      "None",
      "Auto (On Card)",
      "Auto (Sticker)",
    ]);
  });

  test("isReprint, isRelic, isProspect are checkboxes stored in the features map", () => {
    expect(feature("isReprint").inputType).toBe("checkbox");
    expect(feature("isRelic").inputType).toBe("checkbox");
    expect(feature("isProspect").inputType).toBe("checkbox");
  });

  test("shortPrint is a toggleOptions control with exactly None/SP/SSP, no toggleLabels override needed", () => {
    const shortPrint = feature("shortPrint");
    expect(shortPrint.inputType).toBe("toggleOptions");
    expect(shortPrint.options).toEqual(["None", "SP", "SSP"]);
    expect(shortPrint.toggleLabels).toBeUndefined();
  });

  test("season, countryOfOrigin, cardSize, cardMaterial, cardThickness, language, eventTournament, conventionEvent are free text (no inputType override)", () => {
    for (const key of [
      "season",
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
