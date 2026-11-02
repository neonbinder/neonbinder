/**
 * NEO-415 — the eBay SELLER client: the REST calls NB makes on a collector's
 * own eBay account to list their for-sale copies, read their business
 * policies and read the orders they receive.
 *
 * Convex default runtime (fetch only, no "use node"), the `bscSeller.ts`
 * pattern. Called from the listing drainer (`listingDrainEbay.ts`), the order
 * poll (`listingSales.ts`) and the settings actions (`ebayConnect.ts`). Every
 * call is made for an explicit owner: the user access token comes from
 * `credentials.getSiteTokenForUser` (site "ebay"; the browser service holds
 * the refresh token and the client secret, Convex never sees either), and a
 * 401 refreshes through `credentials.refreshSiteTokenForUser` ONCE per
 * session, then retries once. A second 401 kills the session.
 *
 * Not configured (`lib/ebayEnv.ebayConfig()` null) or paused
 * (`NEONBINDER_PAUSED_PLATFORMS` names "ebay"): no session opens and eBay is
 * never contacted.
 *
 * Every answer is narrowed here or in `lib/ebayListing.ts` before anything
 * else reads it; failures carry an NB-written sentence plus eBay's numeric
 * error ids (never eBay's message text, which can echo the request). Logs
 * carry platform, operation, status and timing, never a token or a body.
 *
 * Shapes are from eBay's published OpenAPI documents, read 2026-11-01:
 *   Sell Inventory v1   https://developer.ebay.com/api-docs/sell/inventory/resources/methods
 *   Sell Account v1     https://developer.ebay.com/api-docs/sell/account/resources/methods
 *   Sell Fulfillment v1 https://developer.ebay.com/api-docs/sell/fulfillment/resources/methods
 *   Sell Metadata v1    https://developer.ebay.com/api-docs/sell/metadata/resources/methods
 *   Commerce Taxonomy   https://developer.ebay.com/api-docs/commerce/taxonomy/resources/methods
 *   Commerce Media      https://developer.ebay.com/api-docs/commerce/media/resources/methods
 * Where a detail is NOT in those documents the code says UNVERIFIED beside it.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { isPlatformPaused } from "../marketplacePause";
import { ebayConfig, type EbayConfig } from "../lib/ebayEnv";
import {
  EBAY_CARD_CATEGORY_ID,
  EBAY_CATEGORY_TREE_ID,
  EBAY_CONTENT_LANGUAGE,
  EBAY_MARKETPLACE_ID,
  isRecord,
} from "../lib/ebayListing";
import { readCappedText } from "./bscSeller";

/** The `credentials` site key for eBay. */
const SITE = "ebay" as const;

export const EBAY_TIMEOUTS_MS = {
  read: 30_000,
  write: 60_000,
  bulk: 90_000,
  media: 60_000,
  token: 20_000,
} as const;

export const EBAY_MAX_BYTES = {
  small: 256 * 1024,
  bulk: 2 * 1024 * 1024,
  policies: 2 * 1024 * 1024,
  orders: 4 * 1024 * 1024,
  /** A category's aspect metadata carries every suggested value: large. */
  aspects: 16 * 1024 * 1024,
  shipping: 4 * 1024 * 1024,
} as const;

export type EbayFailureKind =
  | "notConfigured"
  | "paused"
  | "no_token"
  | "signed_out"
  | "timeout"
  | "network"
  | "http"
  | "bad_response";

export interface EbayFailure {
  kind: EbayFailureKind;
  httpStatus?: number;
  /** eBay's numeric error ids from an error body, when it sent any. */
  errorIds?: number[];
  /** NB-written; safe for logs and the sync record. */
  message: string;
}

export type EbayResult<T> = { ok: true; value: T } | { ok: false; failure: EbayFailure };

export interface EbaySellerSession {
  ownerId: string;
  token: string;
  config: EbayConfig;
  reauthAttempted: boolean;
  dead: boolean;
}

type SessionCtx = Pick<ActionCtx, "runAction">;

const SIGNED_OUT = "eBay signed NeonBinder out. Connect eBay again under Profile.";

function failure(kind: EbayFailureKind, message: string, extra: { httpStatus?: number; errorIds?: number[] } = {}): EbayFailure {
  return {
    kind,
    message,
    ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    ...(extra.errorIds && extra.errorIds.length > 0 ? { errorIds: extra.errorIds } : {}),
  };
}

function logCall(operation: string, startedAt: number, outcome: string, httpStatus?: number): void {
  console.log(
    JSON.stringify({
      msg: "ebay_seller_call",
      platform: "ebay",
      operation,
      outcome,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      durationMs: Date.now() - startedAt,
    }),
  );
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** eBay's numeric error ids out of an `{ errors: [{ errorId }] }` body (capped). */
export function errorIdsOf(body: unknown): number[] {
  if (!isRecord(body)) return [];
  const list = Array.isArray(body.errors) ? body.errors : Array.isArray(body.warnings) ? [] : [];
  const ids: number[] = [];
  for (const e of list.slice(0, 20)) {
    if (isRecord(e) && typeof e.errorId === "number" && Number.isInteger(e.errorId)) ids.push(e.errorId);
  }
  return ids;
}

/** Opens a session for `ownerId`, or says why it cannot. Reads the token once. */
export async function openEbaySellerSession(ctx: SessionCtx, ownerId: string): Promise<EbayResult<EbaySellerSession>> {
  const config = ebayConfig();
  if (!config) return { ok: false, failure: failure("notConfigured", "eBay isn't hooked up on this NeonBinder yet.") };
  if (isPlatformPaused(SITE)) return { ok: false, failure: failure("paused", "eBay is paused on NeonBinder right now.") };
  const startedAt = Date.now();
  let token: { token: string } | null = null;
  try {
    token = await ctx.runAction(internal.credentials.getSiteTokenForUser, { site: SITE, userId: ownerId });
  } catch {
    token = null;
  }
  logCall("token", startedAt, token ? "ok" : "no_token");
  if (!token) {
    return { ok: false, failure: failure("no_token", "NeonBinder couldn't reach your eBay account. Connect eBay again under Profile.") };
  }
  return { ok: true, value: { ownerId, token: token.token, config, reauthAttempted: false, dead: false } };
}

interface SendOptions {
  operation: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** API path from the host root, e.g. `/sell/inventory/v1/offer`. */
  path: string;
  query?: Record<string, string>;
  json?: unknown;
  form?: () => FormData;
  host?: "api" | "media";
  timeoutMs: number;
  maxBytes: number;
  /** Non-2xx statuses whose body is still the answer (a bulk call's 400 carries per-entry results). */
  bodyStatuses?: number[];
}

interface SendValue {
  status: number;
  body: unknown;
  location: string | null;
}

function headersFor(session: EbaySellerSession, opts: SendOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.token}`,
    Accept: "application/json",
    "Accept-Language": EBAY_CONTENT_LANGUAGE,
    "Content-Language": EBAY_CONTENT_LANGUAGE,
    "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE_ID,
  };
  // fetch sets the multipart boundary itself for a FormData body.
  if (opts.form === undefined && opts.json !== undefined) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * One request with the session's token: a 401 refreshes once per session and
 * retries once; a second 401 kills the session. A non-2xx other than 401
 * fails `http` with eBay's error ids. Returns the parsed JSON (null for an
 * empty body) with the status and any `Location` header.
 */
async function send(ctx: SessionCtx, session: EbaySellerSession, opts: SendOptions): Promise<EbayResult<SendValue>> {
  if (session.dead) return { ok: false, failure: failure("signed_out", SIGNED_OUT, { httpStatus: 401 }) };
  const base = opts.host === "media" ? session.config.mediaBase : session.config.apiBase;
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const url = `${base}${opts.path}${qs}`;
  const attempt = async (): Promise<Response | EbayFailure> => {
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        method: opts.method,
        headers: headersFor(session, opts),
        ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
        ...(opts.form !== undefined ? { body: opts.form() } : {}),
        // The bearer token goes to eBay's API host and nowhere else.
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      logCall(opts.operation, startedAt, res.ok ? "ok" : "http_error", res.status);
      return res;
    } catch (err) {
      const kind = isAbort(err) ? "timeout" : "network";
      logCall(opts.operation, startedAt, kind);
      return failure(kind, kind === "timeout" ? "eBay took too long to answer." : "NeonBinder couldn't reach eBay.");
    }
  };

  let res = await attempt();
  if (!(res instanceof Response)) return { ok: false, failure: res };
  if (res.status === 401) {
    await res.text().catch(() => "");
    if (session.reauthAttempted) {
      session.dead = true;
      return { ok: false, failure: failure("signed_out", SIGNED_OUT, { httpStatus: 401 }) };
    }
    session.reauthAttempted = true;
    const refreshStartedAt = Date.now();
    let next: { token: string } | null = null;
    try {
      const r = await ctx.runAction(internal.credentials.refreshSiteTokenForUser, { site: SITE, userId: session.ownerId });
      if (r.refreshed) {
        next = await ctx.runAction(internal.credentials.getSiteTokenForUser, { site: SITE, userId: session.ownerId });
      }
    } catch {
      next = null;
    }
    logCall("reauth", refreshStartedAt, next ? "ok" : "failed");
    if (!next) {
      session.dead = true;
      return { ok: false, failure: failure("signed_out", SIGNED_OUT, { httpStatus: 401 }) };
    }
    session.token = next.token;
    res = await attempt();
    if (!(res instanceof Response)) return { ok: false, failure: res };
    if (res.status === 401) {
      await res.text().catch(() => "");
      session.dead = true;
      return { ok: false, failure: failure("signed_out", SIGNED_OUT, { httpStatus: 401 }) };
    }
  }

  let text: string | null;
  try {
    text = await readCappedText(res, opts.maxBytes);
  } catch (err) {
    return {
      ok: false,
      failure: failure(isAbort(err) ? "timeout" : "bad_response", `eBay's answer to ${opts.operation} could not be read.`, {
        httpStatus: res.status,
      }),
    };
  }
  let body: unknown = null;
  if (text !== null && text.trim() !== "") {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }
  }
  const bodyAnswer = opts.bodyStatuses?.includes(res.status) === true && isRecord(body);
  if (!res.ok && !bodyAnswer) {
    return {
      ok: false,
      failure: failure("http", `eBay answered ${res.status} to ${opts.operation}.`, {
        httpStatus: res.status,
        errorIds: errorIdsOf(body),
      }),
    };
  }
  if (text === null) {
    return { ok: false, failure: failure("bad_response", `eBay's answer to ${opts.operation} was too large to read.`, { httpStatus: res.status }) };
  }
  if (body === undefined) {
    return { ok: false, failure: failure("bad_response", `eBay's answer to ${opts.operation} was not JSON.`, { httpStatus: res.status }) };
  }
  return { ok: true, value: { status: res.status, body, location: res.headers.get("location") } };
}

// ── Account: programs and business policies ─────────────────────────────────

/** The program a seller must be in to use business policies. */
export const SELLING_POLICY_MANAGEMENT = "SELLING_POLICY_MANAGEMENT";

/** `GET /sell/account/v1/program/get_opted_in_programs` → program types. */
export async function getOptedInPrograms(ctx: SessionCtx, session: EbaySellerSession): Promise<EbayResult<string[]>> {
  const r = await send(ctx, session, {
    operation: "getOptedInPrograms",
    method: "GET",
    path: "/sell/account/v1/program/get_opted_in_programs",
    timeoutMs: EBAY_TIMEOUTS_MS.read,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  if (!r.ok) return r;
  const programs = isRecord(r.value.body) && Array.isArray(r.value.body.programs) ? r.value.body.programs : [];
  return {
    ok: true,
    value: programs
      .filter((p): p is Record<string, unknown> => isRecord(p) && typeof p.programType === "string")
      .map((p) => p.programType as string)
      .slice(0, 50),
  };
}

/** `POST /sell/account/v1/program/opt_in`. A 409 (already in) counts as done. */
export async function optInToProgram(ctx: SessionCtx, session: EbaySellerSession, programType: string): Promise<EbayResult<null>> {
  const r = await send(ctx, session, {
    operation: "optInToProgram",
    method: "POST",
    path: "/sell/account/v1/program/opt_in",
    json: { programType },
    timeoutMs: EBAY_TIMEOUTS_MS.write,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  if (!r.ok && r.failure.httpStatus === 409) return { ok: true, value: null };
  return r.ok ? { ok: true, value: null } : r;
}

type PolicyKind = "fulfillment_policy" | "payment_policy" | "return_policy";

/** `GET /sell/account/v1/<kind>?marketplace_id=EBAY_US` → the raw body (narrowed by `lib/ebayListing`). */
export async function getPolicies(ctx: SessionCtx, session: EbaySellerSession, kind: PolicyKind): Promise<EbayResult<unknown>> {
  const r = await send(ctx, session, {
    operation: `get_${kind}`,
    method: "GET",
    path: `/sell/account/v1/${kind}`,
    query: { marketplace_id: EBAY_MARKETPLACE_ID },
    timeoutMs: EBAY_TIMEOUTS_MS.read,
    maxBytes: EBAY_MAX_BYTES.policies,
  });
  return r.ok ? { ok: true, value: r.value.body } : r;
}

/**
 * `POST /sell/account/v1/<kind>` (fulfillment's path carries a trailing slash
 * in eBay's spec) → the new policy id from the 201 body.
 */
export async function createPolicy(
  ctx: SessionCtx,
  session: EbaySellerSession,
  kind: PolicyKind,
  body: Record<string, unknown>,
): Promise<EbayResult<string>> {
  const idField = kind === "fulfillment_policy" ? "fulfillmentPolicyId" : kind === "payment_policy" ? "paymentPolicyId" : "returnPolicyId";
  const r = await send(ctx, session, {
    operation: `create_${kind}`,
    method: "POST",
    path: kind === "fulfillment_policy" ? "/sell/account/v1/fulfillment_policy/" : `/sell/account/v1/${kind}`,
    json: body,
    timeoutMs: EBAY_TIMEOUTS_MS.write,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  if (!r.ok) return r;
  const id = isRecord(r.value.body) ? r.value.body[idField] : null;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    return { ok: false, failure: failure("bad_response", "eBay didn't say which policy it made.") };
  }
  return { ok: true, value: id };
}

// ── Metadata: shipping services ─────────────────────────────────────────────

export interface EbayShippingServiceInfo {
  code: string;
  carrier: string | null;
  international: boolean;
  validForSelling: boolean;
  costTypes: string[];
}

/** `GET /sell/metadata/v1/shipping/marketplace/EBAY_US/get_shipping_services`, narrowed. */
export async function getShippingServices(ctx: SessionCtx, session: EbaySellerSession): Promise<EbayResult<EbayShippingServiceInfo[]>> {
  const r = await send(ctx, session, {
    operation: "getShippingServices",
    method: "GET",
    path: `/sell/metadata/v1/shipping/marketplace/${EBAY_MARKETPLACE_ID}/get_shipping_services`,
    timeoutMs: EBAY_TIMEOUTS_MS.read,
    maxBytes: EBAY_MAX_BYTES.shipping,
  });
  if (!r.ok) return r;
  const list = isRecord(r.value.body) && Array.isArray(r.value.body.shippingServices) ? r.value.body.shippingServices : [];
  const out: EbayShippingServiceInfo[] = [];
  for (const s of list.slice(0, 2000)) {
    if (!isRecord(s) || typeof s.shippingService !== "string" || s.shippingService.length > 80) continue;
    out.push({
      code: s.shippingService,
      carrier: typeof s.shippingCarrier === "string" ? s.shippingCarrier.slice(0, 40) : null,
      international: s.internationalService === true,
      validForSelling: s.validForSellingFlow === true,
      costTypes: Array.isArray(s.shippingCostTypes)
        ? s.shippingCostTypes.filter((t): t is string => typeof t === "string").slice(0, 10)
        : [],
    });
  }
  return { ok: true, value: out };
}

// ── Inventory location ──────────────────────────────────────────────────────

/**
 * Creates the seller's inventory location `key` (`POST /location/{key}`), or
 * updates its address when it already exists (409 →
 * `POST /location/{key}/update_location_details`). A WAREHOUSE in the US.
 */
export async function upsertInventoryLocation(
  ctx: SessionCtx,
  session: EbaySellerSession,
  key: string,
  address: { postalCode: string; city: string; stateOrProvince: string },
): Promise<EbayResult<null>> {
  const addr = { city: address.city, stateOrProvince: address.stateOrProvince, postalCode: address.postalCode, country: "US" };
  const created = await send(ctx, session, {
    operation: "createInventoryLocation",
    method: "POST",
    path: `/sell/inventory/v1/location/${encodeURIComponent(key)}`,
    json: {
      location: { address: addr },
      locationTypes: ["WAREHOUSE"],
      name: "NeonBinder",
      merchantLocationStatus: "ENABLED",
    },
    timeoutMs: EBAY_TIMEOUTS_MS.write,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  if (created.ok) return { ok: true, value: null };
  if (created.failure.httpStatus !== 409) return created;
  const updated = await send(ctx, session, {
    operation: "updateInventoryLocation",
    method: "POST",
    path: `/sell/inventory/v1/location/${encodeURIComponent(key)}/update_location_details`,
    json: { location: { address: addr }, locationTypes: ["WAREHOUSE"], name: "NeonBinder" },
    timeoutMs: EBAY_TIMEOUTS_MS.write,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  return updated.ok ? { ok: true, value: null } : updated;
}

// ── Taxonomy ────────────────────────────────────────────────────────────────

/** `GET /commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=261328` → raw body. */
export async function getCardCategoryAspects(ctx: SessionCtx, session: EbaySellerSession): Promise<EbayResult<unknown>> {
  const r = await send(ctx, session, {
    operation: "getItemAspectsForCategory",
    method: "GET",
    path: `/commerce/taxonomy/v1/category_tree/${EBAY_CATEGORY_TREE_ID}/get_item_aspects_for_category`,
    query: { category_id: EBAY_CARD_CATEGORY_ID },
    timeoutMs: EBAY_TIMEOUTS_MS.read,
    maxBytes: EBAY_MAX_BYTES.aspects,
  });
  return r.ok ? { ok: true, value: r.value.body } : r;
}

// ── Media ───────────────────────────────────────────────────────────────────

/**
 * Uploads one picture (`POST /commerce/media/v1_beta/image/create_image_from_file`
 * on the `apim.` host, multipart) and returns eBay's hosted URL. The 201
 * body is an ImageResponse (`imageUrl`, `expirationDate`) per the spec; the
 * multipart field name `image` is UNVERIFIED (the published spec omits the
 * request body; eBay's guide names the field "image").
 */
export async function uploadImage(
  ctx: SessionCtx,
  session: EbaySellerSession,
  args: { bytes: ArrayBuffer; contentType: string; fileName: string },
): Promise<EbayResult<{ url: string; expiresAt: number | null }>> {
  const r = await send(ctx, session, {
    operation: "createImageFromFile",
    method: "POST",
    host: "media",
    path: "/commerce/media/v1_beta/image/create_image_from_file",
    form: () => {
      const form = new FormData();
      form.append("image", new Blob([args.bytes], { type: args.contentType }), args.fileName);
      return form;
    },
    timeoutMs: EBAY_TIMEOUTS_MS.media,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  if (!r.ok) return r;
  const body = isRecord(r.value.body) ? r.value.body : {};
  const url = typeof body.imageUrl === "string" ? body.imageUrl : null;
  if (!url || !url.startsWith("https://") || url.length > 500) {
    return { ok: false, failure: failure("bad_response", "eBay didn't say where it put the photo.") };
  }
  const expires = typeof body.expirationDate === "string" ? Date.parse(body.expirationDate) : NaN;
  return { ok: true, value: { url, expiresAt: Number.isFinite(expires) ? expires : null } };
}

// ── Inventory: items and offers ─────────────────────────────────────────────

/** One entry of a bulk answer, narrowed. */
export interface EbayBulkEntry {
  statusCode: number;
  sku: string | null;
  offerId: string | null;
  listingId: string | null;
  errorIds: number[];
}

function readBulk(body: unknown): EbayBulkEntry[] {
  const list = isRecord(body) && Array.isArray(body.responses) ? body.responses : [];
  const out: EbayBulkEntry[] = [];
  for (const e of list.slice(0, 50)) {
    if (!isRecord(e)) continue;
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null);
    out.push({
      statusCode: typeof e.statusCode === "number" ? e.statusCode : 0,
      sku: str(e.sku),
      offerId: str(e.offerId),
      listingId: str(e.listingId),
      errorIds: errorIdsOf(e),
    });
  }
  return out;
}

async function bulk(
  ctx: SessionCtx,
  session: EbaySellerSession,
  operation: string,
  path: string,
  requests: unknown[],
): Promise<EbayResult<EbayBulkEntry[]>> {
  const r = await send(ctx, session, {
    operation,
    method: "POST",
    path,
    json: { requests },
    timeoutMs: EBAY_TIMEOUTS_MS.bulk,
    maxBytes: EBAY_MAX_BYTES.bulk,
    // A bulk call whose every entry failed answers 400 with the same
    // `responses` body; the caller still needs the per-entry results.
    bodyStatuses: [400],
  });
  if (!r.ok) return r;
  const entries = readBulk(r.value.body);
  if (r.value.status >= 400 && entries.length === 0) {
    return {
      ok: false,
      failure: failure("http", `eBay answered ${r.value.status} to ${operation}.`, {
        httpStatus: r.value.status,
        errorIds: errorIdsOf(r.value.body),
      }),
    };
  }
  return { ok: true, value: entries };
}

/** `POST /sell/inventory/v1/bulk_create_or_replace_inventory_item` (≤25). */
export async function bulkCreateOrReplaceInventoryItems(
  ctx: SessionCtx,
  session: EbaySellerSession,
  items: Array<Record<string, unknown>>,
): Promise<EbayResult<EbayBulkEntry[]>> {
  return await bulk(ctx, session, "bulkCreateOrReplaceInventoryItem", "/sell/inventory/v1/bulk_create_or_replace_inventory_item", items);
}

/** `POST /sell/inventory/v1/bulk_create_offer` (≤25). */
export async function bulkCreateOffers(
  ctx: SessionCtx,
  session: EbaySellerSession,
  offers: Array<Record<string, unknown>>,
): Promise<EbayResult<EbayBulkEntry[]>> {
  return await bulk(ctx, session, "bulkCreateOffer", "/sell/inventory/v1/bulk_create_offer", offers);
}

/** `POST /sell/inventory/v1/bulk_publish_offer` (≤25). */
export async function bulkPublishOffers(
  ctx: SessionCtx,
  session: EbaySellerSession,
  offerIds: string[],
): Promise<EbayResult<EbayBulkEntry[]>> {
  return await bulk(
    ctx,
    session,
    "bulkPublishOffer",
    "/sell/inventory/v1/bulk_publish_offer",
    offerIds.map((offerId) => ({ offerId })),
  );
}

/** `POST /sell/inventory/v1/bulk_update_price_quantity` (≤25), published offers only. */
export async function bulkUpdatePriceQuantity(
  ctx: SessionCtx,
  session: EbaySellerSession,
  updates: Array<{ sku: string; offerId: string; quantity: number; price: { value: string; currency: "USD" } }>,
): Promise<EbayResult<EbayBulkEntry[]>> {
  return await bulk(
    ctx,
    session,
    "bulkUpdatePriceQuantity",
    "/sell/inventory/v1/bulk_update_price_quantity",
    updates.map((u) => ({
      sku: u.sku,
      shipToLocationAvailability: { quantity: u.quantity },
      offers: [{ offerId: u.offerId, availableQuantity: u.quantity, price: u.price }],
    })),
  );
}

/** `GET /sell/inventory/v1/offer?sku=…&marketplace_id=EBAY_US` → the FIXED_PRICE offer for a SKU, if any. */
export async function getOfferBySku(
  ctx: SessionCtx,
  session: EbaySellerSession,
  sku: string,
): Promise<EbayResult<{ offerId: string; listingId: string | null; published: boolean } | null>> {
  const r = await send(ctx, session, {
    operation: "getOffers",
    method: "GET",
    path: "/sell/inventory/v1/offer",
    query: { sku, marketplace_id: EBAY_MARKETPLACE_ID, format: "FIXED_PRICE", limit: "5" },
    timeoutMs: EBAY_TIMEOUTS_MS.read,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  if (!r.ok) {
    // No offer for the SKU answers 404 (eBay's spec lists it).
    if (r.failure.httpStatus === 404) return { ok: true, value: null };
    return r;
  }
  const offers = isRecord(r.value.body) && Array.isArray(r.value.body.offers) ? r.value.body.offers : [];
  for (const o of offers) {
    if (!isRecord(o) || typeof o.offerId !== "string" || o.sku !== sku) continue;
    const listing = isRecord(o.listing) ? o.listing : {};
    return {
      ok: true,
      value: {
        offerId: o.offerId.slice(0, 64),
        listingId: typeof listing.listingId === "string" ? listing.listingId.slice(0, 40) : null,
        published: o.status === "PUBLISHED",
      },
    };
  }
  return { ok: true, value: null };
}

/** `PUT /sell/inventory/v1/offer/{offerId}`: a FULL replacement of the offer. */
export async function updateOffer(
  ctx: SessionCtx,
  session: EbaySellerSession,
  offerId: string,
  offer: Record<string, unknown>,
): Promise<EbayResult<null>> {
  const r = await send(ctx, session, {
    operation: "updateOffer",
    method: "PUT",
    path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    json: offer,
    timeoutMs: EBAY_TIMEOUTS_MS.write,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  return r.ok ? { ok: true, value: null } : r;
}

/** `POST /sell/inventory/v1/offer/{offerId}/withdraw`: ends the listing, keeps the offer. */
export async function withdrawOffer(ctx: SessionCtx, session: EbaySellerSession, offerId: string): Promise<EbayResult<null>> {
  const r = await send(ctx, session, {
    operation: "withdrawOffer",
    method: "POST",
    path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
    timeoutMs: EBAY_TIMEOUTS_MS.write,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  return r.ok ? { ok: true, value: null } : r;
}

// ── Fulfillment: orders ─────────────────────────────────────────────────────

/** Orders one page asks for (eBay's max for getOrders is 200; default 50). */
export const EBAY_ORDERS_PAGE = 100;

/**
 * `GET /sell/fulfillment/v1/order?filter=…&limit=&offset=` → the page's raw
 * orders (projected by `lib/ebayListing.projectEbayOrder`) and whether more
 * follow (`next` present).
 */
export async function getOrdersPage(
  ctx: SessionCtx,
  session: EbaySellerSession,
  args: { filter: string; offset: number },
): Promise<EbayResult<{ orders: unknown[]; more: boolean; total: number | null }>> {
  const r = await send(ctx, session, {
    operation: "getOrders",
    method: "GET",
    path: "/sell/fulfillment/v1/order",
    query: { filter: args.filter, limit: String(EBAY_ORDERS_PAGE), offset: String(args.offset) },
    timeoutMs: EBAY_TIMEOUTS_MS.read,
    maxBytes: EBAY_MAX_BYTES.orders,
  });
  if (!r.ok) return r;
  const body = isRecord(r.value.body) ? r.value.body : {};
  const orders = Array.isArray(body.orders) ? body.orders.slice(0, EBAY_ORDERS_PAGE) : [];
  return {
    ok: true,
    value: {
      orders,
      more: typeof body.next === "string" && body.next.length > 0,
      total: typeof body.total === "number" ? body.total : null,
    },
  };
}
