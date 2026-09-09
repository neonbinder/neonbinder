---
name: neo141-credential-rework-browser-half
description: NEO-140/141 — user passwords are no longer stored; the canary secrets are the ONLY exception, and `reauth_required` is a cross-repo monitoring contract
metadata:
  type: project
---

The browser service stopped persisting users' marketplace passwords
(NEO-140/NEO-141, implemented 2026-08-11, left uncommitted in worktree
`neo-141-credential-rework`). User secrets now hold
`{username, token, expiresAt, refreshToken?, refreshExpiresAt?}`; a password
enters only in a login request body, is used for one sign-in, and is discarded.

**Why:** BSC's Azure AD B2C was already handing us a rotating 24h refresh token
on every login — under the *base production scope*, `offline_access` not
required — and we were discarding it, which is the only reason a password had
to be kept at rest. Probed live 2026-08-11; the probe script is at
`.claude/scripts/bsc-refresh-probe.mjs` (private repo).

**How to apply — three constraints that are NOT derivable from
`services/browser/` alone, and that a future change can silently break:**

- **The two canary secrets keep their passwords, deliberately.**
  `bsc-credentials-canary` / `sportlots-credentials-canary` are driven by live
  prod Cloud Scheduler jobs (`terraform/main.tf`, ~30 min cadence)
  that POST `{key, canary:true}` and must perform a REAL password login — that
  is the whole NEO-43 login alerting. Any "let's finish the job and delete
  password support" cleanup breaks production monitoring. `password` must stay
  optional on `Credentials`, never merely removed.

- **`error_class: "reauth_required"` is a monitoring contract.** It is a label
  on the `browser_login_failures` log-based metric in `terraform`,
  and it is what Convex keys off to prompt "sign in again". It must behave like
  the other CALLER-error tags (422, never pages). Renaming it silently zeroes a
  metric series — Cloud Monitoring reports no error, the alert just stops
  firing.

- **A BSC refresh must persist the rotated token atomically, not
  best-effort.** B2C invalidates the token you present, so returning success
  after a failed write strands the user on a one-hour fuse with no way to
  renew. A write failure must FAIL the login (502).

Related: [[secret-version-keep-one]], [[puppeteer-cleanup-invariant]]
