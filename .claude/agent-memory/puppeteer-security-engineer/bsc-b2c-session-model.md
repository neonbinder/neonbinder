---
name: bsc-b2c-session-model
description: BSC's Azure AD B2C refresh window is absolute (24h from the password sign-in), and only the rememberMe=true SSO cookie carries a session past it via a prompt-less /authorize
metadata:
  type: project
---

BSC's B2C tenant: `refresh_token_expires_in` is ABSOLUTE from the password
sign-in (a grant seconds later returns 86396, not 86400); rotation never
extends it. `rememberMe=true` on the `/confirmed` step sets a ~62-day
`x-ms-cpim-sso:*` cookie; a bare GET `/authorize` with a fresh PKCE pair,
NO `prompt` param, and that cookie answers 302 `#code=` with no password and
no SelfAsserted step, and the exchange mints a fresh 24h refresh window. The
302 re-issues the cookie (it slides). `prompt=select_account` forces the form
and defeats the SSO path.

SportLots gives no session expiry at all; any `expiresAt` we store for it is
our bookkeeping and must never gate validation.

**Why:** NEO-278 (2026-09-14): both prod marketplace sessions "lapsed" for
reasons that were ours — SL's self-imposed 30-day TTL skipped validation of a
working cookie, and BSC's refresh-only chain died at the absolute 24h mark.

**How to apply:** login order in the BSC adapter is cached token → refresh
grant → silent SSO re-authorize → password → reauth_required; a 5xx from the
token endpoint is an outage and must not fall through to the silent path.
Any write to a BSC secret must carry the stored SSO cookies forward
(`updateCredentials` replaces the payload). Cookie values are credentials:
names only in logs.
