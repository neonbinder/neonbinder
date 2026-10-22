---
name: wizard-implicit-pin-yields-to-a-ready-league
description: An untouched ORDINARY player step in the entity-review wizard is swapped for any presentable team/league the moment one appears (a same-name pick step is exempt since NEO-339); staged career teams settle in seconds, not after the FIFO, and stage READY leagues
metadata:
  type: reference
---

The entity-review wizard presents a player under an IMPLICIT pin. `resolveNav`
yields it to any presentable team or league (`hasSettledUndecidedTeam`, which
counts leagues) unless the wizard passes its hold flag: `pinnedRowHasEdits`
(work on the row) OR, since NEO-339, `pickStep` — a same-name "Which <name>
is this?" step holds its place touched or not (`holdPresentedRow`), see
[[same-name-player-panel]]. Explicit pins (Back, Change decision, Decide
team, and "Back to the list" from a pick step's New Player step) do not yield until the row is decided. Neither the hold nor an edit
stops the DEPENDENCY moves: a row waiting on its own staged teams or league
still moves the walk to them.

A flow that sits on a player step while a big batch streams lookups can
therefore have the step swapped out from under it. Do not lean on "teams
settle after every player lookup (FIFO)": a STAGED career team (raised by a
player's lookup landing) gets its own lookup within seconds, and its P118
league is inserted `ready` (presentable at once, NEO-254/NEO-307). Measured on
a 255-row NPB batch: a staged team settled and its league took the front ~17s
after the wizard opened.

**How to apply:** for an ordinary player step that must hold while lookups
run, put the row under an operator action (an edit, or an explicit
navigation) before asserting across a long window, and treat any assert made
on an untouched implicit player step as racing the batch. A pick step needs
neither; the opposite risk applies to it (it blocks a team drain until
answered). The tell in a failure PNG is a
`New League:` / `New Team:` heading with "Needed by: <club>" while the
counter's decided number has not moved. Pull `convex-logs-*` and grep the
club's `enrichment_fixture` line for the time it settled.

Related: [[wizard-decided-list-and-batch-resume]], [[wizard-fixture-lookup-throughput]].
