// First, so no SDK ever sees eBay's code on the address (NEO-434).
import "./ebay-return-address";
import * as Sentry from "@sentry/react";
import { scrubUrlSecrets as scrub } from "../lib/observability/scrub-url-secrets";

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
        // Replay calls this for rrweb custom events only: its breadcrumb and
        // performance-span frames, which is where request URLs appear. Page
        // snapshots, mutations and the Meta frame never reach it, and neither
        // does the replay_event envelope item: eBay's return stays out of those
        // because it is off the address before this runs (ebay-return-address).
        beforeAddRecordingEvent: (event) => scrub(event),
        // Explicit, not inherited: these are the library defaults, but they
        // are load-bearing for /profile/api-keys — the reveal-once API-key
        // dialog is on-screen text, and replay films 10% of sessions (100%
        // on error). Masking every text node and input is what keeps a
        // user's key out of the recording; never relax these without a
        // block-selector covering the API-keys surface (NEO-172 audit).
        maskAllText: true,
        maskAllInputs: true,
        // These links' hrefs are bearers for private photos, and rrweb records an
        // href even under masking, as raw DOM no hook here sees. `maskAttributes`
        // skips href, so only a block works. Images are blocked by default.
        block: ['a[href*="/copy-photo/"]', 'a[href*="/api/storage/"]'],
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
    // NEO-415: the eBay return's one-time `code` and `state` are off the address
    // before Sentry starts (NEO-434). This pass is the second layer, for any
    // other way they reach an event, such as Replay's navigation-timing span.
    beforeSend: (event) => scrubEvent(event),
  });
}
