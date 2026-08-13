import * as Sentry from "@sentry/react";
import { scrubSignedStorageUrls } from "../lib/observability/scrub-signed-urls";

// Skip Sentry entirely when running under Maestro/E2E tests. Sentry's
// Replay integration spawns Web Workers and same-origin iframes for
// session capture; Maestro's CdpWebDriver `detectWindowChange` latches
// onto those transient handles and never switches back, causing
// subsequent CDP JS calls to fail with `null cannot be cast to non-null
// type kotlin.Int`. See NEO-13 / Maestro issues #3176, #3271, #3289.
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
        beforeAddRecordingEvent: (event) => scrubSignedStorageUrls(event),
      }),
    ],

    tracesSampleRate: import.meta.env.MODE === "production" ? 0.1 : 1.0,
    enableLogs: true,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,

    // XHR/fetch breadcrumbs (e.g. the signed PUT/POST in direct-upload.ts)
    // carry the full request URL, query string included.
    beforeBreadcrumb: (breadcrumb) => scrubSignedStorageUrls(breadcrumb),
    // browserTracingIntegration's auto-instrumented spans record the request
    // URL on `http.url` — same signed-capability leak, different pipeline.
    beforeSendTransaction: (event) => scrubSignedStorageUrls(event),
  });
}
