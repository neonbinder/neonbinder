import { useCallback, useMemo, useRef, useState } from "react";
import { PrinterIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import NeonButton from "@/components/modules/NeonButton";
import { PlaceholderSheet } from "@/components/modules/PlaceholderSheet";
import { Input } from "@/components/primitives/Input";
import {
  DEFAULT_SHEET_FORMAT,
  SHEET_FORMATS,
  cellsPerSheet,
  type SheetFormat,
} from "@/lib/print/sheet-formats";
import { layoutSheets, sheetCountFor, type FlipEdge } from "@/lib/print/sheet-layout";
import { printHtmlDocument } from "@/lib/print/print-html";

/**
 * Blank numbered placeholder sheets — the NEO-157 tool, now a SECTION of
 * /print/placeholders rather than the whole page.
 *
 * NEO-152 put real card photos on the same paper, and this did not become
 * redundant when it did. Two reasons it stays:
 *
 *  - It is the **calibration instrument**. Every claim the print path makes is
 *    a claim about paper — does a cut card fit the pocket, does the duplexer
 *    land the back on the right front — and numbered rectangles are how you
 *    check that without spending a scan. Printing 1..N and reading the numbers
 *    after cutting turns "is the mirroring right" into something you can see.
 *  - Blank placeholders are **useful on their own**. A collector filling a
 *    pocket for a card they have not photographed wants a placeholder, not a
 *    photo of nothing.
 *
 * The heading demotion is the only edit to what NEO-157 shipped; everything
 * below is as it was, including every reason it is written this way.
 *
 * ## This section is a measuring instrument before it is a feature
 * NEO-152 will fill these pockets with real card images. This slice deliberately
 * ships numbered rectangles first, because every hard question about placeholder
 * sheets is a PAPER question — does a cut card fit the pocket, does the duplexer
 * land the back on the right front — and none of them can be answered on screen.
 * Printing 1..N and reading the numbers after cutting turns "is the mirroring
 * right" into something you can see rather than something you argue about: card
 * 1's front must have card 1's back behind it. Get that loop working, and the
 * image work that follows only has to not break it.
 *
 * ## The preview is scaled; the printable element is not
 * A Letter sheet is 8.5in, which CSS defines as exactly 816px — it does not fit
 * a page column, so unlike /print/shipping (whose 6in label is 576px and fits at
 * 1:1) this preview has to shrink. The `transform: scale()` goes on a WRAPPER
 * and never on the sheet itself: printing serializes the sheet's `outerHTML`,
 * and a transform baked into that element would travel into the print document
 * and print the sheet at 40% size. The sheet element stays in real inches; only
 * its container is scaled.
 *
 * ## No persistence, no Convex
 * Nothing here is worth storing — the whole page is derived from a count and two
 * settings, and re-deriving it is instant. That is also why the Print Shop
 * shell's `useWarmPrintQueries` needs no entry for this tool.
 */

const FIELD_CLASS = "w-full px-3 py-2";
const LABEL_CLASS = "block text-sm font-medium mb-1 text-slate-300";

/**
 * CSS defines `1in` as exactly 96px regardless of the device — this is the
 * unit conversion, not an assumed printer DPI. The formats themselves stay in
 * inches and know nothing about pixels.
 */
const CSS_PX_PER_IN = 96;

/** Preview width in CSS px. Two sheets sit side by side on a desktop column. */
const PREVIEW_WIDTH_PX = 300;

/**
 * Enough paper to fill a binder in one go, few enough that the preview stays
 * navigable. 90 is ten sheets — twenty sides at duplex.
 */
const MAX_PLACEHOLDERS = 90;

const DEFAULT_COUNT = "9";
const DEFAULT_FLIP_EDGE: FlipEdge = "long";

const FLIP_EDGE_CHOICES: { value: FlipEdge; label: string; hint: string }[] = [
  {
    value: "long",
    label: "Long edge",
    hint: "Flips about the left/right edge — the back's columns reverse. Most printers' default.",
  },
  {
    value: "short",
    label: "Short edge",
    hint: "Flips about the top/bottom edge — the back's rows reverse instead.",
  },
];

export default function BlankPlaceholderSheets() {
  const [countText, setCountText] = useState(DEFAULT_COUNT);
  const [formatId, setFormatId] = useState(DEFAULT_SHEET_FORMAT.id);
  const [flipEdge, setFlipEdge] = useState<FlipEdge>(DEFAULT_FLIP_EDGE);
  const [duplex, setDuplex] = useState(true);
  const [printError, setPrintError] = useState("");

  // One ref per rendered side. The print body is these elements concatenated,
  // so what goes to the printer is literally what is on screen — the same
  // guarantee /print/shipping gets from serializing its single label.
  const sheetRefs = useRef<(HTMLDivElement | null)[]>([]);

  const format: SheetFormat =
    SHEET_FORMATS.find((f) => f.id === formatId) ?? DEFAULT_SHEET_FORMAT;

  // Digits only, not `parseInt`: parseInt("9abc") is 9, so a typo would print
  // nine sheets while the field still showed the typo back to you.
  const count = /^\d+$/.test(countText.trim())
    ? Number.parseInt(countText.trim(), 10)
    : Number.NaN;
  const countIsValid =
    Number.isInteger(count) && count >= 1 && count <= MAX_PLACEHOLDERS;

  const sheets = useMemo(
    () =>
      countIsValid ? layoutSheets(count, format, { flipEdge, duplex }) : [],
    [countIsValid, count, format, flipEdge, duplex],
  );

  const paperCount = countIsValid ? sheetCountFor(count, format) : 0;
  const perSheet = cellsPerSheet(format);

  const reset = useCallback(() => {
    setCountText(DEFAULT_COUNT);
    setFormatId(DEFAULT_SHEET_FORMAT.id);
    setFlipEdge(DEFAULT_FLIP_EDGE);
    setDuplex(true);
    setPrintError("");
  }, []);

  const handlePrint = useCallback(async () => {
    const bodyHtml = sheetRefs.current
      .slice(0, sheets.length)
      .map((el) => el?.outerHTML ?? "")
      .join("");
    if (!bodyHtml) return;

    setPrintError("");
    try {
      await printHtmlDocument({
        title: `Placeholder sheets — ${count} card${count === 1 ? "" : "s"}`,
        bodyHtml,
        // Empty on purpose: every style is inline on the sheet elements, which
        // is the only kind that survives into the isolated print document.
        css: "",
        page: { widthIn: format.pageWidthIn, heightIn: format.pageHeightIn },
      });
    } catch (error) {
      setPrintError(
        error instanceof Error
          ? error.message
          : "Could not open the print dialog.",
      );
    }
  }, [sheets.length, count, format]);

  return (
    <div
      className="flex flex-col items-center gap-8 py-12 px-4"
      // Escape cancels — it puts the form back to its defaults rather than
      // navigating away, which is what "cancel" means on a page with no
      // destination to return to.
      //
      // Guarded against text fields deliberately. This handler sits on the
      // wrapper, so it fires for any focused descendant, and without the guard
      // pressing Escape midway through retyping the count silently reverted the
      // field to 9 with no cue that anything had happened. Inside a text field
      // Escape already means "undo my typing" to the browser, not "reset this
      // whole form". The reset needs no extra announcement machinery: it
      // rewrites the aria-live summary below, which is what gets picked up.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && active.type === "text") return;
        reset();
      }}
    >
      <div className="text-center">
        <Squares2X2Icon className="w-16 h-16 text-neon-purple mx-auto mb-4" />
        {/* h3: PrintLayout owns the h1, and the page owns the h2 above this
            section (NEO-145 / NEO-152). */}
        <h3 className="text-2xl font-bold mb-2">Blank placeholder sheets</h3>
        <p className="text-gray-400 max-w-md">
          Print a 3 × 3 grid of 2.5&quot; × 3.5&quot; placeholders — one sheet
          fills one 9-pocket binder page. Cut along the guides.
        </p>
      </div>

      <form
        className="w-full max-w-md space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          void handlePrint();
        }}
      >
        <div>
          <label htmlFor="placeholder-count" className={LABEL_CLASS}>
            How many placeholders
          </label>
          <Input
            bare
            id="placeholder-count"
            type="text"
            inputMode="numeric"
            value={countText}
            onChange={(e) => setCountText(e.target.value)}
            className={FIELD_CLASS}
            placeholder="9"
            // When the value is out of range the explanation lives under the
            // submit button, so it has to be pointed at from HERE too — a
            // screen reader user sitting in the invalid field would otherwise
            // be told it is invalid with no way to hear why.
            aria-invalid={!countIsValid}
            aria-describedby={
              countIsValid
                ? "placeholder-count-hint"
                : "placeholder-count-hint print-requirements"
            }
          />
          <p id="placeholder-count-hint" className="text-xs text-slate-400 mt-1">
            1 to {MAX_PLACEHOLDERS}. {perSheet} fit on a sheet.
          </p>
        </div>

        {/*
          Radio groups rather than <select>s, and not for looks: the headless
          E2E driver can only reach the FIRST <select> on a page, so a stack of
          two dropdowns would leave the flip-edge setting — the one thing on
          this page that can silently ruin a print run — permanently untestable.
          Native radios also give arrow-key navigation for free.
        */}
        <fieldset>
          <legend className={LABEL_CLASS}>Paper size</legend>
          <div className="space-y-2">
            {SHEET_FORMATS.map((option) => (
              <label
                key={option.id}
                className="flex items-start gap-3 rounded-lg border border-slate-800 p-3 cursor-pointer hover:bg-slate-900/60 focus-within:ring-2 focus-within:ring-neon-purple"
              >
                <input
                  type="radio"
                  name="sheet-format"
                  value={option.id}
                  checked={formatId === option.id}
                  onChange={() => setFormatId(option.id)}
                  className="mt-1 accent-[#A44AFF]"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-200">
                    {option.label}
                  </span>
                  <span className="block text-xs text-slate-400">
                    {option.marginXIn}&quot; side margins,{" "}
                    {option.marginYIn}&quot; top and bottom
                  </span>
                </span>
              </label>
            ))}
          </div>
          {/* Portrait only. Rotating the block fits eight cells, which is not a
              binder page, and leaves a tighter margin — worse on both counts,
              so there is no orientation choice to offer. */}
          <p className="text-xs text-slate-400 mt-2">
            Portrait only — landscape fits eight cards, not a full binder page.
          </p>
        </fieldset>

        <fieldset>
          <legend className={LABEL_CLASS}>Two-sided printing</legend>
          <label className="flex items-start gap-3 rounded-lg border border-slate-800 p-3 cursor-pointer hover:bg-slate-900/60 focus-within:ring-2 focus-within:ring-neon-purple">
            <input
              type="checkbox"
              checked={duplex}
              onChange={(e) => setDuplex(e.target.checked)}
              className="mt-1 accent-[#A44AFF]"
            />
            <span className="text-sm text-slate-200">
              Print backs too
              <span className="block text-xs text-slate-400">
                Adds a mirrored back for every sheet.
              </span>
            </span>
          </label>

          {/* A nested fieldset, not a div with a styled span: these two radios
              are their own group, and a bare span is invisible to the
              accessibility tree — it left both options reporting the OUTER
              "Two-sided printing" legend as their group name, which is the
              wrong context for the one setting on this page that can ruin a
              print run. */}
          {duplex && (
            <fieldset className="mt-3 space-y-2">
              <legend className={LABEL_CLASS}>
                Which edge your printer flips
              </legend>
              {FLIP_EDGE_CHOICES.map((choice) => (
                <label
                  key={choice.value}
                  className="flex items-start gap-3 rounded-lg border border-slate-800 p-3 cursor-pointer hover:bg-slate-900/60 focus-within:ring-2 focus-within:ring-neon-purple"
                >
                  <input
                    type="radio"
                    name="flip-edge"
                    value={choice.value}
                    checked={flipEdge === choice.value}
                    onChange={() => setFlipEdge(choice.value)}
                    className="mt-1 accent-[#A44AFF]"
                  />
                  <span>
                    <span className="block text-sm font-medium text-slate-200">
                      {choice.label}
                    </span>
                    <span className="block text-xs text-slate-400">
                      {choice.hint}
                    </span>
                  </span>
                </label>
              ))}
              <p className="text-xs text-slate-400">
                Copy this from your printer&apos;s two-sided setting. Get it
                wrong and every back lands on the wrong card.
              </p>
            </fieldset>
          )}
        </fieldset>

        <div className="flex flex-col items-center pt-2">
          <div className="flex items-center gap-4">
            <NeonButton
              type="submit"
              disabled={!countIsValid}
              size="3"
              aria-describedby="print-requirements"
            >
              <PrinterIcon className="w-5 h-5 mr-2" />
              Print Sheets
            </NeonButton>
            <button
              type="button"
              onClick={reset}
              className="text-sm text-slate-400 hover:text-slate-200 underline p-2 -m-2"
            >
              Reset
            </button>
          </div>
          {/* A natively-disabled button drops out of the tab order and
              announces only as "unavailable", with no clue what is missing. */}
          {!countIsValid && (
            <p
              id="print-requirements"
              className="text-xs text-slate-400 text-center mt-2"
            >
              Enter a whole number from 1 to {MAX_PLACEHOLDERS} to enable
              printing.
            </p>
          )}
        </div>

        {/* Always mounted: a live region inserted at the same moment its text
            appears is unreliably announced (notably VoiceOver). */}
        <p role="alert" className="text-sm text-neon-pink text-center">
          {printError}
        </p>
      </form>

      <div className="w-full max-w-full flex flex-col items-center gap-3">
        <h4 id="sheet-preview-heading" className="text-lg font-semibold">
          Preview
        </h4>
        {/* One composed sentence rather than three numbers side by side: it is
            the line that tells you how much paper you are about to spend, and
            it reads the same to a screen reader as it does on screen. */}
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-slate-300 text-center"
        >
          {countIsValid
            ? `${count} placeholder${count === 1 ? "" : "s"} on ${paperCount} sheet${paperCount === 1 ? "" : "s"} of ${format.shortLabel}, ${duplex ? "printed both sides" : "front only"}.`
            : "Enter a number of placeholders to see the sheets."}
        </p>

        <ul
          aria-labelledby="sheet-preview-heading"
          className="flex flex-wrap justify-center gap-6 list-none p-0"
        >
          {sheets.map((sheet, index) => (
            <li
              key={`${sheet.sheetIndex}-${sheet.side}`}
              className="flex flex-col items-center gap-2"
            >
              <span className="text-xs text-slate-400">
                Sheet {sheet.sheetIndex + 1} — {sheet.side}
              </span>
              {/*
                The scaled wrapper. `transform` does not affect layout, so the
                outer box is given the SCALED size explicitly — otherwise every
                preview would reserve a full 816 × 1056px of empty column.

                aria-hidden because the sheet is a picture of paper. Its text is
                real text (it has to be — it gets printed), so unhidden it reads
                out as ~54 fragments of "1 FRONT Sheet 1 2 FRONT Sheet 1 …" per
                pair of sheets, drowning the two lines that actually say what is
                about to print: this item's caption above, and the live summary
                over the list. Those stay in the tree; only the picture is
                hidden. Note this does NOT weaken the E2E flow — maestro-web
                builds its hierarchy by walking `node.children` directly and
                filters on neither aria-hidden nor the accessibility tree.
              */}
              <div
                aria-hidden="true"
                className="border border-neon-purple/30 rounded-lg overflow-hidden"
                style={{
                  width: `${format.pageWidthIn * CSS_PX_PER_IN * previewScale(format)}px`,
                  height: `${format.pageHeightIn * CSS_PX_PER_IN * previewScale(format)}px`,
                }}
              >
                <div
                  style={{
                    transform: `scale(${previewScale(format)})`,
                    transformOrigin: "top left",
                  }}
                >
                  <PlaceholderSheet
                    ref={(el) => {
                      sheetRefs.current[index] = el;
                    }}
                    sheet={sheet}
                    format={format}
                    totalSheets={paperCount}
                    // Every side but the last starts a new sheet of paper.
                    pageBreakAfter={index < sheets.length - 1}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>

        <p className="text-xs text-gray-400 text-center max-w-md">
          Shown reduced to fit. Print at 100% scale — not &quot;fit to
          page&quot; — or the cut cards will not fit the pockets.
        </p>
      </div>
    </div>
  );
}

/** How far the preview shrinks a sheet to fit a page column. */
function previewScale(format: SheetFormat): number {
  return PREVIEW_WIDTH_PX / (format.pageWidthIn * CSS_PX_PER_IN);
}
