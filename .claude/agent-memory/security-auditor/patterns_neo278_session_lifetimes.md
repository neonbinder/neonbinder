---
name: patterns-neo278-session-lifetimes
description: NEO-278 marketplace session lifetimes — stored B2C SSO cookies are a long-lived sliding bearer in Secret Manager; the two durable audit rules are the undici header-validation TypeError that embeds the full Cookie/Authorization value into error.message, and the persistTokens `previous` carry-forward contract (SSO cookies only, never password or refresh token)
metadata:
  type: project
---

NEO-278 (2026-09-14) added a silent B2C re-authorize to the BSC adapter: a
stored `x-ms-cpim-sso:*` cookie map (`Credentials.ssoCookies` /
`ssoExpiresAt`) is presented on a prompt-less GET /authorize, the 302 `#code=`
is exchanged with a fresh PKCE pair. SportLots now validates its stored cookie
on every hit instead of gating on our own 30-day `expiresAt`. Convex adds a
15-min backoff (`reauthObservedAt`, `getSiteReauthState` internalQuery) on
fetch-driven refreshes only; user-initiated `testSiteCredentials` /
`saveCredentials` never see the backoff.

**Rule 1 — undici embeds the header VALUE in its validation error.** Node 22
`fetch()` throws `TypeError: Headers.append: "<full value>" is an invalid
header value.` when a header contains CR/LF/NUL. Every `catch` in the browser
service that logs `error.message` around a fetch whose headers carry a secret
(`Cookie:` with SSO/SL cookies, `Authorization: Bearer`) is therefore a latent
secret-to-log path. Reachable only via a hostile stored value today (the
marketplace cannot emit CRLF in Set-Cookie), but the narrowing boundary
(`parseCookieMap`, the flat `token` field) does not reject control chars.
Fix shape: reject `[\x00-\x1f\x7f]` in cookie names/values at the
secrets-manager narrowing, or log `error.name` only in those catches.

**Rule 2 — `persistTokens(..., previous)` carries forward ONLY
`ssoCookies`/`ssoExpiresAt`.** `updateCredentials` replaces the payload, so a
refresh-grant write must carry the stored SSO cookie forward. The contract to
re-check on any edit: `previous.password` and `previous.refreshToken` are never
read (a stale refused refresh token must die with the write; NEO-141's
password-shedding must survive). Also: a 302 that explicitly CLEARS the SSO
cookie is indistinguishable from "not reissued" and the stale cookie is
carried forward (documented in the adversarial tests).

**Rule 3 — lifetime widened deliberately.** Before NEO-278 a compromised
user secret bought at most 24h (refresh window). The SSO cookie is ~62 days
and slides on every silent authorize, so it is effectively indefinite while
the adapter keeps using it. Mitigations are the existing ones only: Cloud Run
IAM on the browser service, no route returns the field (`/token` and
`/metadata` wire shapes pinned by tests), `DELETE /credentials/:key` drops the
whole secret. There is no IdP-side revocation on Clear — flag if a ticket
adds a "sign out everywhere" expectation.

**Rule 4 — SportLots outage reads as a lapsed session.** `validateCachedCookie`
returns false on 5xx/network throw; with no stored password that is
`reauth_required`, which now also sets the 15-min backoff and the Set Builder
"session ran out" notice. BSC carves 5xx (and, in-flight, 429) out of the
reauth bucket; SL does not. Not a security finding, but the notice can lie
during an SL outage.

**How to apply:** on any change to `bsc-adapter.ts` login order, check the
order is cache → refresh → silent SSO → password → reauth_required and that
the canary skips 1–3; on any new catch around a fetch with a secret header,
apply Rule 1; on any new `Credentials` field, confirm `getCredentials`
narrows it AND the two credential routes' key-set tests still pin the wire.
