---
name: late-lookup-reopens-a-bulk-skipped-review
description: "Skip remaining names" is not terminal while lookups are queued — a player's Wikidata lookup landing AFTER the skip stages a fresh undecided "New Team: X / Needed by: <skipped player>" step, so "Confirm & Save" never renders (found NEO-330, 2026-10-12)
metadata:
  type: reference
---

**Signature.** Failure PNG shows `N-1 of N reviewed · K still being looked up`,
a `New Team: <club>` step with `Needed by: <a name the bulk skip just decided>`,
and the footer offering `Skip remaining names (1)` again. The wait on
`.*Confirm & Save.*` runs out its whole window.

**Mechanism (product, not flow; fixed in NEO-330 W10).** The player was still
UNDECIDED when its lookup landed: `applyLookupResult` already drops decided rows.
The hole was the bulk skip's query-then-mutation paging (NEO-301):
`listBulkCandidates` picks a page's ids, the late lookup stages a team row after
the cursor, and `decideRowsByIds` decides only the ids it was handed. On the
LAST page nothing re-read, so the staged step stayed open and `allDecided` went
false. The fix: `runBulkDecidePage` re-checks after a skip's last page and keeps
draining; staging also refuses under a `skip` decision as a backstop. Whether it
bit depended on the shared 5-wide pool's timing.

**Proving it from artifacts.** convex-logs: the `enrichment_fixture` line for the
player (logged at lookup START) is later than the skip tap's start in
maestro.log, and the staged club's own `kind:"team"` lookup line follows ~2s on.

**How to apply.** Do not "fix" with a re-tap loop on `Skip remaining names` —
that hides the product bug. Report it; this one was a paging gap in the bulk skip. Related: [[wizard-fixture-lookup-throughput]],
[[wizard-decisions-read-from-header-and-summary]].
