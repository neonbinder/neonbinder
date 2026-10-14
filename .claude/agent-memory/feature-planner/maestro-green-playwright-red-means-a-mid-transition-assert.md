---
name: maestro-green-playwright-red-means-a-mid-transition-assert
description: A spec that is red in Playwright but whose Maestro flow passed usually means Maestro asserted mid-transition (race) and PW's helper waits for the settle; look for a product status row that a later write overwrites, not for a spec bug
metadata:
  type: feedback
---

When a Playwright spec is consistently red while its Maestro flow was green on
the same steps, assume the Maestro flow passed by a race, not that the port is
wrong. PW drill helpers wait for the column's sync to finish ("Syncing X"
hidden) before returning; Maestro's `scrollUntilVisible` polled from the first
paint, so it could see a transient state.

**Why:** NEO-341's `brand-via-all-brands-narrows-sportlots`: the create-brand
door writes a `done` selectorSyncStatus row ("N sets moved out of Unknown") on
the brand's Sets column; the brand's first open then runs a sets sync whose
`syncing`/final writes patch the SAME (level, parentId) row and lose the notice.
Maestro read the row before the sync's first write. PW read it after.

**How to apply:** treat the PW assert as the product truth and fix the
product (carry the earlier notice into the sync summary, or make the write
additive); never add a wait or weaken the spec. Also: `selectorSyncStatus` is
one row per (level, parentId) and every writer patches/deletes it, so any
"done" notice written outside a sync is lost on the next sync of that column.
