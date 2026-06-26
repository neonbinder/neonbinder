---
name: bsc-b2c-http-login
description: BSC login is browser-free over fetch via Azure AD B2C custom policy (B2C_1A_signin); the exact OIDC flow, public client config, and where it can break
metadata:
  type: reference
---

BSC (`buysportscards.com`) authenticates through Azure AD B2C tenant
`identity.buysportscards.com` using a **custom policy** `B2C_1A_signin`. The
SPA runs MSAL.js doing OAuth2 **auth-code + PKCE**. As of the 2026-06-09 spike
the BSC adapter replays this entirely over `fetch` (NO Chromium) — mirroring
how SportLots already logs in. The Puppeteer login path was removed from
`src/adapters/bsc-adapter.ts`.

**Public client config** (extracted from `main.*.js` bundle + B2C OIDC
metadata — these are PUBLIC, not secrets; safe to hardcode):
- clientId `9b4d7d82-6b2b-4c9e-9542-d94ee43bcac1`
- authority `https://identity.buysportscards.com/identity.buysportscards.com/b2c_1a_signin`
- redirectUri `https://www.buysportscards.com/`
- scope `openid profile https://buysportscards.onmicrosoft.com/api/read`
- policy param on SelfAsserted/confirmed: `p=B2C_1A_signin`

**The 4-step fetch flow** (all share an in-flight `x-ms-cpim-*` cookie jar; node
fetch does NOT persist cookies, so collect Set-Cookie via `getSetCookie()`):
1. `GET .../oauth2/v2.0/authorize` (client_id, redirect_uri, response_type=code,
   scope, code_challenge S256, state, nonce, response_mode=fragment) → returns
   the self-asserted HTML embedding `var SETTINGS = {csrf, transId, api, ...}`
   + sets the cpim cookies. Parse SETTINGS for `csrf`, `transId`, `api`.
   `api` is literally `"SelfAsserted"` for this policy.
2. `POST .../SelfAsserted?tx=<transId>&p=B2C_1A_signin` with header
   `X-CSRF-TOKEN: <csrf>` and body `request_type=RESPONSE&signInName=<email>&password=<pw>`.
   Replies HTTP 200 with JSON `{"status":"200"}` on accept, `{"status":"400","message":...}`
   on reject (the message can ECHO the typed email — never return it raw; feed
   only the redacted diagnostic).
3. `GET .../api/SelfAsserted/confirmed?rememberMe=false&csrf_token=<csrf>&tx=<transId>&p=B2C_1A_signin`
   → 302 `Location: https://www.buysportscards.com/#code=<authcode>` (fragment).
4. `POST .../oauth2/v2.0/token` (grant_type=authorization_code, code,
   redirect_uri, code_verifier, client_id, scope) → JSON `{access_token,...}`,
   `token_type: Bearer`, `expires_in: 3600`.

Store the BARE access_token (no `Bearer ` prefix) in Secret Manager — the cache
path and Convex BSC API adapter both prepend `Bearer ` themselves. Validate via
`GET https://api-prod.buysportscards.com/marketplace/user/profile` (Bearer auth)
→ `sellerProfile.sellerId` / `.sellerStoreName`.

**Timing:** fetch path ≈ 3.0–3.4s B2C-only (≈4.4s full endpoint incl. Secret
Manager + profile). Old Puppeteer path was ≈17–20s (≈9.9s of it was
`goto(homepage, networkidle2)`). Cached-token short-circuit ≈1.1s.

**Why it's feasible / where it could break:** the sign-in custom policy
presents NO CAPTCHA/JS challenge (the old Puppeteer login solved none — it just
filled `#signInName`/`#password`). If BSC adds a real bot challenge or makes the
self-asserted page JS-mandatory, step 1 won't return a SETTINGS blob and step 2
will stop returning `{"status":"200"}` — that's the signal to fall back to a
Puppeteer path (navigate directly to the authorize URL,
`networkidle2`→`domcontentloaded`, block images/fonts). To re-derive the config
if BSC rotates it: `curl` the home page, find `main.*.js`, grep for `clientId:`,
`authority:`, `scopes:`, and `GET <authority>/v2.0/.well-known/openid-configuration`.

See [[bsc-b2c-login-secret-discipline]] for the redaction rules on this flow.
