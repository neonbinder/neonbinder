/**
 * NEO-121 — turning EasyPost tracker fields into words a seller can act on.
 *
 * Kept out of the page so the mapping is testable on its own, and so the same
 * words are available to any other surface that grows a scan timeline later.
 * Everything here is pure: no Convex, no React, no clock.
 *
 * ## Why `out_for_delivery` is the DONE state
 * A production letter (Madison WI → Olympia WA, verified 2026-09-03) collected
 * exactly four USPS scans over three days and finished at status
 * `out_for_delivery` — the destination post office's "Delivery" scan. `delivered`
 * never arrives for a First-Class letter, because nothing scans a mailbox. So
 * treating `out_for_delivery` as a hopeful in-flight state would leave every
 * letter permanently "almost there"; it is the finish line, and the words and
 * the tone both say so. `delivered` keeps its mapping for the day a parcel
 * flows through here, not because a letter will ever reach it.
 */

/**
 * How a status should read visually.
 *
 * Deliberately not a colour name: the page owns the palette, and the same four
 * buckets have to survive a theme change. `idle` = nothing has happened yet,
 * `moving` = in the network, `done` = as far as USPS will ever tell us,
 * `warn` = the seller needs to look at something.
 */
export type TrackingTone = "idle" | "moving" | "done" | "warn";

export interface TrackingStatusDescription {
  label: string;
  tone: TrackingTone;
}

/**
 * The state a row sits in before EasyPost has told us anything.
 *
 * Shared by `unknown`, `pre_transit`, a missing status, and any value outside
 * EasyPost's enum. That last case is the debatable one: a status we do not
 * recognise means we have no information to pass on, and inventing a word for
 * it would be worse than saying so plainly. It is never `warn` — an unfamiliar
 * enum value is our gap, not the seller's problem.
 */
const NO_SCANS_YET: TrackingStatusDescription = {
  label: "Label printed — no scans yet",
  tone: "idle",
};

const STATUS_WORDS: Record<string, TrackingStatusDescription> = {
  unknown: NO_SCANS_YET,
  pre_transit: NO_SCANS_YET,
  in_transit: { label: "Moving through USPS", tone: "moving" },
  // See the header: for a letter this is the end of the line, not a promise
  // that something better is coming.
  out_for_delivery: { label: "Out for delivery — last USPS scan", tone: "done" },
  delivered: { label: "Delivered", tone: "done" },
  // In EasyPost's enum but not in a letter's normal path. Mapped anyway so it
  // does not fall into "no scans yet", which would be an outright lie: there
  // is a scan, and it is one the buyer has to act on.
  available_for_pickup: { label: "Waiting at the post office", tone: "moving" },
  return_to_sender: { label: "Returned to sender", tone: "warn" },
  failure: { label: "Problem — check USPS", tone: "warn" },
  error: { label: "Problem — check USPS", tone: "warn" },
  cancelled: { label: "Problem — check USPS", tone: "warn" },
};

/**
 * EasyPost's `tracker.status` → the words and tone the page shows.
 *
 * The status is stored verbatim from EasyPost precisely so this mapping can
 * change without a migration; nothing downstream of the row reads the raw enum.
 */
export function describeTrackingStatus(
  status?: string,
): TrackingStatusDescription {
  if (!status) return NO_SCANS_YET;
  return STATUS_WORDS[status.trim().toLowerCase()] ?? NO_SCANS_YET;
}

/**
 * The gloss the first USPS scan on every letter needs.
 *
 * USPS's own wording for the postmark is "Origin Processing Cancellation of
 * Postage" — which to a seller reads as a refund, a void, or a label that has
 * been killed. It means the opposite: the stamp was cancelled (postmarked), so
 * the letter is in the mail. This is the single most alarming string in the
 * timeline and it is the FIRST one, so it gets the explanation inline rather
 * than in a legend nobody reads.
 */
const POSTMARK_GLOSS = " (postmarked — nothing was cancelled)";

export function glossScanMessage(message: string): string {
  if (!message.toLowerCase().includes("cancellation of postage")) return message;
  // Idempotent: a message that already carries the gloss (re-render, or a
  // caller that glossed once already) must not collect a second copy.
  if (message.includes(POSTMARK_GLOSS)) return message;
  return `${message}${POSTMARK_GLOSS}`;
}

/**
 * "OLYMPIA, WA" from a scan's tracking location.
 *
 * USPS hands these back already upper-cased, and they are shown verbatim: this
 * is the buyer's own town on the seller's screen, so re-casing it would only
 * introduce a way to be wrong. Either half can be missing — an origin sorting
 * scan sometimes carries a city with no state — and both missing yields the
 * empty string so the caller can drop the separator rather than render
 * "Delivery · · 2d ago".
 */
export function formatScanPlace(place: {
  city?: string;
  state?: string;
}): string {
  const parts = [place.city, place.state]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.join(", ");
}

/**
 * Is this a URL safe to render as an anchor?
 *
 * `publicTrackingUrl` originates in a webhook body, and a webhook body is
 * seller-forgeable (a seller can read their own webhook secret out of the
 * EasyPost dashboard). The backend scheme-checks it before storing; this is the
 * second check at the anchor, because a `javascript:` href that only one layer
 * rejects is one deploy away from being rendered. `new URL` rather than a
 * `startsWith("https://")` string test so a scheme-relative or whitespace-
 * padded value cannot slip through.
 */
export function isHttpsUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
