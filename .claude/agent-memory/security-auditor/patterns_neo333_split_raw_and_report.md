---
name: patterns-neo333-split-raw-and-report
description: NEO-333 marketplace name splitting + read-only stored-data report — what to check when an adapter starts carrying a raw marketplace value beside its split, and the shape of a safe CLI-only scan report
metadata:
  type: project
---

When an adapter splits a marketplace free-text value and ALSO carries the raw,
unsplit string onward (whole-name-first resolution), the split is bounded by
`boundParsedNames` but the raw string is not. Check every consumer bounds the
raw value before it is stored or used as a lookup key (NEO-333: both resolvers
length-check before `resolveTeamForSetYear`, the stored hint is sliced to 120).
The raw value still crosses an internal action -> mutation arg boundary
unbounded; harmless while internal, a finding the moment it reaches a public
validator.

Read-only scan report shape that audits clean: `internalQuery` doing ONE
`.paginate()` per call (a query cannot write, so read-only is structural, not
a promise), an `internalAction` driver with a wall-clock budget and a
`resume` cursor, ids and counts only in return/log. Traps to check on the next
one: the budget arg has no upper cap (above the 10-min action timeout the run
dies and returns nothing), and an uncaught `runQuery` error throws away every
accumulated hit — wrap the page call and return partial + resume.

Batch-scoped caches (sport/year read once per call) are only safe when the
batch is pinned to one parent row at insert; verify the insert site, not the
comment. Related: [[patterns-name-bounds-three-tiers]], [[patterns-neo251-sl-player-derivation]].
