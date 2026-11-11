---
name: token-leg-is-bsc-wait-time
description: A BSC token read (getBscToken / re-auth) can be a multi-second sign-in with no call in flight; hold the recorder's wait open with whileWaitingOnBsc, never separate edges
metadata:
  type: reference
---

The BSC call recorder (`lib/bscCallTelemetry.ts`) emits wait edges only from
calls it `start`s. The token read before the first call (`getBscToken` →
`credentials.getSiteToken`) is a BSC sign-in through the browser service when
the session is stale (seconds), and a 401's re-auth is the same. Uncovered,
"Waiting on BuySportsCards…" shows nothing for that whole stretch, and the
E2E marketplace-wait helper credits 0 s.

Wrap those reads in `whileWaitingOnBsc(rec, () => ctx.runAction(...))`
(`rec.beginWait()` underneath). It shares the recorder's openCalls / grace /
`accumulatedMs`, so the token leg plus the first call is ONE wait and no time
is counted twice. Do not emit a separate open/close for the token: a close
then reopen gives a new `waitingSince`, which restarts the client's 1.5 s
announce clock (`WaitingOnMarketplace`).

The recorder (and wait writer) must exist BEFORE the token read, with the
early returns inside the try/finally that flushes and drains.

`fetchBscCardTeamNames` has no token leg (card-listing is public). The seller
session (`bscSeller.openBscSellerSession` → `getSiteTokenForUser`) reads its
token before its recorder exists, so the listing drain's wait misses it.

Test pattern: `marketplaceWaits.tokenLeg.test.ts` mocks getSiteToken with a
real delay and wraps `createMarketplaceWaitWriter` to interleave edges with
token/fetch events; assert the event order, not timings. Related:
[[testing-wired-bsc-call-telemetry]].
