"use node";

/**
 * Convex → preprocess Cloud Run adapter (NEO-170; fast/heavy split NEO-175).
 *
 * Two SERVICES now, selected per call, both stateless and both speaking the
 * same routes. Every route is JSON, takes `job_id` + `user_id` and NEVER an
 * object path — see the `placeholderJobs` table comment in schema.ts for why
 * that is a hard rule rather than a style preference. Each service re-derives
 * the GCS path from the job id on its own side.
 *
 *   POST /extract        → unzip the upload, list the entries it accepted (FAST)
 *   POST /process-entry  → crop + orient + classify + hash ONE entry (FAST first,
 *                          HEAVY on escalation)
 *   POST /warmup         → force an instance resident (FAST on start, HEAVY on
 *                          the first escalation)
 *
 * FAST is the classical-only service every image hits first; it cold-starts in
 * seconds and returns `needs_escalation: true` (no crop) for a card its fast
 * path cannot settle. HEAVY runs the full BiRefNet cascade, cold-loads ~191s,
 * and is where those escalations go. `/extract` is a per-job unzip that needs no
 * model, so it goes to FAST — routing it to HEAVY would cold-start the 191s
 * service just to unzip, on every batch, and defeat the whole split.
 *
 * The services are stateless: every scrap of orchestration state (which entries
 * exist, which are done, what to retry, what the batch's progress is) lives in
 * Convex. That is what lets the pools cancel, retry and resume without a service
 * needing a job table.
 */

import { ActionCtx } from "../_generated/server";
import { NonRetryableError } from "@convex-dev/workpool";
import { buildAuthHeaders } from "../lib/cloudRunAuth";
import { preprocessAudienceFor } from "../preprocessAudience";
import {
  classifyAdapterError,
  newRequestId,
  recordAdapterCall,
} from "../observability";

/**
 * Which preprocess service a call is aimed at: its base URL and the env-var name
 * that URL came from (only used to point a misconfiguration error at the right
 * variable — see `getIdTokenClient`).
 */
type PreprocessService = { url: string; envVarName: string };

/**
 * Base URL of the HEAVY preprocess service (the full BiRefNet cascade).
 *
 * Local default is port 8081, NOT 8080 — 8080 is the browser service's local
 * port (see credentials.ts `browserUrl()`), and both run at once during
 * full-stack local dev. Pointing preprocess at 8080 would silently send
 * `/extract` to the browser service, which answers 404 and looks like a
 * terminal INPUT_NOT_FOUND.
 */
export function preprocessHeavyUrl(): string {
  return process.env.NEONBINDER_PREPROCESS_URL || "http://localhost:8081";
}

/**
 * Base URL of the FAST preprocess service (classical-only).
 *
 * **Falls back to the heavy URL when `NEONBINDER_PREPROCESS_FAST_URL` is unset.**
 * That fallback is the graceful-degradation story for the window BEFORE NEO-175
 * Phase 3 terraform deploys a separate fast service: with only one service
 * running (in its default `heavy` role, see Phase 1), fast == heavy == that one
 * service, which always crops and never returns `needs_escalation: true` — so no
 * escalation ever fires and the pipeline behaves exactly as it did pre-split.
 * Once Phase 3 sets this variable, the two diverge and escalations start
 * flowing. Local dev likewise runs a single service on 8081 unless a dev sets
 * the variable to run two.
 */
export function preprocessFastUrl(): string {
  return process.env.NEONBINDER_PREPROCESS_FAST_URL || preprocessHeavyUrl();
}

const FAST_SERVICE = (): PreprocessService => ({
  url: preprocessFastUrl(),
  envVarName: "NEONBINDER_PREPROCESS_FAST_URL",
});

const HEAVY_SERVICE = (): PreprocessService => ({
  url: preprocessHeavyUrl(),
  envVarName: "NEONBINDER_PREPROCESS_URL",
});

/**
 * 4 minutes. A single `/process-entry` is a full BiRefNet inference plus a
 * Vision round-trip — roughly 40s warm — but the request may also be the one
 * that triggers a Cloud Run cold start, and a cold start on a multi-GB model
 * image is measured in minutes, not seconds. The timeout has to clear
 * cold-start + work, or the pool would abort exactly the requests that were
 * about to succeed and retry them into another cold start.
 *
 * `/extract` shares the budget: unzipping a 500MB upload (the signed-policy
 * cap, see adapters/placeholderUploads.ts) is I/O-bound but not fast.
 */
const PREPROCESS_FETCH_TIMEOUT_MS = 240_000;

/**
 * Terminal HTTP statuses. Retrying any of these re-runs a request whose
 * outcome is already decided:
 *
 *   400 INVALID_IDENTIFIER   — malformed job/user id
 *   401 / 403                — our OIDC token or internal key is wrong; a retry
 *                              sends the same bad credential
 *   404 INPUT_NOT_FOUND      — no such upload
 *   413 INPUT_TOO_LARGE      — the zip exceeds what the service will open
 *   415                      — wrong content type
 *   422 ZIP_REJECTED         — the zip failed the safety checks (zipsafe.py);
 *                              it will fail them identically forever
 *
 * Everything else — 429, 5xx, network errors, timeouts — is transient and gets
 * the pool's retry policy.
 */
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 413, 415, 422]);

/**
 * Retry rationale — deliberately NOT the same as this repo's other adapters,
 * and the differences are the point:
 *
 *  - `loginWithRetry` (convex/credentials.ts) retries ONLY on 503. Retrying a
 *    failed marketplace login fires another ~30s login at a shared account; in
 *    NEO-29 that turned one hiccup into a ~6-minute burst of serialized BSC
 *    logins and tripped bot protection — the retry caused the failures it was
 *    meant to fix.
 *  - `wikidata` does not retry 429 at all: it is a third party's quota, we do
 *    not get to decide how much of it we are entitled to, and a 3-second inter-
 *    request gap is already the conservative answer.
 *
 * Preprocess is neither. It is OUR service, so a 429 is our own capacity
 * telling us to wait rather than a stranger's quota; the requests are
 * idempotent (GCS writes are write-once, and re-processing an entry produces
 * the same output object); and the workpool caps in-flight work at
 * `PREPROCESS_MAX_PARALLELISM`, which equals the service's entire instance
 * ceiling. A retry therefore re-orders load in time but cannot amplify it —
 * the pool physically cannot have more than N requests outstanding no matter
 * how many are retrying. That is the property NEO-29's retry loop lacked.
 */
function classifyHttpStatus(status: number, code: string | undefined, body: string): Error {
  const label = code ? `${code} (HTTP ${status})` : `HTTP ${status}`;
  const detail = body ? `: ${body.slice(0, 400)}` : "";
  if (TERMINAL_STATUSES.has(status)) {
    return new NonRetryableError(`preprocess ${label}${detail}`);
  }
  return new Error(`preprocess ${label}${detail}`);
}

/**
 * Recover the service's error code (INVALID_IDENTIFIER, ZIP_REJECTED, …) from
 * a thrown adapter error.
 *
 * The code travels in the message rather than on a custom field because
 * `NonRetryableError` is a `ConvexError` with a fixed data shape, and the
 * workpool serializes a thrown error down to its message string before the
 * onComplete hook ever sees it. Parsing the message back is therefore not a
 * shortcut — it is the only channel that survives the round trip.
 *
 * Two wrappings have to be tolerated (both pinned by tests):
 *  - `NonRetryableError.message` is itself a JSON envelope,
 *    `{"__convexWorkpoolNonRetryable":true,"message":"preprocess …"}` — the
 *    real text sits one (or more) `.message` unwraps down;
 *  - by the time an error reaches an onComplete hook or a log line the runtime
 *    may have prefixed it ("Uncaught Error: …"), so the marker is searched for
 *    anywhere in the text, not anchored to the start.
 *
 * Returns undefined when the response carried no code (Cloud Run's own
 * 429/503, a non-JSON body), which callers should treat as "transport-level,
 * not service-level".
 */
export function parsePreprocessErrorCode(message: string): string | undefined {
  let text = message;
  for (let depth = 0; depth < 3; depth++) {
    let unwrapped: string | undefined;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (parsed && typeof parsed.message === "string") unwrapped = parsed.message;
    } catch {
      // Not a JSON envelope — `text` is already the real message.
    }
    if (unwrapped === undefined) break;
    text = unwrapped;
  }
  return /\bpreprocess ([A-Z][A-Z0-9_]+) \(HTTP \d+\)/.exec(text)?.[1];
}

/** One entry the extract step found inside the uploaded zip. */
export type ExtractEntry = {
  index: number;
  name: string;
  accepted: boolean;
  content_type: string;
  size_bytes: number;
  reason?: string | null;
};

export type ExtractResponse = {
  entries: ExtractEntry[];
  accepted_count: number;
  rejected_count: number;
};

/**
 * Per-entry result. Field names mirror `ProcessResponse` in
 * services/preprocess/app/main.py (snake_case on the wire); the Convex row
 * stores them camelCased — see placeholderImages in schema.ts.
 */
export type ProcessEntryResponse = {
  players: string[];
  player: string | null;
  team: string | null;
  card_number: string | null;
  side: string;
  rotation_degrees: number;
  orient_confidence: number;
  text_count: number;
  cropped_source: string;
  /** 16-char lowercase hex. Perceptual hash used by the pairing pass. */
  dhash: string | null;
  output_written: boolean;
  /**
   * NEO-175 Phase 1 contract. Always present, default `false`.
   *
   *   false → a completed crop result (all the fields above carry their values).
   *   true  → the FAST role declined this card: the classical fast path could
   *           not settle it, so there is NO crop result and nothing was written,
   *           and the response is a 200 whose only meaningful field is this one.
   *           Convex re-enqueues the entry to the HEAVY service, which runs the
   *           full cascade and returns a completed result. The heavy service
   *           always crops, so its responses always carry `false`.
   *
   * No crop, image bytes, or secrets ever ride an escalation response.
   */
  needs_escalation: boolean;
};

/**
 * Headers for a preprocess call: OIDC bearer + the shared internal key.
 *
 * BOTH are sent during the transition. The internal key (`x-internal-key`) is
 * what the service checks today (`_verify_internal_key` in main.py); the OIDC
 * token is what it will check once Cloud Run IAM is flipped to
 * invoker-only. Sending both means neither side has to deploy in lockstep with
 * the other.
 *
 * TODO(NEO-171): delete the `x-internal-key` half — and the
 * NEONBINDER_PREPROCESS_INTERNAL_KEY env var with it — once the IAM flip has
 * shipped and the service stops requiring the header. Until then a missing key
 * is left to the service to reject (503 EXTRACT_NOT_CONFIGURED / 401) rather
 * than pre-empted here, because in loopback dev the service may legitimately
 * run without one.
 */
async function preprocessHeaders(service: PreprocessService): Promise<Record<string, string>> {
  // Normalize the audience through the base-host allowlist BEFORE minting the
  // token (SECURITY control #3, NEO-175): a tagged preview host must be REACHED
  // at the tagged URL but AUTHORIZED against the base service URL, or Cloud Run
  // IAM 403s the token once invoker-only is enforced. `preprocessAudienceFor`
  // rewrites only OUR recognized preprocess hosts and returns anything else
  // verbatim (fail closed). Both services' URLs go through it.
  const headers = await buildAuthHeaders(
    preprocessAudienceFor(service.url),
    service.envVarName,
  );
  const internalKey = process.env.NEONBINDER_PREPROCESS_INTERNAL_KEY;
  if (internalKey) {
    headers["x-internal-key"] = internalKey;
  }
  return headers;
}

/**
 * POST a JSON body to a preprocess route and parse the response, recording an
 * `adapter_sync_call` telemetry event for EVERY request (success or failure).
 *
 * Errors are thrown, never returned as `{success:false}`: the workpool decides
 * whether to retry by looking at what came out of the action, and a soft
 * failure object reads as success.
 */
async function preprocessPost<T>(
  ctx: ActionCtx,
  service: PreprocessService,
  path: string,
  body: Record<string, unknown>,
  operation: string,
  // Correlation for the telemetry event only — never sent to the service (the
  // service re-derives everything from `body`). `jobId`/`entryIndex` let a
  // preprocess `adapter_sync_call` in PostHog be joined to the exact
  // `placeholderImages` row it processed. Both are opaque/positional, never a
  // path or PII; see the AdapterCall comment in observability.ts.
  correlation?: { jobId?: string; entryIndex?: number },
): Promise<T> {
  const started = Date.now();
  const requestId = newRequestId();
  let statusCode: number | undefined;

  const record = async (success: boolean, errorText?: string) => {
    await recordAdapterCall(ctx, {
      requestId,
      operation,
      platform: "preprocess",
      duration_ms: Date.now() - started,
      success,
      status_code: statusCode,
      // Not "marketplace_fetch" — that stage name means an outbound call to a
      // third-party marketplace. This is our own Cloud Run service, and the
      // dashboard needs to be able to separate "preprocess is saturated" from
      // "BSC is slow".
      stage: "preprocess_call",
      error_class: classifyAdapterError(errorText),
      // Undefined for callers that pass no correlation (warmup) — the property
      // is simply absent on those events rather than null.
      jobId: correlation?.jobId,
      entryIndex: correlation?.entryIndex,
    });
  };

  let response: Response;
  try {
    response = await fetch(`${service.url}${path}`, {
      method: "POST",
      headers: await preprocessHeaders(service),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PREPROCESS_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure, DNS failure, or AbortSignal.timeout firing
    // (`TimeoutError`). All transient by construction — a plain Error, so the
    // pool retries.
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    const text = isTimeout
      ? `preprocess request timed out after ${PREPROCESS_FETCH_TIMEOUT_MS / 1000}s: ${path}`
      : `preprocess request failed (network): ${path}: ${message}`;
    await record(false, text);
    throw new Error(text);
  }

  statusCode = response.status;

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let code: string | undefined;
    try {
      // The service's error bodies carry a top-level `error_code`
      // ("INVALID_IDENTIFIER", "ZIP_REJECTED", …) alongside human-readable
      // `detail`/`reason` fields — see the JSONResponse sites in
      // services/preprocess/app/main.py. Only accept SCREAMING_SNAKE strings so
      // a human sentence in `detail` can never masquerade as a machine code.
      const parsed = JSON.parse(raw) as { error_code?: unknown };
      if (typeof parsed.error_code === "string" && /^[A-Z][A-Z0-9_]+$/.test(parsed.error_code)) {
        code = parsed.error_code;
      }
    } catch {
      // Non-JSON error body (e.g. Cloud Run's own 429/503 HTML). Fine — the
      // status alone determines retryability.
    }
    const error = classifyHttpStatus(response.status, code, raw);
    await record(false, error.message);
    throw error;
  }

  let parsed: T;
  try {
    parsed = (await response.json()) as T;
  } catch (err) {
    // A 200 whose body isn't JSON is a bug on the service side, but it is not
    // obviously permanent (a truncated response mid-deploy looks like this),
    // so treat it as retryable.
    const text = `preprocess returned a non-JSON 200 from ${path}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    await record(false, text);
    throw new Error(text);
  }

  await record(true);
  return parsed;
}

/**
 * Unzip a placeholder upload and list what came out.
 *
 * Terminal on 400 INVALID_IDENTIFIER, 404 INPUT_NOT_FOUND, 413
 * INPUT_TOO_LARGE and 422 ZIP_REJECTED — all four describe the upload itself,
 * which will not change between attempts. Retryable on 502/503 (including
 * 503 EXTRACT_NOT_CONFIGURED, which is a deploy-ordering state that resolves
 * itself) and on Cloud Run's own 429.
 */
export async function callExtract(
  ctx: ActionCtx,
  args: { jobId: string; userId: string },
): Promise<ExtractResponse> {
  return preprocessPost<ExtractResponse>(
    ctx,
    // FAST: unzip needs no model, and routing it to HEAVY would cold-start the
    // 191s service on every batch just to open an archive.
    FAST_SERVICE(),
    "/extract",
    { job_id: args.jobId, user_id: args.userId },
    "preprocessExtract",
    // Extract is a per-job call — no entryIndex, so a slow extract still joins
    // to its batch in the telemetry.
    { jobId: args.jobId },
  );
}

/**
 * Crop, orient, classify and hash a single entry against the FAST service — the
 * first stop for every image. One call per image; the fast workpool is what
 * keeps the fan-out inside the fast service's capacity. A `needs_escalation:
 * true` response means the classical path declined and Convex must re-enqueue
 * the entry to `callProcessEntryHeavy`.
 */
export async function callProcessEntryFast(
  ctx: ActionCtx,
  args: { jobId: string; userId: string; entryIndex: number },
): Promise<ProcessEntryResponse> {
  return preprocessPost<ProcessEntryResponse>(
    ctx,
    FAST_SERVICE(),
    "/process-entry",
    { job_id: args.jobId, user_id: args.userId, entry_index: args.entryIndex },
    // Distinct operation names so the telemetry dashboard can separate fast load
    // from heavy load — the two services scale independently and "which one is
    // saturated" is the whole question.
    "preprocessProcessEntryFast",
    { jobId: args.jobId, entryIndex: args.entryIndex },
  );
}

/**
 * The same call against the HEAVY service — the full BiRefNet cascade an
 * escalated entry is routed to. Its response always carries `needs_escalation:
 * false`, and the heavy workpool bounds the fan-out to the heavy service's own,
 * smaller instance ceiling.
 */
export async function callProcessEntryHeavy(
  ctx: ActionCtx,
  args: { jobId: string; userId: string; entryIndex: number },
): Promise<ProcessEntryResponse> {
  return preprocessPost<ProcessEntryResponse>(
    ctx,
    HEAVY_SERVICE(),
    "/process-entry",
    { job_id: args.jobId, user_id: args.userId, entry_index: args.entryIndex },
    "preprocessProcessEntryHeavy",
    { jobId: args.jobId, entryIndex: args.entryIndex },
  );
}

/**
 * How long a warm-up call waits before giving up.
 *
 * Shorter than PREPROCESS_FETCH_TIMEOUT_MS (4 min) and deliberately so: a
 * warm-up that has not returned in a minute has already done its ONE useful
 * thing — it landed on an instance and told Cloud Run to keep that instance
 * alive with the model loading — and waiting longer for the `{status:"warm"}`
 * body buys nothing, because the instance keeps warming after we hang up. The
 * real images that follow are what actually need the warm model, and they get
 * the full 4-minute budget.
 */
const WARMUP_FETCH_TIMEOUT_MS = 60_000;

/**
 * Best-effort warm-up of the preprocess service — force the BiRefNet model
 * resident on ONE instance so the first real `/process-entry` does not pay the
 * multi-minute cold start.
 *
 * **This function NEVER throws.** It is fired from a fire-and-forget scheduled
 * action at the very start of a batch, long before any image needs processing,
 * and nothing downstream depends on it succeeding: a warm-up that fails, times
 * out, or hits a service that has not deployed `/warmup` yet simply means the
 * cold start happens later, exactly as it does today. So every failure path
 * records telemetry, logs, and returns `{ warmed: false }` rather than
 * propagating — a warm-up must never be able to fail a start or a batch.
 *
 * Only the 2xx/non-2xx distinction is read; the response BODY is advisory (the
 * service returns `{status:"warm"}`, but we do not depend on its shape). Same
 * auth headers as every other preprocess call, so it rides the same
 * x-internal-key / OIDC transition. `container_concurrency = 1` means one
 * warm-up warms exactly one instance.
 *
 * Takes the target service so the same swallow-everything body serves both the
 * FAST fan-out (`warmupPreprocess`, N-wide on start) and the HEAVY warm-gate
 * (`warmupHeavyPreprocess`, one on the first escalation). `operation` names
 * which, so the telemetry can tell a fast warm-up from a heavy one.
 */
async function callWarmupFor(
  ctx: ActionCtx,
  service: PreprocessService,
  operation: string,
): Promise<{ warmed: boolean }> {
  const started = Date.now();
  const requestId = newRequestId();
  let statusCode: number | undefined;

  // Even telemetry must not throw into the caller — the whole contract of this
  // function is that it cannot fail a start.
  const record = async (success: boolean, errorText?: string) => {
    await recordAdapterCall(ctx, {
      requestId,
      operation,
      platform: "preprocess",
      duration_ms: Date.now() - started,
      success,
      status_code: statusCode,
      stage: "preprocess_call",
      error_class: classifyAdapterError(errorText),
    }).catch(() => {});
  };

  try {
    const response = await fetch(`${service.url}/warmup`, {
      method: "POST",
      headers: await preprocessHeaders(service),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(WARMUP_FETCH_TIMEOUT_MS),
    });
    statusCode = response.status;
    // Drain the body so the socket can be reused; its contents are ignored.
    await response.text().catch(() => "");

    if (!response.ok) {
      await record(false, `preprocess warmup HTTP ${response.status}`);
      console.warn(`[${operation}] non-2xx (non-fatal): HTTP ${response.status}`);
      return { warmed: false };
    }
    await record(true);
    return { warmed: true };
  } catch (err) {
    // Network failure, timeout (AbortSignal), or DNS — all non-fatal. A cold
    // start simply happens later.
    const message = err instanceof Error ? err.message : String(err);
    await record(false, `preprocess warmup failed: ${message}`);
    console.warn(`[${operation}] failed (non-fatal): ${message}`);
    return { warmed: false };
  }
}

/** Warm one FAST instance. Fired PREPROCESS_MAX_PARALLELISM-wide on start. */
export function callWarmupFast(ctx: ActionCtx): Promise<{ warmed: boolean }> {
  return callWarmupFor(ctx, FAST_SERVICE(), "preprocessWarmupFast");
}

/**
 * Warm one HEAVY instance. Fired exactly ONCE, on the first escalation of a
 * batch (the warm-gate) — deliberately not N-wide like the fast fan-out, because
 * heavy instances are the 191s cold-loaders and escalations are a minority of
 * images; the heavy pool queues the rest behind this one warming instance rather
 * than stampeding N cold heavy instances.
 */
export function callWarmupHeavy(ctx: ActionCtx): Promise<{ warmed: boolean }> {
  return callWarmupFor(ctx, HEAVY_SERVICE(), "preprocessWarmupHeavy");
}
