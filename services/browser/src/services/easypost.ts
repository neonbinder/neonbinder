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
  return [base, ...detail].filter(Boolean).join(" — ") || `HTTP ${status}`;
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
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    // A GET carries no payload, so it declares no Content-Type either —
    // EasyPost is content-sniffing-tolerant, but sending a body-less request
    // that claims to have a JSON body is the kind of thing proxies punish.
    const isGet = method === "GET";
    let response: Response;
    try {
      response = await doFetch(`${EASYPOST_BASE}${path}`, {
        method,
        headers: isGet
          ? { Authorization: authHeader }
          : {
              Authorization: authHeader,
              "Content-Type": "application/json",
            },
        ...(isGet ? {} : { body: JSON.stringify(body) }),
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
  };
}
