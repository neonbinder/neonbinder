---
name: ancestor-chain-read-collides-with-children-patch
description: A per-card write that reads its selector ancestors up to the sport row puts the sport row in its OCC read set, and every selector-row insert patches the parent's `children`; across parallel set builds that is a sport-wide reader-vs-writer invalidation. Stop the chain read at the set row once the levels above are flagged.
metadata:
  type: project
---

`CardCountLedger.flush` (`convex/cardCounts.ts`) reads every ancestor of a
card's row (`chainOf` → `ctx.db.get`) on every card insert, delete, move or
re-parent, so the brand, year and sport rows sit in the read set of every
commit chunk. Separately, every path that creates a selector row patches the
parent's `children` array (`selectorOptions.ts`, several sites). A patch to
the sport row's `children` therefore rolls back every in-flight card write in
that sport, however unrelated the set.

NEO-358 (2026-10-24) introduced the chain read AND patched the top three rows
per card write (writer-vs-writer); NEO-364 made the top-level flag write-once
but kept the read, so the collision became reader-vs-writer and the loser is
always the card commit. Found reviewing the 2026-10 E2E instability
(2026-11-01); not measured, argued from the read set.

**How to apply:** when a hot write path needs a fact about a row far up the
tree (a "has anything beneath" flag, a sport id), cache the fact on the
nearest row the write already touches (the set row) and read above it only
while that cache is absent. Audit any `get` of a root-level row inside a
mutation that runs many-wide: ask who patches that row (`children`, counts,
sync status) and how often. Related: [[convex-occ-read-set-is-the-third-budget]],
[[per-card-derived-state-hook-points]].
