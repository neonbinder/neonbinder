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
import { narrowBscSheet, type NarrowedBscSheet } from "../lib/bscSheetPlan";
import {
  createBscRecorder,
  type BscCallToken,
  type BscFlushResult,
  type BscRecorder,
} from "../lib/bscCallTelemetry";
import { deploymentName } from "../observability";

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

/**
 * The most bytes NB reads of one answer, per call. A `Content-Length` above
 * the cap is refused before the body is read, and the body is counted while
 * it streams in, so a lying or absent header cannot make NB hold more. The
 * sheet cap fits `SHEET_MAX_ROWS` rows at well over the ~1 KB a measured row
 * takes; the rest are far above anything BSC was seen to send.
 */
export const BSC_SELLER_MAX_BYTES = {
  sheet: 12 * 1024 * 1024,
  put: 4 * 1024 * 1024,
  photo: 64 * 1024,
  order: 1024 * 1024,
  profile: 256 * 1024,
} as const;

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

/**
 * NEO-475 — the failure sentences a collector can read on a set's sync line
 * (`SyncStatusView` adds "The next round tries again."). NB's voice, and no
 * operation name or other internal word: `lastError` is shown as written.
 */
export const BSC_SELLER_COPY = {
  /** BSC's gateway answered 503: its seller API was asleep (cold) and did not wake in time. */
  busy: "BuySportsCards was snoozing and didn't wake up in time.",
  timeout: "BuySportsCards left NeonBinder hanging with no answer.",
  /** Any other non-2xx but 401. */
  http: (status: number) => `BuySportsCards fumbled that one (error ${status}).`,
  /** A 2xx whose body NB could not read or parse. */
  garbled: "BuySportsCards sent back a garbled answer.",
  /** A body past `BSC_SELLER_MAX_BYTES`. */
  tooBig: "BuySportsCards sent back way more than NeonBinder can carry.",
} as const;

/**
 * Fixed-vocabulary detail a call's log line may carry (NEO-475: a sheet read's
 * BSC condition key and its retry attempt). Never an id, a token or a body.
 */
type LogFields = { condition?: string; attempt?: number };

function logCall(operation: string, startedAt: number, outcome: string, httpStatus?: number, fields?: LogFields): void {
  console.log(
    JSON.stringify({
      msg: "bsc_seller_call",
      platform: "bsc",
      operation,
      ...(fields?.condition !== undefined ? { condition: fields.condition } : {}),
      ...(fields?.attempt !== undefined ? { attempt: fields.attempt } : {}),
      outcome,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      durationMs: Date.now() - startedAt,
    }),
  );
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

// ── NEO-475: call telemetry ────────────────────────────────────────────────

/**
 * One BSC call recorder (`lib/bscCallTelemetry.ts`) per seller session, kept
 * beside the session rather than on it so the session's shape, and every
 * caller or test that builds one, is unchanged. `openBscSellerSession` names
 * the recorder after its owner (the drain, the order poll, the test cleanup);
 * a session built some other way gets one on its first call.
 */
const sessionRecorders = new WeakMap<BscSellerSession, BscRecorder>();

/** The op a session's summary carries when its opener named none. */
const DEFAULT_SESSION_OP = "bscSellerSession";

/**
 * A seller session's recorder. `keysOnly`: a seller call's failed body can
 * name an order, a buyer, an address or a phone, and redaction is pattern
 * based, so only key names and safe-shaped `code` / `status` values are kept.
 */
function newSessionRecorder(op: string): BscRecorder {
  return createBscRecorder(op, { deployment: deploymentName(), bodyMode: "keysOnly" });
}

function recorderFor(session: BscSellerSession): BscRecorder {
  let rec = sessionRecorders.get(session);
  if (!rec) {
    rec = newSessionRecorder(DEFAULT_SESSION_OP);
    sessionRecorders.set(session, rec);
  }
  return rec;
}

/**
 * NEO-475 — emits a recorder's summary line and, when `ctx` can schedule,
 * hands the row to `bscCallStats.record` off the hot path. Awaited once, when
 * the invocation (or session) ends. Never throws: a failed flush or a refused
 * `runAfter` is logged and swallowed, so telemetry cannot change a result.
 *
 * A ctx without `scheduler` (a stub, or a caller typed without one) gets the
 * `bsc_call_summary` log line only.
 */
export async function flushBscRecorder(ctx: unknown, recorder: BscRecorder): Promise<void> {
  let out: BscFlushResult | null = null;
  try {
    out = await recorder.flush();
  } catch {
    return;
  }
  if (!out) return;
  const scheduler =
    ctx !== null && typeof ctx === "object"
      ? (ctx as { scheduler?: Partial<ActionCtx["scheduler"]> }).scheduler
      : undefined;
  if (!scheduler || typeof scheduler.runAfter !== "function") return;
  try {
    await scheduler.runAfter(0, internal.bscCallStats.record, out.row);
  } catch (err) {
    try {
      console.warn(
        JSON.stringify({
          msg: "bsc_call_summary_not_recorded",
          platform: "bsc",
          operation: out.summary.op,
          error: err instanceof Error ? err.name : "unknown",
        }),
      );
    } catch {
      // telemetry never throws into a caller
    }
  }
}

/**
 * NEO-475 — ends a session's telemetry: its one `bsc_call_summary` line and
 * its `bscCallSummaries` row. Call once, in the `finally` of whatever opened
 * the session; a second call (or a session that sent nothing) does nothing.
 */
export async function closeBscSellerSession(ctx: unknown, session: BscSellerSession): Promise<void> {
  const rec = sessionRecorders.get(session);
  if (!rec) return;
  sessionRecorders.delete(session);
  await flushBscRecorder(ctx, rec);
}

/**
 * Opens a session for `ownerId`, or says why it cannot. Reads the token once.
 *
 * `opts.op` names the session's call summary (NEO-475); the opener closes it
 * with `closeBscSellerSession`.
 */
export async function openBscSellerSession(
  ctx: SessionCtx,
  ownerId: string,
  opts: { op?: string } = {},
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
  const session: BscSellerSession = { ownerId, token: token.token, reauthAttempted: false, dead: false };
  sessionRecorders.set(session, newSessionRecorder(opts.op ?? DEFAULT_SESSION_OP));
  return { ok: true, value: session };
}

interface SendOptions {
  operation: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  /**
   * `path` with its ids replaced (`seller/order/:id`), for call telemetry.
   * Required, and a literal at every call site: a raw path can carry an id
   * into the telemetry row, so there is no fallback to `path` (NEO-475).
   */
  pathTemplate: string;
  json?: unknown;
  form?: () => FormData;
  timeoutMs: number;
  /** The most bytes of the answer NB reads (`BSC_SELLER_MAX_BYTES`). */
  maxBytes: number;
  /** Extra fields for this call's `bsc_seller_call` line (NEO-475). */
  logFields?: LogFields;
}

/**
 * The body as text, or null when it is (or claims to be) over `maxBytes`.
 * Reads the stream itself so a body without a `Content-Length`, or with a
 * false one, still stops at the cap.
 */
export async function readCappedText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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
  // NEO-475: every request is recorded; `last.call` is the request whose
  // answer is read below, so a body that fails after a 2xx lands on it.
  const rec = recorderFor(session);
  let attempts = 0;
  const last: { call?: BscCallToken } = {};
  const attempt = async (): Promise<Response | BscSellerFailure> => {
    const startedAt = Date.now();
    attempts += 1;
    const call = rec.start({ pathTemplate: opts.pathTemplate, timeoutMs: opts.timeoutMs, attempt: attempts });
    last.call = call;
    try {
      const res = await fetch(`${BSC_API_BASE}/${opts.path}`, {
        method: opts.method,
        headers: bscHeaders(session.token, { json: opts.form === undefined }),
        ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
        ...(opts.form !== undefined ? { body: opts.form() } : {}),
        // The bearer token goes to BSC's API host and nowhere else: a
        // redirect is a failure, never followed.
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      rec.respond(call, res);
      logCall(opts.operation, startedAt, res.ok ? "ok" : "http_error", res.status, opts.logFields);
      return res;
    } catch (err) {
      rec.fail(call, { error: err });
      const kind = isAbort(err) ? "timeout" : "network";
      logCall(opts.operation, startedAt, kind, undefined, opts.logFields);
      return failure(kind, kind === "timeout" ? BSC_SELLER_COPY.timeout : "NeonBinder couldn't reach BuySportsCards.");
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
      failure: failure(
        "http",
        res.status === 503 ? BSC_SELLER_COPY.busy : BSC_SELLER_COPY.http(res.status),
        res.status,
      ),
    };
  }
  let text: string | null;
  try {
    text = await readCappedText(res, opts.maxBytes);
  } catch (err) {
    if (last.call) rec.fail(last.call, { kind: isAbort(err) ? "body_timeout" : "parse", error: err, response: res });
    return {
      ok: false,
      failure: isAbort(err)
        ? failure("timeout", BSC_SELLER_COPY.timeout, res.status)
        : failure("bad_response", BSC_SELLER_COPY.garbled, res.status),
    };
  }
  if (text === null) {
    if (last.call) rec.fail(last.call, { kind: "parse", response: res });
    return {
      ok: false,
      failure: failure("bad_response", BSC_SELLER_COPY.tooBig, res.status),
    };
  }
  if (text.trim() === "") return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    if (last.call) rec.fail(last.call, { kind: "parse", error: err, response: res });
    return {
      ok: false,
      failure: failure("bad_response", BSC_SELLER_COPY.garbled, res.status),
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
    pathTemplate: "marketplace/user/profile",
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.profile,
    maxBytes: BSC_SELLER_MAX_BYTES.profile,
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
 * Each row is narrowed as it is read (`narrowBscSheet`): an unreadable or
 * oversized row is counted and dropped, never held.
 *
 * `attempt` (1 when absent) is the caller's retry count for this condition and
 * filter (`listingDrain.readSheets`), logged with the condition (NEO-475).
 */
export async function readBscSellerSheet(
  ctx: SessionCtx,
  session: BscSellerSession,
  args: { filters: Record<string, string[]>; condition: string; attempt?: number },
): Promise<BscSellerResult<NarrowedBscSheet>> {
  const r = await send(ctx, session, {
    operation: "sheetRead",
    method: "POST",
    path: "seller/bulk-upload/results",
    pathTemplate: "seller/bulk-upload/results",
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
    maxBytes: BSC_SELLER_MAX_BYTES.sheet,
    logFields: { condition: args.condition, attempt: args.attempt ?? 1 },
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
  return { ok: true, value: narrowBscSheet(rows.slice(0, SHEET_MAX_ROWS)) };
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
    pathTemplate: "seller/bulk-upload",
    json: { sellerId: args.sellerId, listings: args.listings },
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.put,
    maxBytes: BSC_SELLER_MAX_BYTES.put,
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
    pathTemplate: "common/card/undefined/product/undefined/attachment",
    form: () => {
      const form = new FormData();
      form.append("attachment", new Blob([args.bytes], { type: args.contentType }), args.fileName);
      return form;
    },
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.photo,
    maxBytes: BSC_SELLER_MAX_BYTES.photo,
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
    pathTemplate: "seller/order/history",
    json: { name: "", orderNo: "", fromDate: "", toDate: "", page, size: BSC_ORDER_PAGE_SIZE, status: [] },
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.order,
    maxBytes: BSC_SELLER_MAX_BYTES.order,
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
    pathTemplate: "seller/order/:id",
    timeoutMs: BSC_SELLER_TIMEOUTS_MS.order,
    maxBytes: BSC_SELLER_MAX_BYTES.order,
  });
  if (!r.ok) return r;
  const order = parseBscOrder(r.value);
  if (order === null || order.orderId !== orderId) {
    return { ok: false, failure: failure("bad_response", "BuySportsCards sent an order NeonBinder can't read.") };
  }
  return { ok: true, value: order };
}
