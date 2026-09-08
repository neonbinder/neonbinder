---
name: patterns-credential-atomicity-neo89
description: NEO-89 credential-flag atomicity design — saveCredentials writes the Convex hasCredentials flag server-side in the same action as the Secret Manager write; getSiteToken self-heals a stale flag on a 404. The invariants + residual gaps to check on future changes.
metadata:
  type: project
---

NEO-89 fixed "ghost credentials": Convex `hasCredentials` stayed true after the underlying Secret Manager secret was gone, because clearing the flag was a SEPARATE client-triggered call after the browser-service delete — interrupt the client between the two and they drift permanently.

**The design now (apps/web/convex/credentials.ts + userProfile.ts):**
- Single public `saveCredentials` action: both username+password → store branch (PUT) then `internal.userProfile.updateSiteCredentialStatus`; both blank → clear branch (DELETE) then `removeSiteCredentialStatus`. Flag write is server-side in the SAME action as the secret write. Mismatched pair rejected before any network/lock.
- `updateSiteCredentialStatus`/`removeSiteCredentialStatus` are `internalMutation` taking explicit `userId` (matching acquire/releaseCredentialLock). All 4 call sites derive userId from `getCurrentUserId(ctx)` (saveCredentials store+clear, getSiteToken self-heal, testing.ts seedMyTestCredentials) — none client-supplied.
- `updateUserProfile` no longer accepts `siteCredentials` (was a dead-but-real spoofing surface). Convex strict-arg validator now rejects it.
- `getSiteToken` self-heals: `readCachedToken` returns `"not_found"` on a 404 (secret genuinely absent) vs `null` (transient) vs token. On `"not_found"` it fires `removeSiteCredentialStatus`. Belt-and-suspenders for the clear-branch residual crash window.

**These credential endpoints are per-user (getCurrentUserId), NOT requireAdmin** — storing your own marketplace creds is self-service. requireAdmin (see [[patterns-convex-auth-boundary]]) applies to adapter/Set-Builder operator tooling, NOT to profile credential save/get/test. Do not flag the absence of requireAdmin here.

**Residual gaps confirmed (accepted as low/med, not blockers):**
- Store-branch crash between PUT-ok and runMutation → flag false / secret exists ("phantom absent"): benign (user re-saves; updateCredentials just adds a version), self-corrects, and is the SAFE failure direction vs the old ghost. Much smaller window than the old client round-trip.
- `getSiteToken`'s FIRST `readCachedToken` + self-heal runs WITHOUT the credential lock (only `refreshSiteToken` takes the lock internally). A concurrent same-user first-time store (secret not yet written → 404) can make the self-heal `removeSiteCredentialStatus` strip the site entry — which also carries the live lock — freeing the lock mid-store. End flag state stays correct, but the lock invariant is briefly defeated. Cheap fix: self-heal should skip when a live lock is held (lockedAt + lease > now).
- Single 404 is treated as authoritative for wiping the flag (no 2nd-read confirm). Only wipes the Convex flag, never the secret → recoverable, low severity.
- `saveCredentials`/`getSiteCredentials` take `site: v.string()` unvalidated against SUPPORTED_SITES (testSiteCredentials + listUserSites do gate). credKey always suffixes the caller's own userId so no cross-user key collision, but a junk `site` sprays arbitrary-named secrets. LOW defense-in-depth.

**Out-of-scope root cause still open:** the incident was an E2E flow (credentials-lifecycle.yaml) running on a real logged-in Clerk session via testing/sign-in "already signed in" fast path, deleting a REAL user's secret. This fix only makes the CONSEQUENCE self-healing; the delete-a-real-user's-secret vector must be fixed separately.
