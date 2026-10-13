---
name: diff-optional-branches-green-vs-red
description: When a live-fixture spec goes red after a merge, diff which conditional branches (`if (await x.isVisible())`, optional skips) ran in the green vs the red run; a branch that ran only in the red run proves the fixture's DATA changed, before any product theory
metadata:
  type: feedback
---

Download the last green run's artifacts (traces, step logs) and compare them with
the red run's for the spec's conditional branches: the `if (await ...isVisible())`
arms, the optional skip taps, and the accessible name of whatever each one clicked.
A branch that ran only in the red run is the fixture changing shape under the spec.
For example, NEO-335 after NEO-333 merged: the `Skip <club> (not a team)` arm ran
in the red run and not in the green one, because the fetch now waited for BSC team
lookups, so the cards arrived listing a team.

**Why:** walk helpers absorb new wizard steps silently (that is their job), so the
red shows up many steps later, on a re-sync, as a product symptom. The branch diff
names the cause in one grep. The red step's screenshot shows only the consequence.

**How to apply:** on any red step in a spec that reads live marketplace data, run
this diff before reading product code. Also read the failure screenshot's banner
text in full. A `Saved N cards.` assertion written as a prefix match also accepts a
`... names were not reviewed` tail, so an earlier green can hide the same damage.
Related: [[measure-a-fixture-from-ci-artifacts]].
