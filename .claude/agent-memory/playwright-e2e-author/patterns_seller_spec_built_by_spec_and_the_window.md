---
name: seller-spec-built-by-spec-and-the-window
description: A seller spec whose set the SPEC builds needs builtBySpec in SELLER_SPEC_SETS (else the start-clean pass throws on a fresh preview); and the in-progress-run check misses a seller job that has not started yet
metadata:
  type: pattern
---

1. `testingSellerCleanup.clearBsc` resolves every `SELLER_SPEC_SETS` entry to a
   row BEFORE signing in and THROWS "did the seed run?" when it is missing. That
   is right for a set the seed provisions (1988 Topps) and wrong for one the spec
   builds in-flow: the seller jobs run the cleanup first, on a freshly reset
   preview, so a spec-built set is always absent then. Mark such an entry
   `builtBySpec: true` (skipped, logged `seller_cleanup_set_absent`) and give it
   `parallel: "<name>"` when its cards live in a parallel instead of Base. The
   consequence to say in the PR: in CI that entry's start-clean never reaches BSC,
   so the spec's own takedown Sync and failure hook are the only zeroing; seeding
   the set instead would put the build in every seed.

2. `gh run list --status in_progress` plus the run's jobs shows only seller jobs
   that have STARTED. `seller-mobile` waits behind `seed-mobile`, which waits for
   the last desktop shard, so a run with one desktop shard left is minutes from
   holding the shared seller. A red-then-green seller run takes 15+ minutes: do
   not start it on that signal, and say why.

3. Seller specs run as worker 8 in alphabetical order inside one job, so a new
   `inventory-bsc-listing-*` spec follows the 1988 one; each must end "connected
   and not syncing".
