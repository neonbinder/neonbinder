---
name: patterns-neo288-automated-access
description: NEO-288 SportLots automated-access handshake (service-level keyId/secret -> single-use authId on the signin POST) — the exposure invariants that hold, the class-name mismatch between adapter error strings and Convex's "challenge" bucket, and why a green preview login probe can mean the live path was never exercised
metadata:
  type: project
---

NEO-288 added a service-owned marketplace credential (not per-user) read
from its own Secret Manager secret by a dedicated reader module, traded for a
single-use token that rides the signin form. Audit rules that came out of it:

- **Reader contract = one fixed error string.** Every failure (missing
  version, junk JSON, client throw) must surface as the same constant and
  log only `error.name`. Node's `SyntaxError.message` quotes the input, so a
  `JSON.parse` of a secret payload must be swallowed, never logged or
  re-thrown as `cause`. Check the adapter reports the constant, not what
  the reader actually threw.
- **Handshake material rides `buildLoginDiagnostic` only as redaction
  inputs.** Verify the diagnostic builder never copies `secrets` into its
  output; the handshake *response* body must never become a diagnostic.
- **summarizeFetchError only redacts double-quoted spans.** A JSON request
  body is fully quoted so it is safe; a form-encoded body would not be.
  Check which body shape a fetch-error log could quote.
- **"challenge" as a Convex error_class is derived from the error STRING**
  (`classifyBrowserError`: "captcha"/"challenge"), not from
  `diagnostic.challengeDetected`. The SL no-cookies branch returns "No
  session cookies received. Check credentials." → class `other`. Any Convex
  copy/branch keyed on `errorClass === "challenge"` is dead for that path
  unless the adapter's string or the route's class is changed. Grep both
  sides before believing a comment that says "the service classifies it as
  challenge".
- **Challenge patterns scan the whole raw body + url + title.** A broad
  token (`/turnstile/i`, `/cloudflare/i`) matches a login page that merely
  embeds the widget script, which would turn a genuine bad-password page
  into challengeDetected → 502 + 5 retries of the wrong password. Ask for a
  live wrong-password capture before accepting a new broad pattern.
- **Preview login probe can skip the SportLots cases** (NEO-287 pause
  variable). "Preview login probe: pass" with `# skipped 2` means the live
  handshake was NOT exercised. Read the job log's TAP summary, not the check
  colour, before treating the probe as verification.

**How to apply:** on any change to the handshake, the reader, the challenge
patterns or `classifyBrowserError`, re-run these five checks; they are the
ones the unit suite cannot prove on its own.
