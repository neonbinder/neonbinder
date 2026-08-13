/**
 * NEO-147 — spine label geometry.
 *
 * The numbers asserted here are the ones the ticket calls out as verifiable
 * against real paper: a 2in spine fits 4 labels per sheet and a 3in fits 2, and
 * a full-height binder spine does NOT fit on one sheet.
 */

import { describe, expect, it } from "vitest";
import {
  FULL_BINDER_HEIGHT_IN,
  MAX_LABEL_HEIGHT_IN,
  MIN_LABEL_HEIGHT_IN,
  MIN_SPINE_WIDTH_IN,
  PRINTABLE_HEIGHT_IN,
  PRINTABLE_WIDTH_IN,
  clampLabelHeight,
  clampSpineWidth,
  fitFontSizeIn,
  labelsPerSheet,
  splitHeightIntoSegments,
} from "./spine-formats";

describe("printable area", () => {
  it("is 8 × 10.5in inside a Letter sheet's unprintable margin", () => {
    expect(PRINTABLE_WIDTH_IN).toBe(8);
    expect(PRINTABLE_HEIGHT_IN).toBe(10.5);
  });

  it("caps a single-sheet label below a real binder's spine height", () => {
    // This inequality is the entire reason tiling exists. If it ever stops
    // holding, the two-piece path is dead code.
    expect(MAX_LABEL_HEIGHT_IN).toBeLessThan(FULL_BINDER_HEIGHT_IN);
  });
});

describe("labelsPerSheet", () => {
  it("matches the counts worked out on paper", () => {
    expect(labelsPerSheet(2)).toBe(4);
    expect(labelsPerSheet(3)).toBe(2);
    expect(labelsPerSheet(1)).toBe(8);
    expect(labelsPerSheet(1.5)).toBe(5);
  });

  it("floors rather than rounds — a partial label is a clipped label", () => {
    // 8 / 2.5 = 3.2. Rounding would promise 3 full labels and print a sliver.
    expect(labelsPerSheet(2.5)).toBe(3);
  });

  it("never returns zero for an over-wide or nonsense spine", () => {
    expect(labelsPerSheet(12)).toBe(1);
    expect(labelsPerSheet(0)).toBe(1);
    expect(labelsPerSheet(Number.NaN)).toBe(1);
  });
});

describe("splitHeightIntoSegments", () => {
  it("leaves a label that fits on one sheet alone", () => {
    expect(splitHeightIntoSegments(10.5)).toEqual([10.5]);
    expect(splitHeightIntoSegments(4)).toEqual([4]);
  });

  it("fills the first sheet and puts the remainder on the last", () => {
    // Deliberately unequal: 10.5 + 1.0, not 5.75 + 5.75, so the splice lands
    // near the bottom instead of through the middle of the name.
    const segments = splitHeightIntoSegments(FULL_BINDER_HEIGHT_IN);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toBe(10.5);
    expect(segments[1]).toBeCloseTo(1, 5);
  });

  it("segments always sum to the requested height", () => {
    for (const height of [3, 10.5, 11.5, 21, 25.25]) {
      const total = splitHeightIntoSegments(height).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(height, 5);
    }
  });
});

describe("clamping", () => {
  it("keeps a free-entry width printable", () => {
    expect(clampSpineWidth(0.1)).toBe(MIN_SPINE_WIDTH_IN);
    expect(clampSpineWidth(99)).toBe(PRINTABLE_WIDTH_IN);
    expect(clampSpineWidth(2)).toBe(2);
  });

  it("falls back rather than propagating NaN from an emptied number field", () => {
    expect(Number.isFinite(clampSpineWidth(Number.NaN))).toBe(true);
    expect(Number.isFinite(clampLabelHeight(Number.NaN))).toBe(true);
  });

  it("allows a height up to a full binder spine, for tiling", () => {
    expect(clampLabelHeight(FULL_BINDER_HEIGHT_IN)).toBe(FULL_BINDER_HEIGHT_IN);
    expect(clampLabelHeight(1)).toBe(MIN_LABEL_HEIGHT_IN);
    expect(clampLabelHeight(50)).toBe(FULL_BINDER_HEIGHT_IN);
  });
});

describe("fitFontSizeIn", () => {
  it("is limited by the spine's width for a short name", () => {
    // "Reggie White" on a 3in spine has length to spare; the constraint is not
    // running the lettering onto the covers.
    const size = fitFontSizeIn("Reggie White", 3, 10.5);
    expect(size).toBeLessThan(3);
    expect(size).toBeGreaterThan(1);
  });

  it("shrinks a long name on a narrow spine so it is not clipped", () => {
    const short = fitFontSizeIn("Cal Ripken Jr.", 1, 4);
    const long = fitFontSizeIn(
      "Bartolomeo Colon Extremely Long Name Indeed",
      1,
      4,
    );
    expect(long).toBeLessThan(short);
  });

  it("keeps a name inside the label's length", () => {
    const name = "Ken Griffey Jr.";
    const heightIn = 6;
    const size = fitFontSizeIn(name, 2, heightIn);
    // Same approximation the function uses, asserted as a bound rather than an
    // exact value: whatever the ratios are, the name must not exceed the label.
    expect(size * name.length * 0.55).toBeLessThanOrEqual(heightIn);
  });

  it("returns a usable size for an empty name", () => {
    expect(fitFontSizeIn("", 2, 10.5)).toBeGreaterThan(0);
  });
});
