---
name: stop-a-sequential-run-at-a-named-item
description: Driving a "Stop after this one" run (NEO-312 ParallelBuildPanel) — gate on the target line LEAVING "Waiting", then tap Stop; waiting for "Built" first loses the button when the target is last. Plus the sr-only live line that duplicates line text.
metadata:
  type: feedback
---

A sequential client-side run that builds items one at a time and offers
**Stop after this one** (rendered only while the run is live) needs this order
when the flow must prove one named item AND the stop:

1. Gate on the named item's line leaving its idle state:
   `text: "<item> — (?!Waiting$).+"` (lookahead works: maestro full-match is
   Java `Matcher.matches()`).
2. Tap Stop, then assert the in-app acknowledgement at 7000
   (`Stopping after this one…|<stopped heading>`).
3. Gate on the line leaving `Building…` (`(?!Waiting$|Building…$).+`) at the
   marketplace ceiling, THEN hard-`assertVisible` the success form. Blocked or
   Failed then fails at once with the reason on screen, not after 120s.
4. Assert the stopped heading (it can take ONE more item's build).

**Why:** the build order is data-dependent (for NEO-312 it is the insert's
`children` order, set by a grouping save the flow does not control). Waiting
for "<item> — Built" before tapping Stop fails outright when the item is last,
because Stop unmounts with the run. Pressed while the item is in flight, Stop
means "after this one" in any order; the one remaining race (item last AND its
build lands inside the ~2s gate-to-tap gap) fails with a named signature.

**How to apply:** also expect a `sr-only role="status"` node repeating the
heading or a FINISHED line — maestro sees it (1×1 bounds, in the viewport), so
a text regex may resolve to it. Harmless for asserts; never tap by such text.
Related: [[moving-target-tap-and-hierarchy-forensics]].
