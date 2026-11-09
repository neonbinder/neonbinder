---
name: patterns-signed-url-scrub-coverage
description: How to check a new signed-URL shape or transport (XHR, alternate host) against the client scrubs — which pipelines scrubUrlSecrets covers, how to test a shape, and the PostHog replay compression blind spot
metadata:
  type: reference
---

Client telemetry scrub = `lib/observability/scrub-url-secrets.ts` (text regex
over JSON). It is wired into Sentry `beforeBreadcrumb` (xhr AND fetch
breadcrumbs, same hook), `beforeSend`/`beforeSendTransaction` (spans:
`http.url`, `http.query`, `server.address`), Replay `beforeAddRecordingEvent`
(network frames), and PostHog `before_send` (prod and E2E).

Checks for any change that adds a signed URL shape or moves a request to XHR:
- Transport parity is free: the scrub is URL-text based, not keyed on fetch.
  Sentry trace headers go only to same-origin by default, so XHR to a storage
  host gets no extra header. XHR default `withCredentials=false`.
- Run the new shape through the scrub directly: copy the .ts to scratchpad and
  `node --experimental-strip-types` a breadcrumb, a span and a console string.
  Check host (account/bucket labels), path token and every query param.
- Ask for a unit pin of the exact new host shape; a regex refactor otherwise
  regresses it silently.

PostHog replay blind spot (pre-existing, NEO-466 audit): posthog-js sends
`$snapshot` through `capture()`, so `before_send` runs, but it gzip-compresses
full snapshots (type 2) and mutation events (type 3 source 0) first. Network
plugin events (type 6) stay plain and are scrubbed; DOM attributes (img src,
a href carrying a bearer path) are NOT visible to a text scrub. Sentry solves
this with a `block` selector; PostHog needs its own masking/blocking config if
prod recording is on. Related: [[patterns-neo434-address-step-bundle-order]].
