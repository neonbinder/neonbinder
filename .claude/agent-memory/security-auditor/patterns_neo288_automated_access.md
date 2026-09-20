---
name: patterns-neo288-automated-access
description: NEO-288 SportLots automated-access handshake (service-level keyId/secret -> single-use authId, one undici Client per attempt) — exposure invariants that hold, why disconnect errors are log-safe, the challenge/retry amplification, and why a green preview login probe can mean the live path was never exercised
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

**Second pass (single-connection client, 2026-09-20) — what held and what to re-check:**

- **A dedicated `undici.Client` as `fetch`'s `dispatcher` is auth-neutral.** TLS
  verification stays Node-default (undici's connector never sets
  `rejectUnauthorized`), SNI comes from the host, ALPN is `http/1.1` only,
  and `redirect: "manual"` is fetch-side, not dispatcher-side. Undici 7 unwraps
  legacy handlers, so Node 22's bundled fetch (undici 6) can drive an external
  undici 7 Client. Re-verify only if the Node major or the undici major moves.
- **`Client` `disconnect` errors are safe to log as `name: message`.** Every
  undici site passes a fixed string (`other side closed`, `socket idle
  timeout`, `aborted`, `bad response`) or a Node socket/TLS error;
  `HTTPParserError` keeps the offending bytes in `.data`, not `.message`;
  `SocketError` keeps addresses in `.socket`. Logging the error OBJECT (or
  `.data`/`.socket`) would change that. Request headers/body never reach a
  disconnect error.
- **`close()` racing `destroy()` never rejects** — DispatcherBase resolves
  pending close callbacks after destroy — so a bounded-close helper cannot
  leave an unhandled rejection. A cookie-carrying body is safe only because it
  is fully read INSIDE the connection scope; check any new early return in
  that scope calls `discardBody`, or the graceful close hangs to the bound.
- **Retry amplification under an account-scoped key.** `challengeDetected`
  clears `credentialRejected`, which makes the no-cookies branch retryable, so
  a deterministic site-side refusal costs MAX_ATTEMPTS handshakes with the
  service key per `/login` call. Any change that widens the challenge bucket
  widens that amplification; the fix is to make a detected challenge
  non-retryable, not to narrow the pattern.
