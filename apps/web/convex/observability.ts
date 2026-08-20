/**
 * Adapter performance instrumentation helpers.
 *
 * Goal: capture latency + success/failure for every marketplace adapter call so we
 * can build a perf-over-time dashboard in PostHog and decide where the 10s UI SLO
 * (`feedback_ui_response_10s`) is being violated. Triggered by NEO-24's setup
 * yaml failure where `fetchAggregatedOptions(level=year, sport=Baseball)` took
 * ~23s on local headless — we don't have the data to tell whether it was the
 * BSC token cold start, the BSC filter API call, the SportLots fetch, or
 * something else.
 *
 * Why PostHog, not Sentry: this project only runs `@sentry/react` on the
 * browser side — there is no `@sentry/node` integration on the Convex action
 * runtime, so server-side spans aren't available. Adapter calls execute on
 * Convex actions, so PostHog (via `internal.posthog.captureEvent`) is the
 * single sink we already pay for. The frontend gets the request duration as
 * part of the action result; Sentry's existing browserTracing instrumentation
 * captures the round-trip transaction on the client side.
 *
 * Event schema — used by the adapter-perf dashboard:
 *
 *   event: "adapter_sync_call"
 *   properties:
 *     requestId: string         // correlation id, unique per fetchAggregatedOptions call
 *     operation: string         // "fetchAggregatedOptions" | "fetchBscSelectorOptions" |
 *                               // "fetchSportLotsSelectorOptions" | "getBscToken"
 *     platform: string          // "bsc" | "sportlots" | "aggregator"
 *     level?: string            // taxonomy level being synced (e.g. "year", "setName")
 *     parentSport?: string      // taxonomy parent — sport display name, NEVER PII
 *     parentYear?: string       // taxonomy parent — year display name
 *     parentSetName?: string    // taxonomy parent — setName display name
 *     duration_ms: number       // total wall-clock for this operation
 *     success: boolean          // adapter-level success (parsed from result.success)
 *     // operation-specific extras:
 *     token_ms?: number         // time inside getBscToken / getSportLotsCookie
 *     filters_call_ms?: number  // time for the actual HTTP fetch to the marketplace
 *     status_code?: number      // HTTP status from the marketplace API call
 *     result_count?: number     // options returned (post-filter, pre-dedupe)
 *     cache_hit?: boolean       // true when token came from the cache without refresh
 *     sl_ms?: number            // aggregator-only: SportLots branch duration
 *     bsc_ms?: number           // aggregator-only: BSC branch duration
 *     sl_success?: boolean      // aggregator-only
 *     bsc_success?: boolean     // aggregator-only
 *     error_class?: string      // when success=false, a short stable error tag
 *
 * NEVER include: user emails, credentials, tokens, response bodies, set-level
 * identifiers tied to a specific seller (BSC sellerId etc.). Taxonomy strings
 * only — sport/year/setName display labels and adapter status codes.
 */

import { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUserId } from "./auth";

// "preprocess" (NEO-170) is not a marketplace — it is our own Cloud Run image
// pipeline. It shares this event because the question the dashboard asks is the
// same one ("which outbound dependency is slow / failing, and how often"), and
// because `classifyAdapterError` already buckets the status codes it returns —
// notably 429 → "rate_limited", which for preprocess means the workpool's
// parallelism has drifted above the service's instance ceiling. See
// convex/preprocessCapacity.ts.
export type AdapterPlatform = "bsc" | "sportlots" | "aggregator" | "preprocess";

export type AdapterCallProperties = {
  requestId: string;
  operation: string;
  platform: AdapterPlatform;
  level?: string;
  parentSport?: string;
  parentYear?: string;
  parentSetName?: string;
  duration_ms: number;
  success: boolean;
  token_ms?: number;
  filters_call_ms?: number;
  status_code?: number;
  result_count?: number;
  cache_hit?: boolean;
  sl_ms?: number;
  bsc_ms?: number;
  sl_success?: boolean;
  bsc_success?: boolean;
  error_class?: string;
  // Which stage of the sync chain this record describes / failed at, so a hang
  // or timeout is attributable end-to-end: "marketplace_fetch" (the SL/BSC HTTP
  // call), "auth" (token mint / cold login), "aggregator" (fetchAggregatedOptions
  // composing the two), or "fe" (the front-end give-up). Lets PostHog answer
  // "what timed out — the marketplace, the adapter, or the FE?".
  stage?: string;
  // 1-based attempt number when the record is the result of a bounded retry
  // loop (e.g. BSC 10s × 3). Lets us see whether a failure exhausted retries.
  attempt?: number;
  // When stage="aggregator" and a child platform blew its deadline, which one.
  timed_out_platform?: string;
  // ---- preprocess correlation (NEO-170) ----
  // The placeholder batch and the image WITHIN it that this call is processing,
  // so a slow or failing `/process-entry` in PostHog joins back to the exact
  // `placeholderImages` row — and, through the watchdog's wedged-batch event
  // (convex/placeholderWatchdog.ts), to a batch that later stranded. Only the
  // preprocess call sites set these (`callProcessEntryFast` /
  // `callProcessEntryHeavy` / `callExtract`); every
  // other caller omits them. Both are opaque ids / positional integers — a
  // `jobId` is an unguessable UUID and an `entryIndex` is a position in the zip,
  // never a path and never PII. See the `objectPath` rule in schema.ts.
  jobId?: string;
  entryIndex?: number;
};

/**
 * Fire-and-forget capture of an adapter_sync_call event. Caller passes the
 * fully-populated property bag; we resolve the distinctId from auth context
 * (falling back to "anonymous" if auth context is unavailable, e.g. internal
 * actions invoked from cron jobs).
 *
 * Never throws — observability must not be able to fail the request it's
 * observing. PostHog client errors are logged and swallowed.
 */
export async function recordAdapterCall(
  ctx: ActionCtx,
  props: AdapterCallProperties,
): Promise<void> {
  let distinctId = "anonymous";
  try {
    distinctId = (await getCurrentUserId(ctx)) || "anonymous";
  } catch {
    // auth context may not be available (internal callers, cron jobs)
  }
  // NEO-43: tag the emitting deployment. One PostHog project serves prod, dev
  // and every per-PR preview, so without this every insight and dashboard
  // silently blends environments. See deploymentName().
  const deployment = deploymentName();
  // Also emit a structured console line for cases where PostHog is misconfigured —
  // Cloud Run / Convex logs are the fallback channel.
  try {
    console.log(
      JSON.stringify({
        msg: "adapter_sync_call",
        ...props,
        deployment,
      }),
    );
  } catch {
    // unreachable but defensive
  }
  try {
    await ctx.runAction(internal.posthog.captureEvent, {
      distinctId,
      event: "adapter_sync_call",
      properties: { ...props, deployment },
    });
  } catch (err) {
    console.error(
      "[observability.recordAdapterCall] PostHog capture failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Generate a correlation id for an aggregator call. Lives in observability.ts
 * so call sites don't need to repeat the crypto.randomUUID() boilerplate (and
 * so we can swap the implementation if needed without grepping every caller).
 */
export function newRequestId(): string {
  // crypto.randomUUID is available on Convex's action runtime (Node 18+)
  return crypto.randomUUID();
}

/**
 * Classify an error/message string into a small set of stable tags so the
 * dashboard's error breakdown stays useful instead of fragmenting on every
 * unique error message. Returns undefined for empty input.
 */
export function classifyAdapterError(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s.includes("timed out") || s.includes("timeout")) return "timeout";
  if (s.includes("401") || s.includes("unauthorized") || s.includes("no token")) return "auth";
  if (s.includes("403") || s.includes("forbidden")) return "forbidden";
  if (s.includes("429") || s.includes("rate limit")) return "rate_limited";
  if (s.includes("session expired")) return "session_expired";
  if (s.includes("no bsc token") || s.includes("no sportlots") || s.includes("credentials")) return "no_credentials";
  if (s.includes("network") || s.includes("fetch failed")) return "network";
  return "other";
}

// ---------------------------------------------------------------------------
// NEO-43 — marketplace login (credential-test) instrumentation
// ---------------------------------------------------------------------------
//
// Events: "credential_test_failed" (pre-existing) and "credential_test_succeeded"
// (added by NEO-43 so a failure RATE is computable — an absolute failure count
// reads as "outage" at today's volume and as "Tuesday" at 100x the users).
//
// Both are emitted from the SAME two functions (authenticateBsc /
// authenticateSportlots in credentials.ts) so numerator and denominator cover
// one population. That population is wider than "a user pressed Test": those
// functions are also driven by background token refresh (refreshSiteToken, and
// the BSC/SportLots adapters' own re-auth paths), so a single seller with a
// permanently-bad stored password emits a steady drip of failures forever.
// That is why the PostHog alert aggregates on UNIQUE USERS, not event count.
//
// SECURITY: the console line below is an explicit field allowlist, never a
// spread of `props`. `props` can carry the login diagnostic's `snippet` — up
// to 1500 chars of marketplace page text.

/**
 * Which Convex deployment emitted this event — "first-starfish-800" for prod,
 * a per-PR slug for a preview, the dev slug for dev.
 *
 * NEO-43: the PostHog account is limited to ONE project, so prod, dev and
 * every per-PR preview report into the SAME event stream. Without this tag
 * they are indistinguishable, which makes environment-scoped alerting
 * impossible — and concretely would make a "N unique users failed login"
 * alert fire on every PR, because the E2E suite runs 8 workers as 8 distinct
 * Clerk users and `credentials-lifecycle` fails a login on purpose.
 *
 * CONVEX_CLOUD_URL is set automatically by Convex on every deployment, so
 * this needs no new environment variable and cannot drift out of sync with
 * where the code is actually running. Returns undefined rather than guessing
 * if the URL shape is unexpected.
 */
export function deploymentName(): string | undefined {
  const url = process.env.CONVEX_CLOUD_URL;
  if (!url) return undefined;
  return /^https?:\/\/([^.]+)\./.exec(url)?.[1];
}

export type CredentialTestProperties = {
  platform: "buysportscards" | "sportlots";
  /** Free-text failure detail. PostHog-only; high cardinality, do NOT group on it. */
  reason?: string;
  /** Low-cardinality stable tag — group and alert on THIS, not on `reason`. */
  error_class?: string;
  duration_ms?: number;
  /** camelCase: pre-existing property name on credential_test_failed, kept for continuity. */
  challengeDetected?: boolean;
  url?: string;
  title?: string;
  snippet?: string;
};

/**
 * Allowlist + clamp a login diagnostic that crossed the browser-service
 * boundary, before it reaches PostHog.
 *
 * The previous code spread `result.diagnostic` unmodified into the event
 * properties, which trusted a remote service to have done its own redaction
 * and truncation. That holds today (buildLoginDiagnostic caps snippet at
 * MAX_SNIPPET_CHARS), but a regression there — or a future adapter that
 * hand-builds a diagnostic — would leak silently and permanently into
 * analytics. Defense in depth at the trust boundary.
 */
export function sanitizeLoginDiagnostic(
  d: { url?: string; title?: string; challengeDetected?: boolean; snippet?: string } | undefined,
): Pick<CredentialTestProperties, "url" | "title" | "challengeDetected" | "snippet"> {
  if (!d || typeof d !== "object") return {};
  const clamp = (v: unknown, max: number): string | undefined =>
    typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
  return {
    challengeDetected: typeof d.challengeDetected === "boolean" ? d.challengeDetected : undefined,
    url: clamp(d.url, 200),
    title: clamp(d.title, 200),
    // Mirrors MAX_SNIPPET_CHARS in services/browser/src/services/login-diagnostic.ts.
    snippet: clamp(d.snippet, 1500),
  };
}

/**
 * Fire-and-forget capture of a credential-test outcome. Mirrors
 * recordAdapterCall: dual-writes a structured console line so the signal
 * survives an unset POSTHOG_API_KEY (which internal.posthog.captureEvent
 * swallows silently), then captures to PostHog.
 *
 * NOTE the console line lands in CONVEX logs, not GCP Cloud Logging — this
 * project has no Convex log sink. It is a fallback channel for humans, not a
 * feed for the NEO-43 Cloud Monitoring log-based metrics; those read the
 * browser service's own `browser_login_call` lines instead.
 *
 * Never throws — observability must not be able to fail the login it observes.
 */
export async function recordCredentialTest(
  ctx: ActionCtx,
  distinctId: string,
  success: boolean,
  props: CredentialTestProperties,
): Promise<void> {
  const deployment = deploymentName();
  try {
    console.log(
      JSON.stringify({
        msg: "credential_login_call",
        platform: props.platform,
        success,
        error_class: props.error_class,
        duration_ms: props.duration_ms,
        challenge_detected: props.challengeDetected,
        deployment,
        // snippet/title/url deliberately omitted — page-derived text.
      }),
    );
  } catch {
    // unreachable but defensive
  }
  try {
    await ctx.runAction(internal.posthog.captureEvent, {
      distinctId,
      event: success ? "credential_test_succeeded" : "credential_test_failed",
      properties: { ...props, deployment },
    });
  } catch (err) {
    console.error(
      "[observability.recordCredentialTest] PostHog capture failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
