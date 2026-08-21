/**
 * NEO-157 — pagination and duplex mirroring.
 *
 * The whole point of putting this logic in a pure module is that the failure it
 * guards against is otherwise only observable on paper: you print, cut, sleeve,
 * and only then discover every back is on the wrong card. These cases are the
 * cheap version of that experiment.
 *
 * The mirroring pair is the load-bearing assertion. Portrait paper has its long
 * edges left and right, so a LONG-edge flip reverses COLUMNS and a SHORT-edge
 * flip reverses ROWS. Getting the two backwards is the single most likely bug
 * here and it is silent, so both directions are asserted explicitly — including
 * that each one leaves the OTHER axis alone.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHEET_FORMAT,
  SHEET_A4_3X3,
  SHEET_LETTER_3X3,
  cellsPerSheet,
} from "./sheet-formats";
import {
  layoutSheets,
  mirrorPosition,
  sheetCountFor,
  type Sheet,
} from "./sheet-layout";

const FRONT_ONLY = { flipEdge: "long", duplex: false } as const;
const DUPLEX_LONG = { flipEdge: "long", duplex: true } as const;
const DUPLEX_SHORT = { flipEdge: "short", duplex: true } as const;

/** The 1-based numbers in a sheet, as a 3-row grid — how the paper reads. */
function grid(sheet: Sheet, cols: number): (number | null)[][] {
  const rows: (number | null)[][] = [];
  for (const cell of sheet.cells) {
    (rows[cell.row] ??= new Array(cols).fill(null))[cell.col] = cell.itemNumber;
  }
  return rows;
}

function fronts(sheets: Sheet[]) {
  return sheets.filter((s) => s.side === "front");
}
function backs(sheets: Sheet[]) {
  return sheets.filter((s) => s.side === "back");
}

describe("sheet geometry", () => {
  // A sheet that is not exactly one 9-pocket binder page defeats the purpose:
  // the cut stack stops lining up with the pockets.
  it("is exactly one 9-pocket binder page on both papers", () => {
    expect(cellsPerSheet(SHEET_LETTER_3X3)).toBe(9);
    expect(cellsPerSheet(SHEET_A4_3X3)).toBe(9);
    expect([SHEET_LETTER_3X3.cols, SHEET_LETTER_3X3.rows]).toEqual([3, 3]);
    expect([SHEET_A4_3X3.cols, SHEET_A4_3X3.rows]).toEqual([3, 3]);
  });

  // Margins are (page − block) / 2. Asserted as arithmetic rather than as the
  // literals, so a future page size cannot be added with a hand-typed margin
  // that silently pushes the block off-centre.
  it.each([SHEET_LETTER_3X3, SHEET_A4_3X3])(
    "centres the card block on $id",
    (format) => {
      const blockW = format.cellWidthIn * format.cols;
      const blockH = format.cellHeightIn * format.rows;
      expect(blockW).toBeCloseTo(7.5, 5);
      expect(blockH).toBeCloseTo(10.5, 5);
      expect(format.marginXIn).toBeCloseTo((format.pageWidthIn - blockW) / 2, 3);
      expect(format.marginYIn).toBeCloseTo((format.pageHeightIn - blockH) / 2, 3);
    },
  );

  it("holds a real card at 2.5in x 3.5in on both papers", () => {
    for (const format of [SHEET_LETTER_3X3, SHEET_A4_3X3]) {
      expect(format.cellWidthIn).toBe(2.5);
      expect(format.cellHeightIn).toBe(3.5);
    }
  });

  // ~2mm, in the same unit as everything else so nothing has to assume a DPI.
  it("reserves a duplex-drift safe area inside every cell", () => {
    expect(DEFAULT_SHEET_FORMAT.safeAreaIn).toBeGreaterThan(0);
    expect(DEFAULT_SHEET_FORMAT.safeAreaIn).toBeLessThan(0.25);
  });

  it("defaults to Letter", () => {
    expect(DEFAULT_SHEET_FORMAT).toBe(SHEET_LETTER_3X3);
  });
});

describe("layoutSheets — pagination", () => {
  // Zero items is zero paper, not one blank sheet.
  it("returns nothing for an empty run", () => {
    expect(layoutSheets(0, SHEET_LETTER_3X3, DUPLEX_LONG)).toEqual([]);
    expect(layoutSheets(-3, SHEET_LETTER_3X3, DUPLEX_LONG)).toEqual([]);
    expect(sheetCountFor(0, SHEET_LETTER_3X3)).toBe(0);
  });

  // One item still gets a full grid of positions; eight of them are empty.
  it("puts a single item in the top-left and leaves the rest blank", () => {
    const sheets = layoutSheets(1, SHEET_LETTER_3X3, FRONT_ONLY);
    expect(sheets).toHaveLength(1);
    expect(grid(sheets[0], 3)).toEqual([
      [1, null, null],
      [null, null, null],
      [null, null, null],
    ]);
  });

  // The boundary case: exactly one sheet, no empty cells, no second sheet.
  it("fills exactly one sheet with 9 and does not start a second", () => {
    const sheets = layoutSheets(9, SHEET_LETTER_3X3, FRONT_ONLY);
    expect(sheets).toHaveLength(1);
    expect(sheetCountFor(9, SHEET_LETTER_3X3)).toBe(1);
    expect(grid(sheets[0], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    expect(sheets[0].cells.every((c) => c.item !== null)).toBe(true);
  });

  // 10 is the off-by-one that a `<` / `<=` slip produces: one full sheet plus a
  // sheet holding a single card.
  it("spills the 10th item onto a partial second sheet", () => {
    const sheets = layoutSheets(10, SHEET_LETTER_3X3, FRONT_ONLY);
    expect(sheets).toHaveLength(2);
    expect(sheetCountFor(10, SHEET_LETTER_3X3)).toBe(2);
    expect(grid(sheets[1], 3)).toEqual([
      [10, null, null],
      [null, null, null],
      [null, null, null],
    ]);
    // Every position still exists — the renderer draws 9 pockets either way.
    expect(sheets[1].cells).toHaveLength(9);
    expect(sheets[1].cells.filter((c) => c.item !== null)).toHaveLength(1);
  });

  it("numbers a partial last sheet continuing from the previous one", () => {
    const sheets = layoutSheets(14, SHEET_LETTER_3X3, FRONT_ONLY);
    expect(sheets).toHaveLength(2);
    expect(grid(sheets[1], 3)).toEqual([
      [10, 11, 12],
      [13, 14, null],
      [null, null, null],
    ]);
  });

  // Reading order is what a binder page is read in, and what a cut stack
  // assumes; column-major would silently transpose every sheet.
  it("fills left-to-right, top-to-bottom", () => {
    const [sheet] = layoutSheets(9, SHEET_LETTER_3X3, FRONT_ONLY);
    expect(sheet.cells.map((c) => [c.row, c.col, c.itemNumber])).toEqual([
      [0, 0, 1], [0, 1, 2], [0, 2, 3],
      [1, 0, 4], [1, 1, 5], [1, 2, 6],
      [2, 0, 7], [2, 1, 8], [2, 2, 9],
    ]);
  });

  it("emits only fronts when duplex is off", () => {
    const sheets = layoutSheets(20, SHEET_LETTER_3X3, FRONT_ONLY);
    expect(sheets).toHaveLength(3);
    expect(backs(sheets)).toHaveLength(0);
  });

  // Front then its own back, so the print order matches the feed order.
  it("pairs each front with its back, in order", () => {
    const sheets = layoutSheets(20, SHEET_LETTER_3X3, DUPLEX_LONG);
    expect(sheets.map((s) => [s.sheetIndex, s.side])).toEqual([
      [0, "front"], [0, "back"],
      [1, "front"], [1, "back"],
      [2, "front"], [2, "back"],
    ]);
    // Sheets of PAPER, not sides — 20 items is 3 sheets run through twice.
    expect(sheetCountFor(20, SHEET_LETTER_3X3)).toBe(3);
  });

  it("paginates A4 identically — only the margins differ", () => {
    const letter = layoutSheets(14, SHEET_LETTER_3X3, DUPLEX_LONG);
    const a4 = layoutSheets(14, SHEET_A4_3X3, DUPLEX_LONG);
    expect(a4.map((s) => grid(s, 3))).toEqual(letter.map((s) => grid(s, 3)));
  });
});

describe("mirrorPosition — the two flips are different transforms", () => {
  // Portrait paper's long edges are its left and right sides, so rotating about
  // the long edge spins the sheet about the VERTICAL axis: columns reverse and
  // rows do not move.
  it("long-edge flip reverses columns and leaves rows alone", () => {
    expect(mirrorPosition(0, 0, SHEET_LETTER_3X3, "long")).toEqual({ row: 0, col: 2 });
    expect(mirrorPosition(0, 2, SHEET_LETTER_3X3, "long")).toEqual({ row: 0, col: 0 });
    expect(mirrorPosition(2, 1, SHEET_LETTER_3X3, "long")).toEqual({ row: 2, col: 1 });
  });

  // Short edges are top and bottom → rotation about the HORIZONTAL axis.
  it("short-edge flip reverses rows and leaves columns alone", () => {
    expect(mirrorPosition(0, 0, SHEET_LETTER_3X3, "short")).toEqual({ row: 2, col: 0 });
    expect(mirrorPosition(2, 0, SHEET_LETTER_3X3, "short")).toEqual({ row: 0, col: 0 });
    expect(mirrorPosition(1, 2, SHEET_LETTER_3X3, "short")).toEqual({ row: 1, col: 2 });
  });

  // Reversing one axis twice is the identity — which is what lets one function
  // answer both "where does the front land" and "what is behind this back".
  it("is its own inverse", () => {
    for (const flip of ["long", "short"] as const) {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const once = mirrorPosition(row, col, SHEET_LETTER_3X3, flip);
          expect(mirrorPosition(once.row, once.col, SHEET_LETTER_3X3, flip)).toEqual({ row, col });
        }
      }
    }
  });
});

describe("layoutSheets — duplex mirroring", () => {
  /**
   * The headline case, stated the way the paper states it.
   *
   * Front row 0 reads 1 2 3. After a LONG-edge flip the sheet has spun about
   * its vertical axis, so the back's row 0 must read 3 2 1 — columns 1 and 3
   * swapped, the middle column fixed. A SHORT-edge flip must NOT do this: it
   * spins about the horizontal axis, so row 0 of the back is the front's
   * BOTTOM row, still in left-to-right order.
   */
  it("long-edge flip swaps columns 1 and 3; short-edge flip does not", () => {
    const [, longBack] = layoutSheets(9, SHEET_LETTER_3X3, DUPLEX_LONG);
    expect(grid(longBack, 3)).toEqual([
      [3, 2, 1],
      [6, 5, 4],
      [9, 8, 7],
    ]);

    const [, shortBack] = layoutSheets(9, SHEET_LETTER_3X3, DUPLEX_SHORT);
    expect(grid(shortBack, 3)).toEqual([
      [7, 8, 9],
      [4, 5, 6],
      [1, 2, 3],
    ]);
  });

  // The two settings must not be interchangeable — if they produced the same
  // sheet the setting would be decoration and half of all users would misprint.
  it("produces genuinely different backs for the two flip edges", () => {
    const [, longBack] = layoutSheets(9, SHEET_LETTER_3X3, DUPLEX_LONG);
    const [, shortBack] = layoutSheets(9, SHEET_LETTER_3X3, DUPLEX_SHORT);
    expect(grid(longBack, 3)).not.toEqual(grid(shortBack, 3));
  });

  /**
   * The property that actually matters on paper, checked for every cell rather
   * than by eye: after the flip, the back cell physically behind front cell N
   * must itself be N. This is what the numbered dev harness verifies with real
   * paper, expressed as an invariant.
   */
  it.each([DUPLEX_LONG, DUPLEX_SHORT])(
    "lands every back cell behind its own front cell (flipEdge=$flipEdge)",
    (options) => {
      const sheets = layoutSheets(14, SHEET_LETTER_3X3, options);
      for (const front of fronts(sheets)) {
        const back = backs(sheets).find((s) => s.sheetIndex === front.sheetIndex)!;
        for (const cell of front.cells) {
          const behind = mirrorPosition(cell.row, cell.col, SHEET_LETTER_3X3, options.flipEdge);
          const backCell = back.cells.find(
            (c) => c.row === behind.row && c.col === behind.col,
          )!;
          expect(backCell.itemNumber).toBe(cell.itemNumber);
        }
      }
    },
  );

  // A partial last sheet mirrors as a partial: the blanks move with the flip,
  // and no back cell invents an item the front does not have.
  it("mirrors a partial last sheet without inventing items", () => {
    const sheets = layoutSheets(10, SHEET_LETTER_3X3, DUPLEX_LONG);
    const lastBack = backs(sheets).at(-1)!;
    expect(grid(lastBack, 3)).toEqual([
      [null, null, 10],
      [null, null, null],
      [null, null, null],
    ]);
    for (const sheet of sheets) {
      for (const cell of sheet.cells) {
        expect(cell.itemNumber === null || cell.itemNumber <= 10).toBe(true);
      }
    }
  });

  it("keeps every back sheet a full grid of positions", () => {
    const sheets = layoutSheets(10, SHEET_LETTER_3X3, DUPLEX_SHORT);
    for (const sheet of sheets) {
      expect(sheet.cells).toHaveLength(9);
    }
  });
});
