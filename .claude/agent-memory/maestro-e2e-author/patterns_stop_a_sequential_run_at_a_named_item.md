---
name: stop-a-sequential-run-at-a-named-item
description: A client-side sequential run (NEO-312 ParallelBuildPanel) can FINISH before the flow's previous assert returns — assert its finished heading, never the running heading or its Stop button; exclude the sr-only live line by its trailing "."
metadata:
  type: feedback
---

Assert the TERMINAL state of an auto-started sequential run, never a transient
one (the "Building … k of M" heading, a "Stop after this one" button that exists
only while live).

**Why:** NEO-312's first flow draft centred on `Building parallels of Anime — k
of M` and pressed Stop mid-run. On CI (PR #291) four parallel builds — a
Convex action + one BSC call each, no team lookup, no wizard — finished in ~3s,
DURING the `Confirm & Save` tap's own post-tap wait, so the running heading was
already gone when the next command started. The DOWN scroll then drove the page
to maximum scroll, past the panel (the failure screenshot showed the bottom of
the card list). The coordinator ruled: assert the finished heading, drop Stop
from the flow (it is unit-tested). "Can I see it while it runs?" is a timing
bet the flow will lose whenever the product is fast — a transient UI state is
unit-test territory.

**How to apply:**
- Anchor the scroll on a pattern that matches EITHER heading
  (`Building parallels of X — k of M|X parallels — [^.]+`), centre it at 7000,
  then `extendedWaitUntil` the finished form under the live-round-trip budget.
- The panel's `sr-only role="status"` line repeats the finished heading WITH a
  trailing "." — a pattern that cannot end in "." (`[^.]+`, or an explicit
  clause list) resolves only to the visible `<h3>`.
- If a flow truly must press a live-only control, gate on the target item
  leaving its idle state (`<item> — (?!Waiting$).+`), not on it finishing —
  the control unmounts with the run.
Related: [[moving-target-tap-and-hierarchy-forensics]].
