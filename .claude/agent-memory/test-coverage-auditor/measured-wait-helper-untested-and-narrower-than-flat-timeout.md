---
name: measured-wait-helper-untested-and-narrower-than-flat-timeout
description: A spec helper that swaps a flat live-wait timeout for "7 s plus time the product says it waits" has its own logic, no test, and only credits waits the product announces
metadata:
  type: feedback
---

When a PR replaces flat live-marketplace timeouts (60 s) with a measured wait
(`expectAfterMarketplace`: 7 s of our time plus seconds a "Waiting on X" status
was on screen):

- The helper is an accumulator with episodes and a back-credit; it ships with no
  unit test, so an over-credit (false green) or under-credit (false red) is
  invisible. Ask for a pure-function test of the accumulator.
- It only credits waits the PRODUCT announces (retry/429/pacing edges). A slow
  read with no wait edge now fails at 7 s where the old flat ceiling passed.
  On a flaky-marketplace night that is a new red source; check which calls
  emit an edge.
- No spec can force the announced state itself unless the test switch fakes a
  429; a stall switch that fakes only a timeout leaves the status/cooldown UI
  without live proof.

**How to apply:** on any PR touching live-wait helpers, grep for who emits the
status, ask for the accumulator test, and ask for a deterministic way to show
the status live.
