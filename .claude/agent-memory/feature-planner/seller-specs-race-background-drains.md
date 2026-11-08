---
name: seller-specs-race-background-drains
description: Marketplace seller specs press Sync on a live preview whose 15-min sales-poll cron and other kicks can start a drain first; a press during a running drain answers "throttled" (copy says "just synced"), and a BSC ledger step is one live sheet read (~4 s warm, ~8 s under load) inside the 7 s budget
metadata:
  type: project
---

The two `@marketplace-seller` specs assume "no cron path", but the preview's
cron runs. `listingSales.finishPoll` kicks a drain whenever outbox rows exist,
so the window between any queueing write (price, quantity, box "Listed" flip)
and the spec's Sync press is a race. `listingSync.syncOnePlatform` drops a
press while the variant's run holds a lease and answers `ignored: "throttled"`,
which `SyncButton.syncToast` reads as "just synced. Give it a minute": wrong
copy for a run in progress, and the spec's `said("Syncing … now")` goes red.
Seen on PR #420 (cron listed before the first press) and PR #422 run
41948082370 (cron's drain claimed the set 1.3 s after the box flip, 1 s before
the take-down press).

**Why:** background kicks are product behaviour; a spec cannot pause the cron,
and the ledger/result gates after the press are what prove the sync.

**How to apply:** plan the fix as (a) a product answer that distinguishes "a run
is under way" from "pressed twice in a minute" and says "Syncing now" for the
former, with the spec unchanged, or (b) a spec that accepts either answer and
leans on `underWay`/result-line gates. Never a sleep or a bigger number. The
BSC `Read …` ledger steps are one live BSC `sheetRead` each (3.9-4.1 s warm,
7.3-7.9 s measured under load 2026-11-05); GUIDE hard rule 3 already names a
live BSC round trip as an allowed longer wait, so a ceiling there is Jason's
call, recorded at the site with the measurement. A failed BSC `afterEach`
leaves its box stocked and cascades into the eBay spec's "Your copies (1 line)".
Related: [[turn-count-waits-are-load-dependent-under-web-crypto]].
