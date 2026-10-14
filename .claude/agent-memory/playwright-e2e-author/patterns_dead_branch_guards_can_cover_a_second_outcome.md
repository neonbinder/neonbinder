---
name: dead-branch-guards-can-cover-a-second-outcome
description: Before deleting a branch whose PREMISE is dead, list every outcome its guard admits — a fallback gated on "next column absent" also caught the select-existing outcome of a create; keep the guard, drop the body
metadata:
  type: feedback
---

When a branch in a helper or spec becomes unreachable on its stated premise ("no
search box"), its guard may still be doing a second job. In the old custom-drill
helper's Level 4 the short-list fallback was gated on "Variant Types column
absent" and the search branch on "search box visible". Together they also
handled the create submit SELECTING an existing row (the typed name already
exists but sits clipped in a long list): the box vanished with the collapse, the
search branch skipped, and the other guard skipped the fallback. Making the
search pick unconditional would have re-picked a selected row.

**Why:** stripping on the premise alone silently drops coverage of an outcome
nobody wrote down; it shows up later as a re-pick/toggle or a hard fail on a box
that collapsed.

**How to apply:** for each branch you remove, enumerate the app states that
reach that point (every outcome of the step before it: create vs select-existing
vs confirm-exists), and check which branch each one took before. Keep a cheap
guard that preserves those, and put the hard result assertion after the block
(R2). Related: [[search-box-is-not-a-content-signal]].
