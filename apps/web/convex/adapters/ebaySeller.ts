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
 * carry platform, operation, status and timing, never a token or a body;
 * a refusal's log line also carries eBay's error text and parameters,
 * redacted and capped (`ebayErrorDetailsOf`), so a red live run names the
 * field eBay objected to.
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
  /** A page of inventory items, each with its description and aspects. */
  inventory: 8 * 1024 * 1024,
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
  /**
   * The session's one token refresh, once started: concurrent calls that hit
   * a 401 together all wait on it instead of each spending (or, finding it
   * spent, killing) the session (`reauthOnce`).
   */
  reauth?: Promise<boolean>;
  /**
   * Tokens this session held before its current one (a refresh replaced
   * them), so a log line masks every token the session ever sent, not only
   * the one it holds when the line is written.
   */
  pastTokens?: string[];
}

type SessionCtx = Pick<ActionCtx, "runAction">;

const SIGNED_OUT = "eBay signed NeonBinder out. Connect eBay again in Profile → Credentials → eBay.";

/**
 * What a failure SAYS (NB copy; callers show it as it is, or put their own
 * sentence for the step in its place). The operation and status never go in
 * it: they go to the structured `ebay_seller_error` log line.
 */
export const EBAY_SAYS = {
  timeout: "eBay took too long to answer. Try again in a bit.",
  network: "NeonBinder couldn't reach eBay. Try again in a bit.",
  busy: "eBay's not answering right now. Try again in a bit.",
  refused: "eBay turned that one down. Try again in a bit.",
  unreadable: "eBay sent back something NeonBinder couldn't read. Try again in a bit.",
} as const;

/**
 * An eBay failure in NB's words for the step that hit it. The adapter's own
 * sentences (signed out, timeout, no network, not connected) pass through;
 * eBay saying no (a 4xx) gets `refused`, the step's own sentence; eBay busy
 * (5xx, 429) or an answer NB couldn't read gets `busy`. eBay's status and
 * error ids are already in the `ebay_seller_error` log line.
 */
export function sayEbayFailure(failure: EbayFailure, refused: string, busy: string = EBAY_SAYS.busy): string {
  if (failure.kind === "bad_response") return busy;
  if (failure.kind !== "http") return failure.message;
  const status = failure.httpStatus ?? 0;
  return status >= 500 || status === 429 ? busy : refused;
}

/** The NB sentence for an eBay HTTP failure: a server-side or rate-limit status is eBay being busy, anything else a refusal. */
function httpSays(status: number): string {
  return status >= 500 || status === 429 ? EBAY_SAYS.busy : EBAY_SAYS.refused;
}

/**
 * One structured line per failed eBay answer: operation, status, eBay's
 * numeric error ids and, for a refusal, `errors` (`ebayErrorDetailsOf`).
 * Never the token, the request or the raw body.
 */
function logFailure(
  operation: string,
  httpStatus: number,
  extra: { errorIds?: number[]; errors?: EbayErrorDetail[]; reason?: string; attempt?: number },
): void {
  console.log(JSON.stringify({ msg: "ebay_seller_error", platform: "ebay", operation, httpStatus, ...extra }));
}

function failure(kind: EbayFailureKind, message: string, extra: { httpStatus?: number; errorIds?: number[] } = {}): EbayFailure {
  return {
    kind,
    message,
    ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    ...(extra.errorIds && extra.errorIds.length > 0 ? { errorIds: extra.errorIds } : {}),
  };
}

/** `attempt` is set only on a busy retry (`publishOffer`), so a first call's line is unchanged. */
function logCall(operation: string, startedAt: number, outcome: string, httpStatus?: number, attempt?: number): void {
  console.log(
    JSON.stringify({
      msg: "ebay_seller_call",
      platform: "ebay",
      operation,
      outcome,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
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

/**
 * What one eBay error says, for the log line only (never the UI, never the
 * sync record): eBay's message, longMessage, parameters (name/value) and
 * inputRefIds. eBay's Account errors are templates ("Invalid {fieldName}.
 * {additionalInfo}", e.g. 20403), so the field eBay objected to is in this
 * text or in a parameter, never in the id alone.
 */
export interface EbayErrorDetail {
  errorId?: number;
  message?: string;
  longMessage?: string;
  parameters?: Array<{ name: string; value?: string }>;
  inputRefIds?: string[];
}

const DETAIL_ERRORS_MAX = 5;
const DETAIL_PARAMETERS_MAX = 8;
const DETAIL_REFS_MAX = 8;
const DETAIL_TEXT_MAX = 300;
const DETAIL_VALUE_MAX = 120;
const DETAIL_NAME_MAX = 60;
const REDACTED = "[redacted]";
/** A dotted field path, optionally indexed: `A[0].b.c`. */
const FIELD_PATH = /^[A-Za-z0-9_.[\]]+$/;
const LONG_WORD = /[A-Za-z0-9_]{33,}/;

/**
 * eBay's text with what could be the seller's data or a credential taken
 * out: an email address, any unbroken run of 33+ characters that is not a
 * dotted field path (a token, a URL, base64), any run of 33+ letters and
 * digits even inside a path, and any run of 5+ digits (a ZIP, a phone
 * number, an order or item id). Whitespace collapsed; capped. Null when
 * nothing is left. eBay's own wording and field paths such as
 * `DomesticItemShippingService[0].shippingService` pass through.
 */
export function redactEbayText(raw: unknown, max: number = DETAIL_TEXT_MAX): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .slice(0, 4 * max)
    .replace(/\S+@\S+/g, REDACTED)
    .replace(/\S{33,}/g, (run) => (FIELD_PATH.test(run) && !LONG_WORD.test(run) ? run : REDACTED))
    .replace(/\d{5,}/g, REDACTED)
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** eBay's error text and parameters out of an `{ errors: [...] }` body, redacted and capped; [] when none says anything. */
export function ebayErrorDetailsOf(body: unknown): EbayErrorDetail[] {
  if (!isRecord(body) || !Array.isArray(body.errors)) return [];
  const out: EbayErrorDetail[] = [];
  for (const e of body.errors.slice(0, DETAIL_ERRORS_MAX)) {
    if (!isRecord(e)) continue;
    const detail: EbayErrorDetail = {};
    if (typeof e.errorId === "number" && Number.isInteger(e.errorId)) detail.errorId = e.errorId;
    const message = redactEbayText(e.message);
    if (message) detail.message = message;
    const longMessage = redactEbayText(e.longMessage);
    if (longMessage && longMessage !== message) detail.longMessage = longMessage;
    if (Array.isArray(e.parameters)) {
      const parameters: Array<{ name: string; value?: string }> = [];
      for (const p of e.parameters.slice(0, DETAIL_PARAMETERS_MAX)) {
        if (!isRecord(p)) continue;
        const name = redactEbayText(p.name, DETAIL_NAME_MAX);
        if (!name) continue;
        const value = redactEbayText(p.value, DETAIL_VALUE_MAX);
        parameters.push(value ? { name, value } : { name });
      }
      if (parameters.length > 0) detail.parameters = parameters;
    }
    if (Array.isArray(e.inputRefIds)) {
      const refs = e.inputRefIds
        .slice(0, DETAIL_REFS_MAX)
        .map((r) => redactEbayText(r, DETAIL_VALUE_MAX))
        .filter((r): r is string => r !== null);
      if (refs.length > 0) detail.inputRefIds = refs;
    }
    if (detail.message || detail.longMessage || detail.parameters || detail.inputRefIds) out.push(detail);
  }
  return out;
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
    return { ok: false, failure: failure("no_token", "NeonBinder couldn't reach your eBay account. Connect eBay again in Profile → Credentials → eBay.") };
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
  /** Which try this is when the caller retries a busy answer (2); its log lines carry it. Absent on a first try. */
  attempt?: number;
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
 * The session's single token refresh. The first caller starts it; a caller
 * arriving while it runs, or after, gets the same answer. A session opened
 * with `reauthAttempted` already true (its owner holds the credential lock)
 * never refreshes. True when the session now holds a fresh token.
 */
async function reauthOnce(ctx: SessionCtx, session: EbaySellerSession): Promise<boolean> {
  if (!session.reauth) {
    if (session.reauthAttempted) return false;
    session.reauthAttempted = true;
    session.reauth = (async () => {
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
      if (!next) return false;
      (session.pastTokens ??= []).push(session.token);
      session.token = next.token;
      return true;
    })();
  }
  return await session.reauth;
}

function attemptOf(opts: SendOptions): { attempt?: number } {
  return opts.attempt !== undefined ? { attempt: opts.attempt } : {};
}

/**
 * One request with the session's token: a 401 refreshes once per session and
 * retries once; a second 401 kills the session. Calls running at once share
 * that one refresh: a call whose 401 came with the token another call has
 * since replaced retries with the new one. A non-2xx other than 401
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
      logCall(opts.operation, startedAt, res.ok ? "ok" : "http_error", res.status, opts.attempt);
      return res;
    } catch (err) {
      const kind = isAbort(err) ? "timeout" : "network";
      logCall(opts.operation, startedAt, kind, undefined, opts.attempt);
      return failure(kind, kind === "timeout" ? EBAY_SAYS.timeout : EBAY_SAYS.network);
    }
  };

  // The token this attempt carries (`attempt` reads it before its first await).
  const sentWith = session.token;
  let res = await attempt();
  if (!(res instanceof Response)) return { ok: false, failure: res };
  if (res.status === 401) {
    await res.text().catch(() => "");
    // Already replaced by a concurrent call's refresh: retry with it. Otherwise
    // refresh (or wait on the refresh already running); a refresh that gives
    // back the token that was just refused is no refresh.
    const fresh = session.token !== sentWith || ((await reauthOnce(ctx, session)) && session.token !== sentWith);
    if (session.dead || !fresh) {
      session.dead = true;
      return { ok: false, failure: failure("signed_out", SIGNED_OUT, { httpStatus: 401 }) };
    }
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
    const timedOut = isAbort(err);
    logFailure(opts.operation, res.status, { reason: timedOut ? "body_timeout" : "body_unreadable", ...attemptOf(opts) });
    return {
      ok: false,
      failure: failure(timedOut ? "timeout" : "bad_response", timedOut ? EBAY_SAYS.timeout : EBAY_SAYS.unreadable, {
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
    const errorIds = errorIdsOf(body);
    // eBay's ids, plus its text and parameters redacted (`ebayErrorDetailsOf`):
    // what a red live run needs to name the refusal and the field. The text
    // goes to this log line only; the failure carries NB's sentence.
    const errors = ebayErrorDetailsOf(body);
    logFailure(opts.operation, res.status, { errorIds, ...(errors.length > 0 ? { errors } : {}), ...attemptOf(opts) });
    return {
      ok: false,
      failure: failure("http", httpSays(res.status), {
        httpStatus: res.status,
        errorIds,
      }),
    };
  }
  if (text === null) {
    logFailure(opts.operation, res.status, { reason: "body_too_large", ...attemptOf(opts) });
    return { ok: false, failure: failure("bad_response", EBAY_SAYS.unreadable, { httpStatus: res.status }) };
  }
  if (body === undefined) {
    logFailure(opts.operation, res.status, { reason: "body_not_json", ...attemptOf(opts) });
    return { ok: false, failure: failure("bad_response", EBAY_SAYS.unreadable, { httpStatus: res.status }) };
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

/**
 * Metadata `PackageLimits`: the physical limits eBay states for a service
 * (its units beside them). Only the fields eBay sent, as numbers or unit words.
 */
export type EbayPackageLimits = Partial<Record<(typeof PACKAGE_LIMIT_NUMBERS)[number], number>> & {
  weightUnit?: string;
  dimensionUnit?: string;
};

const PACKAGE_LIMIT_NUMBERS = [
  "maxWeight",
  "minWeight",
  "maxLength",
  "minLength",
  "maxWidth",
  "minWidth",
  "maxHeight",
  "minHeight",
  "maxGirth",
  "minGirth",
] as const;

function readPackageLimits(raw: unknown): EbayPackageLimits | null {
  if (!isRecord(raw)) return null;
  const out: EbayPackageLimits = {};
  for (const k of PACKAGE_LIMIT_NUMBERS) {
    const n = raw[k];
    if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  }
  for (const k of ["weightUnit", "dimensionUnit"] as const) {
    const u = raw[k];
    if (typeof u === "string" && u.length > 0) out[k] = u.slice(0, 20);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function wholeOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 1000 ? n : null;
}

export interface EbayShippingServiceInfo {
  code: string;
  /** eBay's localized name for the service (Metadata `ShippingService.description`), e.g. "USPS Ground Advantage". */
  description: string | null;
  carrier: string | null;
  international: boolean;
  /** `validForSellingFlow` is true. False when eBay said false OR left it out (`validForSellingStated` tells which). */
  validForSelling: boolean;
  /** Whether eBay sent `validForSellingFlow` at all (diagnostics only). */
  validForSellingStated: boolean;
  costTypes: string[];
  /** Metadata `shippingCategory` (ECONOMY, STANDARD, …), as eBay wrote it. Diagnostics only. */
  category: string | null;
  /** Metadata `minShippingTime` / `maxShippingTime`, business days. Diagnostics only. */
  minDays: number | null;
  maxDays: number | null;
  /** Metadata `packageLimits`; null when eBay states none. Diagnostics only. */
  packageLimits: EbayPackageLimits | null;
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
      description: typeof s.description === "string" ? s.description.slice(0, 120) : null,
      carrier: typeof s.shippingCarrier === "string" ? s.shippingCarrier.slice(0, 40) : null,
      international: s.internationalService === true,
      validForSelling: s.validForSellingFlow === true,
      validForSellingStated: typeof s.validForSellingFlow === "boolean",
      costTypes: Array.isArray(s.shippingCostTypes)
        ? s.shippingCostTypes.filter((t): t is string => typeof t === "string").map((t) => t.slice(0, 20)).slice(0, 10)
        : [],
      category: typeof s.shippingCategory === "string" ? s.shippingCategory.slice(0, 40) : null,
      minDays: wholeOrNull(s.minShippingTime),
      maxDays: wholeOrNull(s.maxShippingTime),
      packageLimits: readPackageLimits(s.packageLimits),
    });
  }
  return { ok: true, value: out };
}

// ── Inventory location ──────────────────────────────────────────────────────

/**
 * `GET /sell/inventory/v1/location/{key}`: whether the seller already has
 * the location, and whether it is enabled. A 404 is "not there".
 */
async function readInventoryLocation(
  ctx: SessionCtx,
  session: EbaySellerSession,
  key: string,
): Promise<EbayResult<{ exists: false } | { exists: true; disabled: boolean }>> {
  const r = await send(ctx, session, {
    operation: "getInventoryLocation",
    method: "GET",
    path: `/sell/inventory/v1/location/${encodeURIComponent(key)}`,
    timeoutMs: EBAY_TIMEOUTS_MS.read,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  if (!r.ok) return r.failure.httpStatus === 404 ? { ok: true, value: { exists: false } } : r;
  const status = isRecord(r.value.body) ? r.value.body.merchantLocationStatus : undefined;
  return { ok: true, value: { exists: true, disabled: status === "DISABLED" } };
}

/**
 * Makes the seller's inventory location `key` say `address`: a WAREHOUSE in
 * the US. Safe to repeat. The location is READ first (`GET /location/{key}`):
 *   not there  → `POST /location/{key}` (create, enabled)
 *   there      → `POST /location/{key}/update_location_details` (the address
 *                of a warehouse may change any number of times), then
 *                `POST /location/{key}/enable` if the seller disabled it
 * Reading first is what makes a second save work: eBay's contract says an
 * existing key answers create with 409, but the sandbox answered 400 (the
 * key survives a Disconnect, so every save after the first hits it). A
 * create that fails anyway (a save racing another) reads again and updates
 * when the location turned out to be there; otherwise its own failure stands.
 */
export async function upsertInventoryLocation(
  ctx: SessionCtx,
  session: EbaySellerSession,
  key: string,
  address: { postalCode: string; city: string; stateOrProvince: string },
): Promise<EbayResult<null>> {
  const addr = { city: address.city, stateOrProvince: address.stateOrProvince, postalCode: address.postalCode, country: "US" };
  const path = `/sell/inventory/v1/location/${encodeURIComponent(key)}`;
  const update = async (disabled: boolean): Promise<EbayResult<null>> => {
    const updated = await send(ctx, session, {
      operation: "updateInventoryLocation",
      method: "POST",
      path: `${path}/update_location_details`,
      json: { location: { address: addr }, locationTypes: ["WAREHOUSE"], name: "NeonBinder" },
      timeoutMs: EBAY_TIMEOUTS_MS.write,
      maxBytes: EBAY_MAX_BYTES.small,
    });
    if (!updated.ok) return updated;
    if (!disabled) return { ok: true, value: null };
    const enabled = await send(ctx, session, {
      operation: "enableInventoryLocation",
      method: "POST",
      path: `${path}/enable`,
      timeoutMs: EBAY_TIMEOUTS_MS.write,
      maxBytes: EBAY_MAX_BYTES.small,
    });
    return enabled.ok ? { ok: true, value: null } : enabled;
  };

  const before = await readInventoryLocation(ctx, session, key);
  if (!before.ok) return before;
  if (before.value.exists) return await update(before.value.disabled);
  const created = await send(ctx, session, {
    operation: "createInventoryLocation",
    method: "POST",
    path,
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
  if (created.failure.httpStatus !== 400 && created.failure.httpStatus !== 409) return created;
  const after = await readInventoryLocation(ctx, session, key);
  if (!after.ok || !after.value.exists) return created;
  return await update(after.value.disabled);
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

const MEDIA_IMAGE_PATH = "/commerce/media/v1_beta/image";
/** The image id segment at the end of create's `Location` header (`…/commerce/media/v1_beta/image/{image_id}`). */
const IMAGE_ID_IN_LOCATION = /\/commerce\/media\/v1_beta\/image\/([^/?#]{1,256})\/?$/;

/** The image id a `Location` header names (decoded; printable, no slash), or null. */
function imageIdOf(location: string | null, base: string): string | null {
  if (!location) return null;
  try {
    const segment = IMAGE_ID_IN_LOCATION.exec(new URL(location, base).pathname)?.[1];
    const id = segment === undefined ? null : decodeURIComponent(segment);
    return id !== null && /^[\x21-\x7e]{1,128}$/.test(id) && !id.includes("/") ? id : null;
  } catch {
    return null;
  }
}

/** An ImageResponse body narrowed to its https URL and expiry, or null. */
function readImageResponse(body: unknown): { url: string; expiresAt: number | null } | null {
  const b = isRecord(body) ? body : {};
  const url = typeof b.imageUrl === "string" ? b.imageUrl : null;
  if (!url || !url.startsWith("https://") || url.length > 500) return null;
  const expires = typeof b.expirationDate === "string" ? Date.parse(b.expirationDate) : NaN;
  return { url, expiresAt: Number.isFinite(expires) ? expires : null };
}

/**
 * Uploads one picture (`POST /commerce/media/v1_beta/image/create_image_from_file`
 * on the `apim.` host, multipart, the file in the form field `image`: the
 * Media contract's method description gives `image: "sample_picture.jpg"`)
 * and returns eBay's hosted URL. The contract types the 201 body as an
 * ImageResponse (`imageUrl`, `expirationDate`) but tells callers to capture
 * the image id from the `Location` header and read it with `getImage`; when
 * the body carries no usable URL, that is what happens
 * (`GET /commerce/media/v1_beta/image/{image_id}` on the configured media
 * host, never the header's own host).
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
    path: `${MEDIA_IMAGE_PATH}/create_image_from_file`,
    form: () => {
      const form = new FormData();
      form.append("image", new Blob([args.bytes], { type: args.contentType }), args.fileName);
      return form;
    },
    timeoutMs: EBAY_TIMEOUTS_MS.media,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  if (!r.ok) return r;
  const noUrl = { ok: false as const, failure: failure("bad_response", "eBay didn't say where it put the photo.") };
  const direct = readImageResponse(r.value.body);
  if (direct) return { ok: true, value: direct };
  const imageId = imageIdOf(r.value.location, session.config.mediaBase);
  if (!imageId) return noUrl;
  const read = await send(ctx, session, {
    operation: "getImage",
    method: "GET",
    host: "media",
    path: `${MEDIA_IMAGE_PATH}/${encodeURIComponent(imageId)}`,
    timeoutMs: EBAY_TIMEOUTS_MS.read,
    maxBytes: EBAY_MAX_BYTES.small,
  });
  if (!read.ok) return read;
  const image = readImageResponse(read.value.body);
  return image ? { ok: true, value: image } : noUrl;
}

// ── Inventory: items and offers ─────────────────────────────────────────────

/** One entry of a bulk answer, narrowed. */
export interface EbayBulkEntry {
  statusCode: number;
  sku: string | null;
  offerId: string | null;
  listingId: string | null;
  errorIds: number[];
  /** eBay's text and parameters for this entry, redacted and capped (`ebayErrorDetailsOf`): the log line only. */
  errors: EbayErrorDetail[];
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
      errors: ebayErrorDetailsOf(e),
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
    const errorIds = errorIdsOf(r.value.body);
    const errors = ebayErrorDetailsOf(r.value.body);
    logFailure(operation, r.value.status, { errorIds, ...(errors.length > 0 ? { errors } : {}) });
    return {
      ok: false,
      failure: failure("http", httpSays(r.value.status), { httpStatus: r.value.status, errorIds }),
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

/** eBay's answer to one offer's publish: its listing on success, its error ids and details when refused. */
export interface EbayPublishAnswer {
  statusCode: number;
  listingId: string | null;
  errorIds: number[];
  /** eBay's text and parameters, redacted and capped (`ebayErrorDetailsOf`): the log line only. */
  errors: EbayErrorDetail[];
}

/**
 * Statuses where eBay refused THIS offer (its body names why), as opposed to
 * eBay busy, signed out or refusing the seller: those stay failures.
 */
const PUBLISH_REFUSAL_STATUSES = [400, 404, 409, 422];

/** How long `publishOffer` waits before its one retry of a busy answer (5xx or 429). */
export const EBAY_PUBLISH_RETRY_PAUSE_MS = 1_000;

/** A wait; injected in tests so a retry costs no real time. */
export type EbayPause = (ms: number) => Promise<void>;

const realPause: EbayPause = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * eBay said it is busy: an HTTP answer of 5xx or 429. Not a refusal (4xx), a
 * sign-out (401, handled inside `send`), a timeout, a network failure or an
 * answer NB couldn't read.
 */
export function isBusyAnswer(f: EbayFailure): boolean {
  if (f.kind !== "http" || f.httpStatus === undefined) return false;
  return f.httpStatus >= 500 || f.httpStatus === 429;
}

/**
 * `POST /sell/inventory/v1/offer/{offerId}/publish`: one offer goes live.
 * One call per offer, run side by side by the drain, because eBay's
 * bulk_publish_offer took ~9 s for two offers on the sandbox while a single
 * publish answers in about the time of one. A refusal of this offer
 * (`PUBLISH_REFUSAL_STATUSES` with a JSON body) is an answer, with eBay's
 * ids and details, like a bulk call's per-entry result; anything else fails.
 *
 * eBay busy (5xx or 429) is tried once more after
 * `EBAY_PUBLISH_RETRY_PAUSE_MS` (the sandbox has answered one publish of a
 * pair 500/25001 while the other went live); that second answer is the
 * result, whatever it is. Each try logs its own `ebay_seller_call` line, the
 * retry's with `attempt: 2`. The retry goes through `send`, so a 401 on it
 * shares the session's one refresh and a dead session is not called again.
 */
export async function publishOffer(
  ctx: SessionCtx,
  session: EbaySellerSession,
  offerId: string,
  pause: EbayPause = realPause,
): Promise<EbayResult<EbayPublishAnswer>> {
  const opts: SendOptions = {
    operation: "publishOffer",
    method: "POST",
    path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
    timeoutMs: EBAY_TIMEOUTS_MS.write,
    maxBytes: EBAY_MAX_BYTES.small,
    bodyStatuses: PUBLISH_REFUSAL_STATUSES,
  };
  let r = await send(ctx, session, opts);
  if (!r.ok && isBusyAnswer(r.failure)) {
    await pause(EBAY_PUBLISH_RETRY_PAUSE_MS);
    r = await send(ctx, session, { ...opts, attempt: 2 });
  }
  if (!r.ok) return r;
  const body = r.value.body;
  const listingId = isRecord(body) && typeof body.listingId === "string" && body.listingId.length > 0 && body.listingId.length <= 64 ? body.listingId : null;
  return {
    ok: true,
    value: { statusCode: r.value.status, listingId, errorIds: errorIdsOf(body), errors: ebayErrorDetailsOf(body) },
  };
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

/** Items one inventory page asks for (eBay's contract: 1 to 200, default 25). */
export const EBAY_INVENTORY_PAGE = 100;

/**
 * `GET /sell/inventory/v1/inventory_item?limit=&offset=` → one page of the
 * seller's SKUs; nothing else of the items is held. Testing cleanup only.
 *
 * `offset` is a PAGE NUMBER on this route, not a record offset (Sell Inventory
 * contract: the first page is 0, the second 1), unlike `getOrdersPage`. So the
 * caller never does the arithmetic: `nextOffset` is the `offset` in eBay's own
 * `next` link, null when there is no `next`. A `next` NB can't read fails, so a
 * caller can never take a partial listing for the whole one.
 */
export async function getInventorySkusPage(
  ctx: SessionCtx,
  session: EbaySellerSession,
  offset: string,
): Promise<EbayResult<{ skus: string[]; unreadable: number; nextOffset: string | null }>> {
  const r = await send(ctx, session, {
    operation: "getInventoryItems",
    method: "GET",
    path: "/sell/inventory/v1/inventory_item",
    query: { limit: String(EBAY_INVENTORY_PAGE), offset },
    timeoutMs: EBAY_TIMEOUTS_MS.read,
    maxBytes: EBAY_MAX_BYTES.inventory,
  });
  if (!r.ok) return r;
  const body = r.value.body;
  if (!isRecord(body)) return { ok: false, failure: failure("bad_response", EBAY_SAYS.unreadable, { httpStatus: r.value.status }) };
  const skus: string[] = [];
  let unreadable = 0;
  // An account with no items answers with no `inventoryItems` at all.
  for (const raw of Array.isArray(body.inventoryItems) ? body.inventoryItems : []) {
    // eBay's SKU limit is 50: a longer one is not an answer to act on.
    if (isRecord(raw) && typeof raw.sku === "string" && raw.sku.length > 0 && raw.sku.length <= 100) skus.push(raw.sku);
    else unreadable += 1;
  }
  let nextOffset: string | null = null;
  if (typeof body.next === "string" && body.next.length > 0) {
    nextOffset = /[?&]offset=(\d{1,9})(?:&|$)/.exec(body.next)?.[1] ?? null;
    if (nextOffset === null) return { ok: false, failure: failure("bad_response", EBAY_SAYS.unreadable, { httpStatus: r.value.status }) };
  }
  return { ok: true, value: { skus, unreadable, nextOffset } };
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
