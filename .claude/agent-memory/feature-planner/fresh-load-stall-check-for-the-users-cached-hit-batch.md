---
name: fresh-load-stall-check-for-the-users-cached-hit-batch
description: A spec red where a fresh page.goto never shows the first Convex-fed list (Sports column, etc.): prove whether the page ever subscribed by finding the signed-in user's cached-hit batch in convex-logs; also, a set-builder column heading is visible while its first-visit BSC sync still runs
metadata:
  type: project
---

Two forensic patterns from the NEO-527 mobile reds (2026-11-13):

1. **Did the page subscribe at all?** Queries that read `ctx.auth` are cached per
   identity, so a user's re-subscription logs as `cachedResult: true` carrying the
   ORIGINAL `executionTimestamp` (see [[convex-log-tracing-by-request-id]]). Find the
   user's earlier read of the same column (e.g. `collectionCatalog:drill` rd=19 for
   Sports), then look for a cached hit with that executionTimestamp in each page
   load's window. A page load that worked shows the batch (containers, wants, sports
   drill together ~1 s after the goto); a red window with NO batch while the latency
   probe is healthy means the client never sent its queries (auth/socket leg before
   Convex), not a slow or wrong query, and not the drill code.

2. **A set-builder column heading is not a sync-done signal.** "Inserts" renders at
   once beside "Syncing Inserts / Waiting on BuySportsCards…"; a first-visit sync can
   include a BSC token refresh that re-logs in (credentials:authenticateBsc 3-21 s on
   CI). An option wait after the heading must use `expectAfterBscSync` /
   `expectAfterMarketplace`, never a flat 7 s (and a long flat timeout on the heading
   proves nothing).

**How to apply:** before blaming a branch for a fresh-load or first-visit-column red,
check (1) for the subscription batch and (2) for a `credential_login_call` inside the
step's window.
