---
name: sync-summary-is-not-a-ui-surface
description: A selector sync's `Synced … (summary)` return message is NEVER rendered — `ensureSelectorOptions` writes a `done` status row only for paused/failed/skipped/unlinked notices and a clean sync deletes the row. And the one count that WAS composed in (`slCreated`) was removed on 2026-09-22 by product decision, so do not ask for a count sentence to make a flow assertable: ask for an affordance, or prove it structurally
metadata:
  type: reference
---

# The sync summary string is a return value, not a screen

`syncSetsAcrossManufacturers` (and `fetchAggregatedOptions`) return
`{ success, message: "Synced sets (312 sets, 74 sets added from SportLots)" … }`.
`ensureSelectorOptions` reads `res.message` ONLY on failure (console.error);
on success it composes the column's notice from `pausedSides`,
`failedPlatforms`, notifiable `skippedSides` and `unlinkedTotal`, and writes
`status: "done"` only when one of those is non-empty — otherwise the status
row is deleted and `EntityColumn` renders the bare idle action row
(`selectorOptions.ts` around the `hasNotice` block; `EntityColumn.tsx`
"a clean sync still deletes its status row").

**So:** when a plan says "the summary fragment will read X", check whether X
ever reaches a `setSelectorSyncStatus` write. If not, the assertion has no
surface. **Do not ask for it to be given one as a count sentence** — see the
third example below; that request was granted once and reversed a day later.
Ask instead for an AFFORDANCE the operator would want anyway, or prove the
behaviour structurally.

**How to prove the gap cheaply:** run the flow against a backend WITHOUT the
notice and read the failure hierarchy — the Sets column idle with `Sync Sets`
and no `role=status` box above it (NEO-237 E3, 2026-09-21, local run against
the PR preview: red by name at the notice step in 1m, the R2 property).

Related: [[neo237-all-brands-view-and-unknown]].

**Second worked example, NEO-294 (2026-09-22).** The known-brands split added
`N brands added from the known list` / `N sets filed under a known brand` to the
same `summary` array. Neither reaches a `setSelectorSyncStatus` write — the
action's return object carries `slCreated` and nothing else new — so both are
unassertable. The flow proves the filing STRUCTURALLY instead (the view's
back-fill card `Manufacturers: <brand> — change` plus the panel breadcrumb),
which does not depend on a count at all. Check the RETURN OBJECT, not just the
summary: a fragment is only a target once `ensureSelectorOptions` has a field to
compose it from. See [[neo294-known-brands-and-move-control]].

**Third worked example, and the reversal (2026-09-22).** NEO-237 DID get the
count carried on the done row — `ensureSelectorOptions` composed
`N sets added from SportLots.` from `res.slCreated`, and
`brand-via-all-brands-narrows-sportlots` STEP 2 asserted
`.*[1-9][0-9]* sets? added from SportLots.*` as its sole proof of the save.
Jason removed it the next day: *"We don't do it for other marketplaces we
shouldn't do it here."* A count sentence that exists only because a test
needed a handle is a notice the product does not want — it announces one
marketplace's housekeeping and nothing else's.

What the flow does now, and the shape to reuse: assert the side was ASKED,
not what it added. `syncSetsAcrossManufacturers` puts `"sportlots"` into
`skippedSides` only when NOT ONE brand of the year passes the ATTACH gate, so
`SportLots skipped: no SportLots ids on this path.` is present exactly when
the side was never asked — absent live, present under the pause, which is a
real R2 pair on one sentence (the idiom `setup.yaml` already runs on the
paused sentence). Order the steps so the negative is not vacuous: scroll to
the idle `Sync <X>` button FIRST, because `SyncDoneNotice` shares its slot
directly above it.

And note what stayed unprovable: no flow can now show that a set was saved
from SportLots, because nothing on screen separates an SL-minted set row from
a BSC-filed one (a set row is not terminal → no `SL` pill; the id is on the
Base, reachable only by picking the set BY NAME; and a minted row's name is a
marketplace label). The ask to file when this comes up again is an affordance:
a set row that carries its marketplace coverage, plus a way to REACH such a
row that does not need its name (the `leadRow` / pinned-entry machinery
NEO-237 already built). Recorded in `SET-REGISTRY.md` → "Hockey → 1997".
