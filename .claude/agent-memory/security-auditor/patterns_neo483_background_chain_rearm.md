---
name: patterns-neo483-background-chain-rearm
description: NEO-483 BSC seller-id background chain + no-verdict cached token; a capped retry chain re-armed by a periodic trigger is perpetual; tokenRefused is the only thing stopping a refused token being re-served
metadata:
  type: project
---

**A "max attempts" cap on a background chain is not a bound if anything
periodic re-arms it.** NEO-483's `bscSellerId` chain gives up after 10 reads
and clears its row field, but `claimDrain` (kicked by the 15-min sales poll
whenever outbox rows are queued) and `runSiteLogin` (every hourly token
refresh, which no longer returns a seller id) both call ensure again. For an
owner whose upstream answers "no such thing" (200, no `sellerProfile`) the
chain runs forever. Audit any capped chain by listing every ensure/arm call
site and asking which of them a cron reaches; ask whether a positive upstream
"no" is treated as terminal; ask for a give-up timestamp + cooldown instead of
clearing the field.

**Serving an unvalidated cached token is safe only while every 401 reaction
says so.** After NEO-483 the browser cached branch serves the token on any
non-401/403 profile outcome; only the `tokenRefused` request flag stops it
being re-served after a refusal. Check every caller that reacts to a BSC 401
(`refreshSiteTokenForUser`, `refreshSiteTokenAfterRejection`) passes it, and
that the leeway fallback is never armed when it is set. A new-service +
old-Convex deploy window re-serves the refused token during a profile stall.

Related: [[patterns-neo370-scheduled-marketplace-poll]], [[patterns-neo411-retry-generation-and-dispatcher]].

**Delta lesson: a cooldown with a "user action skips it" door needs its own
floor.** The fix let the public `syncVariant` press restart an ENDED chain
with no minimum interval, placed before the per-variant resync throttle. With
a one-read terminal end (`noSellerProfile`) a scripted press loop drives about
one upstream read per tick latency. Audit every `userAction: true` call site
that a public mutation reaches. It needs a row-level floor on chain starts,
not the per-variant throttle, which a user with many variants sidesteps.
