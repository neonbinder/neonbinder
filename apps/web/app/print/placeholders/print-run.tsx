import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import NeonButton from "@/components/modules/NeonButton";
import { PlaceholderSheet } from "@/components/modules/PlaceholderSheet";
import {
  DEFAULT_SHEET_FORMAT,
  SHEET_FORMATS,
  cellsPerSheet,
  type SheetFormat,
} from "@/lib/print/sheet-formats";
import { layoutSheets, sheetCountFor, type FlipEdge } from "@/lib/print/sheet-layout";
import { printHtmlDocument } from "@/lib/print/print-html";

/**
 * Reviewed pairs become paper (NEO-152 §4).
 *
 * Consumes what NEO-157 built rather than re-deriving any of it: `layoutSheets`
 * owns the 3x3 geometry, the duplex column mirroring and the flip-edge
 * handling, and `PlaceholderSheet` owns the inch-exact rendering. This file
 * adds only what is specific to real cards — the art, the guides switch, and
 * the signed URLs.
 *
 * ## Why the URLs are minted at PRINT time, synchronously
 * Card art sits behind signed GETs that expire in about fifteen minutes. A set
 * minted when the section first rendered would be stale for anyone who reviewed
 * their pairs and then went to make coffee, and a stale URL prints a blank
 * pocket — a failure you discover on paper. So Print mints a fresh set every
 * time, commits it with `flushSync` so the sheets are really in the DOM, and
 * only then serializes them. `printHtmlDocument` already waits for every image
 * to `decode()` before opening the dialog, so an image that is still fetching
 * cannot slip through half-painted.
 *
 * ## Fronts and backs come from the SHEET, not the pair
 * `layoutSheets` returns a front sheet and (for duplex) its mirrored back. The
 * item index identifies a PAIR; which face to draw is a property of the sheet
 * being rendered. Getting this backwards prints the same face on both sides,
 * which looks fine on screen and is worthless once cut.
 */

export type PrintablePair = {
  frontIndex: number;
  backIndex: number;
  player?: string;
};

/**
 * CSS defines `1in` as exactly 96px regardless of device — a unit conversion,
 * not an assumed printer DPI. The formats stay in inches and know nothing of
 * pixels.
 */
const CSS_PX_PER_IN = 96;

/** Preview width in CSS px. Two sheets sit side by side on a desktop column. */
const PREVIEW_WIDTH_PX = 300;

/** How far the preview shrinks a sheet to fit a page column. */
function previewScale(format: SheetFormat): number {
  return PREVIEW_WIDTH_PX / (format.pageWidthIn * CSS_PX_PER_IN);
}

/** One pair's two signed URLs, minted together. */
type PairArt = { front: string; back: string };

export function PrintRun({
  jobId,
  pairs,
}: {
  jobId: string;
  pairs: PrintablePair[];
}) {
  const createDownloadUrl = useAction(
    api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl,
  );

  const [formatId, setFormatId] = useState(DEFAULT_SHEET_FORMAT.id);
  const [duplex, setDuplex] = useState(true);
  const [flipEdge, setFlipEdge] = useState<FlipEdge>("long");
  const [guides, setGuides] = useState(false);
  const [art, setArt] = useState<PairArt[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const sheetRefs = useRef<(HTMLDivElement | null)[]>([]);

  /** Mint one signed URL per face, in pair order. */
  const mintArt = useCallback(
    async (forPairs: PrintablePair[]): Promise<PairArt[]> =>
      Promise.all(
        forPairs.map(async (pair) => {
          const [front, back] = await Promise.all([
            createDownloadUrl({ jobId, entryIndex: pair.frontIndex }),
            createDownloadUrl({ jobId, entryIndex: pair.backIndex }),
          ]);
          return { front: front.url, back: back.url };
        }),
      ),
    [createDownloadUrl, jobId],
  );

  // Mint for the PREVIEW as well as the print. Without this the preview shows
  // numbered rectangles and the user is asked to approve a sheet that looks
  // nothing like what comes out — the guides toggle in particular is
  // meaningless without seeing art under it.
  //
  // NOTE for the set-upload work: this is two signed-URL actions per pair, so a
  // several-hundred-card run mints several hundred URLs to draw a preview. Fine
  // at present sizes; it will want batching before then.
  const pairSignature = pairs.map((p) => `${p.frontIndex}-${p.backIndex}`).join(",");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const minted = await mintArt(pairs);
        if (!cancelled) setArt(minted);
      } catch {
        // A failed mint leaves the preview on numbered rectangles rather than
        // blank pockets, and Print re-mints anyway.
        if (!cancelled) setArt(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on WHICH pairs, not the array identity — the parent rebuilds it on
    // every render (it filters by the excluded set), so depending on `pairs`
    // itself would re-mint forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairSignature, jobId]);

  const format: SheetFormat =
    SHEET_FORMATS.find((f) => f.id === formatId) ?? DEFAULT_SHEET_FORMAT;
  const paperCount = sheetCountFor(pairs.length, format);
  const perSheet = cellsPerSheet(format);

  const handlePrint = useCallback(async () => {
    if (pairs.length === 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      // Fresh every time — see the module comment on expiry. The preview's set
      // may be many minutes old by the time someone actually prints.
      const minted = await mintArt(pairs);

      // Commit synchronously: the next line reads the DOM, and a normal
      // setState would still be queued when it did.
      flushSync(() => setArt(minted));

      const sheets = layoutSheets(pairs.length, format, { flipEdge, duplex });
      const bodyHtml = sheetRefs.current
        .slice(0, sheets.length)
        .map((el) => el?.outerHTML ?? "")
        .join("");
      if (!bodyHtml) {
        setError("Nothing to print yet — try again in a moment.");
        return;
      }

      await printHtmlDocument({
        title: `Placeholder cards — ${pairs.length} card${pairs.length === 1 ? "" : "s"}`,
        bodyHtml,
        // Empty on purpose: every style is inline on the sheet elements, which
        // is the only kind that survives into the isolated print document.
        css: "",
        page: { widthIn: format.pageWidthIn, heightIn: format.pageHeightIn },
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not open the print dialog.",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, duplex, flipEdge, format, mintArt, pairs]);

  if (pairs.length === 0) return null;

  const sheets = layoutSheets(pairs.length, format, { flipEdge, duplex });

  return (
    <section aria-labelledby="print-run-heading" className="space-y-4">
      <div>
        <h3 id="print-run-heading" className="text-2xl font-bold mb-1">
          Print your placeholders
        </h3>
        {/* The sentence that says how much paper this costs, before it costs it. */}
        <p role="status" aria-live="polite" className="text-slate-300">
          {pairs.length} card{pairs.length === 1 ? "" : "s"} on {paperCount}{" "}
          sheet{paperCount === 1 ? "" : "s"} of {format.shortLabel},{" "}
          {duplex ? "printed both sides" : "front only"}. {perSheet} fit on a
          sheet.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="block text-sm font-medium text-slate-300 mb-1">
          Paper size
        </legend>
        {SHEET_FORMATS.map((option) => (
          <label
            key={option.id}
            className="flex items-start gap-3 rounded-lg border border-slate-800 p-3 cursor-pointer hover:bg-slate-900/60 focus-within:ring-2 focus-within:ring-neon-purple"
          >
            <input
              type="radio"
              name="print-run-format"
              value={option.id}
              checked={formatId === option.id}
              onChange={() => setFormatId(option.id)}
              className="mt-1 accent-[#A44AFF]"
            />
            <span className="text-sm text-slate-200">{option.label}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="block text-sm font-medium text-slate-300 mb-1">
          Two-sided printing
        </legend>
        <label className="flex items-start gap-3 rounded-lg border border-slate-800 p-3 cursor-pointer hover:bg-slate-900/60 focus-within:ring-2 focus-within:ring-neon-purple">
          <input
            type="checkbox"
            checked={duplex}
            onChange={(e) => setDuplex(e.target.checked)}
            className="mt-1 accent-[#A44AFF]"
          />
          <span className="text-sm text-slate-200">
            Print the backs too
            <span className="block text-xs text-slate-400">
              Adds a mirrored back sheet for every front.
            </span>
          </span>
        </label>

        {duplex && (
          <fieldset className="mt-2 space-y-2">
            <legend className="block text-sm font-medium text-slate-300 mb-1">
              Which edge your printer flips
            </legend>
            {(
              [
                ["long", "Long edge", "Most printers' default."],
                ["short", "Short edge", "Flips about the top/bottom edge."],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className="flex items-start gap-3 rounded-lg border border-slate-800 p-3 cursor-pointer hover:bg-slate-900/60 focus-within:ring-2 focus-within:ring-neon-purple"
              >
                <input
                  type="radio"
                  name="print-run-flip"
                  value={value}
                  checked={flipEdge === value}
                  onChange={() => setFlipEdge(value)}
                  className="mt-1 accent-[#A44AFF]"
                />
                <span>
                  <span className="block text-sm text-slate-200">{label}</span>
                  <span className="block text-xs text-slate-400">{hint}</span>
                </span>
              </label>
            ))}
            <p className="text-xs text-slate-400">
              Copy this from your printer&apos;s two-sided setting. Get it wrong
              and every back lands on the wrong card.
            </p>
          </fieldset>
        )}
      </fieldset>

      {/* Guides default OFF for a card run — see the `guides` prop. On is the
          calibration mode you reach for when checking the duplex alignment. */}
      <label className="flex items-start gap-3 rounded-lg border border-slate-800 p-3 cursor-pointer hover:bg-slate-900/60 focus-within:ring-2 focus-within:ring-neon-purple">
        <input
          type="checkbox"
          checked={guides}
          onChange={(e) => setGuides(e.target.checked)}
          className="mt-1 accent-[#A44AFF]"
        />
        <span className="text-sm text-slate-200">
          Show cutting guides
          <span className="block text-xs text-slate-400">
            Off for a real run — the lines print over the artwork. The corner
            ticks stay either way, and the card edges themselves show you where
            to cut.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <NeonButton type="button" disabled={busy} onClick={() => void handlePrint()}>
          {busy ? "Preparing..." : "Print these"}
        </NeonButton>
        <p role="alert" className="text-sm text-neon-pink">
          {error}
        </p>
      </div>

      <div className="w-full flex flex-col items-center gap-3">
        <h4 id="print-preview-heading" className="text-lg font-semibold">
          Preview
        </h4>
        <ul
          aria-labelledby="print-preview-heading"
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
                The scale goes on a WRAPPER and never on the sheet: printing
                serializes the sheet's `outerHTML`, and a transform baked into
                that element would travel into the print document and print the
                sheet at 40% size. The sheet stays in real inches; only its
                container is scaled. `transform` does not affect layout, so the
                outer box is given the scaled size explicitly, or every preview
                would reserve a full 816 x 1056px of empty column.

                aria-hidden because it is a picture of paper — its text is real
                text (it gets printed) and unhidden it reads out as dozens of
                fragments, drowning the caption above and the summary line that
                actually say what is about to print.
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
                    guides={guides}
                    pageBreakAfter={index < sheets.length - 1}
                    // Which FACE comes from the sheet, not the pair.
                    imageForItem={(item) =>
                      sheet.side === "front"
                        ? art?.[item]?.front
                        : art?.[item]?.back
                    }
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-xs text-gray-400 text-center max-w-md">
          Shown reduced to fit. Print at 100% scale — not &quot;fit to page&quot;
          — or the cut cards will not fit the pockets.
        </p>
      </div>
    </section>
  );
}
