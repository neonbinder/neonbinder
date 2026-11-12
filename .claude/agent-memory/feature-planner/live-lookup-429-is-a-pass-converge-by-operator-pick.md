---
name: live-lookup-429-is-a-pass-converge-by-operator-pick
description: A spec's one live BSC card may meet a cooldown (teamLookup failed, pre-fill withheld); Jason 2026-11-11 ruled that a pass; assert both outcomes, then converge with the operator's pick
metadata:
  type: feedback
---

When a spec keeps one or two cards for a live per-card BSC lookup, a 429 or an open cooldown on that card is a PASS (Jason, 2026-11-11, NEO-489: "consider a 429 'success' in the spec"). Fetch-time lookups never wait a cooldown out: the card is marked `teamLookup: "failed"`, invariant 8 withholds every pre-fill (the choice is offered, "Leave for later" is the default), and the commit hands an unanswered teamless card to the background lane ("Still looking up teams for N cards.", no "Waiting on BuySportsCards").

**Why:** other shards' bursts open a deployment-wide cooldown at random; failing on it made the suite red for correct product behaviour.

**How to apply:** read the settled state once behind a positive `.or()` (`getByRole("radio", { name, checked: true })` for each default), annotate which branch ran (`bsc-lookup`), and in the held-back branch make the operator's pick (`check()`) so everything downstream asserts unconditionally (an operator-picked team is never queued to the lane). Name what stays unconditional so the branch is not an R2 fall-through. Local repro: record a 600 s cardListing cooldown on the worktree's own deployment after the seed; the reset clears it. Related: [[checklist-fixture-blank-team-cell-still-asks-bsc]], [[seller-specs-race-background-drains]].
