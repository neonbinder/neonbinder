/**
 * NEO-216 — the "serves this level" table, enumerated.
 *
 * The bug: the Manufacturers column reported "BuySportsCards could not be
 * reached, so nothing from BuySportsCards was changed…" after every healthy
 * sync, because BSC has no manufacturer level and the aggregator filed that
 * answer under `platformErrors`. The fix is a single table both callers and
 * both adapters read; these tests are what stop it drifting away from the
 * adapters it describes.
 *
 * Every (platform, level) pair is pinned EXPLICITLY rather than derived, so a
 * change to either adapter's capability has to be made here deliberately and
 * shows up as a diff on a named expectation.
 */

import { describe, expect, test } from "vitest";
import {
  PLATFORM_LEVEL_SUPPORT,
  PLATFORM_SIDES_ORDERED,
  SELECTOR_LEVELS,
  platformServesLevel,
  platformsServingLevel,
  unsupportedLevelMessage,
  type SelectorLevel,
} from "./platformLevels";
import { LEVEL_TO_BSC_FACET } from "./bscFacets";

/**
 * The whole table, written out. Read against the adapters:
 *   BSC — convex/bscFacets.ts `LEVEL_TO_BSC_FACET`
 *   SL  — convex/adapters/sportlots.ts `LEVEL_TO_TARGET_SELECT` + the `insert`
 *         branch that reads SL's flat dealsets.tpl set list.
 */
const EXPECTED: Array<[SelectorLevel, { bsc: boolean; sportlots: boolean }]> = [
  ["sport", { bsc: true, sportlots: true }],
  ["year", { bsc: true, sportlots: true }],
  // THE BUG. BSC has no manufacturer axis at all.
  ["manufacturer", { bsc: false, sportlots: true }],
  // NB's own split, filled from BSC; SportLots does not model it.
  ["setName", { bsc: true, sportlots: false }],
  ["variantType", { bsc: true, sportlots: false }],
  ["insert", { bsc: true, sportlots: true }],
  // Neither marketplace has a sub-variant level.
  ["parallel", { bsc: false, sportlots: false }],
];

describe("PLATFORM_LEVEL_SUPPORT — every (platform, level) pair", () => {
  test.each(EXPECTED)("%s", (level, expected) => {
    expect(platformServesLevel("bsc", level)).toBe(expected.bsc);
    expect(platformServesLevel("sportlots", level)).toBe(expected.sportlots);
  });

  test("covers every level in the hierarchy and nothing else", () => {
    expect([...SELECTOR_LEVELS]).toEqual(EXPECTED.map(([level]) => level));
    for (const side of PLATFORM_SIDES_ORDERED) {
      expect(Object.keys(PLATFORM_LEVEL_SUPPORT[side]).sort()).toEqual(
        [...SELECTOR_LEVELS].sort(),
      );
    }
  });

  test("the level list matches the schema's selector-level union", async () => {
    // Guards the one thing the explicit table above cannot: a NEW level added
    // to the schema and never given an answer for either platform. Reading the
    // union's members is a convex-values detail, so it lives here rather than
    // in the module.
    const { selectorOptionLevelValidator } = await import("./schema");
    const members = (
      selectorOptionLevelValidator as unknown as {
        members: Array<{ value: string }>;
      }
    ).members.map((m) => m.value);
    expect([...members].sort()).toEqual([...SELECTOR_LEVELS].sort());
  });

  test("the BSC half is exactly LEVEL_TO_BSC_FACET's coverage", () => {
    // The adapter still consults `LEVEL_TO_BSC_FACET` as defence in depth. If
    // these two ever disagreed, a request would be planned for a facet that
    // does not exist (or skipped for one that does).
    for (const level of SELECTOR_LEVELS) {
      expect(platformServesLevel("bsc", level)).toBe(
        LEVEL_TO_BSC_FACET[level] !== undefined,
      );
    }
  });

  test("an unrecognised level is served by nobody", () => {
    // The adapters take `level: v.string()`, so this is reachable.
    expect(platformServesLevel("bsc", "sprocket")).toBe(false);
    expect(platformServesLevel("sportlots", "sprocket")).toBe(false);
    expect(platformsServingLevel("sprocket")).toEqual([]);
  });

  test("platformsServingLevel returns BSC first, and both when both serve", () => {
    expect(platformsServingLevel("sport")).toEqual(["bsc", "sportlots"]);
    expect(platformsServingLevel("manufacturer")).toEqual(["sportlots"]);
    expect(platformsServingLevel("variantType")).toEqual(["bsc"]);
    expect(platformsServingLevel("parallel")).toEqual([]);
  });

  test("the unsupported-level message carries no marketplace response text", () => {
    // It is built from our own strings plus the caller's own level name — the
    // same rule `partialSyncMessage` follows, for the same reason.
    expect(unsupportedLevelMessage("bsc", "manufacturer")).toBe(
      "BuySportsCards has no manufacturer level — nothing to fetch.",
    );
    expect(unsupportedLevelMessage("sportlots", "variantType")).toBe(
      "SportLots has no variantType level — nothing to fetch.",
    );
  });
});
