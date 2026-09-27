---
name: base-role-and-row-are-one-thing
description: isBase never moves without its row — no clear, no transfer; a set loses its base only by deleting the empty Base row (Jason, NEO-306, 2026-09-27)
metadata:
  type: project
---

`metadata.isBase` and the Base variant-type row are one thing. `setBaseVariantType`
only grants the role, only to a set with no base (ConvexError refusal otherwise);
the old `clear: true` and the sibling-clearing transfer are gone. Taking the role
away = deleting the row through the ordinary empty-row delete (the panel's trash
icon, with a base-aware confirm), which refuses while cards hang off it.

**Why:** clearing the flag left a non-terminal row; the cascade opened an Inserts
column under it and the drill auto-synced SportLots, whose `insert` answer is the
brand's whole flat set list. Those junk rows' SL ids counted as "covered" and hid
real sets from Sync Sets and the SL review.

**How to apply:** treat any NB role that decides a row's structural behaviour
(terminal-ness, what its children are) the same way: never offer a UI that flips
it off while the row stays. If a plan says "clear the flag", ask whether it
should be "delete the row". `ensureSelectorOptions` also refuses a SportLots-only
drill sync at `insert` under a role-less variant type (backstop). Legacy
anomalies are counted by `backfillVariantTypeRole:reportBaseAnomalies`, never
auto-fixed. See [[marketplace-data-is-linkage-only]].
