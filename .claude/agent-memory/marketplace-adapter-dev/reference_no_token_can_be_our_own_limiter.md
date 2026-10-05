---
name: no-token-can-be-our-own-limiter
description: a checklist fetch failing "no token" may be the browser service's own express-rate-limit (60/min per credential key; /health per caller IP, one bucket for all Convex), a busy credential lock or the NEO-278 backoff — getSiteToken collapses all of them to null
metadata:
  type: reference
---

`credentials.getSiteToken` returns `null` for every failure on the token
path, and the adapters turn `null` into "No BSC token" / "No SportLots
session cookie". Things that land there that are OURS, not a marketplace's:

- `services/browser` installs `express-rate-limit` globally (`app.use`
  before every route): 60/min per credential key, and keyless routes —
  including `/health`, which `assertBrowserContract` probes before every
  authenticated call when its 60s module cache is cold — fall back to the
  caller IP. Behind Cloud Run IAM every Convex deployment shares that IP, so
  `/health` is one bucket for all of Convex, per Cloud Run instance.
  `readCachedToken` treats a 429 as "no token cached" (null → mint path).
- `withCredentialLock` contention in `refreshSiteToken` → refresh "failed" →
  stale cached token or null. A crashed hold blocks for `CRED_LOCK_LEASE_MS`.
- NEO-278 `inReauthBackoff` skips the refresh for 15 min.
- Our timers: 15s `browserFetch`, 10s `/health`, 60s login, 30s BSC
  checklist, 30s per SportLots page.

Since the NEO-321 follow-up each of these logs a
`{"msg":"marketplace_limiter", limiter, outcome, waitedMs}` line, and
`getSiteToken`'s catch logs `site_token_failed` with a scrubbed reason.

**How to apply:** when a fetch fails as no_sign_in / "didn't answer", grep the
same window for `marketplace_limiter` and `site_token_` before blaming the
marketplace. Never add pacing to "fix" it; the owner decides.
