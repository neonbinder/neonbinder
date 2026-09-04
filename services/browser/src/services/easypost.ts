/**
 * NEO-120 — EasyPost letter-postage client.
 *
 * ## Why this lives in the browser service and not in Convex
 * The EasyPost API key is a per-seller credential that **spends their money**.
 * The credential boundary this repo enforces (NEO-20) is that only this service
 * ever holds a per-user secret in plaintext: `PUT /credentials/:key` writes to
 * Secret Manager and **no route ever hands the password back**. Convex is a
 * third-party runtime off GCP; it is deliberately never given the key.
 *
 * So Convex cannot call EasyPost itself. It asks this service to, exactly as it
 * already does for BSC and SportLots logins. The duplication between this and
 * anything similar under `apps/web/convex/` is the intentional security
 * boundary, not an accident.
 *
 * Like the BSC and SportLots HTTP paths, this never launches Chromium.
 *
 * ## Money
 * EasyPost sends money as a decimal string (`"0.78"`). It is converted to
 * integer cents at the boundary and never handled as a float — a month of
 * postage totalled in floats accumulates visible error.
 */

const EASYPOST_BASE = "https://api.easypost.com/v2";

/** Generous: a rate call is two USPS round-trips behind EasyPost's API. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * First-Class Mail. EasyPost documents this service as "Cards, Letters and
 * Flats only (no Parcels)" with a 13oz ceiling — it is the letter rate, and the
 * reason this feature costs stamp money rather than parcel money.
 */
export const LETTER_SERVICE = "First";

/**
 * 11.5 x 6.125 x 0.25in. `Card` (6 x 4.5 x 0.016in) also gets the letter rate
 * but is far too thin for a card in a top-loader, so `Letter` is the honest
 * declaration for what sellers actually mail.
 */
export const LETTER_PACKAGE = "Letter";

/**
 * 6x4 landscape — matches the label NEO-118 already prints, so the existing
 * 6in x 4in print page needs no change.
 *
 * NOT the default `4x6`: that is the portrait parcel label. The two strings
 * differ only in digit order and produce different orientations.
 */
export const LETTER_LABEL_SIZE = "6x4";

export type EasyPostErrorKind =
  | "auth"
  | "address"
  | "no_rate"
  | "payment"
  | "timeout"
  /**
   * NEO-121. The caller handed us something this client refuses to send
   * upstream at all (today: a webhook URL that is not https). Distinct from
   * `unknown` so the router can answer 400 — "you sent something wrong" —
   * rather than 502, which would tell Convex that EasyPost failed when
   * EasyPost was never called.
   */
  | "invalid_input"
  /**
   * NEO-121. The shipment exists but carries no tracker yet. Not an error in
   * the seller's setup and not an EasyPost outage: USPS simply has not
   * produced anything to show. Its own kind so the UI can say "no scans yet"
   * instead of "something went wrong".
   */
  | "no_tracker"
  | "unknown";

export class EasyPostError extends Error {
  readonly kind: EasyPostErrorKind;
  constructor(message: string, kind: EasyPostErrorKind) {
    super(message);
    this.name = "EasyPostError";
    this.kind = kind;
  }
}

export interface PostalAddressLike {
  name: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface RateQuote {
  shipmentId: string;
  rateId: string;
  service: string;
  carrier: string;
  amountCents: number;
  verifiedTo: PostalAddressLike;
}

export interface PurchasedLabel {
  shipmentId: string;
  trackingCode: string;
  labelUrl: string;
  amountCents: number;
  /**
   * NEO-121. A bought shipment carries its tracker inline, so the first
   * snapshot costs no extra call and no extra id to store. Additive and
   * optional: an older Convex ignores it, and a shipment that comes back with
   * no tracker is normal (USPS has not produced one yet), not a failure.
   */
  tracker?: TrackerSnapshot;
}

/**
 * A label re-fetched from EasyPost for reprinting (NEO-213).
 *
 * Deliberately `PurchasedLabel` minus `amountCents`: a retrieve charges
 * nothing, and the price the seller actually paid is whatever was recorded at
 * purchase time. Echoing back a *current* amount here would invite the caller
 * to overwrite a historical ledger entry with a number that never moved.
 */
export type RetrievedLabel = Pick<
  PurchasedLabel,
  "shipmentId" | "trackingCode" | "labelUrl"
>;

/**
 * NEO-121 — one USPS scan, normalised out of EasyPost's `tracking_details`.
 *
 * Every field except `at`/`status`/`message` is optional because
 * `tracking_location` fields come back null on real letter trackers (verified
 * against a production NEO-120 letter).
 */
export interface TrackerScan {
  /** ms epoch, parsed from `datetime` at this boundary. */
  at: number;
  status: string;
  message: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

/**
 * NEO-121 — a tracker as this service hands it to Convex.
 *
 * Timestamps are ms epoch, parsed here rather than downstream, for the same
 * reason `moneyToCents` converts money here: a value that crosses the boundary
 * in a foreign representation gets re-parsed (differently) by every consumer.
 *
 * Strings are NOT truncated here — Convex owns the document-size budget and
 * truncates on the write (`applyTrackerSnapshot`). `scans` IS capped, because
 * the cap is about how much of a tracker is worth transporting at all.
 */
export interface TrackerSnapshot {
  trackerId: string;
  /** EasyPost's status enum verbatim; the UI maps it to words. */
  status: string;
  statusDetail?: string;
  /** ms epoch. The monotonic guard Convex applies snapshots by. */
  updatedAt: number;
  /** ms epoch of the newest scan, if there are any. */
  lastScanAt?: number;
  estDeliveryAt?: number;
  /** EasyPost's public tracking page. Present only when it is an https URL. */
  publicTrackingUrl?: string;
  /** Oldest → newest, newest 50 kept. */
  scans: TrackerScan[];
}

/** NEO-121 — one registered webhook, for reconciliation. */
export interface WebhookSummary {
  webhookId: string;
  url: string;
  mode: string;
  /** ms epoch, or null while the hook is healthy. */
  disabledAt: number | null;
}

/**
 * NEO-121 — the per-seller webhook URL carries a **bearer token** in its path
 * (`/webhooks/easypost/<token>`): anyone holding it can post to that seller's
 * ingest path. EasyPost echoes the URL it rejected back inside its own error
 * messages, so an unredacted EasyPost error is a credential leak into logs and
 * into the JSON body Convex receives.
 *
 * Applied at BOTH ends on purpose: here, so a token can never enter an
 * `EasyPostError` message in the first place, and again in the router, so a
 * message arriving from anywhere else is still scrubbed before it reaches
 * console or a response body.
 *
 * The character class is `[^/\s]+` — linear, no nesting, nothing to backtrack
 * on, so this cannot be turned into a CPU sink by a hostile message.
 */
export function redactWebhookToken(message: string): string {
  return (message ?? "").replace(
    /\/webhooks\/easypost\/[^/\s]+/g,
    "/webhooks/easypost/<token>",
  );
}

/**
 * ISO-8601 → ms epoch, or undefined. Parsed at the boundary for the same
 * reason as `moneyToCents`: one place decides what a timestamp means.
 */
function toMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** A non-empty trimmed string, or undefined. Null-tolerant by design. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * An https URL, or undefined. Anything else — http, javascript:, data:, a
 * non-string — is dropped rather than passed on for a renderer to decide about.
 */
function httpsOnly(value: unknown): string | undefined {
  const url = optionalString(value);
  return url && /^https:\/\//i.test(url) ? url : undefined;
}

/** Newest-kept cap. A letter gets single-digit scans; 50 is far above real. */
export const MAX_SCANS = 50;

/**
 * Normalise an EasyPost tracker object into `TrackerSnapshot`.
 *
 * Exported pure so the shape can be pinned against real payloads without a
 * client, a key, or a network.
 *
 * Two decisions worth knowing:
 *  - A scan whose `datetime` will not parse is DROPPED, not kept with `at: 0`.
 *    `at` drives relative-time rendering, and "56 years ago" on a row is worse
 *    than one missing line.
 *  - `updatedAt` falls back to the newest scan, then to 0 — never to
 *    `Date.now()`. Convex applies a snapshot only when `updatedAt` beats the
 *    stored one, so an invented "now" would let an undated payload overwrite a
 *    good one. 0 fails closed against anything already stored.
 */
export function normalizeTracker(raw: any): TrackerSnapshot {
  const details: any[] = Array.isArray(raw?.tracking_details)
    ? raw.tracking_details
    : [];

  const scans: TrackerScan[] = details
    .map((d): TrackerScan | undefined => {
      const at = toMs(d?.datetime);
      if (at === undefined) return undefined;
      const loc = d?.tracking_location ?? {};
      return {
        at,
        status: optionalString(d?.status) ?? "unknown",
        message: optionalString(d?.message) ?? "",
        city: optionalString(loc?.city),
        state: optionalString(loc?.state),
        zip: optionalString(loc?.zip),
        country: optionalString(loc?.country),
      };
    })
    .filter((s): s is TrackerScan => s !== undefined)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_SCANS);

  const lastScanAt = scans.length ? scans[scans.length - 1].at : undefined;

  return {
    trackerId: optionalString(raw?.id) ?? "",
    status: optionalString(raw?.status) ?? "unknown",
    statusDetail: optionalString(raw?.status_detail),
    updatedAt: toMs(raw?.updated_at) ?? lastScanAt ?? 0,
    lastScanAt,
    estDeliveryAt: toMs(raw?.est_delivery_date),
    publicTrackingUrl: httpsOnly(raw?.public_url),
    scans,
  };
}

interface EasyPostRate {
  id: string;
  service: string;
  carrier: string;
  rate: string;
}

/**
 * `"0.78"` -> `78`. String-based on purpose: `parseFloat("0.29") * 100` is
 * 28.999999999999996, and rounding that per label is how ledgers drift.
 */
export function moneyToCents(amount: string): number {
  const trimmed = (amount ?? "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new EasyPostError(
      `Unparseable amount from EasyPost: "${amount}"`,
      "unknown",
    );
  }
  const negative = trimmed.startsWith("-");
  const [whole, fraction = ""] = trimmed.replace("-", "").split(".");
  const cents =
    Number(whole) * 100 +
    Number((fraction + "00").slice(0, 2)) +
    // Third decimal rounds the cent, e.g. "0.785" -> 79.
    (Number((fraction + "000")[2] ?? "0") >= 5 ? 1 : 0);
  return negative ? -cents : cents;
}

/**
 * Pick the First-Class letter rate out of everything EasyPost offers.
 *
 * Exported for testing: a shipment comes back with parcel services too, and
 * silently buying a $4 First-Class *Package* rate instead of a $0.78 letter
 * would be an expensive mistake that nobody notices until the bill.
 */
export function pickLetterRate(
  rates: EasyPostRate[] | undefined,
): EasyPostRate | undefined {
  return (rates ?? []).find(
    (r) => r.service === LETTER_SERVICE && /usps/i.test(r.carrier),
  );
}

function toEasyPostAddress(a: PostalAddressLike) {
  return {
    name: a.name,
    company: a.company?.trim() || undefined,
    street1: a.line1,
    street2: a.line2?.trim() || undefined,
    city: a.city,
    state: a.state,
    zip: a.postalCode,
    country: a.country || "US",
  };
}

function describeError(body: any, status: number): string {
  const err = body?.error;
  if (!err) return `EasyPost request failed (HTTP ${status})`;
  const base = Array.isArray(err.message) ? err.message.join("; ") : err.message;
  const detail = (err.errors ?? []).map((e: any) =>
    [e.field, e.message].filter(Boolean).join(": "),
  );
  // NEO-121: EasyPost echoes the URL it rejected. That URL carries the
  // seller's webhook bearer token, so it is scrubbed HERE — before the string
  // becomes an EasyPostError message — and a token therefore never exists on
  // any path that could log or return one.
  return redactWebhookToken(
    [base, ...detail].filter(Boolean).join(" — ") || `HTTP ${status}`,
  );
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface EasyPostClientOptions {
  apiKey: string;
  /** Injected in tests so the whole client runs with no network and no key. */
  fetchImpl?: typeof fetch;
}

export function createEasyPostClient(options: EasyPostClientOptions) {
  const doFetch = options.fetchImpl ?? fetch;
  // HTTP Basic: API key as username, empty password.
  const authHeader = `Basic ${Buffer.from(`${options.apiKey}:`).toString("base64")}`;

  /**
   * The single place an EasyPost call is made. Every status mapping below —
   * 401/403 as a key problem, 402 as a funding problem, an abort as a timeout —
   * lives here rather than at the call sites so that a new endpoint cannot
   * quietly grow its own, weaker interpretation of a failure.
   *
   * SECURITY: `authHeader` is built once from the key and is never read back,
   * logged, or attached to a thrown error. Nothing on this path can put the
   * seller's API key into a message that reaches a caller.
   */
  async function request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    /**
     * Upstream statuses this caller declares to be a success. The ONLY user is
     * `deleteWebhook`, for EasyPost's own 404.
     *
     * It is an argument rather than a check at the call site so that the
     * status→outcome decision stays inside this one helper: "gone already" is
     * decided from the upstream response here, and the router — where a 404
     * means "this seller has saved no key" and nothing else — never has to
     * reason about EasyPost's 404 at all.
     */
    options?: { treatStatusAsSuccess?: readonly number[] },
  ): Promise<T> {
    // A GET (and a DELETE) carries no payload, so it declares no Content-Type
    // either — EasyPost is content-sniffing-tolerant, but sending a body-less
    // request that claims to have a JSON body is the kind of thing proxies
    // punish.
    const sendsBody = method === "POST";
    let response: Response;
    try {
      response = await doFetch(`${EASYPOST_BASE}${path}`, {
        method,
        headers: sendsBody
          ? {
              Authorization: authHeader,
              "Content-Type": "application/json",
            }
          : { Authorization: authHeader },
        ...(sendsBody ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const timedOut = /abort|timeout/i.test(msg);
      throw new EasyPostError(
        timedOut ? "EasyPost timed out" : `EasyPost unreachable: ${msg}`,
        timedOut ? "timeout" : "unknown",
      );
    }

    const text = await response.text();
    const parsed = text ? safeJson(text) : undefined;

    if (!response.ok) {
      if (options?.treatStatusAsSuccess?.includes(response.status)) {
        return parsed as T;
      }
      const described = describeError(parsed, response.status);
      if (response.status === 401 || response.status === 403) {
        throw new EasyPostError(
          "EasyPost rejected the API key. Check the key saved on your profile.",
          "auth",
        );
      }
      // 402 is "no money" — worth its own message because the fix is
      // "add funds", not "try again".
      if (
        response.status === 402 ||
        /insufficient|balance|funds/i.test(described)
      ) {
        throw new EasyPostError(
          `EasyPost could not charge for this label: ${described}`,
          "payment",
        );
      }
      throw new EasyPostError(described, "unknown");
    }

    return parsed as T;
  }

  return {
    /**
     * Verify the recipient address and price a First-Class letter for it.
     * Charges nothing. Verification runs as part of shipment creation, so a bad
     * address fails BEFORE any money moves — the reason address validation is
     * mandatory for this feature rather than optional.
     */
    async quoteLetterRate(args: {
      to: PostalAddressLike;
      from: PostalAddressLike;
      weightOz: number;
    }): Promise<RateQuote> {
      const shipment = await request<any>("POST", "/shipments", {
        shipment: {
          to_address: { ...toEasyPostAddress(args.to), verify: ["delivery"] },
          from_address: toEasyPostAddress(args.from),
          parcel: {
            predefined_package: LETTER_PACKAGE,
            weight: args.weightOz,
          },
          options: {
            label_format: "PNG",
            label_size: LETTER_LABEL_SIZE,
          },
        },
      });

      const to = shipment?.to_address;
      const delivery = to?.verifications?.delivery;
      if (delivery && delivery.success === false) {
        const why =
          (delivery.errors ?? [])
            .map((e: any) => e.message)
            .filter(Boolean)
            .join("; ") || "USPS could not verify this address.";
        throw new EasyPostError(why, "address");
      }

      const letterRate = pickLetterRate(shipment?.rates);
      if (!letterRate) {
        throw new EasyPostError(
          `No First-Class letter rate came back for ${args.weightOz}oz. Letters are limited to 13oz, and anything rigid or oversized rates as a parcel instead.`,
          "no_rate",
        );
      }

      return {
        shipmentId: shipment.id,
        rateId: letterRate.id,
        service: letterRate.service,
        carrier: letterRate.carrier,
        amountCents: moneyToCents(letterRate.rate),
        verifiedTo: {
          name: to?.name ?? args.to.name,
          company: to?.company ?? undefined,
          line1: to?.street1 ?? args.to.line1,
          line2: to?.street2 ?? undefined,
          city: to?.city ?? args.to.city,
          state: to?.state ?? args.to.state,
          // The point of verification: ZIP+4 back from USPS.
          postalCode: to?.zip ?? args.to.postalCode,
          country: to?.country ?? "US",
        },
      };
    },

    /**
     * Buy a previously-quoted rate. **This spends the seller's money** and is
     * the only irreversible call here.
     */
    async buyLabel(args: {
      shipmentId: string;
      rateId: string;
    }): Promise<PurchasedLabel> {
      const bought = await request<any>(
        "POST",
        `/shipments/${encodeURIComponent(args.shipmentId)}/buy`,
        { rate: { id: args.rateId } },
      );

      const labelUrl = bought?.postage_label?.label_url;
      if (!bought?.tracking_code || !labelUrl) {
        // Money may well have moved, so do not imply it hasn't.
        throw new EasyPostError(
          "EasyPost accepted the purchase but returned no label. Check your EasyPost dashboard before buying again.",
          "unknown",
        );
      }

      return {
        shipmentId: bought.id,
        trackingCode: bought.tracking_code,
        labelUrl,
        amountCents: bought.selected_rate
          ? moneyToCents(bought.selected_rate.rate)
          : 0,
        // NEO-121: free — a bought shipment carries its tracker inline. Absent
        // is the normal early case, not a failure, so it is never asserted.
        ...(bought.tracker
          ? { tracker: normalizeTracker(bought.tracker) }
          : {}),
      };
    },

    /**
     * Re-fetch a bought label so it can be printed again (NEO-213).
     *
     * Read-only and free — it buys nothing, so it is safe to call on every
     * reprint. That is the reason the URL is fetched fresh each time rather
     * than stored: EasyPost's `label_url` is a time-limited link to a file it
     * keeps for **180 days** after purchase, so a URL captured at purchase
     * time rots, and after 180 days the image is gone entirely and
     * `postage_label.label_url` comes back null.
     *
     * A shipment EasyPost cannot find surfaces as an ordinary request failure
     * from the shared helper, NOT as a distinct "missing" result — the router
     * reserves 404 for "this seller has saved no API key", and conflating the
     * two would tell a seller to re-enter a key that is already fine.
     */
    async retrieveLabel(args: { shipmentId: string }): Promise<RetrievedLabel> {
      const shipment = await request<any>(
        "GET",
        `/shipments/${encodeURIComponent(args.shipmentId)}`,
      );

      const labelUrl = shipment?.postage_label?.label_url;
      if (!labelUrl) {
        // Nothing to retry and nothing to fix, so say what actually happened
        // rather than implying a transient failure.
        throw new EasyPostError(
          "EasyPost no longer has this label — labels are kept for 180 days after purchase.",
          "unknown",
        );
      }

      return {
        shipmentId: shipment.id ?? args.shipmentId,
        // The label prints without it; an empty string beats blocking a
        // reprint over a display field.
        trackingCode: shipment.tracking_code ?? "",
        labelUrl,
      };
    },

    /**
     * NEO-121 — the current tracker for an already-bought shipment.
     *
     * Read-only and free. This is the on-demand backstop behind the webhook:
     * it covers rows bought before webhooks existed, the deploy window, and a
     * seller who just wants to press a button.
     *
     * A shipment with no tracker is `no_tracker`, NOT `unknown`: USPS has
     * simply produced nothing yet, which is the ordinary state for the first
     * hours of a letter's life and must not read as a broken key or a broken
     * EasyPost.
     */
    async retrieveTracker(args: {
      shipmentId: string;
    }): Promise<TrackerSnapshot> {
      const shipment = await request<any>(
        "GET",
        `/shipments/${encodeURIComponent(args.shipmentId)}`,
      );

      const tracker = shipment?.tracker;
      if (!tracker) {
        throw new EasyPostError(
          "USPS has not scanned this label yet, so there is nothing to show. Scans usually start once the post office processes the mail.",
          "no_tracker",
        );
      }

      return normalizeTracker(tracker);
    },

    /**
     * NEO-121 — list the webhooks registered on this seller's account.
     *
     * Reconciliation reads this before it creates anything, so a lost create
     * response never leaves a second hook behind delivering duplicate events.
     *
     * SECURITY: the returned `url` values contain other webhooks' path tokens
     * (ours included). They are business data to the caller, which already
     * holds the token it is looking for — but they must never be logged. The
     * router returns them and logs nothing.
     */
    async listWebhooks(): Promise<WebhookSummary[]> {
      const body = await request<any>("GET", "/webhooks");
      const list = Array.isArray(body?.webhooks)
        ? body.webhooks
        : Array.isArray(body)
          ? body
          : [];
      return list.map((w: any) => ({
        webhookId: optionalString(w?.id) ?? "",
        url: optionalString(w?.url) ?? "",
        mode: optionalString(w?.mode) ?? "",
        disabledAt: toMs(w?.disabled_at) ?? null,
      }));
    },

    /**
     * NEO-121 — register a webhook on this seller's account.
     *
     * The https check happens BEFORE the call, and its own `invalid_input`
     * kind keeps it distinguishable from an EasyPost rejection: registering a
     * plaintext endpoint would put the seller's scan events (and the bearer
     * token in the URL) on the wire in the clear, and there is no version of
     * that we want EasyPost to be the one to refuse.
     *
     * The host allowlist is the ROUTER's job, not this client's — see
     * routes/easypost.ts. This layer refuses only what it can decide alone.
     *
     * SECURITY: `secret` is write-only. It goes into the request body and is
     * never read back, logged, echoed, or attached to a thrown error; nothing
     * in the response is derived from it.
     */
    async createWebhook(args: {
      url: string;
      secret: string;
    }): Promise<{ webhookId: string; mode: string }> {
      if (!/^https:\/\//i.test(args.url)) {
        // Fixed string: the rejected URL carries the bearer token, so it is
        // never quoted back, not even into an error the caller asked for.
        throw new EasyPostError(
          "A webhook URL must be https.",
          "invalid_input",
        );
      }

      const created = await request<any>("POST", "/webhooks", {
        webhook: { url: args.url, webhook_secret: args.secret },
      });

      const webhookId = optionalString(created?.id);
      if (!webhookId) {
        throw new EasyPostError(
          "EasyPost accepted the webhook registration but returned no webhook id.",
          "unknown",
        );
      }
      return { webhookId, mode: optionalString(created?.mode) ?? "" };
    },

    /**
     * NEO-121 — remove a webhook from this seller's account.
     *
     * **EasyPost's own 404 is success**, and that is decided here rather than
     * in the router on purpose. The router's 404 means one thing only — "this
     * seller has saved no EasyPost key" — so letting a 404 travel up from here
     * would make "the hook is already gone" indistinguishable from "we could
     * not authenticate", and Convex would drop a webhook row it still needs.
     *
     * Idempotent by construction: the caller can retry a delete it is unsure
     * about and still learn the truth (gone = gone).
     */
    async deleteWebhook(args: { webhookId: string }): Promise<void> {
      await request<any>(
        "DELETE",
        `/webhooks/${encodeURIComponent(args.webhookId)}`,
        undefined,
        { treatStatusAsSuccess: [404] },
      );
    },
  };
}
