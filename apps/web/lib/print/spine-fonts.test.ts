/**
 * NEO-147 — the spine label typefaces.
 *
 * The `charWidthRatio` cases are the ones that matter. They are measured from
 * each font's own metrics, and the fitter uses them to decide how large a name
 * can be set — so a wrong one is not a cosmetic issue, it either wastes half
 * the label or runs the name off the end of it.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPINE_FONT_ID,
  SPINE_FONTS,
  SYSTEM_SPINE_FONT,
  spineFontById,
  spineFontUrl,
} from "./spine-fonts";
import { fitFontSizeIn } from "./spine-formats";

describe("the font list", () => {
  it("has a unique id and family per font", () => {
    expect(new Set(SPINE_FONTS.map((f) => f.id)).size).toBe(SPINE_FONTS.length);
    expect(new Set(SPINE_FONTS.map((f) => f.family)).size).toBe(
      SPINE_FONTS.length,
    );
  });

  it("defaults to Anton", () => {
    // The most condensed athletic face that still reads as lettering, so it
    // prints long names largest — the constraint that bites on a 1in spine.
    expect(DEFAULT_SPINE_FONT_ID).toBe("anton");
    expect(spineFontById(DEFAULT_SPINE_FONT_ID).label).toBe("Anton");
  });

  it("gives every downloadable font a file, and the system stack none", () => {
    for (const font of SPINE_FONTS) {
      if (font.id === SYSTEM_SPINE_FONT.id) {
        expect(font.file).toBe("");
        expect(spineFontUrl(font)).toBe("");
      } else {
        expect(font.file).toMatch(/\.woff2$/);
        expect(spineFontUrl(font)).toBe(`/fonts/${font.file}`);
      }
    }
  });

  it("carries a plausible measured width for every font", () => {
    // Measured from hmtx over sample name text. Anything outside this range is
    // a transcription error, not a real typeface.
    for (const font of SPINE_FONTS) {
      expect(font.charWidthRatio).toBeGreaterThan(0.2);
      expect(font.charWidthRatio).toBeLessThan(0.9);
    }
  });

  it("falls back to the system stack for an unknown id", () => {
    // A stale font id in saved state must not blank the label.
    expect(spineFontById("no-such-font")).toBe(SYSTEM_SPINE_FONT);
  });

  it("keeps the condensed faces genuinely narrower than the round ones", () => {
    const anton = spineFontById("anton").charWidthRatio;
    const bigShoulders = spineFontById("big-shoulders").charWidthRatio;
    const bungee = spineFontById("bungee").charWidthRatio;
    const titan = spineFontById("titan-one").charWidthRatio;

    expect(bigShoulders).toBeLessThan(anton);
    expect(anton).toBeLessThan(titan);
    expect(titan).toBeLessThan(bungee);
  });
});

describe("font width feeding the fitter", () => {
  const NAME = "Ken Griffey Jr.";

  it("sets the same name larger in a condensed face", () => {
    // The whole reason the ratio is per font. Deliberately a LENGTH-bound case
    // — a long name on a short label. When the spine's width is what binds
    // instead, every font hits the same cap and the ratio is irrelevant, which
    // is exactly what an earlier version of this test accidentally measured.
    const longName = "Bartolo Colon Extremely Long";
    const narrow = fitFontSizeIn(longName, 3, 3, spineFontById("big-shoulders").charWidthRatio);
    const wide = fitFontSizeIn(longName, 3, 3, spineFontById("bungee").charWidthRatio);
    expect(narrow).toBeGreaterThan(wide);
    // Nearly the full ratio difference, since neither is width-capped here.
    expect(narrow / wide).toBeCloseTo(0.623 / 0.346, 1);
  });

  it("keeps a name inside the label in EVERY font", () => {
    // The failure this prevents: a face wider than the fitter assumed runs the
    // name past the end of the label, and you only find out on paper.
    const heightIn = 10.5;
    for (const font of SPINE_FONTS) {
      const size = fitFontSizeIn(NAME, 2, heightIn, font.charWidthRatio);
      const estimatedLength = size * NAME.length * font.charWidthRatio;
      expect(estimatedLength).toBeLessThanOrEqual(heightIn);
    }
  });

  it("still works with no font given", () => {
    // Callers that predate the picker fall back rather than dividing by zero.
    expect(fitFontSizeIn(NAME, 2, 10.5)).toBeGreaterThan(0);
    expect(fitFontSizeIn(NAME, 2, 10.5, 0)).toBeGreaterThan(0);
  });
});
