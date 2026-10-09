---
name: adapter-reauth-goes-through-refresh-site-token
description: an adapter forcing a re-auth after a marketplace refusal must call credentials.refreshSiteTokenAfterRejection, never authenticate* directly; and the credential lock inserts a userProfiles row in convex-test
metadata:
  type: reference
---

An adapter that forces a re-auth after the marketplace refuses a request (BSC 401 with a "fresh" cached token) must go through `internal.credentials.refreshSiteTokenAfterRejection` (NEO-325), which is `refreshSiteToken`: NEO-278 `inReauthBackoff` + the per-(user, site) `withCredentialLock`. Calling `internal.credentials.authenticateBsc` / `authenticateSportlots` directly skips both, so a batch (or two in-flight calls) runs repeated, concurrent, unlocked logins. The SportLots selector empty-result retry still calls `authenticateSportlots` directly (same bug class, not yet fixed as of 2026-10-09).

A shared session object gets a one-re-auth budget (`BscSession.reauthAttempted` / `dead`): after a failed re-auth or a second 401, remaining requests fail `signed_out` with no request and no login.

**Why:** a security audit failed the Base match probe on exactly this; refreshSiteToken answers false for backoff, busy lock and failed login alike, and callers treat all three as "failed".

**How to apply:** in convex-test, `acquireCredentialLock` INSERTS a `userProfiles` row when the test identity has none, so a "no table changes" test that counts every table goes red once a path takes the lock. Scope write-free assertions to catalog tables, or seed a profile and compare it minus the lock fields. See [[convex-test-needs-the-modules-arg]].
