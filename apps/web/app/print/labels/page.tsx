import { useCallback, useRef, useState } from "react";
import { Link } from "react-router";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import TrackingCode from "@/components/modules/TrackingCode";
import { formatUsd } from "@/lib/format/money";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time/relative-time";
import { printHtmlDocument } from "@/lib/print/print-html";
import { DEFAULT_LABEL_FORMAT } from "@/lib/shipping/label-formats";
import { sellerMessage } from "@/lib/shipping/postage-error";

/**
 * NEO-213 — every label the seller has bought, newest first, each reprintable.
 *
 * ## Why reprint is an action and not a stored URL
 * The `labelUrl` on a purchase row is the URL EasyPost minted at purchase time,
 * and it expires. So the button does not link to it: it calls
 * `postage.refreshLabelUrl`, which re-fetches the shipment and hands back a
 * URL that works *now*. The stored one is kept only so a row is never empty.
 *
 * ## The 180-day wall
 * EasyPost deletes the label image 180 days after purchase. The shipment still
 * resolves, so the reprint call would succeed all the way to a seller-readable
 * "this label is gone" — a button that can only fail. Past the wall we say so
 * up front and render no button, the same reasoning that keeps "Buy postage"
 * off the shipping page for a seller with no EasyPost key.
 */

/**
 * Mirrors `PURCHASE_HISTORY_LIMIT` in convex/shipping.ts. Duplicated rather
 * than imported because importing the Convex module would drag the server
 * runtime into the browser bundle; the only thing this drives is the sentence
 * that discloses the cap, and a stale copy would understate rather than lie.
 */
const HISTORY_LIMIT = 25;

/** EasyPost's label-image retention. Past this a reprint has nothing to fetch. */
const LABEL_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

type LabelPurchase = FunctionReturnType<
  typeof api.shipping.listMyLabelPurchases
>[number];

export default function LabelHistoryPage() {
  const purchases = useQuery(api.shipping.listMyLabelPurchases);
  const refreshLabelUrl = useAction(api.postage.refreshLabelUrl);

  /** The row whose reprint is in flight — at most one at a time. */
  const [reprintingId, setReprintingId] = useState<Id<"labelPurchases"> | null>(
    null,
  );
  /** Per-row failure text, keyed by row id. */
  const [errors, setErrors] = useState<Record<string, string>>({});

  /**
   * Row headings, so focus can be put back after a reprint settles.
   *
   * The Reprint button is natively disabled while it runs, and a browser blurs
   * a button the moment it becomes disabled — a keyboard user would be dropped
   * to the top of the document mid-flow, with 25 rows to tab back through.
   * pipeline-runs solved the same problem the same way, which is why the
   * heading carries a focus-visible ring of its own.
   */
  const headingRefs = useRef(new Map<string, HTMLHeadingElement | null>());

  /**
   * One instant for the whole list. Rows formatted a few milliseconds apart
   * could otherwise disagree about which side of a boundary they sit on — the
   * reason `formatRelativeTime` takes `now` rather than reading the clock.
   */
  const now = Date.now();

  const handleReprint = useCallback(
    async (row: LabelPurchase) => {
      setReprintingId(row._id);
      setErrors((prev) => ({ ...prev, [row._id]: "" }));
      try {
        // Never the stored `row.labelUrl`: that URL has probably expired, and
        // printing an expired URL yields a blank 6×4 sheet with no error.
        const { labelUrl } = await refreshLabelUrl({ purchaseId: row._id });
        await printHtmlDocument({
          title: `Postage label — ${row.toAddress.name || "label"}`,
          // Sized to the page rather than left at natural size, exactly as the
          // original purchase print does: EasyPost's 6x4 PNG is a known aspect
          // ratio, and letting it overflow clips the barcode a carrier scans.
          bodyHtml: `<img src="${labelUrl}" alt="" style="width:${DEFAULT_LABEL_FORMAT.widthIn}in;height:${DEFAULT_LABEL_FORMAT.heightIn}in;display:block">`,
          css: "",
          page: {
            widthIn: DEFAULT_LABEL_FORMAT.widthIn,
            heightIn: DEFAULT_LABEL_FORMAT.heightIn,
          },
        });
      } catch (error) {
        // A ConvexError's message is the seller-actionable one the backend
        // chose ("this label expired", "add your EasyPost key"); anything else
        // — including a print-dialog failure — gets the fallback.
        setErrors((prev) => ({
          ...prev,
          [row._id]: sellerMessage(error, "Could not reprint the label."),
        }));
      } finally {
        setReprintingId(null);
        headingRefs.current.get(row._id)?.focus();
      }
    },
    [refreshLabelUrl],
  );

  return (
    <section className="space-y-6">
      <div>
        {/* h2, not h1: the "Print Shop" h1 lives in PrintLayout (NEO-145). */}
        <h2 className="text-3xl font-bold mb-2">Label History</h2>
        <p className="text-slate-400">
          Every label you&apos;ve bought, newest first. Reprint one without
          paying for it twice.
        </p>
      </div>

      {purchases === undefined && (
        <p className="text-sm text-slate-400">Digging through the shoebox…</p>
      )}

      {purchases !== undefined && purchases.length === 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-6 text-center space-y-2">
          <p className="text-slate-300">No labels yet — nothing to reprint.</p>
          <p className="text-sm text-slate-400">
            Buy postage over on{" "}
            <Link
              to="/print/shipping"
              className="text-neon-teal hover:text-neon-teal/80 underline focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm"
            >
              Shipping
            </Link>{" "}
            and every label lands here.
          </p>
        </div>
      )}

      {/* The cap is a real edge of the data, not a paging control: purchase 26
          is not off-screen, it is not loaded. Say so rather than let a seller
          conclude an older label was never saved. */}
      {purchases !== undefined && purchases.length >= HISTORY_LIMIT && (
        <p className="text-xs text-slate-500">
          Showing your {HISTORY_LIMIT} most recent label purchases.
        </p>
      )}

      {purchases !== undefined && purchases.length > 0 && (
        // A list of rows rather than a <table>: at the 1024px-wide headless
        // viewport, minus the tab rail, a tracking number plus an address plus
        // a button do not fit in columns, and a table that scrolls sideways
        // puts the Reprint button somewhere the E2E driver cannot reach (it
        // cannot scroll horizontally). Same data, no horizontal overflow.
        <ul className="space-y-3">
          {purchases.map((row) => {
            const expired = now - row.purchasedAt > LABEL_RETENTION_MS;
            const busy = reprintingId === row._id;
            const recipient = row.toAddress.name || "this label";
            return (
              <li
                key={row._id}
                className="rounded-lg border border-slate-800 bg-slate-900/40 p-4"
              >
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <h3
                    ref={(el) => {
                      headingRefs.current.set(row._id, el);
                    }}
                    tabIndex={-1}
                    // Focus lands here after every reprint attempt, so it needs
                    // a ring of its own — `outline-none` alone would leave a
                    // keyboard user with no idea where focus went (WCAG 2.4.7).
                    className="text-base font-semibold outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon-blue"
                  >
                    {row.toAddress.name}
                  </h3>
                  <span className="ml-auto">
                    {expired ? (
                      // No button: EasyPost has deleted the image, so the only
                      // thing a press could produce is a failure message.
                      <span className="text-xs text-slate-500">
                        Label expired — EasyPost keeps labels for 180 days
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleReprint(row)}
                        disabled={busy}
                        // The visible word is "Reprint" on every row, so the
                        // accessible name has to say WHICH label — otherwise a
                        // screen reader hears the same button 25 times.
                        aria-label={`Reprint the label for ${recipient}`}
                        className="rounded-md border border-neon-teal/40 px-3 py-1.5 text-sm font-medium text-neon-teal transition-colors hover:border-neon-teal hover:bg-neon-teal/10 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-green-500"
                      >
                        {busy ? "Reprinting…" : "Reprint"}
                      </button>
                    )}
                  </span>
                </div>

                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  <div className="flex gap-2">
                    <dt className="text-slate-400">Purchased</dt>
                    <dd className="text-slate-200">
                      {/* The exact timestamp is in the accessible name as well
                          as the `title`: a native tooltip is mouse-only, and
                          "3d ago" is not something to reconcile against an
                          EasyPost statement. */}
                      <time
                        dateTime={new Date(row.purchasedAt).toISOString()}
                        title={formatAbsoluteTime(row.purchasedAt)}
                        aria-label={`${formatRelativeTime(row.purchasedAt, now)} (${formatAbsoluteTime(row.purchasedAt)})`}
                      >
                        {formatRelativeTime(row.purchasedAt, now)}
                      </time>
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-slate-400">Weight</dt>
                    <dd className="text-slate-200">{row.weightOz} oz</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-slate-400">Cost</dt>
                    <dd className="text-slate-200">
                      {formatUsd(row.costCents)}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-slate-400">Tracking</dt>
                    <dd className="text-slate-200">
                      <TrackingCode
                        trackingCode={row.trackingCode}
                        copyLabel={`Copy the tracking number for ${recipient}`}
                      />
                    </dd>
                  </div>
                </dl>

                {/* Always mounted so the announcement is reliable. Reprint
                    failures are seller-actionable — an expired label, a missing
                    EasyPost key — so the backend's message is surfaced rather
                    than flattened. */}
                <p role="status" aria-live="polite" className="text-sm text-neon-pink mt-2">
                  {errors[row._id] ?? ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
