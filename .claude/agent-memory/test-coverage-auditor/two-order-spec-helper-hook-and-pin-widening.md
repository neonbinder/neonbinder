---
name: two-order-spec-helper-hook-and-pin-widening
description: When a live spec is made to pass in two orders (instant vs wait), audit the failure hooks, the widened success regexes, and the dropped "this press started" gate
metadata:
  type: feedback
---

A spec helper that settles on "run started OR wait line shown" (a union via `.or()`) is only as strong as what follows it.

**How to apply:**
- The sibling `afterEach` failure hook usually still uses the old walk helper with a flat claim wait. A stall longer than the cap is exactly when the hook runs, so the hook goes red too and cleanup does not happen. Check every walk call in hooks, not only the body.
- A success regex widened to accept a degraded message (`A|B`) means the live spec cannot tell them apart. Require an annotation of which branch ran, or confirm a unit test pins each message separately.
- A deleted "this press's run is under way" gate (`underWay`) replaced by a union including settled-queue evidence: confirm that evidence is written before the press toast, else a stale ledger can satisfy later `run.last` asserts.
- Branches reachable only when the marketplace misbehaves (waiting, gave up, no profile) get no deterministic live proof when a forcing hook is declined. Record it as a stated limitation and check the unit suite runs axe in both modes on each state, including the read-only admin variant.
