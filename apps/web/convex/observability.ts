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

export type AdapterPlatform = "bsc" | "sportlots" | "aggregator";

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
  // Also emit a structured console line for cases where PostHog is misconfigured —
  // Cloud Run / Convex logs are the fallback channel.
  try {
    console.log(
      JSON.stringify({
        msg: "adapter_sync_call",
        ...props,
      }),
    );
  } catch {
    // unreachable but defensive
  }
  try {
    await ctx.runAction(internal.posthog.captureEvent, {
      distinctId,
      event: "adapter_sync_call",
      properties: props,
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
