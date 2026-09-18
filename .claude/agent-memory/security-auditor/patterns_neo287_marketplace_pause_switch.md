---
name: patterns-neo287-marketplace-pause-switch
description: NEO-287 env-var operator switch that pauses a marketplace — the audit checklist (single login funnel, getSiteToken guard BEFORE readCachedToken, coveredSides recomputed server-side with the pause, fail-open-on-typo by design, repo-variable mirror weakens CI coverage not auth)
metadata:
  type: project
---

NEO-287 added `convex/marketplacePause.ts` (env read + signed-in query) over a
pure `convex/lib/marketplacePause.ts` vocabulary. Audit findings that generalise
to any future "operator flag via Convex env var":

- **One funnel proves the guarantee.** Every marketplace login in Convex goes
  through `runSiteLogin` -> `loginWithRetry`; grep `loginWithRetry(` to confirm
  there is still exactly one call site before trusting a guard placed there.
- **`getSiteToken` guard must sit BEFORE `readCachedToken`.** The `not_found`
  branch below it is the only path that deletes `hasCredentials`; a pause that
  returned null AFTER the read could still self-heal-delete (invariant 5).
- **Client `coveredSides` is never trusted.** Both store mutations recompute
  `resolvableSides(chain, { paused: pausedSides() })` and `effectiveCoveredSides`
  also drops a side whose returned-id universe is empty — double guard, so an
  unpause race between fetch (action) and store (mutation) cannot unlink.
- **Fail-open on a typo is deliberate** (unknown key dropped + console.warn on
  every call). The runbook's UI verification step is the mitigation; a CI
  mirror step can validate the value cheaply, prod cannot.
- **A repo variable mirrored into previews weakens CI coverage, not auth.**
  Anyone with repo write can pause every marketplace for every PR's E2E run
  and skip the SL login probe on promotion; the step summary that echoes the
  value is what makes that visible. Check the summary line exists.
- **Empty-success → failure hardening** (`empty_after_retries`) is only safe
  on levels the adapter serves that are never legitimately empty; confirm the
  level map before approving the same trick elsewhere.

**How to apply:** reuse this checklist for any flag that gates marketplace
contact or unlinking; verify the pure/env split with a grep for `process` and
`_generated` in the lib module.
