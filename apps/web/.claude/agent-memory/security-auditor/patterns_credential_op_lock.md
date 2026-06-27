---
name: patterns-credential-op-lock
description: Per-(userId, site) credential-operation OCC lease lock serializing store/test/delete; the lockToken server-only invariant and the cross-user-isolation argument
metadata:
  type: project
---

# Per-(user, site) credential-op lock (convex/credentials.ts + userProfile.ts)

Introduced to serialize credential ops (store / test-login / delete / background refresh) so a Clear can't race an in-flight marketplace login and corrupt the Secret-Manager token (confirmed Cloud Run race: clear fired 7s after a login).

## Where it lives
- Lock STATE: `userProfiles.siteCredentials[]` gains optional `lockedAt` (epoch ms lease anchor), `lockedOp` ("store"|"test"|"delete"), `lockToken` (server-minted `randomUUID`). All optional → no migration; missing = not locked.
- `acquireCredentialLock` / `releaseCredentialLock` = `internalMutation`s in userProfile.ts. Take `userId` as an ARG (called via runMutation from node actions in credentials.ts). NOT client-reachable. Convex mutation serializability makes the read-check-set race-free.
- `withCredentialLock(ctx, userId, site, op, body, busyResult)` helper in credentials.ts: mint token → acquire → body → release in `finally`. On contention returns `busyResult` WITHOUT running body (fail-CLOSED for the dangerous ops; refresh treats contention as refresh-failed=false → cached/null fallback, also safe).

## Security invariants that MUST hold (verified sound 2026-06-19)
1. **lockToken is server-only.** `getUserProfile` query validator exposes lockedAt/lockedOp but NOT lockToken, and the projection explicitly rebuilds each entry WITHOUT lockToken. Release requires a token match — a client that can't see the token can't forge a release. If you ever add lockToken to the validator or stop projecting field-by-field (e.g. spread `...c`), you LEAK the release capability. Keep the explicit allowlist projection.
2. **Cross-user isolation.** Lock key = (userId, site) where userId = getCurrentUserId (Clerk subject) resolved in the PUBLIC action, never a client arg. A user can only lock/contend their OWN key → at worst a user wedges their own ops (acceptable). The internalMutation taking a userId arg is fine BECAUSE the only callers are these actions passing the authenticated subject; never wire it to a public mutation with a client-supplied userId.
3. **Non-reentrant; no deadlock.** `testSiteCredentials`/`refreshSiteToken` hold the lock across the inner `authenticateBsc`/`authenticateSportlots` runAction. Those inner internalActions do NOT acquire any lock (verified). Re-acquiring the same key would self-deadlock-to-busy.
4. **Lease > worst-case login.** Lease = 5min (300s). loginWithRetry worst case (503-only retries) = 4×60s timeout + (5+10+15)s backoff = 270s. ~30s margin. If you raise maxAttempts or the per-attempt timeout, RAISE CRED_LOCK_LEASE_MS too or a reclaim can hijack an in-flight login.
5. **No write amplification.** acquire/release each do one patch on the single userProfiles row; no unbounded growth.

## Client gate (app/profile/page.tsx)
`credsBusy` = isLoading || any site lock live (lockedAt + 5min > now). Disables all cred controls + site tabs. Client lease constant MUST stay == server CRED_LOCK_LEASE_MS (two copies — drift risk; if server lease changes, change the client too). This is a UX guard only — the server lock is the real enforcement.
