/**
 * NEO-147 — the spine sheet markup.
 *
 * This is the single renderer behind both the on-screen preview and the
 * printed page, so a bug here is a bug in something the user cannot inspect
 * until it comes out of the printer.
 */

import { describe, expect, it } from "vitest";
import { spineSheetCss, spineSheetHtml, type SpineLabel } from "./spine-label-html";
import { FULL_BINDER_HEIGHT_IN, MAX_LABEL_HEIGHT_IN } from "./spine-formats";

const label = (name: string, id = name): SpineLabel => ({
  id,
  name,
  background: "#12284b",
  text: "#ffc52f",
});

const countSheets = (html: string) =>
  (html.match(/class="sheet"/g) ?? []).length;
const countLabels = (html: string) => (html.match(/class="label"/g) ?? []).length;

describe("spineSheetHtml — layout", () => {
  it("renders nothing for an empty sheet", () => {
    expect(spineSheetHtml({ labels: [], widthIn: 2, heightIn: 10.5 })).toBe("");
  });

  it("puts four 2in labels on one sheet", () => {
    const labels = ["A", "B", "C", "D"].map((n) => label(n));
    const html = spineSheetHtml({ labels, widthIn: 2, heightIn: 10.5 });
    expect(countSheets(html)).toBe(1);
    expect(countLabels(html)).toBe(4);
  });

  it("overflows onto a second sheet past the per-sheet count", () => {
    const labels = ["A", "B", "C", "D", "E"].map((n) => label(n));
    const html = spineSheetHtml({ labels, widthIn: 2, heightIn: 10.5 });
    expect(countSheets(html)).toBe(2);
    expect(countLabels(html)).toBe(5);
  });

  it("puts two 3in labels on one sheet", () => {
    const labels = ["A", "B"].map((n) => label(n));
    const html = spineSheetHtml({ labels, widthIn: 3, heightIn: 10.5 });
    expect(countSheets(html)).toBe(1);
  });
});

describe("spineSheetHtml — tiling", () => {
  it("renders one piece for a label that fits", () => {
    const html = spineSheetHtml({
      labels: [label("Reggie White")],
      widthIn: 2,
      heightIn: MAX_LABEL_HEIGHT_IN,
    });
    expect(countSheets(html)).toBe(1);
    // Nothing is shifted, because there is only one window.
    expect(html).toContain("margin-top:-0in");
  });

  it("prints a full-height label as two spliceable pieces", () => {
    const html = spineSheetHtml({
      labels: [label("Reggie White")],
      widthIn: 2,
      heightIn: FULL_BINDER_HEIGHT_IN,
    });

    expect(countSheets(html)).toBe(2);
    // The second piece is a WINDOW onto the same design, shifted by the height
    // of the first — not a second copy of the name centred in an offcut.
    expect(html).toContain("margin-top:-0in");
    expect(html).toContain(`margin-top:-${MAX_LABEL_HEIGHT_IN}in`);
  });

  it("names the player once per piece, never twice on one piece", () => {
    const html = spineSheetHtml({
      labels: [label("Reggie White")],
      widthIn: 2,
      heightIn: FULL_BINDER_HEIGHT_IN,
    });
    expect((html.match(/Reggie White/g) ?? []).length).toBe(2);
  });

  it("sizes the name against the full height, not the piece", () => {
    // Otherwise the fragment on the second sheet would be set in a size chosen
    // to fit a 1in offcut.
    const tiled = spineSheetHtml({
      labels: [label("Reggie White")],
      widthIn: 2,
      heightIn: FULL_BINDER_HEIGHT_IN,
    });
    const sizes = [...tiled.matchAll(/font-size:([\d.]+)in/g)].map((m) => m[1]);
    expect(new Set(sizes).size).toBe(1);
  });

  it("groups every label's piece 1 before any label's piece 2", () => {
    const labels = ["Aaa", "Bbb"].map((n) => label(n));
    const html = spineSheetHtml({
      labels,
      widthIn: 4,
      heightIn: FULL_BINDER_HEIGHT_IN,
    });
    // 2 labels at 4in wide = 2 per sheet, times 2 pieces = 2 sheets.
    expect(countSheets(html)).toBe(2);
    const firstSheet = html.slice(0, html.indexOf('<div class="sheet">', 1));
    expect(firstSheet).toContain("margin-top:-0in");
    expect(firstSheet).not.toContain(`margin-top:-${MAX_LABEL_HEIGHT_IN}in`);
  });
});

describe("spineSheetHtml — escaping", () => {
  it("escapes a name that contains markup", () => {
    const html = spineSheetHtml({
      labels: [{ ...label("x"), name: '<img src=x onerror="alert(1)">' }],
      widthIn: 2,
      heightIn: 10.5,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes colors, which reach an inline style attribute", () => {
    const html = spineSheetHtml({
      labels: [{ ...label("x"), background: '#fff";evil:"' }],
      widthIn: 2,
      heightIn: 10.5,
    });
    expect(html).not.toContain('";evil:"');
  });
});

describe("spineSheetCss", () => {
  it("breaks between sheets but not after the last one", () => {
    const css = spineSheetCss({ labels: [], widthIn: 2, heightIn: 10.5 });
    // A trailing break emits a blank final page on every print.
    expect(css).toContain(".sheet:not(:last-child)");
    expect(css).toContain("break-after: page");
  });

  it("sets the spine width on the label", () => {
    const css = spineSheetCss({ labels: [], widthIn: 1.5, heightIn: 10.5 });
    expect(css).toContain("width: 1.5in");
  });

  it("reserves the leftover row width so labels stay left-aligned", () => {
    // 8in printable, 3in labels, 2 per sheet → 2in of spacer.
    const css = spineSheetCss({ labels: [], widthIn: 3, heightIn: 10.5 });
    expect(css).toContain("width: 2in");
  });

  it("can omit cut marks", () => {
    const withMarks = spineSheetCss({ labels: [], widthIn: 2, heightIn: 10.5 });
    const without = spineSheetCss({
      labels: [],
      widthIn: 2,
      heightIn: 10.5,
      cutMarks: false,
    });
    expect(withMarks).toContain("dashed");
    expect(without).not.toContain("dashed");
  });

  it("draws cut marks inside the label so cutting removes them", () => {
    const css = spineSheetCss({ labels: [], widthIn: 2, heightIn: 10.5 });
    expect(css).toContain("outline-offset: -0.5pt");
  });
});
