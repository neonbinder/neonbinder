import React from "react";
import {
  DEFAULT_SHEET_FORMAT,
  type SheetFormat,
} from "@/lib/print/sheet-formats";
import type { Sheet } from "@/lib/print/sheet-layout";

/**
 * NEO-157 — one printable placeholder sheet: a 3 × 3 block of 2.5″ × 3.5″
 * pockets with cut guides, sized in inches to match `@page`.
 *
 * ## Every style here is inline, and that is not a preference
 * `printHtmlDocument` serializes this element's `outerHTML` into an isolated
 * iframe via `srcdoc`. That document inherits NONE of the app's stylesheets —
 * no Tailwind, no globals.css. A `grid-cols-3` class renders a perfect grid on
 * screen and lays out as a single stacked column on paper, silently, after the
 * user has already spent the sheet. So the grid is `display:grid` with
 * `gridTemplateColumns: repeat(3, 2.5in)` in the style attribute, and the test
 * enforces `className === ""` to keep it that way.
 *
 * ## Black on white, no theme
 * Same rule as ShippingLabel. The neon palette is for the screen; on paper it
 * costs colour ink to print guides the user is about to cut along. There is
 * consequently no `@media print` override to keep in sync — the sheet is
 * correct by construction, and the preview is the same element.
 *
 * ## System font stack, not Lexend
 * A webfont has to finish loading before the print dialog opens or the numbers
 * print in a fallback face at different metrics. A system sans removes the race.
 *
 * ## Why the guides are absolutely-positioned lines rather than cell borders
 * Borders on adjacent cells double up on every interior edge, so each interior
 * cut line would be two hairlines straddling the true cut by half a border
 * each, and `border-box` would quietly shrink the printable interior of the
 * cell. A line placed at exactly `2.5in` is exactly where the blade goes.
 *
 * ## Crop marks point INWARD
 * Conventional crop marks sit outside the trim box. They cannot here: the block
 * is 0.25in from the top and bottom paper edges on Letter, which is at or inside
 * the unprintable margin of most consumer printers, so anything drawn outside
 * the block clips away to nothing. The corner marks are therefore short ticks
 * lying ON the perimeter cut lines and extending into the block, where they are
 * guaranteed to print.
 */

const SHEET_FONT_STACK =
  'Helvetica, "Helvetica Neue", Arial, "Liberation Sans", sans-serif';

/** Guide weight, in points (1/72in) so it never depends on a device DPI. */
const HAIRLINE_PT = 0.5;
const HAIRLINE = `${HAIRLINE_PT}pt`;
/** Half a hairline, to centre a line on the cut rather than beside it. */
const HAIRLINE_HALF = `${HAIRLINE_PT / 2}pt`;
/** How far a corner tick reaches into the block. Long enough to lay a ruler on. */
const CORNER_TICK_IN = 0.3;

const GUIDE_COLOR = "#000000";
/** The safe-area outline is a guide, not content — grey so it reads as one. */
const SAFE_AREA_COLOR = "#999999";

export interface PlaceholderSheetProps {
  sheet: Sheet;
  format?: SheetFormat;
  /**
   * Force a page break after this sheet. Set on every sheet but the last so a
   * multi-sheet run serializes into one print document without a trailing blank
   * page.
   */
  pageBreakAfter?: boolean;
  /** Total sheets of paper in the run, for the "Sheet 2 of 3" caption. */
  totalSheets?: number;
  /**
   * Card art for a cell, by its 0-based item index, or undefined for none.
   *
   * A cell with art renders it FULL BLEED and drops the number; a cell without
   * falls back to the numbered rectangle, so a run can mix the two (a pocket
   * whose card was never photographed still gets a placeholder).
   */
  imageForItem?: (item: number) => string | undefined;
  /**
   * Draw the calibration guides. True (default) is what NEO-157 shipped and
   * what paper-verification uses: interior gridlines, dashed safe-area
   * rectangles, corner ticks.
   *
   * FALSE is the real run, and it exists because of full bleed. The interior
   * lines are absolutely-positioned siblings drawn OVER the block, so with art
   * in the cells they print as a black hairline along every edge you are about
   * to cut — across the artwork. With guides off the abutting images are
   * themselves the interior cut lines (cells tile edge to edge, sharing them),
   * and the corner ticks survive because they sit inside the block and give the
   * four outer cuts via a ruler laid between each pair.
   */
  guides?: boolean;
}

/** One pocket: the big number, what side it is, and the duplex-drift guide. */
function Cell({
  itemNumber,
  format,
  sideLabel,
  sheetCaption,
  imageUrl,
  guides,
}: {
  itemNumber: number | null;
  format: SheetFormat;
  sideLabel: string;
  sheetCaption: string;
  imageUrl?: string;
  guides: boolean;
}) {
  return (
    <div
      style={{
        width: `${format.cellWidthIn}in`,
        height: `${format.cellHeightIn}in`,
        boxSizing: "border-box",
        position: "relative",
        overflow: "hidden",
      }}
      data-cell-item={itemNumber ?? ""}
    >
      {/*
        FULL BLEED — the art goes in THIS div, the full-size cell, not in the
        safe area below it. Dropping it into the safe area is the path of least
        resistance and yields 2.34 x 3.34in of art inside a 2.5 x 3.5in card
        with a ~2mm white frame on every side. Cells tile edge to edge sharing
        cut lines, so neighbouring images abut with no gutter and a slightly-off
        cut steals a sliver of the NEIGHBOUR's art instead of exposing white —
        far more forgiving than a frame, where every miscut shows as an uneven
        margin. A placeholder's whole job is to read as a card in the pocket.
      */}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : null}
      {/*
        The safe area, drawn. This is the measuring instrument for duplex drift:
        print both sides, hold the sheet to a light, and the front and back
        outlines either coincide or they show you exactly how far your duplexer
        re-feeds off-register. Content stays inside it for that reason.
      */}
      <div
        style={{
          position: "absolute",
          top: `${format.safeAreaIn}in`,
          right: `${format.safeAreaIn}in`,
          bottom: `${format.safeAreaIn}in`,
          left: `${format.safeAreaIn}in`,
          border: guides ? `${HAIRLINE} dashed ${SAFE_AREA_COLOR}` : "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        {/*
          Numbers appear when there is no art, OR whenever guides are on.
          Guides-on IS calibration mode: it is the NEO-157 instrument, folded
          into the real tool rather than kept as a separate blank-sheet page.
          Printing with guides on and reading the numbers after cutting is still
          how you prove the duplexer mirrored correctly — card 7's front must
          have card 7's back behind it — and over real art that is exactly when
          you want the number, because the art itself cannot tell you which
          pocket it came from.
        */}
        {itemNumber === null || (imageUrl && !guides) ? null : (
          <>
            {/*
              The number IS the verification. After printing duplex and cutting,
              a card whose front reads 7 must read 7 on its back; if the flip
              edge is wrong it will read 9, and you can see that at a glance
              instead of measuring anything.
            */}
            <div
              style={{
                fontSize: "56pt",
                fontWeight: 700,
                lineHeight: 1,
                // Legible over artwork in calibration mode, and invisible on a
                // plain white cell where there is nothing to sit on.
                ...(imageUrl
                  ? { color: "#ffffff", textShadow: "0 0 6px #000000" }
                  : {}),
              }}
            >
              {itemNumber}
            </div>
            {/* Which face this is, so a cut card is self-describing off the
                table — you cannot tell front from back once the stack is
                shuffled, and that is precisely when you need to know. */}
            <div style={{ fontSize: "10pt", marginTop: "0.12in" }}>
              {sideLabel}
            </div>
            <div style={{ fontSize: "8pt", marginTop: "0.04in" }}>
              {sheetCaption}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const PlaceholderSheet = React.forwardRef<
  HTMLDivElement,
  PlaceholderSheetProps
>(function PlaceholderSheet(
  {
    sheet,
    format = DEFAULT_SHEET_FORMAT,
    pageBreakAfter = false,
    totalSheets,
    imageForItem,
    guides = true,
  },
  ref,
) {
  const blockWidthIn = format.cellWidthIn * format.cols;
  const blockHeightIn = format.cellHeightIn * format.rows;

  const sideLabel = sheet.side === "front" ? "FRONT" : "BACK";
  const sheetCaption =
    totalSheets && totalSheets > 1
      ? `Sheet ${sheet.sheetIndex + 1} of ${totalSheets}`
      : `Sheet ${sheet.sheetIndex + 1}`;

  /** Interior cut lines, full span, centred on the cut. */
  const verticalGuides = Array.from({ length: format.cols - 1 }, (_, i) => {
    const x = format.cellWidthIn * (i + 1);
    return (
      <div
        key={`v${i}`}
        style={{
          position: "absolute",
          top: 0,
          height: `${blockHeightIn}in`,
          left: `calc(${x}in - ${HAIRLINE_HALF})`,
          width: HAIRLINE,
          background: GUIDE_COLOR,
        }}
      />
    );
  });

  const horizontalGuides = Array.from({ length: format.rows - 1 }, (_, i) => {
    const y = format.cellHeightIn * (i + 1);
    return (
      <div
        key={`h${i}`}
        style={{
          position: "absolute",
          left: 0,
          width: `${blockWidthIn}in`,
          top: `calc(${y}in - ${HAIRLINE_HALF})`,
          height: HAIRLINE,
          background: GUIDE_COLOR,
        }}
      />
    );
  });

  /**
   * Corner marks. Each corner gets an L of two ticks lying on the two perimeter
   * cut lines that meet there and reaching inward. Two corners define an edge,
   * so a ruler laid between them gives the outer cuts that no interior gridline
   * covers.
   */
  const cornerMarks = ([0, 1] as const).flatMap((cornerY) =>
    ([0, 1] as const).map((cornerX) => {
      const xEdge = cornerX === 0 ? { left: 0 } : { right: 0 };
      const yEdge = cornerY === 0 ? { top: 0 } : { bottom: 0 };
      return (
        <React.Fragment key={`c${cornerY}${cornerX}`}>
          {/* Horizontal tick — marks the top/bottom cut line. */}
          <div
            style={{
              position: "absolute",
              ...xEdge,
              ...yEdge,
              width: `${CORNER_TICK_IN}in`,
              height: HAIRLINE,
              background: GUIDE_COLOR,
            }}
          />
          {/* Vertical tick — marks the left/right cut line. */}
          <div
            style={{
              position: "absolute",
              ...xEdge,
              ...yEdge,
              width: HAIRLINE,
              height: `${CORNER_TICK_IN}in`,
              background: GUIDE_COLOR,
            }}
          />
        </React.Fragment>
      );
    }),
  );

  return (
    <div
      ref={ref}
      style={{
        width: `${format.pageWidthIn}in`,
        height: `${format.pageHeightIn}in`,
        padding: `${format.marginYIn}in ${format.marginXIn}in`,
        boxSizing: "border-box",
        background: "#ffffff",
        color: "#000000",
        fontFamily: SHEET_FONT_STACK,
        // A sheet that overflows its media loses a row of pockets silently;
        // clipping at least makes it visible in the preview.
        overflow: "hidden",
        // `breakAfter` rather than a separator element: a multi-sheet run is one
        // serialized fragment, and the browser needs to be told where the paper
        // ends. The last sheet omits it or the job gains a blank trailing page.
        breakAfter: pageBreakAfter ? "page" : "auto",
      }}
      data-sheet-format={format.id}
      data-sheet-side={sheet.side}
      data-sheet-index={sheet.sheetIndex}
    >
      <div
        style={{
          position: "relative",
          width: `${blockWidthIn}in`,
          height: `${blockHeightIn}in`,
        }}
      >
        <div
          style={{
            display: "grid",
            // Explicit inch tracks, not `repeat(3, 1fr)`: a fraction of a
            // container is only 2.5in if the container is exactly 7.5in, and
            // this is the one measurement the whole feature is judged on.
            gridTemplateColumns: `repeat(${format.cols}, ${format.cellWidthIn}in)`,
            gridTemplateRows: `repeat(${format.rows}, ${format.cellHeightIn}in)`,
            width: `${blockWidthIn}in`,
            height: `${blockHeightIn}in`,
          }}
        >
          {sheet.cells.map((cell) => (
            <Cell
              key={`${cell.row}-${cell.col}`}
              itemNumber={cell.itemNumber}
              format={format}
              sideLabel={sideLabel}
              sheetCaption={sheetCaption}
              imageUrl={
                cell.item !== null ? imageForItem?.(cell.item) : undefined
              }
              guides={guides}
            />
          ))}
        </div>

        {/* Guides last so they paint over the cells rather than under them —
            which is exactly why the interior ones have to go for a real run:
            over full-bleed art they are a black line across the picture, not a
            line beside it. Corner ticks stay either way. */}
        {guides ? verticalGuides : null}
        {guides ? horizontalGuides : null}
        {cornerMarks}
      </div>
    </div>
  );
});

export default PlaceholderSheet;
