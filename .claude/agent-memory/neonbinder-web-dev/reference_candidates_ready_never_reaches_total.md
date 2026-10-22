---
name: reference-candidates-ready-never-reaches-total
description: getReadyCandidates `ready === total` is NOT a valid "fetch finished" gate — rows that arrived with teams parsed stay pending forever; gate on batch id moved + total === candidateCount
metadata:
  type: reference
---

`checklistCandidates.getReadyCandidates` counts `ready` as rows with `status === "ready"`. `startCandidateBatch` writes EVERY row `pending` when ANY card needs a BSC team lookup, and the lookup loop flips only the rows it looked up — so on a set where some cards arrived with teams already parsed, `ready` never reaches `total`. A waiter keyed on `ready === total` hangs (NEO-339 brief asked for exactly that).

The correct gate is the UI's `awaitStreamedBatch`: the batch id MOVED from the value read before the fetch, and `total === cards.length === candidateCount` from the action's return. `fetchCardChecklist` awaits every team-lookup chunk before it returns, so teams are on the rows by then; the only async tail is NEO-294's single 1 s retry for >700-card batches. If you want teams too, wait briefly on "every card with a BSC ref and no teams is `teamResolved`" and treat a timeout as fine (the dialog never gates Confirm on teams).

**How to apply:** any script/tool/test that drives a checklist fetch outside `CardChecklist` (tools/setbuild/lib/fetch-checklist.ts does it this way).
