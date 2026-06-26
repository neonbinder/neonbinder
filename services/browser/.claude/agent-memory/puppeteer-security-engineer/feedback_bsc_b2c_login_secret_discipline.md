---
name: bsc-b2c-login-secret-discipline
description: Secret-handling rules specific to the BSC B2C fetch login — which fields are secret, what may/may not be logged or returned
metadata:
  type: feedback
---

Secret-handling discipline for the BSC browser-free B2C login (and any future
B2C/OAuth fetch replay).

**Rule:** in the B2C fetch flow, treat ALL of these as secrets that must NEVER
appear in logs, returned `error` strings, or unredacted diagnostics: the
username/email, password, the `x-ms-cpim-*` anti-forgery cookie VALUES, the
`csrf` token, the OAuth `code`, the PKCE `code_verifier`, and the
`access_token`/`id_token`/`refresh_token`.

**Why:** the browser service handles real users' marketplace credentials; a
single leak compromises their BSC seller account. The B2C SelfAsserted
rejection body `{"status":"400","message":...}` and the token endpoint's
`error_description` can echo the typed identifier or carry trace material — so
neither may be returned raw to the caller.

**How to apply:**
- Caller-facing failures return the GENERIC string `"Authentication failed"`
  (never the raw B2C message or a JS `${error}`). The old Puppeteer code's
  `error: \`Error during login process: ${error}\`` was a leak vector — don't
  reintroduce that shape.
- On failure, build the diagnostic via `buildLoginDiagnostic(...)` passing the
  in-scope `{ email, password }` so it redacts the exact typed values plus
  token/cookie/JWT-shaped substrings. The unit test asserts the SelfAsserted
  message's echoed email/password are scrubbed — keep that assertion.
- Logs may contain: step markers, the policy `api` name (`SelfAsserted`),
  `storeName`, and a 4-char `sellerId` PREFIX only (full sellerId lets a
  log-reader correlate a Clerk user to a BSC seller account). Booleans like
  `email=${!!email}` are fine; the values are not.
- The login path must never call `launchPage()`, so `this.browser` stays
  undefined and `cleanup()` is a no-op — no Chromium to leak (see
  [[project-puppeteer-cleanup-invariant]]). The route handler still wraps in
  try/finally with `cleanup()` for uniformity.

See [[bsc-b2c-http-login]] for the flow mechanics.
