/**
 * NEO-350 — the spine-label preview, as a picture.
 *
 * The preview is a picture of the printed page: the collector's own lettering
 * on the collector's own colours, at the size it will print. When they pick a
 * pair that reads poorly the page says so ("Try a lighter or darker lettering
 * color"), and the preview has to SHOW that, not correct it. So the preview
 * is an `<img>`, and its text is an image of text:
 *
 *  - WCAG 1.4.3 exempts text that is "part of a picture that contains
 *    significant other visual content". The picture is the sheet: its margins,
 *    the cut guides, the other labels queued beside this one.
 *  - WCAG 1.4.5 allows images of text where "a particular presentation of text
 *    is essential to the information being conveyed". How the name looks in
 *    these colours is the whole of what the preview conveys.
 *  - The image gets an `alt` naming what it shows, so a screen reader hears
 *    one description instead of nothing (the HTML preview was `aria-hidden`).
 *
 * axe's `color-contrast` rule measures text NODES in the DOM, including ones
 * under `aria-hidden` or `role="img"` (axe-core 4.13 `color-contrast-matches`
 * skips only inert, disabled, clipped and off-screen text), so the HTML preview
 * was measured as page copy. An image has no text nodes for it to measure.
 *
 * The markup inside the picture is still `spineSheetHtml` + `spineSheetCss`,
 * byte for byte what printing hands the printer: the preview and the print
 * stay one renderer. It is wrapped in an SVG `<foreignObject>` and loaded as a
 * `data:` URL. An SVG loaded as an image may not fetch anything, so the caller
 * passes CSS whose `@font-face` sources are already `data:` URIs (the same
 * `fontSrcById` route printing uses).
 */

import { LETTER_PAGE } from "./spine-formats";

/** CSS px per inch. `in` is defined as 96px, inside an SVG image too. */
const PX_PER_IN = 96;

export interface SpinePreviewImageOptions {
  /** `spineSheetHtml(...)`, unchanged. HTML, not XHTML; it is re-serialized here. */
  html: string;
  /** `spineSheetCss(...)`, with `fontSrcById` filled so no font needs a fetch. */
  css: string;
}

/**
 * The first page of the sheet as an SVG document (a string).
 *
 * The HTML is parsed by the HTML parser, exactly as the print iframe parses
 * it, and serialized back as XHTML so the SVG is well-formed XML. Anything the
 * HTML parser forgives (or misreads) is carried over as it would print, rather
 * than breaking the picture.
 *
 * Needs a DOM (`DOMParser`, `XMLSerializer`): it runs in the browser, beside
 * the preview it draws.
 */
export function spinePreviewSvg({ html, css }: SpinePreviewImageOptions): string {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body></body></html>`,
    "text/html",
  );
  const root = doc.createElement("div");
  const style = doc.createElement("style");
  style.textContent = css;
  root.appendChild(style);
  const content = doc.createElement("div");
  content.innerHTML = html;
  root.appendChild(content);
  const xhtml = new XMLSerializer().serializeToString(root);

  const width = LETTER_PAGE.widthIn * PX_PER_IN;
  const height = LETTER_PAGE.heightIn * PX_PER_IN;
  // The foreignObject is one page tall, so a label tiled onto a second sheet
  // shows its first piece only: "Preview shows the first page".
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject>` +
    `</svg>`
  );
}

/** {@link spinePreviewSvg} as a `data:` URL for an `<img src>`. */
export function spinePreviewImageSrc(options: SpinePreviewImageOptions): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(spinePreviewSvg(options))}`;
}

/**
 * The preview's `alt`: what the picture shows, in reading order.
 *
 * `firstPageNames` are the labels on the first page (the only page the preview
 * draws). The colours are not spelled out: a hex pair means nothing read
 * aloud, and the contrast line beside the swatches already says whether the
 * pair reads well.
 */
export function spinePreviewAlt(firstPageNames: string[]): string {
  return `Label preview: ${firstPageNames.join(", ")}`;
}
