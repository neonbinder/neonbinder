/**
 * NEO-157 — printable placeholder-sheet geometry, as data.
 *
 * Deliberately the same shape as `lib/shipping/label-formats.ts`: an interface,
 * one constant per physical format, and a `DEFAULT_*` export. The formats that
 * will follow (A5, or a 4-pocket sheet) differ only in these numbers, so adding
 * one is an entry here plus a picker — never a new layout component.
 *
 * ## Why 3 × 3 and why these margins
 * A standard 9-pocket binder page holds nine 2.5″ × 3.5″ cards, so one printed
 * sheet must produce exactly one binder page or the cut stack stops lining up
 * with the pockets. Nine cells at 2.5 × 3.5 is a 7.5″ × 10.5″ block:
 *
 *   Letter  8.5 × 11    → (8.5−7.5)/2 = 0.50in L/R, (11−10.5)/2 = 0.25in T/B
 *   A4      8.27 × 11.69 → 0.385in L/R, 0.595in T/B  (more slack both ways)
 *
 * Landscape is not offered on either. Rotating the block fits only 8 cells
 * (2 rows of 4 on Letter) and leaves a worse margin on the short axis — it is
 * strictly worse on both counts, and an 8-cell sheet does not fill a 9-pocket
 * page.
 *
 * ## Inches, and no DPI anywhere
 * Same reason as label-formats: inches are the unit CSS `@page size` and the
 * sheet markup both use, so nothing converts and nothing has to assume a device
 * resolution. `safeAreaIn` is in the same unit for the same reason.
 */

export interface SheetFormat {
  id: string;
  /** Shown on the picker. */
  label: string;
  /** Just the paper's name, for prose ("…on 2 sheets of Letter"). */
  shortLabel: string;
  /** Physical page, portrait. */
  pageWidthIn: number;
  pageHeightIn: number;
  /** Derived from the page and the cell block; stored so nothing recomputes it. */
  marginXIn: number;
  marginYIn: number;
  /** One pocket. A trading card is 2.5in × 3.5in. */
  cellWidthIn: number;
  cellHeightIn: number;
  cols: number;
  rows: number;
  /**
   * How far inside a cell edge content must stay to survive duplex drift.
   *
   * Consumer duplex units re-feed the sheet mechanically and land the second
   * pass 1–2mm off the first. Anything printed closer to the cut line than this
   * is a coin-flip on whether it appears on the front's card or the back's.
   * 0.08in ≈ 2mm, the pessimistic end of that range.
   */
  safeAreaIn: number;
}

/** Cells per sheet is a property of the grid, not a stored field that can drift. */
export function cellsPerSheet(format: SheetFormat): number {
  return format.cols * format.rows;
}

/**
 * US Letter, portrait, 3 × 3. The default because it is what a US hobby shop
 * and a home printer both have loaded.
 */
export const SHEET_LETTER_3X3: SheetFormat = {
  id: "letter-3x3",
  label: 'Letter 8.5" × 11" — 9 pockets',
  shortLabel: "Letter",
  pageWidthIn: 8.5,
  pageHeightIn: 11,
  marginXIn: 0.5,
  marginYIn: 0.25,
  cellWidthIn: 2.5,
  cellHeightIn: 3.5,
  cols: 3,
  rows: 3,
  safeAreaIn: 0.08,
};

/**
 * A4, portrait, 3 × 3. The same 7.5 × 10.5 block on a slightly narrower but
 * taller page, so the margins differ and nothing else does.
 */
export const SHEET_A4_3X3: SheetFormat = {
  id: "a4-3x3",
  label: "A4 210 × 297mm — 9 pockets",
  shortLabel: "A4",
  pageWidthIn: 8.27,
  pageHeightIn: 11.69,
  marginXIn: 0.385,
  marginYIn: 0.595,
  cellWidthIn: 2.5,
  cellHeightIn: 3.5,
  cols: 3,
  rows: 3,
  safeAreaIn: 0.08,
};

export const SHEET_FORMATS: SheetFormat[] = [SHEET_LETTER_3X3, SHEET_A4_3X3];

export const DEFAULT_SHEET_FORMAT = SHEET_LETTER_3X3;
