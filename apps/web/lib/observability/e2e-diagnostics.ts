import posthog from "posthog-js";
import type { CaptureResult, PostHogConfig } from "posthog-js";

/**
 * NEO-392 — PostHog as an E2E flight recorder.
 *
 * E2E reds such as "the click landed and the form never opened" leave a
 * screenshot and nothing else: the page's own state at that moment is gone.
 * Under E2E (VITE_CLERK_TESTING_ENABLED) PostHog used to be switched off
 * entirely (NEO-13: Maestro's CDP driver latched onto PostHog's recorder
 * workers and iframes). Maestro is gone (NEO-341), so PostHog now runs under
 * E2E in a narrow diagnostic mode instead:
 *
 * - nothing automatic: no autocapture, pageviews, recordings, surveys,
 *   heatmaps or flags, so the page under test loads no recorder worker or
 *   survey iframe (exception capture loads its one script);
 * - only the events named in {@link E2E_DIAGNOSTIC_EVENTS} leave the page;
 * - every event carries the run, attempt, worker, project and test the
 *   Playwright fixture stamped onto the page ({@link readE2ETags}), so one
 *   red in CI maps to one filterable timeline in PostHog;
 * - each event is sent at once (no batching): a test's context closes the
 *   moment it ends, and a batched tail would be lost with it.
 */

export const isE2E = (): boolean =>
  import.meta.env.VITE_CLERK_TESTING_ENABLED === "true";

/** The only events E2E sends. Anything else is dropped before it is sent. */
export const E2E_DIAGNOSTIC_EVENTS: ReadonlySet<string> = new Set([
  "e2e_page_start",
  "e2e_column",
  "convex_client_reconnect",
  "selector_options_stall_backstop",
  "selector_sync_fe_timeout",
  "$exception",
]);

/** Keys the Playwright fixture may set on `window.__NB_E2E`. */
const TAG_KEYS = [
  "run_id",
  "run_attempt",
  "worker",
  "project",
  "test",
  "file",
  "retry",
] as const;

const MAX_TAG_LENGTH = 200;

/**
 * Reads the tags the Playwright fixture put on the window, keeping only the
 * known keys with string or number values. The window object is page-owned,
 * so nothing else on it is trusted or forwarded.
 */
export function readE2ETags(
  source: unknown,
): Record<string, string | number> {
  const tags: Record<string, string | number> = { e2e: "true" };
  if (!source || typeof source !== "object") return tags;
  const record = source as Record<string, unknown>;
  for (const key of TAG_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      tags[`e2e_${key}`] = value;
    } else if (typeof value === "string") {
      tags[`e2e_${key}`] = value.slice(0, MAX_TAG_LENGTH);
    }
  }
  return tags;
}

/** Drops every event that is not a named diagnostic event. */
export function keepDiagnosticEvent(
  event: CaptureResult | null,
): CaptureResult | null {
  return event && E2E_DIAGNOSTIC_EVENTS.has(event.event) ? event : null;
}

/** The PostHog options for E2E: everything automatic off, sends unbatched. */
export function e2eDiagnosticConfig(): Partial<PostHogConfig> {
  return {
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    rageclick: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_web_experiments: true,
    advanced_disable_flags: true,
    persistence: "memory",
    request_batching: false,
    capture_exceptions: true,
    // Playwright's Chromium reports itself as automated, and PostHog drops
    // automated browsers' events by default. Keep them: they are the point.
    opt_out_useragent_filter: true,
    before_send: keepDiagnosticEvent,
  };
}

/**
 * Records one diagnostic event, under E2E only. Real users never send
 * these: they would be noise there, and the E2E tags would be absent.
 */
export function e2eDiagnostic(
  event: string,
  properties: Record<string, string | number | boolean | null>,
): void {
  if (!isE2E()) return;
  if (!E2E_DIAGNOSTIC_EVENTS.has(event)) return;
  try {
    posthog.capture(event, {
      ...properties,
      at_ms: Math.round(performance.now()),
    });
  } catch {
    // Diagnostics must never break the screen they observe.
  }
}
