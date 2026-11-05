import * as Sentry from "@sentry/react";
import { scrubSignedStorageUrls } from "../lib/observability/scrub-signed-urls";
import { scrubOAuthParams } from "../lib/observability/scrub-oauth-params";

/** Every URL scrub, in one pass per payload (signed storage URLs, then the eBay return's code and state). */
const scrub = <T>(value: T): T => scrubOAuthParams(scrubSignedStorageUrls(value));

/**
 * The scrub for a whole event. `sdkProcessingMetadata` holds the SDK's live
 * scopes, which reach Session Replay's circular objects, so stringifying it
 * throws; Sentry then drops the event and reports the crash as a new error
 * that skips these hooks (NEO-434). It stays out of the stringify and goes back
 * by reference: the SDK reads it after this hook and deletes it before sending.
 *
 * Returning null drops an event that still cannot be stringified. It is never
 * sent unscrubbed, and the drop shows up as a `before_send` client outcome
 * rather than a new error.
 */
function scrubEvent<T extends { sdkProcessingMetadata?: unknown }>(event: T): T | null {
  const { sdkProcessingMetadata, ...payload } = event;
  try {
    return { ...scrub(payload), sdkProcessingMetadata } as T;
  } catch {
    return null;
  }
}

// Skip Sentry entirely when running under E2E tests, so test sessions never
// reach Sentry as errors, traces or replays. (It began as a Maestro
// workaround: Replay's Web Workers and same-origin iframes made Maestro's
// CdpWebDriver latch onto transient window handles — NEO-13, Maestro issues
// #3176, #3271, #3289. That driver is retired; the skip stays for the
// noise.)
//
// VITE_CLERK_TESTING_ENABLED is the existing flag that gates the
// /testing/sign-in page and is already set on Vercel preview + local
// dev for E2E. Reusing it here keeps env-var sprawl down.
if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_ENVIRONMENT || import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION,

    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        // Scrub the raw rrweb recording frame before it's buffered — this is
        // the Session Replay "network entry" capture path, separate from the
        // breadcrumb/span pipeline below.
        beforeAddRecordingEvent: (event) => scrub(event),
        // Explicit, not inherited: these are the library defaults, but they
        // are load-bearing for /profile/api-keys — the reveal-once API-key
        // dialog is on-screen text, and replay films 10% of sessions (100%
        // on error). Masking every text node and input is what keeps a
        // user's key out of the recording; never relax these without a
        // block-selector covering the API-keys surface (NEO-172 audit).
        maskAllText: true,
        maskAllInputs: true,
      }),
    ],

    tracesSampleRate: import.meta.env.MODE === "production" ? 0.1 : 1.0,
    enableLogs: true,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,

    // XHR/fetch breadcrumbs (e.g. the signed PUT/POST in direct-upload.ts)
    // carry the full request URL, query string included.
    beforeBreadcrumb: (breadcrumb) => scrub(breadcrumb),
    // browserTracingIntegration's auto-instrumented spans record the request
    // URL on `http.url` — same signed-capability leak, different pipeline.
    beforeSendTransaction: (event) => scrubEvent(event),
    // NEO-415: an error's `request.url` (and its breadcrumbs) can carry the
    // eBay return's one-time `code` and `state`; the pageload transaction
    // above can too.
    beforeSend: (event) => scrubEvent(event),
  });
}
