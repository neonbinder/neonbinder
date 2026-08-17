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
  packLabelsIntoSheets,
  rowRemainderIn,
  splitHeightIntoSegments,
} from "./spine-formats";
import {
  SYSTEM_SPINE_FONT,
  type SpineFont,
} from "./spine-fonts";

export interface SpineLabel {
  id: string;
  name: string;
  /** Hex, `#rrggbb`. The label's background — the dominant color. */
  background: string;
  /** Hex, `#rrggbb`. The lettering. */
  text: string;
  /**
   * Spine width in inches — the RING SIZE of this binder.
   *
   * Per label, not per sheet: a collector labelling five binders has five ring
   * sizes, and one sheet holds whatever mix fits across its 8in.
   */
  widthIn: number;
  /**
   * Typeface for THIS label. Per label for the same reason as the ring size —
   * one binder is a Packers binder and the next is a Pokémon binder, and they
   * do not want the same lettering just because they share a sheet.
   *
   * Carries the font's `charWidthRatio`, so the fitter sizes each name against
   * the face it is actually set in.
   */
  font: SpineFont;
}

export interface SpineSheetOptions {
  labels: SpineLabel[];
  /**
   * Label height, in inches. Still per SHEET rather than per label: binders
   * are all the same height, so this genuinely is a property of the paper,
   * unlike the ring size. It also keeps tiling uniform — labels taller than
   * one sheet split into the same pieces, so a row cannot end up ragged.
   */
  heightIn: number;
  /**
   * `@font-face` sources, keyed by font id — for the fonts this sheet actually
   * uses, which with a per-label typeface can be several at once.
   *
   * The PRINT document gets `data:` URIs so the iframe depends on no network
   * at all; the on-screen preview passes nothing, because the page has already
   * declared every face by URL. Either way the CSS names the same families, so
   * preview and print cannot drift onto different typefaces.
   */
  fontSrcById?: Record<string, string>;
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

/** `#rgb` or `#rrggbb`, which is the whole of what {@link SpineLabel} promises. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Used when a color fails {@link HEX_COLOR}. Legible, and obviously not a team. */
const FALLBACK_BACKGROUND = "#ffffff";
const FALLBACK_TEXT = "#000000";

/**
 * Colors are interpolated into a `style="..."` attribute, and HTML escaping is
 * NOT sufficient there. The HTML parser decodes entities in an attribute value
 * BEFORE the CSS parser ever sees it, so `&quot;` is a real quote again by the
 * time it matters — and `;` is not escaped at all. `#fff;background:url(...)`
 * would therefore inject whole CSS declarations into the printed page and the
 * preview even though nothing about it "escapes the attribute".
 *
 * An allowlist is the fix rather than more escaping: the type already says hex,
 * every caller normalizes to hex (`lib/print/contrast.ts#normalizeHexColor`),
 * so anything else is either a bug or an attack and the fallback is correct for
 * both. This keeps the guarantee at the point of interpolation instead of
 * spread across every current and future caller.
 */
function cssColor(value: string, fallback: string): string {
  const trimmed = value.trim();
  return HEX_COLOR.test(trimmed) ? trimmed : fallback;
}

/**
 * CSS for the sheet. Kept separate from the body because `printHtmlDocument`
 * takes them separately (it owns `@page` and the print-color-adjust reset).
 */
export function spineSheetCss(options: SpineSheetOptions): string {
  const { heightIn, cutMarks = true } = options;

  // One @font-face per DISTINCT font on the sheet. A sheet of five binders can
  // legitimately use five typefaces, and emitting only the first would print
  // four of them in the fallback face.
  const seen = new Set<string>();
  const faces: string[] = [];
  for (const label of options.labels) {
    const font = label.font ?? SYSTEM_SPINE_FONT;
    if (seen.has(font.id)) continue;
    seen.add(font.id);
    const src = options.fontSrcById?.[font.id];
    if (!src) continue;
    faces.push(`@font-face {
        font-family: "${font.family}";
        src: url(${src}) format("woff2");
        font-weight: 400 900;
        font-display: block;
      }
`);
  }

  return `${faces.join("")}
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
      /* No width here: each label carries its own inline, because ring size
         is a property of the binder rather than the sheet. */
      .label {
        box-sizing: border-box;
        position: relative;
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
        /* No font-family here: each label carries its own inline, because the
           typeface belongs to the binder rather than the sheet. */
        font-weight: 700;
        letter-spacing: 0.02em;
        white-space: nowrap;
      }
      /* Fills whatever a row did not use, so labels stay at the left edge
         rather than stretching. Width is inline per sheet — with mixed ring
         sizes the remainder differs from sheet to sheet. */
      .spacer {
        flex: none;
      }`;
}

/**
 * The sheets themselves.
 *
 * Two dimensions of chunking interact here:
 *
 *  - **Across a sheet**: labels are packed into rows by `packLabelsIntoSheets`
 *    until the next one would not fit the 8in printable width. Ring sizes
 *    differ per binder, so a row is "whatever fits" rather than a fixed count.
 *  - **Down sheets**: a label taller than one sheet is split by
 *    `splitHeightIntoSegments`, and each segment is printed in the SAME
 *    position on consecutive sheets, so the user prints, cuts, and splices
 *    piece 1 to piece 2.
 *
 * Sheets are emitted piece by piece — every label's piece 1, then every
 * label's piece 2 — so the sheets come out of the printer in the order they
 * are cut and spliced, rather than interleaved fragments the user has to sort.
 * The same packing is reused for every piece, so a label sits in the same
 * position on its piece-1 and piece-2 sheets.
 *
 * The name is sized and centred against the FULL height once, not per piece.
 * Sizing per piece would set the name to fit a 1in offcut and centre a second
 * copy in it; the window shifts over one design instead.
 */
export function spineSheetHtml(options: SpineSheetOptions): string {
  const { labels, heightIn } = options;
  if (labels.length === 0) return "";

  const rows = packLabelsIntoSheets(labels);
  const segments = splitHeightIntoSegments(heightIn);

  const sheets: string[] = [];
  let offsetIn = 0;

  for (const segmentHeight of segments) {
    const pieceOffset = offsetIn;
    for (const row of rows) {
      const cells = row
        .map((label) => {
          const font = label.font ?? SYSTEM_SPINE_FONT;
          const fontIn = fitFontSizeIn(
            label.name,
            label.widthIn,
            heightIn,
            font.charWidthRatio,
          );
          // SINGLE quotes around the family, not double.
          //
          // This goes into a double-quoted HTML attribute, so `font-family:"Anton"`
          // closes the `style="` attribute early and every declaration after it
          // — background, colour, font-size — is silently dropped. The label
          // renders as a white box in the default face, which is exactly what
          // it did before this comment existed. Single quotes are valid CSS
          // string delimiters and do not terminate the attribute.
          //
          // The system stack is left bare: it IS a family LIST, and quoting it
          // would look for one absurdly-named font.
          const family =
            font.id === SYSTEM_SPINE_FONT.id
              ? font.family
              : `'${font.family}', sans-serif`;
          return (
            `<div class="label" style="width:${label.widthIn}in;height:${segmentHeight}in;">` +
            `<div class="label-face" style="margin-top:-${pieceOffset}in;` +
            `font-family:${family};` +
            `background:${cssColor(label.background, FALLBACK_BACKGROUND)};` +
            `color:${cssColor(label.text, FALLBACK_TEXT)};` +
            `font-size:${fontIn.toFixed(3)}in;">${escapeHtml(label.name)}</div>` +
            `</div>`
          );
        })
        .join("");
      const spacer = `<div class="spacer" style="width:${rowRemainderIn(row)}in;"></div>`;
      sheets.push(`<div class="sheet">${cells}${spacer}</div>`);
    }
    offsetIn += segmentHeight;
  }

  return sheets.join("");
}
