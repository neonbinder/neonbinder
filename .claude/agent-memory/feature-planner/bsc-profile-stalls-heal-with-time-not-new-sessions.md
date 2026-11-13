---
name: bsc-profile-stalls-heal-with-time-not-new-sessions
description: A BuySportsCards profile-read stall is not tied to one session — a new token or B2C session does not get past it, time does (~50% at 30 s, ~70% at 60 s); the seller id is always read live, never env; the E2E seed re-signs in on a stall because only it holds the test password
metadata:
  type: reference
---

When a plan needs the BSC profile read (the seller id) to succeed, plan for
**waiting**, not for a fresh session.

- **A stall is not tied to one session.** A stall in progress is not escaped
  by minting a new token or a new B2C session: immediate reads after a new
  session succeeded only about 7–20% of the time.
- **Time heals it.** About 50% of stalled reads succeed after 30 s, about
  70% after 60 s. A retry plan is a time budget, spread over attempts.
- **Every password login is already a new session.** Our password login never
  presents the KMSI cookie, so "log out first" or "force a new session" adds
  nothing a plain re-login does not.
- **The seller id is read live, never from env or a constant** (the owner's
  rule): it exists only through BSC's API and may change. The login's own
  profile read is the source; `credentials.runSiteLogin` saves it when the
  login returns one.
- **On a stall, the E2E seed signs in fresh again**, within a bounded number
  of cycles and a time window that fits the seed hop's budget (NEO-482,
  `seedBscWithSellerId` in `convex/testing.ts`). Only the seed can do this,
  because it is the only place holding the test password; a product path with
  a stored session cannot re-run a password login.
- **Signature:** a `storeTestCredentials` call taking 12–13 s means its
  profile read stalled (the login itself returned, without an id). The seed
  logs `seed_bsc_relogin` with `attempt`, `idSaved` and `elapsedMs` per cycle.

Related: [[bsc-cold-sheet-read-is-per-job-not-per-condition]],
[[listing-specs-race-the-sales-poll]].
