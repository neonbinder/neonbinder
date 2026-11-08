---
name: patterns-analytics-leak-check-in-a-spec
description: NEO-434 — how a spec proves PostHog calls never carry a URL secret (host-agnostic filter, gzip body decode, count-not-bodies, unscrubbed-field marker) and what a no-op of the address module does and does not turn red
metadata:
  type: reference
---

- Filter analytics by path `/ingest*` OR hostname `*.posthog.com` (the build's `VITE_POSTHOG_HOST` may be either). Under E2E only `e2e_page_start` and a few named events leave, one per full page load (two with StrictMode), sent at once.
- Bodies are gzip (`1f 8b`) or `data=` base64: decode both with `node:zlib` before searching a marker; use ONE alphanumeric token (survives any encoding).
- Positive anchor: `page.waitForRequest(isAnalytics, { timeout: 7_000 })` created before the full-page `goto`. It fails loudly when the build has no `VITE_POSTHOG_KEY` (proved by starting Vite with an empty key).
- Assert on a COUNT of leaking calls, never on the call array: a failing `expect` prints the whole body (and PostHog's public project key) into the published report.
- The PostHog `before_send` scrub already redacts `code` and `state`, so a marker in those never fails. Put the marker in an UNSCRUBBED eBay field (`expires_in`, `error_description`); only then does a no-op of `src/ebay-return-address.ts` turn the spec red.
- Back after a full-page return cannot prove the module (the landing already replaced that entry); the reload-replay assertion can: break the panel's `state: null` clear and the reload shows the refusal again.
- History state is not perceivable; GUIDE hard rule 8 licenses `evaluate` for the theme check only, so assert the user-visible consequence (a reload replays nothing).
