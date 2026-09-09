---
name: secret-version-keep-one
description: NEO-115 decision — credential secrets keep exactly ONE Secret Manager version; keep-2/history was considered and rejected, don't re-propose it
metadata:
  type: project
---

Credential secrets in Secret Manager keep exactly **one** live version.
`SecretsManagerService.updateCredentials` prunes every other ENABLED/DISABLED
version after each successful write (NEO-115, 2026-08-04).

**Why:** nothing had ever pruned versions, so the dev project accumulated well
over a thousand ENABLED versions (a real monthly cost, growing daily) — driven by
the adapters' cached-token write-back on TTL expiry (BSC `TOKEN_TTL_MS` = 1h,
SportLots = 30d). The user was explicitly told that a `Credentials` payload
carries the durable marketplace username/password (not just the ephemeral
token), so keep-1 means a partial/interrupted write leaves the user
re-entering credentials in Profile. **That trade was considered and accepted.**

**Updated 2026-08-11 (NEO-141):** the *cost side* of that trade changed, the
decision did not. User payloads no longer carry a password at all — they are
`{username, token, expiresAt, refreshToken?, refreshExpiresAt?}` — so an
interrupted write now costs a **re-authentication**, not a re-entry in Profile.
Cheaper, but louder: the BSC refresh token is single-use/rotating, so a
half-completed write is not recoverable by re-reading. Keep-1 still stands;
just don't repeat the old "the payload carries the durable password"
justification, which is now false.

**How to apply:**
- Do NOT propose keep-2, keep-N, or a version-history/rollback scheme as a
  "safer" alternative — it has already been decided against. Implement keep-1.
- Two invariants in the prune are load-bearing and must survive any refactor:
  (1) exclusion is by the resource NAME returned from `addSecretVersion`,
  never by list order — list order races a concurrent write from another Cloud
  Run instance, and losing that race destroys a live credential; and if the
  created name is unknown, prune NOTHING rather than guess.
  (2) the whole prune is best-effort — a cleanup failure must never fail a
  user's credential write.
- Corollary: adapters must not write a secret version just to blank a field.
  The old BSC/SportLots "stale token clear" writes were removed for exactly
  this reason; a dead cached token now simply stays in the secret until the
  fresh-login write-back replaces it. That is safe because the cache-hit
  branches only return success when the token actually validates upstream.

Related: [[puppeteer-cleanup-invariant]], [[bsc-b2c-login-secret-discipline]]
