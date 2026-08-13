/**
 * NEO-147 — the spine label sheet, as markup.
 *
 * Built as an HTML string rather than as a React tree so that the on-screen
 * preview and the printed page are LITERALLY the same markup: the preview
 * renders this into a scaled container, and printing hands the identical
 * string to `printHtmlDocument`. A React preview alongside a separate print
 * renderer would be two implementations of the same geometry, and the one you
 * cannot see on screen is the one that drifts.
 *
 * Everything is sized in inches for the same reason as `spine-formats.ts`:
 * `@page size` is in inches, so no DPI is assumed and nothing converts.
 */

import {
  PRINTABLE_HEIGHT_IN,
  PRINTABLE_WIDTH_IN,
  SHEET_MARGIN_IN,
  fitFontSizeIn,
  labelsPerSheet,
  splitHeightIntoSegments,
} from "./spine-formats";

export interface SpineLabel {
  id: string;
  name: string;
  /** Hex, `#rrggbb`. The label's background — the dominant color. */
  background: string;
  /** Hex, `#rrggbb`. The lettering. */
  text: string;
}

export interface SpineSheetOptions {
  labels: SpineLabel[];
  widthIn: number;
  heightIn: number;
  /**
   * Draw a hairline outline and corner ticks around each label.
   *
   * On by default: a label printed edge-to-edge in its team color gives you
   * nothing to cut along, and guessing costs a sheet. The line is drawn INSIDE
   * the label so it is removed by the cut rather than left on the binder.
   */
  cutMarks?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * CSS for the sheet. Kept separate from the body because `printHtmlDocument`
 * takes them separately (it owns `@page` and the print-color-adjust reset).
 */
export function spineSheetCss(options: SpineSheetOptions): string {
  const { widthIn, heightIn, cutMarks = true } = options;
  const perSheet = labelsPerSheet(widthIn);

  return `
      .sheet {
        box-sizing: border-box;
        width: ${PRINTABLE_WIDTH_IN + SHEET_MARGIN_IN * 2}in;
        height: ${PRINTABLE_HEIGHT_IN + SHEET_MARGIN_IN * 2}in;
        padding: ${SHEET_MARGIN_IN}in;
        display: flex;
        align-items: flex-start;
        gap: 0;
        /* Each sheet is its own page. The last one must not emit a trailing
           blank page, so the break is declared after every sheet but the last
           via :not(:last-child). */
        overflow: hidden;
      }
      .sheet:not(:last-child) {
        break-after: page;
        page-break-after: always;
      }
      /* The window onto one piece of a label. For a single-sheet label this is
         the whole thing; for a tiled one it clips the design to this piece's
         slice, which is what makes the two printed pieces splice into one
         continuous label rather than repeating the name twice. */
      .label {
        box-sizing: border-box;
        position: relative;
        width: ${widthIn}in;
        overflow: hidden;
        ${cutMarks ? "outline: 0.5pt dashed rgba(0, 0, 0, 0.35); outline-offset: -0.5pt;" : ""}
      }
      /* The full-height design, rendered once and shifted up per piece. */
      .label-face {
        box-sizing: border-box;
        width: 100%;
        height: ${heightIn}in;
        display: flex;
        align-items: center;
        justify-content: center;
        /* vertical-rl reads top-to-bottom with the binder upright, which is the
           US book-spine convention and how a binder sits on a shelf. */
        writing-mode: vertical-rl;
        text-orientation: mixed;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif;
        font-weight: 700;
        letter-spacing: 0.02em;
        white-space: nowrap;
      }
      /* Fills the row when fewer than a full row of labels remain, so the
         last sheet's labels stay at the left edge rather than stretching. */
      .spacer {
        width: ${PRINTABLE_WIDTH_IN - widthIn * perSheet}in;
      }`;
}

/**
 * The sheets themselves.
 *
 * Two dimensions of chunking interact here:
 *
 *  - **Across a sheet**: `labelsPerSheet(widthIn)` labels sit side by side.
 *  - **Down sheets**: a label taller than one sheet is split by
 *    `splitHeightIntoSegments`, and each segment is printed in the SAME
 *    position on consecutive sheets, so the user prints, cuts, and splices
 *    piece 1 to piece 2.
 *
 * Sheets are emitted piece by piece — every label's piece 1, then every
 * label's piece 2 — so the sheets come out of the printer in the order they
 * are cut and spliced, rather than interleaved fragments the user has to sort.
 *
 * The name is sized and centred against the FULL height once, not per piece.
 * Sizing per piece would set the name to fit a 1in offcut and centre a second
 * copy in it; the window shifts over one design instead.
 */
export function spineSheetHtml(options: SpineSheetOptions): string {
  const { labels, widthIn, heightIn } = options;
  if (labels.length === 0) return "";

  const perSheet = labelsPerSheet(widthIn);
  const segments = splitHeightIntoSegments(heightIn);

  const sheets: string[] = [];
  let offsetIn = 0;

  for (const segmentHeight of segments) {
    const pieceOffset = offsetIn;
    for (let start = 0; start < labels.length; start += perSheet) {
      const row = labels.slice(start, start + perSheet);
      const cells = row
        .map((label) => {
          const fontIn = fitFontSizeIn(label.name, widthIn, heightIn);
          return (
            `<div class="label" style="height:${segmentHeight}in;">` +
            `<div class="label-face" style="margin-top:-${pieceOffset}in;` +
            `background:${escapeHtml(label.background)};` +
            `color:${escapeHtml(label.text)};` +
            `font-size:${fontIn.toFixed(3)}in;">${escapeHtml(label.name)}</div>` +
            `</div>`
          );
        })
        .join("");
      sheets.push(`<div class="sheet">${cells}<div class="spacer"></div></div>`);
    }
    offsetIn += segmentHeight;
  }

  return sheets.join("");
}
