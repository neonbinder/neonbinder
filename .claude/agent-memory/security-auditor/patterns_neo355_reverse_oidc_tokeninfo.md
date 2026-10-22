---
name: patterns-neo355-reverse-oidc-tokeninfo
description: NEO-355 browser→Convex call authenticated by a Google id token verified via tokeninfo + email allowlist — the checklist for any "caller proves its GCP identity to a Convex HTTP route" surface, and its recurring traps
metadata:
  type: project
---

NEO-355 added the first browser-service → Convex call: `GET /internal/marketplace-pause`
(`convex/marketplacePause.ts` `servicePausedPlatforms`, verifier
`convex/lib/googleIdTokenVerify.ts`, client `services/browser/src/canary-pause.ts`).

**What makes a 200 unforgeable** (re-check all four on any edit):
- `aud` exact-equals `CONVEX_SITE_URL` (only trailing slashes normalised). Any
  GCP SA can mint a token with an arbitrary aud, so aud alone proves nothing.
- `email` exact-in allowlist env, lowercased; empty/unset allowlist = 403
  before any network call. **The allowlist is the real gate.** Check that a
  prod allowlist never includes a dev SA that developers impersonate locally.
- `iss` in {accounts.google.com, https://accounts.google.com}.
- tokeninfo status === 200 (signature + expiry are Google's job).

**Recurring traps (same family as [[patterns-neo172-machine-auth]]):**
1. Unauthenticated amplification: every garbage bearer costs an outbound
   tokeninfo call + a warn line. Cheap fix: JWT-shape check and an unverified
   payload pre-screen (aud/email) before calling Google.
2. Upstream 429 lands in the `!== 200 → 401 token_rejected` branch; it is
   Google's throttle, not a bad token (tokeninfo is documented as throttled).
3. Token in the tokeninfo query string; POST form body keeps it out of URLs.

**Fail-open client invariant:** `shouldSkipCanary` returns true only on a 200
whose `paused` array contains the mapped site key; everything else (mint,
timeout, network, non-200 incl. 3xx via `redirect: "manual"`, bad body,
non-https site URL) proceeds with the real sign-in. `canaryGate` returns before
any lookup when `canary !== true`. Grep both login routes for the gate placement
(after key/transient checks, before adapter construction).

The skip line is `success: true` on purpose (heartbeat for the absent alert);
the cost is that a forgotten pause disables the canary invisibly to alerting.
