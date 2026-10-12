---
name: sync-summary-is-not-a-ui-surface
description: A selector sync's `Synced … (summary)` return message is NEVER rendered — `ensureSelectorOptions` writes a `done` status row only for paused/failed/skipped/unlinked notices and a clean sync deletes the row. Do not ask for a count sentence to make a spec assertable: ask for an affordance, or prove it structurally
metadata:
  type: reference
---

# The sync summary string is a return value, not a screen

`syncSetsAcrossManufacturers` (and `fetchAggregatedOptions`) return
`{ success, message: "Synced sets (312 sets, 74 sets added from SportLots)" … }`.
`ensureSelectorOptions` reads `res.message` ONLY on failure (console.error); on
success it composes the column's notice from `pausedSides`, `failedPlatforms`,
notifiable `skippedSides` and `unlinkedTotal`, and writes `status: "done"` only
when one of those is non-empty; otherwise the status row is deleted and
`EntityColumn` renders the bare idle action row (`selectorOptions.ts` around the
`hasNotice` block).

**So:** when a plan says "the summary fragment will read X", check whether X ever
reaches a `setSelectorSyncStatus` write. If not, the assertion has no surface.
**Do not ask for it to be given one as a count sentence.** Ask instead for an
AFFORDANCE the operator would want anyway, or prove the behaviour structurally.

**How to prove the gap cheaply:** run the spec against a backend WITHOUT the
notice and read `error-context.md`: the Sets column idle with `Sync Sets` and no
status region above it (NEO-237, 2026-09-21: red by name at the notice step in
1 minute, the R2 property).

**Worked examples.**
- NEO-294 (2026-09-22): the known-brands split added `N brands added from the
  known list` fragments to the summary array; neither reaches a status write, so
  both are unassertable. The spec proves the filing STRUCTURALLY (the view's
  back-fill card plus the panel breadcrumb). Check the RETURN OBJECT, not just the
  summary: a fragment is only a target once `ensureSelectorOptions` has a field to
  compose it from.
- NEO-237: the count `N sets added from SportLots.` WAS carried on the done row
  and asserted as the sole proof of a save. Jason removed it the next day: *"We
  don't do it for other marketplaces we shouldn't do it here."* A count sentence
  that exists only because a test needed a handle is a notice the product does not
  want.

What the spec does now, and the shape to reuse: assert the side was ASKED, not
what it added. `syncSetsAcrossManufacturers` puts `"sportlots"` into
`skippedSides` only when NOT ONE brand of the year passes the ATTACH gate, so
`SportLots skipped: no SportLots ids on this path.` is present exactly when the
side was never asked: absent live, present under the pause, a real R2 pair on one
sentence. Scroll to the idle `Sync <X>` button FIRST, because `SyncDoneNotice`
shares its slot directly above it, so the negative is not vacuous.

What stays unprovable: that a set was saved from SportLots, because nothing on
screen separates an SL-minted set row from a BSC-filed one. The ask to file when
this comes up again is an affordance: a set row that carries its marketplace
coverage, plus a way to REACH such a row that does not need its name. Recorded in
`SET-REGISTRY.md`. Related: NEO-294 (no longer
kept as a memory; see SET-REGISTRY.md and GUIDE).
