/**
 * NEO-147 — WCAG contrast for the spine label readout.
 *
 * The reference values (21:1 for black on white, 1:1 for identical colors) are
 * the WCAG definition's endpoints, so these double as a check that the
 * luminance curve is the real one and not a linear approximation.
 */

import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  gradeContrast,
  normalizeHexColor,
  parseHexColor,
  relativeLuminance,
} from "./contrast";

describe("parseHexColor", () => {
  it("accepts six-digit hex with or without the hash", () => {
    expect(parseHexColor("#01214b")).toEqual({ r: 1, g: 33, b: 75 });
    expect(parseHexColor("01214B")).toEqual({ r: 1, g: 33, b: 75 });
  });

  it("expands three-digit hex", () => {
    expect(parseHexColor("#0a3")).toEqual({ r: 0, g: 170, b: 51 });
  });

  it("returns null for partial input rather than throwing", () => {
    // The manual-entry field accepts free text, so "#01" is a normal state
    // mid-typing, not an error.
    expect(parseHexColor("#01")).toBeNull();
    expect(parseHexColor("")).toBeNull();
    expect(parseHexColor("rebeccapurple")).toBeNull();
  });
});

describe("normalizeHexColor", () => {
  it("canonicalizes to lowercase six-digit form", () => {
    expect(normalizeHexColor("0A3")).toBe("#00aa33");
    expect(normalizeHexColor("#AB0008")).toBe("#ab0008");
  });

  it("returns null for unparseable input", () => {
    expect(normalizeHexColor("nope")).toBeNull();
  });
});

describe("relativeLuminance", () => {
  it("anchors at the WCAG endpoints", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10);
  });
});

describe("contrastRatio", () => {
  it("gives 21:1 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("gives 1:1 for a color against itself", () => {
    expect(contrastRatio("#ab0008", "#ab0008")).toBeCloseTo(1, 10);
  });

  it("is symmetric", () => {
    const a = contrastRatio("#01214b", "#ffc52f")!;
    const b = contrastRatio("#ffc52f", "#01214b")!;
    expect(a).toBeCloseTo(b, 10);
  });

  it("returns null when a color is not yet a color", () => {
    expect(contrastRatio("#ab0008", "#nope")).toBeNull();
  });

  it("scores a real low-contrast team pair as poor", () => {
    // Saitama Seibu red on navy — a genuine pairing the designer must warn
    // about without blocking.
    const ratio = contrastRatio("#ab0008", "#01214b")!;
    expect(gradeContrast(ratio)).toBe("poor");
  });

  it("scores a real high-contrast team pair well", () => {
    // Brewers navy on gold.
    const ratio = contrastRatio("#12284b", "#ffc52f")!;
    expect(gradeContrast(ratio)).toBe("excellent");
  });
});

describe("gradeContrast", () => {
  it("uses the WCAG large-text boundaries", () => {
    expect(gradeContrast(4.5)).toBe("excellent");
    expect(gradeContrast(3)).toBe("good");
    expect(gradeContrast(2.99)).toBe("poor");
  });
});
