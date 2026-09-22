---
name: sync-summary-is-not-a-ui-surface
description: A selector sync's `Synced … (summary)` return message is NEVER rendered — `ensureSelectorOptions` writes a `done` status row only for paused/failed/skipped/unlinked notices and a clean sync deletes the row; so a count fragment in the summary is not an E2E target until it is composed into the done row's `message`
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
surface — ask the backend builder to carry the count on the done row (its own
sentence, only when > 0, so the paused/skipped full-match texts stay exact),
and write the flow against `SyncDoneNotice`'s `<p>` (full-match regex over
the whole message, e.g. `.*[1-9][0-9]* sets? added from SportLots.*`).

**How to prove the gap cheaply:** run the flow against a backend WITHOUT the
notice and read the failure hierarchy — the Sets column idle with `Sync Sets`
and no `role=status` box above it (NEO-237 E3, 2026-09-21, local run against
the PR preview: red by name at the notice step in 1m, the R2 property).

Related: [[neo237-all-brands-view-and-unknown]].
