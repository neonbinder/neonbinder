---
name: dead-branch-guards-can-cover-a-second-outcome
description: Before deleting a branch whose PREMISE is dead, list every outcome its guard admits — a fallback gated on "next column absent" also caught the select-existing outcome of a create; keep the guard, drop the body
metadata:
  type: feedback
---

When a flow branch becomes unreachable on its stated premise ("no search box"),
its `when:` guard may still be doing a second job. In `util-drill-to-custom`
Level 4 the short-list fallback was gated `notVisible: "Variant Types"` and the
search branch `visible: ".*Search sets.*"`. Together they also handled the
create submit SELECTING an existing row (`onSelectExisting` when the typed name
already exists but sits clipped in a long list): the box vanished with the
collapse, the search branch skipped, and the VT guard skipped the fallback.
Making the search pick unconditional would have re-picked a selected row.

**Why:** stripping on the premise alone silently drops coverage of an outcome
nobody wrote down; it shows up later as a re-pick/toggle or a hard fail on a
box that collapsed.

**How to apply:** for each branch you remove, enumerate the app states that
reach that point (every outcome of the step before it — create vs
select-existing vs confirm-exists), and check which branch each one took
before. Keep a cheap guard that preserves those (a `notVisible` on an element
that is normally ABSENT answers at once; R10 only bites when it is normally
present), and put the hard result gate after the block. Related:
[[patterns_util_drill_to_custom]], [[search-box-is-not-a-content-signal]].
