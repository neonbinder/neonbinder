import { useCallback, useRef, useState } from "react";
import { Link } from "react-router";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import TrackingCode from "@/components/modules/TrackingCode";
import { formatUsd } from "@/lib/format/money";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time/relative-time";
import { imageBodyHtml, printHtmlDocument } from "@/lib/print/print-html";
import { DEFAULT_LABEL_FORMAT } from "@/lib/shipping/label-formats";
import { sellerMessage } from "@/lib/shipping/postage-error";
import {
  describeTrackingStatus,
  formatScanPlace,
  glossScanMessage,
  isHttpsUrl,
  type TrackingTone,
} from "@/lib/shipping/tracking-status";

/**
 * NEO-213 — every label the seller has bought, newest first, each reprintable.
 * NEO-121 — and what USPS has scanned since.
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
 *
 * ## Why scans landed here rather than on a page of their own (NEO-121)
 * A second screen listing the same 25 purchases would have been the same rows
 * at the same grain under a different name. The scan timeline is another column
 * of the thing this page already is.
 *
 * Scans arrive two ways and both write the same row fields: EasyPost's webhook
 * pushes `tracker.updated` as USPS scans, and "Check for new scans" pulls the
 * tracker on demand. The pull exists because the push can be missing — a seller
 * who bought labels before webhooks shipped, a registration that has not caught
 * up yet — and because it is the only path a test can drive. It is not a
 * refresh button in the "reload the page" sense: the query is live, so a
 * webhook-delivered scan appears here with nothing pressed.
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

type Scan = NonNullable<LabelPurchase["scans"]>[number];

/**
 * A row's one-line status message, and whether it is bad news.
 *
 * Both the reprint failure and the scan-check result land in the SAME live
 * region per row — two live regions in one row race each other and a screen
 * reader announces whichever won. The tone is what keeps "2 new scans" from
 * being painted in the failure colour.
 */
type RowStatus = { text: string; tone: "info" | "error" };

/**
 * Pill colours per tone.
 *
 * All four foregrounds clear WCAG AA on this page's near-black background with
 * room to spare (the dimmest, slate-300, is ~14:1). `text-slate-500` — which
 * NEO-119 pulled out of the operator screens — would not, and is why the idle
 * state uses slate-300 on a filled chip rather than dim grey text.
 */
const TONE_CLASSES: Record<TrackingTone, string> = {
  idle: "border-slate-600 bg-slate-800/60 text-slate-300",
  moving: "border-neon-blue/60 bg-neon-blue/10 text-neon-blue",
  done: "border-neon-green/60 bg-neon-green/10 text-neon-green",
  warn: "border-neon-yellow/60 bg-neon-yellow/10 text-neon-yellow",
};

/**
 * What a failed webhook registration means, in the seller's terms.
 *
 * The backend stores an NB-authored enum rather than EasyPost's own error text,
 * because EasyPost echoes the rejected URL back and that URL carries the
 * seller's webhook token. So the sentence is written here, from the enum.
 */
const SETUP_ERROR_HINTS: Record<string, string> = {
  no_key: "We don't have an EasyPost key for you yet.",
  unauthorized: "EasyPost turned that key down — re-save it and we'll retry.",
  rejected: "EasyPost wouldn't accept our updates address. We'll try again.",
  unavailable: "Couldn't reach EasyPost. We'll try again on your next label.",
};

/**
 * "Scan updates: on / connecting… / not connected yet".
 *
 * A seller whose webhook never registered would otherwise sit looking at rows
 * that say "no scans yet" forever, with no way to tell that from a letter USPS
 * genuinely has not touched. This chip is the difference between the two.
 */
function ScanUpdatesChip() {
  const setup = useQuery(api.shipmentTracking.getMyTrackingSetup);

  // Nothing at all while it loads: flashing "not connected yet" at a seller
  // whose webhook is fine is worse than a beat of silence.
  if (setup === undefined) return null;

  if (setup.connected) {
    return (
      <p className="text-sm">
        <span className="text-slate-400">Scan updates:</span>{" "}
        <span className="text-neon-green font-medium">on</span>
      </p>
    );
  }

  if (setup.pending) {
    return (
      <p className="text-sm">
        <span className="text-slate-400">Scan updates:</span>{" "}
        <span className="text-neon-blue font-medium">connecting…</span>
      </p>
    );
  }

  const hint = setup.lastError ? SETUP_ERROR_HINTS[setup.lastError] : undefined;

  return (
    <p className="text-sm">
      <span className="text-slate-400">Scan updates:</span>{" "}
      <span className="text-neon-yellow font-medium">not connected yet</span>{" "}
      <span className="text-slate-300">
        {hint ? `${hint} ` : ""}Buy a label or re-save your EasyPost key on{" "}
        {/* Deliberately not named "Shipping" or "Postage" in isolation: the
            visible words have to say where the seller is being sent, and
            /print/shipping is a different page with a similar name. */}
        <Link
          to="/profile/postage"
          className="text-neon-teal hover:text-neon-teal/80 underline focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm"
        >
          your profile
        </Link>
        .
      </span>
    </p>
  );
}

/**
 * The result sentence for a "Check for new scans" press.
 *
 * `cooldown` is the server answering from the stored row instead of calling
 * EasyPost — a 60-second guard so a click loop cannot burn the seller's API key
 * or 429 the buy path. It is NOT a failure, so it does not read as one; it just
 * says when to try again.
 */
function refreshResultText(result: {
  newScans: number;
  cooldown: boolean;
}): string {
  if (result.cooldown) return "Checked a moment ago — try again in a minute.";
  if (result.newScans === 1) return "1 new scan.";
  if (result.newScans > 1) return `${result.newScans} new scans.`;
  return "No new scans yet.";
}

export default function LabelHistoryPage() {
  const purchases = useQuery(api.shipping.listMyLabelPurchases);
  const refreshLabelUrl = useAction(api.postage.refreshLabelUrl);
  const refreshTracking = useAction(api.postage.refreshTracking);

  /** The row whose reprint is in flight — at most one at a time. */
  const [reprintingId, setReprintingId] = useState<Id<"labelPurchases"> | null>(
    null,
  );
  /** The row whose scan check is in flight — likewise one at a time. */
  const [checkingId, setCheckingId] = useState<Id<"labelPurchases"> | null>(
    null,
  );
  /** Per-row status text, keyed by row id. */
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  /** Which rows have their scan timeline open. */
  const [openScans, setOpenScans] = useState<Record<string, boolean>>({});

  /**
   * Row headings, so focus can be put back after a reprint or a scan check
   * settles.
   *
   * Both buttons are natively disabled while they run, and a browser blurs a
   * button the moment it becomes disabled — a keyboard user would be dropped
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
      setStatuses((prev) => ({ ...prev, [row._id]: { text: "", tone: "info" } }));
      try {
        // Never the stored `row.labelUrl`: that URL has probably expired, and
        // printing an expired URL yields a blank 6×4 sheet with no error.
        const { labelUrl } = await refreshLabelUrl({ purchaseId: row._id });
        await printHtmlDocument({
          title: `Postage label — ${row.toAddress.name || "label"}`,
          // Sized to the page rather than left at natural size, exactly as the
          // original purchase print does: EasyPost's 6x4 PNG is a known aspect
          // ratio, and letting it overflow clips the barcode a carrier scans.
          // The URL is escaped and scheme-checked by the helper — it comes from
          // EasyPost and lands in a same-origin iframe.
          bodyHtml: imageBodyHtml({
            src: labelUrl,
            widthIn: DEFAULT_LABEL_FORMAT.widthIn,
            heightIn: DEFAULT_LABEL_FORMAT.heightIn,
          }),
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
        setStatuses((prev) => ({
          ...prev,
          [row._id]: {
            text: sellerMessage(error, "Could not reprint the label."),
            tone: "error",
          },
        }));
      } finally {
        setReprintingId(null);
        headingRefs.current.get(row._id)?.focus();
      }
    },
    [refreshLabelUrl],
  );

  const handleCheckScans = useCallback(
    async (row: LabelPurchase) => {
      setCheckingId(row._id);
      setStatuses((prev) => ({ ...prev, [row._id]: { text: "", tone: "info" } }));
      try {
        const result = await refreshTracking({ purchaseId: row._id });
        setStatuses((prev) => ({
          ...prev,
          [row._id]: { text: refreshResultText(result), tone: "info" },
        }));
      } catch (error) {
        // Same rule as reprint: only a ConvexError's own data survives prod
        // redaction, and it is the sentence that tells the seller whether to
        // fix their key or just wait.
        setStatuses((prev) => ({
          ...prev,
          [row._id]: {
            text: sellerMessage(error, "Could not check for new scans."),
            tone: "error",
          },
        }));
      } finally {
        setCheckingId(null);
        headingRefs.current.get(row._id)?.focus();
      }
    },
    [refreshTracking],
  );

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        {/* h2, not h1: the "Print Shop" h1 lives in PrintLayout (NEO-145). */}
        <h2 className="text-3xl font-bold mb-2">Label History</h2>
        <p className="text-slate-400">
          Every label you&apos;ve bought, newest first. Reprint one without
          paying for it twice.
        </p>
        {/* The expectation line. A seller who has used eBay reads "tracking"
            as a delivery guarantee; a First-Class letter is nothing of the
            kind, and the honest version has to be on the page rather than in
            a support reply after the first "it never says delivered". */}
        <p className="text-sm text-slate-300">
          What the scans tell you: USPS scans a letter as it runs the sorting
          machines. Nothing scans it when you drop it off, and the last scan is
          your buyer&apos;s own post office marking it{" "}
          <span className="font-medium">out for delivery</span> — no scan ever
          confirms the mailbox. That one is the finish line.
        </p>
        <ScanUpdatesChip />
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
        <p className="text-xs text-slate-400">
          Showing your {HISTORY_LIMIT} most recent label purchases.
        </p>
      )}

      {purchases !== undefined && purchases.length > 0 && (
        // A list of rows rather than a <table>: at the 1024px-wide headless
        // viewport, minus the tab rail, a tracking number plus an address plus
        // a button do not fit in columns, and a table that scrolls sideways
        // puts the Reprint button somewhere the E2E driver cannot reach (it
        // cannot scroll horizontally). Same data, no horizontal overflow.
        // NEO-121 added a pill, a scan line and a disclosure to each row and
        // kept every one of them inside this constraint — the row grew
        // downward, never sideways.
        <ul className="space-y-3">
          {purchases.map((row) => {
            const expired = now - row.purchasedAt > LABEL_RETENTION_MS;
            const busy = reprintingId === row._id;
            const checking = checkingId === row._id;
            const recipient = row.toAddress.name || "this label";
            const status = describeTrackingStatus(row.trackingStatus);
            // Copied before sorting: the array on the row is Convex's, and
            // EasyPost's own ordering is not something to depend on. Oldest
            // first, which is the order the timeline reads in.
            const scans: Scan[] = [...(row.scans ?? [])].sort(
              (a, b) => a.at - b.at,
            );
            const newest = scans.length > 0 ? scans[scans.length - 1] : undefined;
            const scansOpen = Boolean(openScans[row._id]);
            const scansId = `scans-${row._id}`;
            const rowStatus = statuses[row._id];
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
                    // Focus lands here after every reprint and every scan
                    // check, so it needs a ring of its own — `outline-none`
                    // alone would leave a keyboard user with no idea where
                    // focus went (WCAG 2.4.7).
                    className="text-base font-semibold outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon-blue"
                  >
                    {row.toAddress.name}
                  </h3>
                  {/* Words, not a colour: the tone is a second channel, never
                      the only one (WCAG 1.4.1). */}
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[status.tone]}`}
                  >
                    {status.label}
                  </span>
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCheckScans(row)}
                      disabled={checking}
                      // Every row shows the same words, so the accessible name
                      // has to say WHICH label — and it keeps the visible text
                      // as its prefix so voice input can address it (2.5.3).
                      aria-label={
                        checking
                          ? `Checking for new scans for ${recipient}`
                          : `Check for new scans for ${recipient}`
                      }
                      className="rounded-md border border-slate-600 px-3 py-1.5 text-sm font-medium text-slate-200 transition-colors hover:border-slate-400 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-green-500"
                    >
                      {checking ? "Checking…" : "Check for new scans"}
                    </button>
                    {expired ? (
                      // No reprint button: EasyPost has deleted the image, so
                      // the only thing a press could produce is a failure
                      // message. Scans outlive the image, which is why the
                      // check button above is still here.
                      <span className="text-xs text-slate-400">
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
                        //
                        // It tracks the visible label rather than staying fixed
                        // (WCAG 2.5.3): once the button reads "Reprinting…", an
                        // accessible name still saying "Reprint the label for…"
                        // no longer contains the visible text, so a voice-input
                        // user's "click Reprinting" would not match anything.
                        aria-label={
                          busy
                            ? `Reprinting the label for ${recipient}`
                            : `Reprint the label for ${recipient}`
                        }
                        className="rounded-md border border-neon-teal/60 px-3 py-1.5 text-sm font-medium text-neon-teal transition-colors hover:border-neon-teal hover:bg-neon-teal/10 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-green-500"
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
                      {/* EasyPost mints a public tracking page for every
                          tracker — the one thing the ticket said an aggregator
                          would have been bought for. Scheme-checked here as
                          well as server-side: the value arrives in a webhook
                          body, which is seller-forgeable. */}
                      {isHttpsUrl(row.publicTrackingUrl) && (
                        <a
                          href={row.publicTrackingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-sm text-neon-teal hover:text-neon-teal/80 underline focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm"
                        >
                          Public scan page
                          {/* Visible arrow for sighted users, spelled out for
                              everyone else — a link that steals the tab with
                              no warning is WCAG 3.2.5. */}
                          <span aria-hidden="true"> ↗</span>
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      )}
                    </dd>
                  </div>
                  {newest && (
                    // Full width: USPS's message plus a town plus an age does
                    // not fit in a half-column at 1024px, and this is the line
                    // the whole feature exists for.
                    <div className="flex gap-2 sm:col-span-2">
                      <dt className="text-slate-400">Latest scan</dt>
                      <dd className="text-slate-200">
                        {glossScanMessage(newest.message)}
                        {formatScanPlace(newest) && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span className="sr-only">, </span>
                            {formatScanPlace(newest)}
                          </>
                        )}
                        <span aria-hidden="true"> · </span>
                        <span className="sr-only">, </span>
                        <time
                          dateTime={new Date(newest.at).toISOString()}
                          title={formatAbsoluteTime(newest.at)}
                          aria-label={`${formatRelativeTime(newest.at, now)} (${formatAbsoluteTime(newest.at)})`}
                        >
                          {formatRelativeTime(newest.at, now)}
                        </time>
                      </dd>
                    </div>
                  )}
                </dl>

                {scans.length > 0 && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() =>
                        setOpenScans((prev) => ({
                          ...prev,
                          [row._id]: !prev[row._id],
                        }))
                      }
                      aria-expanded={scansOpen}
                      aria-controls={scansId}
                      // Visible text first so it is a prefix of the accessible
                      // name (2.5.3); the recipient is appended because 25 rows
                      // would otherwise announce 25 identical buttons.
                      aria-label={`${scansOpen ? "Hide" : "Show"} all scans (${scans.length}) for ${recipient}`}
                      className="text-sm text-neon-teal hover:text-neon-teal/80 underline focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm"
                    >
                      {scansOpen ? "Hide" : "Show"} all scans ({scans.length})
                    </button>
                    {/* Kept mounted and toggled with `hidden` rather than
                        unmounted: `aria-controls` above must point at an
                        element that exists, and `hidden` takes it out of the
                        accessibility tree exactly as removing it would. */}
                    <ol
                      id={scansId}
                      hidden={!scansOpen}
                      aria-label={`USPS scans for ${recipient}`}
                      className="mt-2 space-y-1 border-l border-slate-800 pl-3 text-sm"
                    >
                      {scans.map((scan, index) => (
                        <li
                          key={`${scan.at}-${index}`}
                          className="text-slate-200"
                        >
                          {/* Absolute times here, relative on the summary
                              line. Opening the timeline is what a seller does
                              when "2d ago" stopped being enough. */}
                          <time
                            dateTime={new Date(scan.at).toISOString()}
                            className="text-slate-400"
                          >
                            {formatAbsoluteTime(scan.at)}
                          </time>
                          <span aria-hidden="true"> · </span>
                          <span className="sr-only">, </span>
                          {glossScanMessage(scan.message)}
                          {formatScanPlace(scan) && (
                            <>
                              <span aria-hidden="true"> · </span>
                              <span className="sr-only">, </span>
                              {formatScanPlace(scan)}
                            </>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {/* Always mounted so the announcement is reliable, and ONE per
                    row: reprint failures and scan-check results share it rather
                    than racing each other. Reprint and refresh failures are
                    seller-actionable — an expired label, a missing EasyPost key
                    — so the backend's message is surfaced rather than
                    flattened. */}
                <p
                  role="status"
                  aria-live="polite"
                  className={`text-sm mt-2 ${rowStatus?.tone === "error" ? "text-neon-pink" : "text-slate-300"}`}
                >
                  {rowStatus?.text ?? ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
