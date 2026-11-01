/**
 * NEO-370 — the BuySportsCards SELLER client: the calls NB makes to list a
 * collector's for-sale copies and read the orders they receive.
 *
 * Convex default runtime (fetch only, no "use node"), called from the listing
 * drainer (`listingDrain.ts`) and the order poll (`listingSales.ts`). Both run
 * with NO caller identity, so every call is made for an explicit owner: the
 * token comes from `credentials.getSiteTokenForUser`, and a 401 refreshes
 * through `credentials.refreshSiteTokenForUser` (the NEO-278 backoff and the
 * credential lock apply) ONCE per session, then retries once. A second 401
 * kills the session: nothing more is sent (the NEO-325 rule).
 *
 * The pause switch (`NEONBINDER_PAUSED_PLATFORMS`) is honoured before any
 * token is read: a paused BSC is never contacted.
 *
 * Every response is narrowed here or by the pure modules in `lib/` before
 * anything else reads it; nothing returns a raw body to a caller that stores
 * it. Logs carry platform, operation, status and timing, never a token, a
 * body or an order's buyer.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { isPlatformPaused } from "../marketplacePause";
import { BSC_API_BASE, bscHeaders } from "../lib/bscHttp";
import {
  parseBscOrder,
  parseBscOrderHistoryPage,
  type BscOrder,
  type BscOrderSummary,
} from "../lib/bscOrders";

/** The `credentials` site key for BuySportsCards. */
const SITE = "buysportscards" as const;

/**
 * Per-call timeouts. A seller sheet read returns a whole variant in one body
 * (a 798-row sheet was measured during the NEO-370 spike) and a PUT of 100
 * rows is slow on BSC's side, so the listing calls get far more than the
 * 15s the browser service's fetches use.
 */
export const BSC_SELLER_TIMEOUTS_MS = {
  sheet: 90_000,
  put: 90_000,
  photo: 45_000,
  order: 30_000,
  profile: 20_000,
} as const;

/** BSC answers the sheet read in one body; `size` is a guard, not a page. */
const SHEET_MAX_ROWS = 5000;

/** An uploaded photo's object key: BSC's own path, kept within this shape. */
const OBJECT_KEY_RE = /^[A-Za-z0-9._\-/]{1,300}$/;

/** A seller id as `userProfile.setMarketplaceAccountIdInternal` accepts it. */
const SELLER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type BscSellerFailureKind =
  /** BSC is switched off for this deployment (`NEONBINDER_PAUSED_PLATFORMS`). */
  | "paused"
  /** No token: the collector has not connected BSC, or the token read failed. */
  | "no_token"
  /** BSC refused the session even after a refresh: the collector must sign in again. */
  | "signed_out"
  | "timeout"
  | "network"
  /** A non-2xx other than 401. */
  | "http"
  /** A 2xx whose body NB could not read. */
  | "bad_response";

export interface BscSellerFailure {
  kind: BscSellerFailureKind;
  httpStatus?: number;
  /** An NB-written sentence for logs and the sync record; never a BSC body. */
  message: string;
}

export type BscSellerResult<T> = { ok: true; value: T } | { ok: false; failure: BscSellerFailure };

/**
 * One owner's BSC session for one drain or poll. `token` is replaced in place
 * after a refresh, so later calls send the new one. At most one refresh per
 * session (`reauthAttempted`); `dead` means BSC refused it after that, and
 * every later call fails `signed_out` without a request.
 */
export interface BscSellerSession {
  ownerId: string;
  token: string;
  reauthAttempted: boolean;
  dead: boolean;
}

/** The ctx a session needs: the two credential actions. */
type SessionCtx = Pick<ActionCtx, "runAction">;

function failure(kind: BscSellerFailureKind, message: string, httpStatus?: number): BscSellerFailure {
  return { kind, message, ...(httpStatus !== undefined ? { httpStatus } : {}) };
}

function logCall(operation: string, startedAt: number, outcome: string, httpStatus?: number): void {
  console.log(
    JSON.stringify({
      msg: "bsc_seller_call",
      platform: "bsc",
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

/** Opens a session for `ownerId`, or says why it cannot. Reads the token once. */
export async function openBscSellerSession(
  ctx: SessionCtx,
  ownerId: string,
): Promise<BscSellerResult<BscSellerSession>> {
  if (isPlatformPaused(SITE)) {
    return { ok: false, failure: failure("paused", "BuySportsCards is paused on NeonBinder right now.") };
  }
  const startedAt = Date.now();
  let token: { token: string } | null = null;
  try {
    token = await ctx.runAction(internal.credentials.getSiteTokenForUser, { site: SITE, userId: ownerId });
  } catch {
    token = null;
  }
  logCall("token", startedAt, token ? "ok" : "no_token");
  if (!token) {
    return {
      ok: false,
      failure: failure("no_token", "NeonBinder couldn't sign in to BuySportsCards for you. Connect it again under Profile."),
    };
  }
  return { ok: true, value: { ownerId, token: token.token, reauthAttempted: false, dead: false } };
}

interface SendOptions {
  operation: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  json?: unknown;
  form?: () => FormData;
  timeoutMs: number;
}

/**
 * One request with the session's token: a 401 refreshes once per session and
 * retries once; a second 401 kills the session. Returns the parsed JSON body
 * (or null for an empty 2xx body).
 */
async function send(
  ctx: SessionCtx,
  session: BscSellerSession,
  opts: SendOptions,
): Promise<BscSellerResult<unknown>> {
  if (session.dead) {
    return { ok: false, failure: failure("signed_out", "BuySportsCards signed NeonBinder out. Sign in again under Profile.", 401) };
  }
  const attempt = async (): Promise<Response | BscSellerFailure> => {
    const startedAt = Date.now();
    try {
      const res = await fetch(`${BSC_API_BASE}/${opts.path}`, {
        method: opts.method,
        headers: bscHeaders(session.token, { json: opts.form === undefined }),
        ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
        ...(opts.form !== undefined ? { body: opts.form() } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      logCall(opts.operation, startedAt, res.ok ? "ok" : "http_error", res.status);
      return res;
    } catch (err) {
      const kind = isAbort(err) ? "timeout" : "network";
      logCall(opts.operation, startedAt, kind);
      return failure(
        kind,
        kind === "timeout"
          ? "BuySportsCards took too long to answer."
          : "NeonBinder couldn't reach BuySportsCards.",
      );
    }
  };

  let res = await attempt();
  if (!(res instanceof Response)) return { ok: false, failure: res };

  if (res.status === 401) {
    await res.text().catch(() => "");
    if (session.reauthAttempted) {
      session.dead = true;
      return { ok: false, failure: failure("signed_out", "BuySportsCards signed NeonBinder out. Sign in again under Profile.", 401) };
    }
    session.reauthAttempted = true;
    const refreshStartedAt = Date.now();
    let refreshed = false;
    try {
      const r = await ctx.runAction(internal.credentials.refreshSiteTokenForUser, {
        site: SITE,
        userId: session.ownerId,
      });
      refreshed = r.refreshed;
    } catch {
      refreshed = false;
    }
    let next: { token: string } | null = null;
    if (refreshed) {
      try {
        next = await ctx.runAction(internal.credentials.getSiteTokenForUser, { site: SITE, userId: session.ownerId });
      } catch {
        next = null;
      }
    }
    logCall("reauth", refreshStartedAt, next ? "ok" : "failed");
    if (!next) {
      session.dead = true;
      return { ok: false, failure: failure("signed_out", "BuySportsCards signed NeonBinder out. Sign in again under Profile.", 401) };
    }
    session.token = next.token;
    res = await attempt();
    if (!(res instanceof Response)) return { ok: false, failure: res };
    if (res.status === 401) {
      await res.text().catch(() => "");
      session.dead = true;
      return { ok: false, failure: failure("signed_out", "BuySportsCards signed NeonBinder out. Sign in again under Profile.", 401) };
    }
  }

  if (!res.ok) {
    await res.text().catch(() => "");
    return {
      ok: false,
      failure: failure("http", `BuySportsCards answered ${res.status} to ${opts.operation}.`, res.status),
    };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return {
      ok: false,
      failure: failure(isAbort(err) ? "timeout" : "bad_response", `BuySportsCards' answer to ${opts.operation} could not be read.`, res.status),
    };
  }
  if (text.trim() === "") return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      failure: failure("bad_response", `BuySportsCards' answer to ${opts.operation} was not JSON.`, res.status),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── The seller profile ─────────────────────────────────────────────────────

/**
 * The collector's BSC seller id, the `sellerId` a PUT names. Read from
 * `marketplace/user/profile` → `sellerProfile.sellerId` (the field the browser
 * service's login captures, `services/browser/src/adapters/bsc-adapter.ts`).
 * Null when BSC sends none or one outside the stored shape.
 */
export async function fetchBscSellerId(
  ctx: SessionCtx,
  session: BscSellerSession,
): Promise<BscSellerResult<string | null>> {
  const r = await send(ctx, session, {
    operation: "sellerProfile",
    method: "GET",
    path: "marketplace/user/profile",
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.profile,
  });
  if (!r.ok) return r;
  const profile = isRecord(r.value) && isRecord(r.value.sellerProfile) ? r.value.sellerProfile : null;
  const sellerId = profile && typeof profile.sellerId === "string" ? profile.sellerId : null;
  return { ok: true, value: sellerId !== null && SELLER_ID_RE.test(sellerId) ? sellerId : null };
}

/** True when `value` is a seller id NB will send. */
export function isBscSellerId(value: string): boolean {
  return SELLER_ID_RE.test(value);
}

// ── The listing sheet ──────────────────────────────────────────────────────

/**
 * One condition's seller sheet for one facet combination
 * (`POST seller/bulk-upload/results`): every BSC card the filters select,
 * each with the seller's row for that condition (a blank template at
 * quantity 0 when the seller lists none). Raw only.
 *
 * `filters` are single-valued per facet (the caller fans out with
 * `planBscFanOut`: BSC answers a multi-value facet with 200 and no rows).
 * The rows come back unnarrowed; `planBscSheet` narrows them.
 */
export async function readBscSellerSheet(
  ctx: SessionCtx,
  session: BscSellerSession,
  args: { filters: Record<string, string[]>; condition: string },
): Promise<BscSellerResult<unknown[]>> {
  const r = await send(ctx, session, {
    operation: "sheetRead",
    method: "POST",
    path: "seller/bulk-upload/results",
    json: {
      condition: args.condition,
      currentListings: true,
      productType: "raw",
      page: 0,
      size: SHEET_MAX_ROWS,
      sort: "default",
      filters: args.filters,
    },
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.sheet,
  });
  if (!r.ok) return r;
  // A bare array, as `search/bulk-upload/results` answers; `{results}` is
  // accepted too in case the seller route wraps it.
  const rows = Array.isArray(r.value)
    ? r.value
    : isRecord(r.value) && Array.isArray(r.value.results)
      ? r.value.results
      : null;
  if (rows === null) {
    return { ok: false, failure: failure("bad_response", "BuySportsCards' listing sheet came back in a shape NeonBinder can't read.") };
  }
  return { ok: true, value: rows };
}

/**
 * Sends one chunk of listing rows (`PUT seller/bulk-upload`, at most
 * `BSC_PUT_CHUNK_SIZE`). The answer echoes what changed; NB does not trust it
 * as confirmation and reads the sheet back instead.
 */
export async function putBscListings(
  ctx: SessionCtx,
  session: BscSellerSession,
  args: { sellerId: string; listings: ReadonlyArray<Record<string, unknown>> },
): Promise<BscSellerResult<null>> {
  const r = await send(ctx, session, {
    operation: "listingsPut",
    method: "PUT",
    path: "seller/bulk-upload",
    json: { sellerId: args.sellerId, listings: args.listings },
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.put,
  });
  return r.ok ? { ok: true, value: null } : r;
}

/**
 * Uploads one seller photo (`POST common/card/undefined/product/undefined/
 * attachment`, multipart, the path BSC's own seller app posts to) and returns
 * the object key a listing row's `sellerImgFront` / `sellerImgBack` takes.
 */
export async function uploadBscSellerPhoto(
  ctx: SessionCtx,
  session: BscSellerSession,
  args: { bytes: ArrayBuffer; contentType: string; fileName: string },
): Promise<BscSellerResult<string>> {
  const r = await send(ctx, session, {
    operation: "photoUpload",
    method: "POST",
    path: "common/card/undefined/product/undefined/attachment",
    form: () => {
      const form = new FormData();
      form.append("attachment", new Blob([args.bytes], { type: args.contentType }), args.fileName);
      return form;
    },
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.photo,
  });
  if (!r.ok) return r;
  const key = isRecord(r.value) && typeof r.value.objectKey === "string" ? r.value.objectKey : null;
  if (key === null || !OBJECT_KEY_RE.test(key)) {
    return { ok: false, failure: failure("bad_response", "BuySportsCards didn't say where it stored the photo.") };
  }
  return { ok: true, value: key };
}

// ── Orders ─────────────────────────────────────────────────────────────────

/** Orders one history page asks for. */
export const BSC_ORDER_PAGE_SIZE = 50;

/** One page of order history, newest first, every status (`POST seller/order/history`). */
export async function readBscOrderHistory(
  ctx: SessionCtx,
  session: BscSellerSession,
  page: number,
): Promise<BscSellerResult<{ orders: BscOrderSummary[]; unreadable: number }>> {
  const r = await send(ctx, session, {
    operation: "orderHistory",
    method: "POST",
    path: "seller/order/history",
    json: { name: "", orderNo: "", fromDate: "", toDate: "", page, size: BSC_ORDER_PAGE_SIZE, status: [] },
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.order,
  });
  if (!r.ok) return r;
  const parsed = parseBscOrderHistoryPage(r.value);
  if (parsed === null) {
    return { ok: false, failure: failure("bad_response", "BuySportsCards' order history came back in a shape NeonBinder can't read.") };
  }
  return { ok: true, value: { orders: parsed.orders, unreadable: parsed.unreadable } };
}

/** One order (`GET seller/order/{orderId}`), narrowed: no buyer data survives. */
export async function readBscOrder(
  ctx: SessionCtx,
  session: BscSellerSession,
  orderId: string,
): Promise<BscSellerResult<BscOrder>> {
  const r = await send(ctx, session, {
    operation: "orderDetail",
    method: "GET",
    path: `seller/order/${encodeURIComponent(orderId)}`,
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.order,
  });
  if (!r.ok) return r;
  const order = parseBscOrder(r.value);
  if (order === null || order.orderId !== orderId) {
    return { ok: false, failure: failure("bad_response", "BuySportsCards sent an order NeonBinder can't read.") };
  }
  return { ok: true, value: order };
}
