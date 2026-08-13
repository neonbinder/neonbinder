/**
 * NEO-157 — pagination and duplex mirroring for placeholder sheets.
 *
 * Pure functions over plain numbers: no React, no DOM, no Convex. Everything
 * that can be wrong about a duplex sheet is wrong *here* — which cell holds
 * item 7, and which cell on the back lands behind it — so this is the part
 * worth testing exhaustively and the part the renderer must not duplicate.
 *
 * ## The mirroring, precisely
 * The paper is portrait, so its LONG edges are the left and right sides and its
 * SHORT edges are the top and bottom. A duplexer flips the sheet about the edge
 * it is configured for:
 *
 *   long-edge flip  → rotation about the VERTICAL axis → COLUMNS reverse
 *                     col' = cols - 1 - col        (row is unchanged)
 *   short-edge flip → rotation about the HORIZONTAL axis → ROWS reverse
 *                     row' = rows - 1 - row        (col is unchanged)
 *
 * These are two different transforms behind one printer setting, and getting
 * the pair backwards produces a stack where every back is on the wrong card —
 * a failure you only discover after printing, cutting and sleeving. Hence
 * `flipEdge` is a user setting rather than a guess: consumer drivers default
 * differently and some let the user change it globally.
 *
 * ## Why a back cell can be empty while its front is filled
 * Only on the last sheet of a partial run. The back sheet always carries the
 * full grid of positions so the mirror maths stays uniform; positions with no
 * item get `item: null` and the renderer leaves them blank.
 */

import { cellsPerSheet, type SheetFormat } from "./sheet-formats";

/**
 * Which physical edge the printer rotates the sheet about on its second pass.
 * Named for what the printer dialog calls it, not for the axis, because the
 * user is copying a setting across from that dialog.
 */
export type FlipEdge = "long" | "short";

export type SheetSide = "front" | "back";

export interface SheetCell {
  /** 0-based grid position on the sheet as printed. */
  row: number;
  col: number;
  /**
   * 0-based index into the caller's item list, or null for an empty pocket on
   * a partial last sheet.
   */
  item: number | null;
  /**
   * 1-based human number for `item`, or null when empty. This is what the dev
   * harness prints in the rectangle: on a correctly-mirrored duplex sheet,
   * front cell "7" must have back cell "7" directly behind it, so the numbers
   * themselves are the paper-verification instrument.
   */
  itemNumber: number | null;
}

export interface Sheet {
  /** 0-based, counting front/back pairs — a front and its back share it. */
  sheetIndex: number;
  side: SheetSide;
  cells: SheetCell[];
}

export interface LayoutOptions {
  flipEdge: FlipEdge;
  /** When false, only front sheets are produced. */
  duplex: boolean;
}

/**
 * Mirror a grid position for the back of the sheet.
 *
 * Exported because it is the single claim this module makes about the physical
 * world, and a test that goes through `layoutSheets` alone proves it only
 * indirectly.
 */
export function mirrorPosition(
  row: number,
  col: number,
  format: Pick<SheetFormat, "rows" | "cols">,
  flipEdge: FlipEdge,
): { row: number; col: number } {
  return flipEdge === "long"
    ? { row, col: format.cols - 1 - col }
    : { row: format.rows - 1 - row, col };
}

/**
 * Paginate `itemCount` items into sheets of `format.cols × format.rows` cells,
 * emitting a mirrored back sheet after each front when `duplex` is set.
 *
 * Items fill left-to-right, top-to-bottom — the order a binder page is read.
 * Returns `[]` for `itemCount <= 0`: zero items is zero paper, not one blank
 * sheet, so the caller never offers to print nothing.
 */
export function layoutSheets(
  itemCount: number,
  format: SheetFormat,
  options: LayoutOptions,
): Sheet[] {
  const perSheet = cellsPerSheet(format);
  if (itemCount <= 0 || perSheet <= 0) return [];

  const sheetCount = Math.ceil(itemCount / perSheet);
  const sheets: Sheet[] = [];

  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex++) {
    const base = sheetIndex * perSheet;

    /** The item at a grid position on the FRONT, or null past the end. */
    const itemAt = (row: number, col: number): number | null => {
      const index = base + row * format.cols + col;
      return index < itemCount ? index : null;
    };

    const front: SheetCell[] = [];
    const back: SheetCell[] = [];

    for (let row = 0; row < format.rows; row++) {
      for (let col = 0; col < format.cols; col++) {
        const item = itemAt(row, col);
        front.push({ row, col, item, itemNumber: item === null ? null : item + 1 });

        if (!options.duplex) continue;

        // A back cell at (row, col) sits behind the FRONT cell that this
        // position maps to under the flip. The transform is its own inverse
        // (reversing an axis twice is the identity), so the same call answers
        // both "where does front (r,c) land on the back" and "what is behind
        // back (r,c)" — which is exactly why one function is enough.
        const source = mirrorPosition(row, col, format, options.flipEdge);
        const backItem = itemAt(source.row, source.col);
        back.push({
          row,
          col,
          item: backItem,
          itemNumber: backItem === null ? null : backItem + 1,
        });
      }
    }

    sheets.push({ sheetIndex, side: "front", cells: front });
    if (options.duplex) {
      sheets.push({ sheetIndex, side: "back", cells: back });
    }
  }

  return sheets;
}

/** How many sheets of paper a run consumes — pairs, not sides. */
export function sheetCountFor(itemCount: number, format: SheetFormat): number {
  const perSheet = cellsPerSheet(format);
  if (itemCount <= 0 || perSheet <= 0) return 0;
  return Math.ceil(itemCount / perSheet);
}
