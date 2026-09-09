---
name: selector-deadline-scope
description: NEO-198 deliberately did NOT bound the credential/re-auth path behind the selector-option adapters; do not re-propose that surgery.
metadata:
  type: project
---

The unbounded credential path under `fetchSportLotsSelectorOptions` /
`fetchBscSelectorOptions` (`getSiteToken` → 15s browser fetches;
`authenticateSportlots` → `loginWithRetry` at 4 × 60s) is known, documented, and
intentionally left unbounded as of NEO-198 (2026-08-30).

**Why:** three reasons given when the original plan was cancelled — (1)
`cloud_run_min_instances = 1` in both dev and prod already eliminates the
browser-service cold start that motivated it, (2) the product owner has been
loading sets through these paths for months and has never seen the aggregator
deadline fire, and (3) the credential path is shared with the interactive
Profile → Site Credentials flows, so it is the widest blast radius on this
branch. NEO-198 instead made the aggregator's deadlines derive from the
adapters' own ceilings and added an `adapter_phase(token_ready)` breadcrumb so a
future occurrence is attributable rather than guessable.

**How to apply:** if a hang in selector-option sync comes up again, first check
PostHog for `adapter_phase` joined on the aggregator's `requestId` — its absence
means the stall was in auth. Only then is bounding the credential path back on
the table, and it needs the interactive flows considered alongside it. Do not
propose short-timeout variants of the credential calls as a speculative fix.
