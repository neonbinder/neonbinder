---
name: patterns-neo172-machine-auth
description: NEO-172 /machine/token — the first UNAUTHENTICATED credential-exchange endpoint on convex.site; where its anti-oracle/log-hygiene invariants live, the recurring traps, and what CLERK_SECRET_KEY in Convex prod env changes
metadata:
  type: project
---

# NEO-172 machine auth (`POST /machine/token`)

`apps/web/convex/machineAuth.ts` + `convex/machineAuth.test.ts` (60 tests) + one
route in `convex/http.ts`. Client half: cardlister
`script-frontend/src/utils/neonbinder-stream.ts` (READ-ONLY repo).

Exchanges a user-scoped Clerk API key (`ak_…`) for a `convex`-template session
JWT. Unauthenticated by design — the key IS the credential. Session creation is
the production-legal 3-call path (`POST /sign_in_tokens` → FAPI
`/v1/client/sign_ins` `strategy=ticket` → `POST /sessions/{id}/tokens/convex`);
`POST /sessions` is testing-only and must never appear.

## The invariants and where they actually live

- **Anti-oracle**: exactly three constant bodies (`UNAUTHORIZED_BODY` /
  `UPSTREAM_BODY` / `UNCONFIGURED_BODY`). 401 only from the VERIFY step;
  everything after verify is 502 because the key is already known good.
- **Cross-user mint prevention**: `owner === subject && status === "active"` on
  the client-supplied `sessionId`. The only assertion that can catch a
  regression is on the **mint call's URL**, not on the response — the response
  is a 200 either way by design.
- **Log hygiene**: `logExchange`/`logFailure` take stage + status + the PUBLIC
  `ak_` id only. Both fetch helpers reduce a rejection to `err.name`, dropping
  the message *because it carries the URL* — and the dev-browser retry puts
  `__clerk_db_jwt` in the query string.
- **Dev-browser branch** is gated on the FAPI error's WORDING, not the hostname.
  Not attacker-reachable: every byte of that FAPI request is server-generated.

## Traps found here (re-check on any edit)

1. **Clerk 429 → 401.** `verifyResponse.status !== 200` collapses every non-5xx
   to `unauthorized()`, so an upstream *rate limit* is reported as a bad
   credential — and the CLI's `probe()` escalates that to "create a fresh key".
   Any new upstream status class needs the >=500 branch, not the 401 branch.
2. **No length bound on `key` / `sessionId`.** `stringField` accepts any length
   and `SESSION_ID_RE` is unbounded; both go upstream verbatim (the key inside a
   request that carries `CLERK_SECRET_KEY`). Unauthenticated outbound
   amplification on an endpoint with no rate limiting.
3. **`frontendApiOrigin` accepts `http://`** (missing scheme correctly defaults
   to https; explicit http passes through) — would ship the sign-in ticket in
   cleartext. Same one-liner applies to the CLI's `NEONBINDER_CONVEX_SITE_URL`.
4. **`new URL()` in `fapiPost` sits OUTSIDE the try** — a malformed origin
   throws out of the handler, producing a fourth response shape.

## Test-suite gaps (the tests are strong; these three are real)

- `captureLogs()` spies only `console.log` + `console.warn`. A future
  `console.error(…, key)` leaks and stays green despite the "EVERYTHING
  printed" docstring.
- Secret assertions are `not.toContain(<full secret>)`, so a **partial** leak
  (`key.slice(0,12)`) passes all 15 log-hygiene cases. The repo rule is "never
  log credentials, even partially" — the tests defend only the "never" half.
- The anti-oracle comparison covers `{status, text}` but not headers, and omits
  the 429 mode.

## What changed in the trust model

`CLERK_SECRET_KEY` is now required in the **Convex** prod env. That is a Clerk
Backend API admin credential shared by every Convex action's `process.env`: any
future arbitrary-fetch/SSRF/log-leak in ANY Convex action can now exfiltrate a
key that mints a session for *any* user. Clerk secret keys are not scopable —
mitigation is operational (rotation runbook, alerting).

**Do not confuse the two stores.** `apps/web/api/auth/testing.ts` documents
`CLERK_SECRET_KEY` as deliberately ABSENT from **Vercel Production** (one layer
of the testing-endpoint gate — see [[patterns-testing-endpoint-gate]]). NEO-172
needs it in Convex env only. Adding it to Vercel Production would arm the
testing sign-in-token path in prod.

## Cross-check with /e2e/*

Same `*.convex.site` origin, no interaction: different route prefix, different
credential (`x-e2e-queue-secret` header vs Bearer/body key), no shared helper or
state. Note `http.ts`'s `errorResponse()` echoes thrown messages into the body
for the e2e routes — `/machine/token` deliberately does NOT use it, and the two
must never be unified.

## Sentry / the /profile/api-keys page

Zero of our code touches a key secret; Clerk's `<APIKeys>` owns the reveal-once
dialog. Session Replay IS on in prod (`src/sentry.ts`, 10% sessions / 100% on
error) but does not film the secret: installed `@sentry/replay` defaults are
`maskAllText: true`, `maskAllInputs: true`, `networkDetailAllowUrls: []`.
**That safety is inherited from defaults and asserted nowhere** — a future
`maskAllText: false` would silently start recording user API keys.
