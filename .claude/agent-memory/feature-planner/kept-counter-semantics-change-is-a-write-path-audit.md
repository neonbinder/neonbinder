---
name: kept-counter-semantics-change-is-a-write-path-audit
description: Changing WHAT a stored counter counts (collection tally, container counts, building-set cards) is an audit of every write path plus the recount, the derived counts and a backfill, never a read-side filter
metadata:
  type: feedback
---

When a plan changes what a kept counter means (e.g. the Main `tally` going
from "everything the owner holds" to "everything not in a box"), plan it as
a write-path audit: every mutation that moves the counter (add, move, split,
fold, update quantity, remove, restore, container empty/delete), the bounded
recount that fills an absent counter, every count DERIVED from it (Main's
count = tally minus the others), and a backfill (armed internal migration,
dry-run first) for rows counted under the old meaning. Filtering on read is
the smell: the counter is read in one place and written in ten.

**Why:** NEO-364 planning (2026-10-25): the collection's tally, container
counts and building-set `cards` are all kept in place by `moveTally` /
`moveCounts` / `moveBuildingCards` and never counted on read (Jason:
dealers hold tens of thousands of cards). A distinct-cards number cannot be
derived by subtraction (a card can sit in a box and a binder), so the only
honest fix was to change the semantics everywhere the counter moves.

**How to apply:** any ticket that says "N should no longer count X": list
the write paths by grepping the move helper, decide the counter's new
meaning once, derive each write's delta from the same change list the
container counts use, and add a reconcile test (stored == hand count after
every op). Flag the derived counts and the backfill in the plan.
