---
name: neo281-probe-verdicts
description: NEO-281 stored-session probe audit checklist — a marketplace probe must be a three-way verdict (valid/dead/indeterminate); what to check on any adapter that turns an upstream answer into reauthRequired
metadata:
  type: project
---

Audit rule (NEO-281, 2026-09-15): an adapter may set `reauthRequired` ONLY on the
marketplace's positive "session is gone" answer. "Couldn't ask" (5xx, 429,
thrown fetch, abort) is indeterminate → bounded retry → transient 502 with an
error string that classifies as `other`, never `reauth_required`/`invalid_credentials`.

**Why:** since NEO-141 no user password is stored, so a false "dead" goes straight
to the user as "session expired" and (via NEO-278 backoff) mutes fetch-driven
refreshes for 15 min. Collapsing "couldn't validate" into "invalid" flagged every
E2E account during one SL slowdown.

**How to apply — checklist for any probe-style validation:**
- Log hygiene: thrown fetch errors only through `summarizeFetchError` (undici
  quotes the full header value in header-validation TypeErrors); never log the
  redirect `Location` value or the body, only booleans/status.
- Abort timer: `setTimeout(abort)` + `clearTimeout` in `finally`; covers body read
  too. Sum of per-probe timeouts + backoffs must stay under Convex's 60s
  `AbortSignal.timeout` in `loginWithRetry` (3×15s + 1.5s ≈ 47s today).
- Redirect verdict should mirror the body heuristic (`login.tpl`/`signin.tpl`),
  not a bare `/login|signin/` substring, and ideally be same-origin — a bare
  substring on a query string re-creates the false-dead bug.
- Convex `applyLoginOutcome` writes only on success or `error_class ===
  "reauth_required"`; `loginWithRetry` retries only 503, so a 502 is one call.
- The user-facing copy for a transient failure via "Test" still says "check your
  credentials" (`SITE_LOGIN.*.failureMessage`) — misattribution, not exposure.

Related: [[neo278-session-lifetimes]], [[neo141-credential-rework]]
