/**
 * @vitest-environment happy-dom
 *
 * The docblock is load-bearing: `lib/**\/*.test.ts` runs in `node` unless a
 * file asks for a DOM, and `spinePreviewSvg` re-serializes the sheet's HTML
 * with the browser's own `DOMParser` / `XMLSerializer`.
 *
 * NEO-350 — the spine-label preview as a picture. What is pinned: the picture
 * carries the print sheet's markup and CSS unchanged (one renderer for preview
 * and print), it is one letter page in CSS px, the name survives escaping, and
 * the alt names what the first page shows.
 */

import { describe, expect, it } from "vitest";
import { spineSheetCss, spineSheetHtml, type SpineLabel } from "./spine-label-html";
import { SYSTEM_SPINE_FONT, spineFontById } from "./spine-fonts";
import { spinePreviewAlt, spinePreviewImageSrc, spinePreviewSvg } from "./spine-preview-image";

function label(name: string, overrides: Partial<SpineLabel> = {}): SpineLabel {
  return {
    id: name,
    name,
    background: "#ffff00",
    text: "#ffffff",
    widthIn: 1.5,
    font: spineFontById("anton"),
    ...overrides,
  };
}

function sheet(labels: SpineLabel[]) {
  const options = { labels, heightIn: 10.5, fontSrcById: { anton: "data:font/woff2;base64,AAAA" } };
  return { html: spineSheetHtml(options), css: spineSheetCss(options) };
}

describe("spinePreviewSvg", () => {
  it("is one letter page, 8.5in x 11in at 96px to the inch", () => {
    const svg = spinePreviewSvg(sheet([label("Yellow PC")]));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="816" height="1056" viewBox="0 0 816 1056">/);
    expect(svg).toContain(`<foreignObject x="0" y="0" width="816" height="1056">`);
  });

  it("carries the print sheet's CSS and markup, as XHTML", () => {
    const { html, css } = sheet([label("Yellow PC")]);
    const svg = spinePreviewSvg({ html, css });
    expect(svg).toContain(`xmlns="http://www.w3.org/1999/xhtml"`);
    // The CSS is the print CSS, embedded font and all.
    expect(svg).toContain("src: url(data:font/woff2;base64,AAAA)");
    expect(svg).toContain(".label-face {");
    // The collector's colours, exactly as they print.
    expect(svg).toContain("background:#ffff00;color:#ffffff;");
    expect(svg).toContain(">Yellow PC</div>");
  });

  it("keeps a name with markup characters as text, well-formed", () => {
    const svg = spinePreviewSvg(sheet([label(`Tom & Jerry <"PC">`)]));
    expect(svg).toContain(">Tom &amp; Jerry &lt;\"PC\"&gt;</div>");
    expect(svg).not.toContain("<\"PC\">");
  });

  it("draws a System sans label with its colours (the stack's quotes stay inside the style)", () => {
    const svg = spinePreviewSvg(sheet([label("Sys", { font: SYSTEM_SPINE_FONT })]));
    const face = svg.match(/<div class="label-face" style="([^"]*)">Sys<\/div>/);
    expect(face).not.toBeNull();
    expect(face?.[1]).toContain("background:#ffff00;color:#ffffff;");
  });
});

describe("spinePreviewImageSrc", () => {
  it("is the SVG as a UTF-8 data URL", () => {
    const options = sheet([label("Pokémon")]);
    const src = spinePreviewImageSrc(options);
    const prefix = "data:image/svg+xml;charset=utf-8,";
    expect(src.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(src.slice(prefix.length))).toBe(spinePreviewSvg(options));
  });
});

describe("spinePreviewAlt", () => {
  it("names the labels on the page, in order", () => {
    expect(spinePreviewAlt(["Yellow PC"])).toBe("Label preview: Yellow PC");
    expect(spinePreviewAlt(["Packers PC", "Brewers PC"])).toBe("Label preview: Packers PC, Brewers PC");
  });
});
