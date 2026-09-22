---
name: which-paths-exercise-a-cold-bsc-password-login
description: Only two callers ever reach BSC's B2C password sign-in (transient creds and the canary); every other BSC login rides cache/refresh/SSO — so a broken password login shows up as exactly one red E2E flow while everything else stays green
metadata:
  type: reference
---

`BSCAdapter.login()` is a five-step ladder (see the doc comment above it).
**Step 0 short-circuits everything**: when the request body carries transient
`{username, password}`, the adapter goes straight to `passwordLogin()` and
never reads the stored secret — no cached token, no refresh grant, no
"Keep me signed in" SSO cookie. Steps 1–3 (cache → refresh → silent
`/authorize`) are what every *other* BSC call uses.

So the full B2C exchange (`GET /authorize` → `POST /SelfAsserted` →
`GET /api/<api>/confirmed` → `POST /token`) is exercised by exactly two
callers:

1. a login route request that carries transient credentials — i.e. a user
   (or the E2E seed) connecting a marketplace for the first time or after a
   clear; and
2. the `canary: true` probe, which deliberately skips 1–3 so it lands on the
   stored-password path every run.

**Why this matters when triaging.** If BSC's password sign-in breaks but
token refresh still works, almost the whole suite stays green: only the one
E2E flow that clears its credentials and re-connects them goes red, plus the
canary. "BSC logged in fine in 700ms elsewhere in the same run" is therefore
*not* evidence that sign-in is healthy — a sub-second BSC login is the cache
or refresh path, never a password login (a real one is tens of seconds).
The canary is the fastest discriminator: it is the only other consumer of the
same code path, so its history pinpoints the minute the password path broke.

**Reading the verdict.** `loginFailureOutcome()` in `observability.ts` forces
a tag per branch, and each maps to distinct product copy on the Convex side:

| adapter branch | error_class | HTTP | what it means |
|---|---|---|---|
| `/authorize` yielded no sign-in form | `challenge` or `other` | 502 | site change, WAF, or JS-gated page |
| `/SelfAsserted` returned a non-200 `status` envelope | `invalid_credentials` | 422 | BSC judged the password and said no |
| `/SelfAsserted` body did not parse as the envelope | `other` | 502 | integration fault, NOT a rejection |
| `/confirmed` returned no auth code | `other` | 502 | integration fault |
| a challenge page was positively detected | `challenge` | 502 | vetoes a rejection, always pages |

A credential-free reproduction of step 1 is cheap and safe: `GET /authorize`
with the public client config and a throwaway PKCE pair, then check that
`var SETTINGS = {...}` parses and carries `csrf`/`transId`/`api`. If that
comes back clean, the break is at step 2 or later and is about the account,
not the page.

See [[bsc-b2c-session-model]] for what the refresh window and the SSO cookie
actually do, and [[project_neo141_credential_rework_browser_half]] for why the
password only ever lives in-flight.
