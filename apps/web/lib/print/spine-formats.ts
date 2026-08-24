/**
 * NEO-147 — binder spine label geometry, as data.
 *
 * Modelled on `lib/shipping/label-formats.ts`: dimensions live here as numbers
 * rather than as inline `2in`/`10.5in` literals in the layout, so a new spine
 * size is an entry plus a picker option rather than a new component.
 *
 * Inches throughout, because that is the unit CSS `@page size` and the label
 * markup both use — nothing converts and no DPI is assumed anywhere.
 *
 * ## The two numbers that drive everything
 *
 * A US Letter sheet is 8.5 × 11in, but you cannot print to its edge. Allowing
 * a quarter inch all round leaves **8.0 × 10.5in** of printable area, and both
 * of the feature's awkward constraints fall out of that:
 *
 *  - **A full-height spine label does not fit on one sheet.** A letter-size
 *    binder is about 11.5in tall and the printable height is 10.5in. Rotating
 *    does not rescue it either, since 11in of length would then have to fit
 *    across 8.5in of width. So the height is capped and true full height is
 *    offered as a two-sheet tiling instead.
 *  - **Batch printing is nearly free.** Labels are narrow and the sheet is
 *    8in wide, so a 2in spine fits four across and a 3in spine fits two. Any
 *    design that printed one label per sheet would waste most of the paper.
 */

/** US Letter, portrait. The page handed to `printHtmlDocument`. */
export const LETTER_PAGE = { widthIn: 8.5, heightIn: 11 } as const;

/**
 * Printable area inside the sheet's unprintable margin.
 *
 * 0.25in all round is the conservative common denominator across consumer
 * inkjet and laser printers. Being wrong in the generous direction here does
 * not misprint a label, it silently clips one — so this stays pessimistic.
 */
export const SHEET_MARGIN_IN = 0.25;
export const PRINTABLE_WIDTH_IN = LETTER_PAGE.widthIn - SHEET_MARGIN_IN * 2; // 8.0
export const PRINTABLE_HEIGHT_IN = LETTER_PAGE.heightIn - SHEET_MARGIN_IN * 2; // 10.5

/** Tallest single-sheet label. Equal to the printable height, by definition. */
export const MAX_LABEL_HEIGHT_IN = PRINTABLE_HEIGHT_IN;

/**
 * Height of a real letter-size binder spine, and therefore the target for a
 * "true full height" label. Exceeds `MAX_LABEL_HEIGHT_IN`, which is precisely
 * why tiling exists.
 */
export const FULL_BINDER_HEIGHT_IN = 11.5;

/** Narrowest and widest spines accepted from the free-entry field. */
export const MIN_SPINE_WIDTH_IN = 0.5;
export const MAX_SPINE_WIDTH_IN = PRINTABLE_WIDTH_IN;

/** Shortest label worth printing — below this the name will not fit legibly. */
export const MIN_LABEL_HEIGHT_IN = 2;

export interface SpinePreset {
  id: string;
  label: string;
  widthIn: number;
}

/**
 * The common binder spine widths, by ring size. Free entry covers everything
 * else — spine thickness varies by manufacturer and these are nominal.
 */
export const SPINE_PRESETS: SpinePreset[] = [
  { id: "1in", label: '1" (½–1" rings)', widthIn: 1 },
  { id: "1.5in", label: '1½"', widthIn: 1.5 },
  { id: "2in", label: '2"', widthIn: 2 },
  { id: "3in", label: '3"', widthIn: 3 },
];

export const DEFAULT_SPINE_PRESET = SPINE_PRESETS[2]; // 2in — fits 4 per sheet

/**
 * How many labels of this width fit across one sheet.
 *
 * Floor, never rounded: a partial label at the edge is a clipped label. Always
 * at least 1, so an over-wide spine still yields a printable (if edge-to-edge)
 * label rather than an empty sheet.
 */
export function labelsPerSheet(widthIn: number): number {
  if (!Number.isFinite(widthIn) || widthIn <= 0) return 1;
  return Math.max(1, Math.floor(PRINTABLE_WIDTH_IN / widthIn));
}

/**
 * Floating-point slack when comparing inch widths.
 *
 * Widths come from `0.125` steps and arithmetic on them, so `2 + 2 + 2 + 2`
 * can land a hair over `8`. Without slack that drops the fourth 2in label onto
 * a second sheet, which is both wrong and invisible until you count the pages.
 */
const WIDTH_EPSILON_IN = 1e-6;

/**
 * Pack labels into sheets, filling each row across the printable width.
 *
 * NEO-147 originally gave every label on a sheet the same width, because the
 * spine width was a property of the SHEET. It is not — it is the ring size of
 * one binder, and a collector labelling five binders has five different ones.
 * Width therefore travels with the label, and a sheet holds whatever fits.
 *
 * Greedy in input order rather than best-fit: the user is looking at a preview
 * and a list, and a packer that reordered their labels to save paper would
 * make that preview unpredictable. Saving the occasional sheet is not worth
 * "why is Nolan Ryan first now".
 *
 * A label wider than the printable area still gets its own sheet rather than
 * vanishing — clamped by the caller at entry, but never silently dropped here.
 */
export function packLabelsIntoSheets<T extends { widthIn: number }>(
  labels: T[],
): T[][] {
  const sheets: T[][] = [];
  let row: T[] = [];
  let used = 0;

  for (const label of labels) {
    const width = Math.min(Math.max(label.widthIn, 0), PRINTABLE_WIDTH_IN);
    if (row.length > 0 && used + width > PRINTABLE_WIDTH_IN + WIDTH_EPSILON_IN) {
      sheets.push(row);
      row = [];
      used = 0;
    }
    row.push(label);
    used += width;
  }
  if (row.length > 0) sheets.push(row);
  return sheets;
}

/** Unused width left on a row, for the spacer that keeps labels left-aligned. */
export function rowRemainderIn(row: Array<{ widthIn: number }>): number {
  const used = row.reduce(
    (sum, label) => sum + Math.min(Math.max(label.widthIn, 0), PRINTABLE_WIDTH_IN),
    0,
  );
  return Math.max(0, PRINTABLE_WIDTH_IN - used);
}

/**
 * Split a requested height into per-sheet segments.
 *
 * At or under the cap this is a single segment and the answer is boring. Above
 * it, the label is tiled down consecutive sheets and the user splices the
 * pieces — which is the only way to get a true full-height spine out of a
 * letter printer.
 *
 * The segments are deliberately NOT equal. The first sheet is filled to the
 * cap and the remainder goes on the last, so a 11.5in label is 10.5 + 1.0
 * rather than 5.75 + 5.75: one splice near the bottom, instead of one straight
 * through the middle of the player's name.
 */
export function splitHeightIntoSegments(heightIn: number): number[] {
  if (!Number.isFinite(heightIn) || heightIn <= 0) return [MIN_LABEL_HEIGHT_IN];
  if (heightIn <= MAX_LABEL_HEIGHT_IN) return [heightIn];

  const segments: number[] = [];
  let remaining = heightIn;
  while (remaining > MAX_LABEL_HEIGHT_IN) {
    segments.push(MAX_LABEL_HEIGHT_IN);
    remaining -= MAX_LABEL_HEIGHT_IN;
  }
  segments.push(remaining);
  return segments;
}

/**
 * Fraction of the spine's width the lettering may occupy. The remainder is
 * breathing room on both sides — lettering that touches the fold reads as a
 * misprint even when the geometry is exact.
 */
const CAP_HEIGHT_RATIO = 0.62;

/**
 * Fallback character width when no font is given, in ems.
 *
 * NEO-147 originally hardcoded this for the system sans stack, which was the
 * only choice. Every font now supplies its own MEASURED value — see
 * `spine-fonts.ts` — because the real spread is 0.346 to 0.623, and using one
 * number across that range does not merely approximate: it sets the condensed
 * faces a third too small and lets the widest one run past the label's end.
 */
const FALLBACK_CHAR_WIDTH_RATIO = 0.55;

/** Fraction of the label's length the name may run to, leaving end margins. */
const LENGTH_USAGE_RATIO = 0.9;

/**
 * Font size, in inches, for a name set down a spine of this size.
 *
 * Two independent limits, whichever binds first: the name must fit ACROSS the
 * spine (so it does not run onto the covers) and ALONG it (so a long name is
 * not clipped at the ends). "Reggie White" on a 3in spine is limited by width;
 * "Bartolo Colon" on a 1in spine is limited by length.
 */
export function fitFontSizeIn(
  name: string,
  widthIn: number,
  heightIn: number,
  charWidthRatio: number = FALLBACK_CHAR_WIDTH_RATIO,
): number {
  const trimmed = name.trim();
  const acrossLimit = widthIn * CAP_HEIGHT_RATIO;
  if (!trimmed) return acrossLimit;

  const ratio = charWidthRatio > 0 ? charWidthRatio : FALLBACK_CHAR_WIDTH_RATIO;
  const alongLimit = (heightIn * LENGTH_USAGE_RATIO) / (trimmed.length * ratio);
  return Math.min(acrossLimit, alongLimit);
}

/** Clamp a free-entry spine width to something printable. */
export function clampSpineWidth(widthIn: number): number {
  if (!Number.isFinite(widthIn)) return DEFAULT_SPINE_PRESET.widthIn;
  return Math.min(Math.max(widthIn, MIN_SPINE_WIDTH_IN), MAX_SPINE_WIDTH_IN);
}

/** Clamp a free-entry label height to something printable. */
export function clampLabelHeight(heightIn: number): number {
  if (!Number.isFinite(heightIn)) return MAX_LABEL_HEIGHT_IN;
  return Math.min(Math.max(heightIn, MIN_LABEL_HEIGHT_IN), FULL_BINDER_HEIGHT_IN);
}
