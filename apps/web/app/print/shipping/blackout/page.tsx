import { useCallback, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { EyeSlashIcon, PrinterIcon } from "@heroicons/react/24/outline";
import { DEFAULT_LABEL_FORMAT } from "@/lib/shipping/label-formats";
import { printHtmlDocument } from "@/lib/print/print-html";

/**
 * /print/shipping/blackout — a solid black 4×6 label (NEO-349).
 *
 * For reusing a mailer: the seller sticks it over the old shipping label so
 * the previous address and, above all, the previous barcode cannot be scanned
 * by a carrier sorting the package. It needs nothing from the seller — no
 * return address, no Convex data — so unlike /print/shipping there is no gate.
 *
 * ## Why the shared label format and not literal 4/6
 * It goes through the same printer, on the same roll, as the shipping label
 * beside it. Printing at DEFAULT_LABEL_FORMAT (laid out 6in across, 4in tall,
 * and turned onto the portrait 4×6 stock by print-html exactly as the shipping
 * label is) means a printer already set up for shipping labels prints this one
 * square too, and a future format change moves both together.
 */

const { widthIn, heightIn } = DEFAULT_LABEL_FORMAT;

/**
 * The printed page, in full. Pure black edge to edge — the print document's
 * background is overridden as well as the block, so a printer that rounds the
 * page a hair larger still prints black rather than a white sliver. The block
 * is the label's own 6×4 and print-html turns it onto the 4×6 paper; the CSS
 * sets colour only, because print-html owns the page and body size (pinned to
 * the paper and clipped, so rounding never spills a blank second label) and a
 * 6×4 size here would clip the turned block to the top 4in of the paper.
 * print-html already pins `print-color-adjust: exact`, without which browsers
 * drop backgrounds and this would print a blank sheet.
 */
const BLACKOUT_BODY_HTML = `<div style="width:${widthIn}in;height:${heightIn}in;background:#000;display:block"></div>`;
const BLACKOUT_CSS = "html, body { background: #000; }";

export default function BlackoutLabelPage() {
  const [printError, setPrintError] = useState("");

  const handlePrint = useCallback(async () => {
    setPrintError("");
    try {
      await printHtmlDocument({
        title: "Blackout label",
        bodyHtml: BLACKOUT_BODY_HTML,
        css: BLACKOUT_CSS,
        page: { widthIn, heightIn },
      });
    } catch (error) {
      setPrintError(
        error instanceof Error ? error.message : "Could not open the print dialog.",
      );
    }
  }, []);

  return (
    <div className="flex flex-col items-center gap-8 py-12 px-4">
      <div className="text-center">
        <EyeSlashIcon
          className="w-16 h-16 text-neon-yellow-text mx-auto mb-4"
          aria-hidden="true"
        />
        {/* h2, not h1: the "Print Shop" h1 lives in PrintLayout (NEO-145). */}
        <h2 className="text-3xl font-bold mb-2">Blackout Label</h2>
        <p className="text-ink-3 max-w-md">
          Reusing a mailer? Print a solid black 4&Prime; × 6&Prime; label and
          stick it right over the old one, barcode and all.
        </p>
      </div>

      {/* The button sits above the preview, not below it: there is nothing to
          fill in first, and a 4in-tall preview would otherwise push the only
          control on the page under the fold. */}
      <div className="flex flex-col items-center gap-3">
        <NeonButton size="3" onClick={() => void handlePrint()}>
          <PrinterIcon className="w-5 h-5 mr-2" aria-hidden="true" />
          Print Blackout Label
        </NeonButton>
        {/* Always mounted: a live region inserted at the same moment its text
            appears is unreliably announced (notably VoiceOver). */}
        <p role="alert" className="text-sm text-neon-pink-text text-center">
          {printError}
        </p>
      </div>

      {/* Same 1:1 preview as /print/shipping. At 96dpi a 6in label is 576px, so
          it fits a desktop column at actual size; narrower screens scroll it
          rather than shrinking it, so what you see stays true to size. */}
      <div className="w-full max-w-full flex flex-col items-center gap-3">
        <h3 id="blackout-preview-heading" className="text-lg font-semibold">
          Preview
        </h3>
        {/* tabIndex makes the scroll container reachable: on a narrow viewport
            the 6in label overflows, and without it only a pointer could pan. */}
        <div
          role="group"
          aria-labelledby="blackout-preview-heading"
          tabIndex={0}
          className="max-w-full overflow-x-auto rounded-lg focus-outline"
        >
          <div className="border border-neon-yellow/30 rounded-lg p-2 bg-ink/5 w-fit">
            {/* Pure #000, not a theme near-black: this is the ink that prints.
                The soft glow is screen-only — it lifts a black slab off a dark
                page so it reads as a label rather than a hole. */}
            <div
              role="img"
              aria-label={`A solid black ${heightIn} by ${widthIn} inch label`}
              className="shadow-[0_0_24px_rgba(255,230,0,0.12)]"
              style={{
                width: `${widthIn}in`,
                height: `${heightIn}in`,
                background: "#000",
              }}
            />
          </div>
        </div>
        <p className="text-xs text-ink-3 text-center max-w-md">
          Shown at actual size. Print at 100% scale — not &quot;fit to
          page&quot; — so the black covers the label edge to edge.
        </p>
      </div>
    </div>
  );
}
