---
name: diff-optional-branches-green-vs-red
description: When a live-fixture flow goes red after a merge, diff which optional `runFlow when`/`optional` branches ran in the green vs red maestro.log — a branch that flips from SKIPPED to COMPLETED proves the fixture's DATA changed, before any product theory
metadata:
  type: feedback
---

Download the last green run's artifacts (`gh run download <id> -n maestro-report-runner-N …`)
and grep both maestro.logs for the flow's optional branches
(`Run flow when … COMPLETED|SKIPPED`, `Tap on (Optional)`, the tapped element's
`resource-id`). A branch that ran only in the red run is the fixture changing
shape under the flow. For example, NEO-335 after NEO-333 merged: `Skip Roanoke Express — not a team`
ran in the red run and not in the green one, because the fetch now waited for BSC
team lookups, so the cards arrived listing a team.

**Why:** walk utils absorb new wizard steps silently (that is their job), so the
red shows up many steps later, on a re-sync, as a product symptom. The branch
diff names the cause in one grep. The red step's screenshot shows only the
consequence.

**How to apply:** on any red step in a flow that reads live marketplace data,
run this diff before reading product code. Also read the failure screenshot's
banner text in full. `Saved N cards.` assertions written as `.*Saved N cards.*`
also accept a `… names were not reviewed` tail, so an earlier green can hide the
same damage. Related: [[measure-a-fixture-from-ci-artifacts]],
[[present-in-failure-dump-means-late-arrival]].
