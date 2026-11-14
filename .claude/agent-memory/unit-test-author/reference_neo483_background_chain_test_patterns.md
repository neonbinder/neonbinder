---
name: neo483-background-chain-test-patterns
description: Test recipes for a token-owned, self-rescheduling background fetch chain (bscSellerId) and its callers
metadata:
  type: reference
---

- Scheduled jobs in convex-test: `_scheduled_functions.args` is an array; read `args[0]`. Settle with drainScheduled then cancelScheduled (a rescheduled tick has a real delay).
- Stub `authenticateBsc` args must include every arg the product passes (a widened validator broke 16 files at once); grep all stubs when a login arg is added.
- An owner with no stored seller id arms a 0-delay tick on login; fixtures that do not care must store an id or the network guard trips.
- fetchBscSellerId retries a timeout once, so N scripted timeouts cost 2N profile reads.
- Break-check the token guards (tickState, stopChain, scheduleNext) by replacing the compare with `false`: each is killed by a test. A "paused" entry in a stop-failure set behind an earlier pause gate is an equivalent mutant.
- Wait counters (WaitingOnMarketplace) render nothing for ANNOUNCE_AFTER_MS; assert the mounted status element immediately, the text only after fake timers advance.
