---
name: seed-hops-that-consume-rows-replay-on-retry
description: A testing seed that applies a sale lowers the very copies it resolved from; a retried hop must replay the stored order by id, never re-resolve from the box
metadata:
  type: reference
---

A `/testing/*` seed hop that records AND applies a marketplace order (NEO-500
`testing.seedMyTestPickOrder`) consumes its own input: the apply lowers the box
copies the seed used to resolve card, SKU and condition. A second visit of the
same hop (a spec retry, a page re-render, a re-seed) then finds no copy and
throws ("found 0"), which reads like a flaky fixture.

**How to apply:** key the seeded order by a spec-minted token
(`TEST_SALE_ORDER_PREFIX` + token); when that order already exists, rebuild the
projected order from the stored items and re-run the cores (exactly-once makes
it a no-op). Only a new token resolves from the box. Probe the retry in the
scratch test, not just the first call. Related: [[pin-tests-need-a-bypass-plant]].
