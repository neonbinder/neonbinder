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

const label = (name: string, widthIn = 2, id = name): SpineLabel => ({
  id,
  name,
  background: "#12284b",
  text: "#ffc52f",
  widthIn,
});

const countSheets = (html: string) =>
  (html.match(/class="sheet"/g) ?? []).length;
const countLabels = (html: string) => (html.match(/class="label"/g) ?? []).length;

describe("spineSheetHtml — layout", () => {
  it("renders nothing for an empty sheet", () => {
    expect(spineSheetHtml({ labels: [], heightIn: 10.5 })).toBe("");
  });

  it("puts four 2in labels on one sheet", () => {
    const labels = ["A", "B", "C", "D"].map((n) => label(n, 2));
    const html = spineSheetHtml({ labels, heightIn: 10.5 });
    expect(countSheets(html)).toBe(1);
    expect(countLabels(html)).toBe(4);
  });

  it("overflows onto a second sheet past the per-sheet count", () => {
    const labels = ["A", "B", "C", "D", "E"].map((n) => label(n, 2));
    const html = spineSheetHtml({ labels, heightIn: 10.5 });
    expect(countSheets(html)).toBe(2);
    expect(countLabels(html)).toBe(5);
  });

  it("puts two 3in labels on one sheet", () => {
    const labels = ["A", "B"].map((n) => label(n, 3));
    const html = spineSheetHtml({ labels, heightIn: 10.5 });
    expect(countSheets(html)).toBe(1);
  });
});

describe("spineSheetHtml — tiling", () => {
  it("renders one piece for a label that fits", () => {
    const html = spineSheetHtml({
      labels: [label("Reggie White", 2)],
      heightIn: MAX_LABEL_HEIGHT_IN,
    });
    expect(countSheets(html)).toBe(1);
    // Nothing is shifted, because there is only one window.
    expect(html).toContain("margin-top:-0in");
  });

  it("prints a full-height label as two spliceable pieces", () => {
    const html = spineSheetHtml({
      labels: [label("Reggie White", 2)],
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
      labels: [label("Reggie White", 2)],
      heightIn: FULL_BINDER_HEIGHT_IN,
    });
    expect((html.match(/Reggie White/g) ?? []).length).toBe(2);
  });

  it("sizes the name against the full height, not the piece", () => {
    // Otherwise the fragment on the second sheet would be set in a size chosen
    // to fit a 1in offcut.
    const tiled = spineSheetHtml({
      labels: [label("Reggie White", 2)],
      heightIn: FULL_BINDER_HEIGHT_IN,
    });
    const sizes = [...tiled.matchAll(/font-size:([\d.]+)in/g)].map((m) => m[1]);
    expect(new Set(sizes).size).toBe(1);
  });

  it("groups every label's piece 1 before any label's piece 2", () => {
    const labels = ["Aaa", "Bbb"].map((n) => label(n, 4));
    const html = spineSheetHtml({
      labels,
      heightIn: FULL_BINDER_HEIGHT_IN,
    });
    // 2 labels at 4in wide = 2 per sheet, times 2 pieces = 2 sheets.
    expect(countSheets(html)).toBe(2);
    const firstSheet = html.slice(0, html.indexOf('<div class="sheet">', 1));
    expect(firstSheet).toContain("margin-top:-0in");
    expect(firstSheet).not.toContain(`margin-top:-${MAX_LABEL_HEIGHT_IN}in`);
  });
});

describe("spineSheetHtml — mixed ring sizes", () => {
  // Ring size belongs to the binder, so one sheet holds whatever fits across
  // its 8in printable width rather than a fixed count of equal labels.

  it("puts each label's own width on it", () => {
    const html = spineSheetHtml({
      labels: [label("Narrow", 1), label("Wide", 3)],
      heightIn: 10.5,
    });
    expect(html).toContain("width:1in");
    expect(html).toContain("width:3in");
  });

  it("fills a sheet with any mix totalling the printable width", () => {
    // 3 + 3 + 2 = 8in exactly.
    const html = spineSheetHtml({
      labels: [label("A", 3), label("B", 3), label("C", 2)],
      heightIn: 10.5,
    });
    expect(countSheets(html)).toBe(1);
  });

  it("starts a new sheet when the next label would not fit", () => {
    // 3 + 3 = 6in, and a third 3in would be 9in.
    const html = spineSheetHtml({
      labels: [label("A", 3), label("B", 3), label("C", 3)],
      heightIn: 10.5,
    });
    expect(countSheets(html)).toBe(2);
  });

  it("does not spill a full row over floating-point slack", () => {
    // 2 + 2 + 2 + 2 can exceed 8 by a rounding hair; without slack the fourth
    // label lands on a second sheet and nothing on screen explains why.
    const html = spineSheetHtml({
      labels: ["A", "B", "C", "D"].map((n) => label(n, 8 / 4)),
      heightIn: 10.5,
    });
    expect(countSheets(html)).toBe(1);
  });

  it("keeps the labels in the order they were added", () => {
    // A packer that reordered to save paper would make the preview
    // unpredictable — worth more than the occasional saved sheet.
    const html = spineSheetHtml({
      labels: [label("First", 3), label("Second", 1), label("Third", 3)],
      heightIn: 10.5,
    });
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
    expect(html.indexOf("Second")).toBeLessThan(html.indexOf("Third"));
  });

  it("spaces out the width a row did not use", () => {
    // 3 + 2 = 5in used, so 3in of spacer keeps them left-aligned.
    const html = spineSheetHtml({
      labels: [label("A", 3), label("B", 2)],
      heightIn: 10.5,
    });
    expect(html).toContain('class="spacer" style="width:3in;"');
  });

  it("gives an over-wide label its own sheet rather than dropping it", () => {
    const html = spineSheetHtml({
      labels: [label("Huge", 20), label("Normal", 2)],
      heightIn: 10.5,
    });
    expect(countSheets(html)).toBe(2);
    expect(html).toContain("Huge");
    expect(html).toContain("Normal");
  });

  it("sizes each name against ITS OWN width", () => {
    // A 1in label and a 3in label must not share a font size.
    const html = spineSheetHtml({
      labels: [label("Same Name", 1, "a"), label("Same Name", 3, "b")],
      heightIn: 10.5,
    });
    const sizes = [...html.matchAll(/font-size:([\d.]+)in/g)].map((m) => m[1]);
    expect(new Set(sizes).size).toBe(2);
  });
});

describe("spineSheetHtml — escaping", () => {
  it("escapes a name that contains markup", () => {
    const html = spineSheetHtml({
      labels: [{ ...label("x", 2), name: '<img src=x onerror="alert(1)">' }],
      heightIn: 10.5,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes colors, which reach an inline style attribute", () => {
    const html = spineSheetHtml({
      labels: [{ ...label("x", 2), background: '#fff";evil:"' }],
      heightIn: 10.5,
    });
    expect(html).not.toContain('";evil:"');
  });

  it("drops a non-hex color rather than emitting it into the style attribute", () => {
    // Escaping alone is not enough in a `style="..."` attribute: the HTML
    // parser decodes `&quot;` back to a quote before the CSS parser sees the
    // value, and `;` is never escaped — so an escaped-but-unvalidated color
    // still injects whole CSS declarations. The value has to be rejected, not
    // just escaped.
    const html = spineSheetHtml({
      labels: [
        { ...label("x", 2), background: "#fff;background:url(https://evil.test/)" },
      ],
      heightIn: 10.5,
    });
    expect(html).not.toContain("evil.test");
    expect(html).not.toContain("url(");
    expect(html).toContain("background:#ffffff;");
  });
});

describe("spineSheetCss", () => {
  it("breaks between sheets but not after the last one", () => {
    const css = spineSheetCss({ labels: [], heightIn: 10.5 });
    // A trailing break emits a blank final page on every print.
    expect(css).toContain(".sheet:not(:last-child)");
    expect(css).toContain("break-after: page");
  });

  it("does NOT set a label width — ring size is per label, not per sheet", () => {
    // A sheet can hold a 1in and a 3in binder's labels side by side, so width
    // is inline on each label rather than a rule they all share.
    const css = spineSheetCss({ labels: [], heightIn: 10.5 });
    expect(css).not.toMatch(/\.label \{[^}]*width:/);
  });

  it("can omit cut marks", () => {
    const withMarks = spineSheetCss({ labels: [], heightIn: 10.5 });
    const without = spineSheetCss({
      labels: [],
      heightIn: 10.5,
      cutMarks: false,
    });
    expect(withMarks).toContain("dashed");
    expect(without).not.toContain("dashed");
  });

  it("draws cut marks inside the label so cutting removes them", () => {
    const css = spineSheetCss({ labels: [], heightIn: 10.5 });
    expect(css).toContain("outline-offset: -0.5pt");
  });
});
