/**
 * NEO-321 follow-up — WHY one marketplace side of a checklist fetch failed,
 * in a shape a caller can log and turn into operator copy without parsing a
 * message, plus the scrubber every such log line goes through.
 *
 * ## Why this is a separate file
 *
 * The checklist adapters are `"use node"` modules; `parallelChecklistBuild.ts`
 * runs in the default runtime and cannot import from them. The validator, the
 * types and the pure helpers live here so both sides share one definition (the
 * house pattern: contract narrowers live in `convex/lib`).
 *
 * **Pure by contract.** No `_generated/server`, no `process.env`, no I/O
 * beyond `console`.
 *
 * ## What the failure says, and what it never says
 *
 * `kind` is the class of failure; the operator sentence is chosen from it and
 * names no status code, URL or marketplace internal. The diagnostic fields
 * (status, timer, page) go to the log only. Nothing here carries a URL, a
 * token, a cookie or a credential, and `scrubLogText` is applied to every
 * adapter message before it is logged.
 */

import { v, type Infer } from "convex/values";

/**
 * - `timeout`      — OUR abort timer fired (a self-imposed limit).
 * - `network`      — the request threw before any response (DNS, reset, …).
 * - `http_error`   — the marketplace answered with a non-2xx status.
 * - `bad_response` — a 2xx whose body could not be read.
 * - `signed_out`   — the marketplace rejected our session (401 that a re-auth
 *                    did not fix; SportLots served its sign-in page).
 * - `no_sign_in`   — we had no token / cookie to send at all.
 * - `refused`      — the adapter refused before sending (paused, unscoped).
 * - `unknown`      — none of the above could be told apart.
 */
export const FETCH_FAILURE_KINDS = [
  "timeout",
  "network",
  "http_error",
  "bad_response",
  "signed_out",
  "no_sign_in",
  "refused",
  "unknown",
] as const;
export type FetchFailureKind = (typeof FETCH_FAILURE_KINDS)[number];

export const fetchFailureKindValidator = v.union(
  v.literal("timeout"),
  v.literal("network"),
  v.literal("http_error"),
  v.literal("bad_response"),
  v.literal("signed_out"),
  v.literal("no_sign_in"),
  v.literal("refused"),
  v.literal("unknown"),
);

/**
 * Returned (optionally) by `fetchBscChecklist` / `fetchSportLotsChecklist`
 * next to `success: false`. Widening those actions' `returns` with an optional
 * field is safe for every caller (none forwards the result into a narrower
 * validator).
 */
export const fetchFailureValidator = v.object({
  kind: fetchFailureKindValidator,
  /** The marketplace's HTTP status, when there was a response. */
  httpStatus: v.optional(v.number()),
  /** Our own abort timer fired. */
  timedOut: v.boolean(),
  /** That timer's length, when `timedOut`. */
  timeoutMs: v.optional(v.number()),
  /** BSC: a 401 was answered with a forced re-auth before this failure. */
  reauthAttempted: v.optional(v.boolean()),
  /** BSC: fan-out requests sent, and how many of them succeeded. */
  requests: v.optional(v.number()),
  requestsOk: v.optional(v.number()),
  /** SportLots: the `start` offset of the page that failed. */
  pageStart: v.optional(v.number()),
  /** SportLots: pages read successfully before the failing one. */
  pagesOk: v.optional(v.number()),
});
export type FetchFailure = Infer<typeof fetchFailureValidator>;

/** The longest adapter message a log line carries, after scrubbing. */
export const LOG_MESSAGE_MAX = 240;

/**
 * Make a free-text message safe to log: no URL (with or without a query), no
 * bearer token, no JWT, no `token=` / `cookie=` style pair, no credential key
 * path, no long opaque run that could be a secret — then truncate.
 */
export function scrubLogText(
  text: string | undefined,
  max: number = LOG_MESSAGE_MAX,
): string | undefined {
  if (text === undefined) return undefined;
  let s = String(text);
  s = s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "<url>");
  s = s.replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer <redacted>");
  s = s.replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}/g, "<jwt>");
  s = s.replace(
    /\b(access_token|refresh_token|id_token|token|cookie|set-cookie|password|passwd|secret|authorization|api[_-]?key|sid|session_?id|jsessionid|phpsessid)(\s*[=:]\s*)[^\s;,&"']+/gi,
    "$1$2<redacted>",
  );
  s = s.replace(/\/credentials\/[^\s/"']+/g, "/credentials/<key>");
  s = s.replace(/[A-Za-z0-9+/_=-]{32,}/g, "<redacted>");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * A failure read off a free-text message, for the paths that carry no
 * structured `failure`: a thrown `runAction`, or an adapter that predates it.
 * Patterns are the adapters' own wording.
 */
export function failureFromMessage(message: string | undefined): FetchFailure {
  const s = (message ?? "").toLowerCase();
  const status = /\b(?:error|status|http error)[:\s]+(\d{3})\b/.exec(s);
  if (/timed out|timeout|aborted due to timeout/.test(s)) {
    return { kind: "timeout", timedOut: true };
  }
  if (/session expired|re-auth failed|\b401\b|unauthori[sz]ed/.test(s)) {
    return {
      kind: "signed_out",
      timedOut: false,
      ...(status ? { httpStatus: Number(status[1]) } : {}),
    };
  }
  if (/no bsc token|no token|no sportlots session cookie|no .*cookie/.test(s)) {
    return { kind: "no_sign_in", timedOut: false };
  }
  if (status) {
    return { kind: "http_error", timedOut: false, httpStatus: Number(status[1]) };
  }
  if (/fetch failed|network|econnreset|econnrefused|enotfound|socket|request failed/.test(s)) {
    return { kind: "network", timedOut: false };
  }
  if (/paused|refusing an under-scoped|not linked/.test(s)) {
    return { kind: "refused", timedOut: false };
  }
  return { kind: "unknown", timedOut: false };
}

/** Is this thrown value one of fetch's abort-timer errors? */
export function isAbortTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || /aborted due to timeout/i.test(err.message))
  );
}

/**
 * A self-imposed limiter fired on the path to a marketplace: our own timer, a
 * lock, a backoff, the browser service's rate limit. One JSON line per firing,
 * `msg: "marketplace_limiter"`, so a re-run shows every wait or refusal WE
 * caused, separately from what a marketplace did.
 *
 * Fields are numbers, booleans and short fixed strings only — callers never
 * pass a URL, a token, a cookie, a credential key or a user id.
 */
export function logMarketplaceLimiter(event: {
  limiter: string;
  outcome: string;
  waitedMs: number;
  platform?: string;
  operation?: string;
  [extra: string]: string | number | boolean | undefined;
}): void {
  console.warn(JSON.stringify({ msg: "marketplace_limiter", ...event }));
}
