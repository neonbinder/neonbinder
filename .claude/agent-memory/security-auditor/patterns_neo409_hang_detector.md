---
name: patterns-neo409-hang-detector
description: E2E-only Convex hang detector (custom logger + wrapped client) and Playwright failure capture (console + open-call snapshot attachments) - what Convex's verbose log actually carries, where redaction must sit, and the token forms a redactor misses
metadata:
  type: project
---

NEO-409 wraps the Convex client under E2E builds (`isE2E()`, the
VITE_CLERK_TESTING_ENABLED build constant) and attaches the page console plus
`window.__NB_HANG.snapshot()` to every failed Playwright test, so those land
in public CI artifacts.

**Convex custom logger facts (checked on 1.49):** passing `logger:` to the
client makes EVERY `logVerbose` line flow (the verbose flag only gates the
default logger). Those lines carry message types and state words only:
`sendMessage` logs `{type}` plus the last 7 chars of a User Authenticate
value, and `setAuthState` logs the last 7 chars of a fresh token. No args. Function
`logLines` and error messages arrive via `logger.log/error` (same content
already in `convex-logs-*` artifacts). Re-grep `logVerbose(` and
`messageForLog` on any convex bump.

**Redaction rules to check:**
- Redact BEFORE truncating, at every exit (buffer, console echo, attachment,
  PostHog string props).
- A JWT regex (`eyJ...`) is not enough: Clerk dev instances put
  `__clerk_db_jwt=<dev browser token>` on FAPI URLs and it may be an opaque
  `dvb_...` value; Chrome prints FAPI URLs in CORS/blocked-request errors, which
  happen on exactly the failing runs. Require param-name redaction for
  `__clerk_testing_token`, `__clerk_db_jwt`, `__session`, `__client`, plus
  the `%3D`-encoded form.
- An unsalted short hash of args (FNV-1a) is dictionary-recoverable for
  low-entropy args. That's fine for test data, but not a privacy boundary if ever enabled
  for real users.

**Gate shape that held:** detector, `window.__NB_HANG` and the PostHog event
are all behind the same build flag as `/testing/sign-in`, so no new
prerequisite. A page-owned threshold on `__NB_E2E` is clamped.

Related: [[patterns_playwright_report_exposure]], [[patterns_neo84_convex_client_swap]].
