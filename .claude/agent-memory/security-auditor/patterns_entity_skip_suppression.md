---
name: entity-skip-suppression
description: entityReviewSkips started as a write-only suppression list; NEO-212 added listForSet/clearSkip + a Skipped-names panel after audit — check any new "remember this rejection" table for an undo path before it ships
metadata:
  type: project
---

`entityReviewSkips` (NEO-212, `convex/schema.ts`) is a durable per-set
suppression list: a name ruled "not a person / not a team" in the entity review
wizard never re-enters that set's wizard again. It is written only from
`commitCardChecklistPrelude` (internalMutation, re-runs `requireAdmin`) and read
only from `selectorOptions.findSkippedEntityNames` (internalQuery). No public
surface reads or deletes it.

**Why:** the gap that matters is not access control — that part is tight — it is
**reversibility**. `entityReviewQueue.recordAllRemainingAsSkip` turns a whole
batch into skips in one click, and there is no mutation, admin page, or query
that can list or clear a skip afterwards. `skippedByUserId` is stored as an
audit field that nothing can read back. A mis-skip of a real player is
permanent for that set and invisible.

**How to apply:** whenever a branch adds a table that *remembers a human
rejection* and feeds it back into a resolution/dedup path, audit three things
beyond the auth gate:
1. Is there an un-do (delete/clear) mutation, admin-gated?
2. Is there a read surface so the stored audit field (`*ByUserId`, timestamps)
   can actually be inspected?
3. Is there a bulk writer? Bulk + no-undo is the combination that turns a Low
   into a Medium.

Related: [[checklist-commit-trust-boundary]], [[attention-flag-suppression]] —
same family of "a stored review decision silently suppresses later work".


**Resolution (NEO-212, same branch):** the audit finding was accepted and
fixed in-branch — `convex/entityReviewSkips.ts` (`listForSet`, `clearSkip`,
admin-gated, `skippedByUserId` withheld, `batchId` recorded for scoped undo)
and `components/SetSelector/SkippedNamesPanel.tsx` (Unskip). The pattern to
reuse is the check itself: any durable "never ask again" row needs a reader and
an undo before it merges.
