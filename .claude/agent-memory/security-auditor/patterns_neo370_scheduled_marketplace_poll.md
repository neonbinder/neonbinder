---
name: patterns-neo370-scheduled-marketplace-poll
description: NEO-370 BSC listing drain + 15-min order poll — identity-less token path is safe only while internal; traps: credential-state gating, backoff == poll interval, tick overlap, throwing poll pins the index; Rev 5: default-on doors bypass a test marker, all-rows seller holder locks out, per-tick full scan
metadata:
  type: project
---

NEO-370 added the first 24/7, per-user, scheduler-driven marketplace work
(listing drain + order poll). What held and what to re-check next time:

- **Held:** `getSiteTokenForUser` / `refreshSiteTokenForUser` and the
  `userId` arg on `authenticateBsc/Sportlots` are internal; no public action
  forwards a userId. Public listing fns all `requireSignedIn`, owner never an
  argument; returns strip `leaseToken`, `sellerSku`, `orderId`, `appliedAt`.
  Sale application is owner-scoped (SKU card id is catalog, box id only a
  tie-break) and idempotent (applied flag flipped in the lowering mutation).
- **Trap 1 — gate on credential state, not on the token read.** A poll that
  only checks "listing row exists" keeps calling the browser service for an
  owner who cleared credentials (self-heal path, 2 calls/tick) or whose
  session lapsed (a stored-session login every tick). Clearing credentials did
  not switch listing off.
- **Trap 2 — NEO-278 backoff (15 min) == poll interval (15 min)**, so the
  backoff bounds nothing for a poll: each tick is just past the window. The
  NEO-278 "~4/hour/user" bound was sized for interactive use, not 24/7.
- **Trap 3 — fan-out cap x stagger > interval** (500 x 2s = 16.7 min > 15)
  makes ticks overlap and double-schedule owners whose `lastPolledAt` is not
  yet stamped. Correctness held via unique upserts; cost did not.
- **Trap 4 — a per-owner action that can throw before `finishPoll`** leaves
  `lastPolledAt` unstamped, so the owner stays at the head of a
  never-polled-first index every tick (poison owner; starves others once
  owners > cap). Unbounded upstream strings stored on a doc are the usual
  thrower. Drain had try/finally; poll did not.
- Marketplace ids (`platformCardId`, BSC `cardNo` in problem detail) reached
  public validators and rendered copy: invariant finding even when they are
  the user's own orders.

- **Rev 5 (saved sign-in = listing) traps.** (a) A test marker that holds
  off a default-ON behaviour only works if every default-on door honours
  "no marker yet": a login re-asserting the credential flag (token refresh,
  Test Credentials) that creates a fresh state row starts listing on a
  testing deployment the cron skip never covered. On testing deployments
  only an explicit save should start. (b) A one-holder-per-account check that
  counts EVERY row carrying the account id (dormant, conflicted, removed
  sign-in) makes holders permanent; stamping the contested id onto the
  conflicted row turns it into a holder too, so two owners lock each other
  out and removal never releases. Count only active holders. (c) A one-time
  migration written as a per-tick full scan of userProfiles is a perpetual
  O(users) cost; ask what else it covers (saves made while paused) and
  bound it to that.

**How to apply:** any cron/scheduler fan-out that acts on a user's marketplace
session. Related: [[inline-reauth-bypasses-backoff]],
[[patterns-neo278-session-lifetimes]], [[patterns-neo333-split-raw-and-report]].
