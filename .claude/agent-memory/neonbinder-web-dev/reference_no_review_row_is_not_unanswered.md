---
name: reference-no-review-row-is-not-unanswered
description: A name with no entityReviewQueue row may be a STORED skip (the gate drops skipped names before queuing) — any "no row ⇒ resolved / unreviewed" rule, client or commit prelude, must also consult the set's entityReviewSkips
metadata:
  type: reference
---

`resolveUnknownsAndStartBatch` drops a name the set's `entityReviewSkips` rule out BEFORE it queues anything, so on a re-sync a skipped name has no review row at all. Two rules read "no row" wrongly until NEO-335 fixed them:

- client (`teams-on-cards.ts`): "no row ⇒ resolved before the wizard opened" made a skipped team string look like a team, so the teams step never opened. Now `StoredPeople.skippedTeamNames` (from `api.entityReviewSkips.listForSet`) says otherwise; a row in this sitting still outranks the record.
- server (commit prelude): "no decision ⇒ unreviewed" stamped skipped names as `pending*Names` and counted them "not reviewed". Now `isStoredSkip` (one lazy indexed read per prelude call) treats them as skips and reports them in `skipped*Names` so the chunk retires old stamps.

**How to apply:** any new logic that branches on "this name has no review row / no decision" — ask whether a stored skip can be the reason, for BOTH kinds. Stored rows' `pending*Names` can also hold skipped names stamped before the fix; filter them (`pendingBeyondSkips` in CardChecklist). Related: [[reference-review-batch-rows-the-batch-stages-itself]].
