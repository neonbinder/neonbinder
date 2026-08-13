/**
 * NEO-157 — component tests for the printable placeholder sheet.
 *
 * Same two properties as shipping-label.test.tsx, for the same reason: what is
 * at risk is not "does it render numbers", it is whether the paper matches the
 * screen.
 *
 *  1. **Physical dimensions in inches.** The print document sets
 *     `@page { size: 8.5in 11in }`. If the sheet element is not also 8.5 × 11,
 *     or the cells are not exactly 2.5 × 3.5, the cut cards do not fit the
 *     pockets — which is the entire feature. Asserted against the format
 *     constant rather than as loose literals, so geometry and markup cannot
 *     drift apart.
 *  2. **Styles are inline, not classes.** Printing serializes `outerHTML` into
 *     an isolated `srcdoc` document with none of the app's stylesheets. A
 *     `grid-cols-3` here renders a perfect grid on screen and a single stacked
 *     column on paper — silently, after the sheet is already spent. The
 *     serialization test is the guard.
 */

import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { PlaceholderSheet } from "./placeholder-sheet";
import {
  SHEET_A4_3X3,
  SHEET_LETTER_3X3,
  type SheetFormat,
} from "@/lib/print/sheet-formats";
import { layoutSheets, type Sheet } from "@/lib/print/sheet-layout";

const DUPLEX_LONG = { flipEdge: "long", duplex: true } as const;

function sheetsFor(count: number, format: SheetFormat = SHEET_LETTER_3X3) {
  return layoutSheets(count, format, DUPLEX_LONG);
}

function renderSheet(
  sheet: Sheet,
  props: Partial<React.ComponentProps<typeof PlaceholderSheet>> = {},
) {
  const ref = React.createRef<HTMLDivElement>();
  render(<PlaceholderSheet ref={ref} sheet={sheet} {...props} />);
  return ref;
}

/** The grid element — the one whose track sizing decides the printed geometry. */
function gridOf(root: HTMLElement): HTMLElement {
  const grid = [...root.querySelectorAll<HTMLElement>("div")].find(
    (d) => d.style.display === "grid",
  );
  expect(grid).toBeTruthy();
  return grid!;
}

function cellsOf(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-cell-item]")];
}

describe("PlaceholderSheet — geometry", () => {
  // The core contract with @page in lib/print/print-html.ts.
  it("sizes itself in inches to match the print page exactly", () => {
    const ref = renderSheet(sheetsFor(9)[0]);
    const style = ref.current!.style;
    expect(style.width).toBe(`${SHEET_LETTER_3X3.pageWidthIn}in`);
    expect(style.height).toBe(`${SHEET_LETTER_3X3.pageHeightIn}in`);
    // Without border-box the margins would push the sheet past 8.5 × 11.
    expect(style.boxSizing).toBe("border-box");
  });

  it("centres the block with the margins the format specifies", () => {
    const ref = renderSheet(sheetsFor(9)[0]);
    expect(ref.current!.style.padding).toBe(
      `${SHEET_LETTER_3X3.marginYIn}in ${SHEET_LETTER_3X3.marginXIn}in`,
    );
  });

  /**
   * The headline geometry assertion: exactly nine pockets, each exactly the
   * size of a trading card. Nine because that is one binder page — eight or ten
   * means the cut stack stops lining up with the pockets.
   */
  it("renders exactly 9 cells at 2.5in x 3.5in on Letter", () => {
    const ref = renderSheet(sheetsFor(9)[0]);
    const cells = cellsOf(ref.current!);
    expect(cells).toHaveLength(9);
    for (const cell of cells) {
      expect(cell.style.width).toBe(`${SHEET_LETTER_3X3.cellWidthIn}in`);
      expect(cell.style.height).toBe(`${SHEET_LETTER_3X3.cellHeightIn}in`);
    }
  });

  it("renders the same 3 x 3 block on A4 — only the page and margins differ", () => {
    const ref = renderSheet(sheetsFor(9, SHEET_A4_3X3)[0], {
      format: SHEET_A4_3X3,
    });
    const cells = cellsOf(ref.current!);
    expect(cells).toHaveLength(9);
    for (const cell of cells) {
      expect(cell.style.width).toBe(`${SHEET_A4_3X3.cellWidthIn}in`);
      expect(cell.style.height).toBe(`${SHEET_A4_3X3.cellHeightIn}in`);
    }
    expect(ref.current!.style.width).toBe(`${SHEET_A4_3X3.pageWidthIn}in`);
    expect(ref.current!.style.height).toBe(`${SHEET_A4_3X3.pageHeightIn}in`);
    expect(ref.current!.style.padding).toBe(
      `${SHEET_A4_3X3.marginYIn}in ${SHEET_A4_3X3.marginXIn}in`,
    );
  });

  /**
   * `repeat(3, 1fr)` would look identical on screen and be wrong on paper the
   * moment the container is not exactly 7.5in — the tracks must be stated in
   * inches, which is also what makes them survive into the print document.
   */
  it("states its grid tracks in inches, not fractions", () => {
    const ref = renderSheet(sheetsFor(9)[0]);
    const grid = gridOf(ref.current!);
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, 2.5in)");
    expect(grid.style.gridTemplateRows).toBe("repeat(3, 3.5in)");
    expect(grid.style.width).toBe("7.5in");
    expect(grid.style.height).toBe("10.5in");
  });
});

describe("PlaceholderSheet — the numbers are the verification instrument", () => {
  it("numbers the pockets 1..9 in reading order", () => {
    const ref = renderSheet(sheetsFor(9)[0]);
    expect(cellsOf(ref.current!).map((c) => c.dataset.cellItem)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9",
    ]);
  });

  /**
   * The whole point of the harness. Front row 0 reads 1 2 3; on a long-edge
   * flip the back's row 0 must read 3 2 1, so after cutting, card 1's back also
   * says 1. If this renders the front order on the back, the printed stack is
   * wrong and nothing on screen would have told you.
   */
  it("renders the mirrored order on the back of a long-edge flip", () => {
    const [, back] = sheetsFor(9);
    const ref = renderSheet(back);
    expect(cellsOf(ref.current!).map((c) => c.dataset.cellItem)).toEqual([
      "3", "2", "1", "6", "5", "4", "9", "8", "7",
    ]);
  });

  // A cut card is unidentifiable once the stack is shuffled, which is exactly
  // when you need to know which face you are holding.
  it("labels which face each card is", () => {
    const [front, back] = sheetsFor(9);
    const frontRef = renderSheet(front);
    expect(frontRef.current!.dataset.sheetSide).toBe("front");
    expect(frontRef.current!.outerHTML).toContain("FRONT");
    expect(frontRef.current!.outerHTML).not.toContain("BACK");

    const backRef = renderSheet(back);
    expect(backRef.current!.dataset.sheetSide).toBe("back");
    expect(backRef.current!.outerHTML).toContain("BACK");
  });

  it("captions the sheet number across a multi-sheet run", () => {
    const sheets = sheetsFor(10);
    renderSheet(sheets[2], { totalSheets: 2 });
    expect(screen.getAllByText("Sheet 2 of 2").length).toBeGreaterThan(0);
  });

  // A partial last sheet still draws nine pockets — the cut guides run through
  // the empty ones — but must not invent numbers for them.
  it("leaves the empty pockets of a partial sheet blank", () => {
    const sheets = sheetsFor(10);
    const last = sheets.at(-2)!; // the second sheet's front
    const ref = renderSheet(last);
    const cells = cellsOf(ref.current!);
    expect(cells).toHaveLength(9);
    expect(cells.map((c) => c.dataset.cellItem)).toEqual([
      "10", "", "", "", "", "", "", "", "",
    ]);
  });
});

describe("PlaceholderSheet — cut guides", () => {
  /**
   * Two interior cuts per axis on a 3 × 3 (the perimeter is marked by corner
   * ticks instead, because a line outside the block clips on most consumer
   * printers). Positions are asserted because a guide half an inch off is a
   * guide that ruins nine cards.
   */
  it("draws an interior cut line on every interior cell boundary", () => {
    const ref = renderSheet(sheetsFor(9)[0]);
    const guides = [...ref.current!.querySelectorAll<HTMLElement>("div")].filter(
      (d) => d.style.background === "#000000" || d.style.backgroundColor === "#000000",
    );
    const full = guides.filter(
      (g) => g.style.height === "10.5in" || g.style.width === "7.5in",
    );
    expect(full).toHaveLength(4);

    const verticals = full.filter((g) => g.style.height === "10.5in");
    expect(verticals.map((g) => g.style.left)).toEqual([
      "calc(2.5in - 0.25pt)",
      "calc(5in - 0.25pt)",
    ]);

    const horizontals = full.filter((g) => g.style.width === "7.5in");
    expect(horizontals.map((g) => g.style.top)).toEqual([
      "calc(3.5in - 0.25pt)",
      "calc(7in - 0.25pt)",
    ]);
  });

  /**
   * Four corners × two ticks. Every tick must be anchored to a block edge and
   * reach INWARD: conventional crop marks sit outside the trim box, and outside
   * this block is the paper's unprintable margin, so an outward mark is a mark
   * that does not exist on paper.
   */
  it("marks each corner with an inward-pointing L", () => {
    const ref = renderSheet(sheetsFor(9)[0]);
    const ticks = [...ref.current!.querySelectorAll<HTMLElement>("div")].filter(
      (d) => d.style.width === "0.3in" || d.style.height === "0.3in",
    );
    expect(ticks).toHaveLength(8);
    for (const tick of ticks) {
      const s = tick.style;
      expect(s.position).toBe("absolute");
      // Anchored to one horizontal and one vertical block edge — never inset
      // by an offset that would float it away from the cut line.
      expect([s.left, s.right]).toContain("0px");
      expect([s.top, s.bottom]).toContain("0px");
    }
    // Half reach inward horizontally, half vertically.
    expect(ticks.filter((t) => t.style.width === "0.3in")).toHaveLength(4);
    expect(ticks.filter((t) => t.style.height === "0.3in")).toHaveLength(4);
  });

  // A multi-sheet run is one serialized fragment; without this the sheets print
  // on top of each other, and with it on the LAST sheet the job gains a blank
  // trailing page.
  it("breaks the page only when told to", () => {
    expect(renderSheet(sheetsFor(9)[0]).current!.style.breakAfter).toBe("auto");
    expect(
      renderSheet(sheetsFor(9)[0], { pageBreakAfter: true }).current!.style
        .breakAfter,
    ).toBe("page");
  });
});

describe("PlaceholderSheet — print fidelity", () => {
  it("prints black on white with no theme colour leaking in", () => {
    const ref = renderSheet(sheetsFor(9)[0]);
    const style = ref.current!.style;
    // Compared case-insensitively as hex: happy-dom preserves the authored form
    // rather than normalising to rgb().
    expect(style.color.toLowerCase()).toBe("#000000");
    expect(style.background.toLowerCase()).toBe("#ffffff");
    // Neon on paper costs colour ink to print lines the user cuts along.
    expect(ref.current!.outerHTML).not.toMatch(/#00D558|#00E5C0|neon-/);
  });

  /**
   * The serialization guard. What gets printed is `outerHTML` dropped into a
   * document with no stylesheets, so every style that matters has to already be
   * in the style attribute — above all the grid, which is the difference
   * between a 3 × 3 block and one tall column of nine.
   */
  it("carries its styling inline so it survives serialization", () => {
    const ref = renderSheet(sheetsFor(9)[0]);
    const html = ref.current!.outerHTML;
    expect(html).toContain("width: 8.5in");
    expect(html).toContain("height: 11in");
    expect(html).toContain("display: grid");
    expect(html).toContain("repeat(3, 2.5in)");
    // No class-based styling to be lost in the isolated print document — this
    // is what stops a Tailwind `grid-cols-3` creeping back in.
    expect(ref.current!.className).toBe("");
    expect(html).not.toMatch(/class="/);
  });
});
