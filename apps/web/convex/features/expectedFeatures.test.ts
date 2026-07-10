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
});
