---
name: set-subtree-shape-is-not-fixed
description: Real synced sets do not follow the six-level sport→year→manufacturer→setName→variantType→insert→parallel shape below setName; plan every subtree walk generically and size for hundreds of leaves
metadata:
  type: project
---

Below a `setName` row the level of a child is not predictable: a `variantType`
node can have INSERT-level children and an insert can have PARALLEL children
(observed 2026-09-14 on a synced 2026 baseball set: 289 leaf nodes of mixed
levels under one setName, low thousands of cards).

**Why:** the code comments describe a tidy six-level hierarchy, and a plan that
walks "variantType → insert → parallel" by level name, or budgets a preview for
"a few dozen leaves", lands twice. `collectDescendantIds` (children-pointer
walk) is the right primitive; per-level assumptions are the smell.

**How to apply:** any plan that touches "every card under a set" must (a)
recurse the children graph rather than enumerate levels, (b) size reads for
~300 leaves and 10k+ cards (parallel-heavy sets), and (c) use the
action → budgeted internal query pages → chunked internal mutation shape that
`cascadeSelectorOptionTeams` already uses, never one query/mutation per set.
