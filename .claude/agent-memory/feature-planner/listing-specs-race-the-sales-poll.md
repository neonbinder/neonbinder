---
name: listing-specs-race-the-sales-poll
description: Any seller spec that stocks a listed box then presses Sync races the timed sales poll, whose drain can list first; the race is product behaviour, so plan a truthful record for either order and a spec that asserts it, never a cron-off hook
metadata:
  type: project
---

The sales poll (`pollAll` → `pollOwner` → `finishPoll`) kicks the same listing drain a
Sync press does. Both triggers are legitimate: the poll is how a seller who never
presses Sync gets listed. Slow work between stocking a listed box and the press, above
all a full-page axe check, gives the poll a window to list first. The press run then
has nothing to send.

**How to apply:**

- Don't plan a test hook that turns the poll off. It leaves the real order untested.
- Keep slow checks out of the write-to-press window. That only narrows the race, so
  the spec must still hold under either order.
- The product leaves a truthful record either way: a finished run's ledger is never
  empty, and a press during a run is taken rather than dropped.
- The spec has a hard precondition, walks the live run, then branches on the finished
  line (`pushed` 0 omits "updated"), with a hard result in each branch. A missing
  ledger must fail in both branches (GUIDE R2).
