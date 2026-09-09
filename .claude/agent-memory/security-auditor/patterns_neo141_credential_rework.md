---
name: patterns-neo141-credential-rework
description: NEO-140/141 password-less credential architecture — what the invariants are, where they are enforced, and the four structural traps that survived the rework (SL raw body previews, canary write-back, concurrent keep-1 prune, lazy legacy purge).
metadata:
  type: project
---

Supersedes the storage half of [[patterns-credential-atomicity-neo89]]. NEO-141 stopped
persisting marketplace passwords: the password travels ONCE on `POST /login/<site>` as a
transient body field, mints a session (BSC Azure AD B2C refresh token, 24h + ROTATING; SL
session cookie, 30d), and is never written for a user key.

**Where the invariants live (check these on any future credential change):**
- `services/browser/src/services/secrets-manager.ts` — `Credentials.password` is now optional
  and legal ONLY for the two canary secrets. `getCredentials` copies field-by-field: **a field
  missing from that list is silently dropped on read**, so any new field must be added there too.
- `services/browser/src/adapters/bsc-adapter.ts` `persistTokens` + `sportlots-adapter.ts`
  write-back — EXPLICIT field lists, never a spread of the read credentials. The old spread is
  what re-persisted the password hourly.
- `services/browser/src/routes/credentials.ts` — `GET :key/token` answers **204** for "secret
  exists, nothing cached" vs **404** for genuine absence. Never collapse these again.
- `apps/web/convex/credentials.ts` `readCachedToken` — 404 only counts as absence when the body
  matches `/credentials not found|no active version/i`. Unparseable 404 = recoverable.
- `getSiteToken` stays `internalAction`; `getSiteCredentials` exposes `hasRefreshToken` boolean
  + `refreshExpiresAt` only. No token value crosses to a public RPC.
- Destructive `removeSiteCredentialStatus` has exactly TWO call sites: the user-initiated clear
  branch, and the lock-guarded self-heal in `getSiteToken`.

**Structural traps that are still live (found in the pre-PR audit, 2026-08-11):**
1. **SL logs raw response-body previews.** `sportlots-adapter.ts` `preview = body.slice(0,200)`
   in the no-cookies branch and the validation-failed branch is `console.log`ed UNREDACTED,
   two lines from the diagnostic that redacts the same body for the session cookie. SL sets
   cookies via inline `document.cookie="…"` in the body, so this can put a live session cookie
   in Cloud Logging. Any "log a page preview" line in an adapter must go through
   `redactSecrets`/`buildLoginDiagnostic` first.
2. **Canary write-back is guarded only by the request flag, not the key.** A `POST /login/bsc`
   with `key: "<site>-credentials-canary"` and no `canary:true` performs a password login and
   then writes a password-LESS payload; keep-1 pruning destroys the version holding the canary
   password. Result: NEO-43 login alerting goes permanently blind and the failure is a
   non-pageable 422 `reauth_required`. Pre-NEO-141 the spread made this self-healing.
3. **Keep-1 prune has a concurrent-writer mutual-destroy.** `pruneToNewestVersion` excludes only
   the version THIS call created, so two concurrent `updateCredentials` on one key each destroy
   the other's version → zero ENABLED versions → 404 → the destructive status delete fires.
   The Convex per-(user,site) lock does NOT span Convex deployments, and dev + PR-preview
   deployments share both the dev browser service and the same Clerk test users, so this is
   reachable in CI, not just theory.
4. **Legacy passwords are purged only lazily** — on the next *fresh* login write-back. A cache
   hit writes nothing (BSC 1h, SL 30d), and a dormant user's password stays in Secret Manager
   indefinitely. Shipping NEO-141 alone does not retire the stored passwords; a sweep is needed.

**Abuse surface introduced:** `saveCredentials` takes an arbitrary `username`+`password` and
performs a live marketplace login in one request. Any signed-in user can therefore test
arbitrary BSC/SportLots credential pairs at the browser service's 60/min per-credential-key
budget, from our Cloud Run egress IP. Pre-NEO-141 this cost two requests per guess; it is not
new, but it is now cheaper and side-effect-free.
