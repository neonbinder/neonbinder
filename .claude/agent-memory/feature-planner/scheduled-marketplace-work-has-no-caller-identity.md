---
name: scheduled-marketplace-work-has-no-caller-identity
description: A cron or scheduler-driven marketplace call cannot use getSiteToken (it reads getCurrentUserId); plan an internal userId-taking token path and per-user fan-out. New browser-service routes can ship with a per-feature contract minimum in one release.
metadata:
  type: feedback
---

Two traps when a plan adds a scheduled (cron / `scheduler.runAfter`) call to a
marketplace on a user's behalf, found planning NEO-370 (BSC listing sync):

1. **The token path assumes a signed-in caller.** `credentials.getSiteToken`
   calls `getCurrentUserId(ctx)` and throws without one; a cron has no
   identity. Plan an `internalAction` that takes `userId` explicitly (the
   underlying `readCachedToken(site, userId)` / refresh helpers already take
   one) and keep it internal-only. Fan out per user with `scheduler.runAfter`
   so one user's failure never blocks the pass, and find "users with X linked"
   through a feature table indexed by platform, never a scan of `userProfiles`
   (its only index is `by_user`).
2. **A NEW Convex<->browser route does not need the two-release expand/contract.**
   The README's two-release rule guards against an OLD service silently
   misreading a changed shape. A brand-new route 404s loudly on an old
   service, and `release.yml` promotes the service before Convex, so one PR
   can bump `CONTRACT_VERSION` and gate only the new calls on a per-feature
   minimum (`contractVersion >= N` checked by those calls), leaving the global
   `REQUIRED_CONTRACT_VERSION` alone so logins are never blocked mid-deploy.
   Also check `express.json({ limit: "10kb" })` on the service: any route
   that carries rows needs its own larger limit on its router.

**Why:** both are easy to miss from the UI-facing side of the code, and each
would surface only as a production cron failing or a deploy-window outage.

**How to apply:** any plan with "scheduled", "poll", "cron" and a marketplace
token, or a new browser-service route. Related:
[[fe-imported-convex-modules-stay-env-free]],
[[telemetry-awaited-in-a-workpool-worker-holds-the-slot]].
