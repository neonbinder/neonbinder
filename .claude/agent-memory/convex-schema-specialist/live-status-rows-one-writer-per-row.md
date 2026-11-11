---
name: live-status-rows-one-writer-per-row
description: A UI-subscribed "in progress / waiting" status fed from an action's hot loop — one row per writer (per action invocation), point-patched by _id, keyed by an operation key; never a shared counter row
metadata:
  type: feedback
---

When an action's inner loop must publish a live status the UI subscribes to
(PR 451's "Waiting on BuySportsCards…"), design the rows so writers never
share a document:

- **One row per writer** (one per action invocation / recorder), inserted on
  the first edge, then patched by `_id` (no index read, so no range in the
  writer's read set). Writers under one key never conflict; the reader sums.
- **Never a shared inc/dec counter.** Besides OCC on one doc, a counter
  leaks when an action dies between inc and dec, and the reader cannot tell
  a dead count from a live one. Set/clear a `waitingSince` instead.
- **Key by the operation, not the catalog row**: a client-minted run key
  (like `checklistCandidates.batchId`) isolates a dead run's leftovers from
  the next run on the same set, and holding no `v.id("selectorOptions")`
  keeps the table out of the wipe graph, reset steps and reference-seed pins
  ([[transient-side-table-checklist]], [[schema-pins-text-scan-vs-export-walk]]).
- **Expiry at insert**: schedule the row's delete in the inserting mutation
  (no sweep index, covers dead actions). The client shows the status only
  while its own action call is pending.
- **Debounce the idle edge** (close after a short grace or at flush), or a
  Promise.all-in-chunks loop writes twice per chunk instead of per wave.
- If an existing per-run row is already written per step (listing runs'
  `progress.steps`), add `startedAt` to that write instead of a new table.

**Why:** the planner's first sketch was a per-(owner, subject) counter row;
the analysis above is what replaced it.
**How to apply:** any "show progress from inside an action" schema request.
Related: [[convex-occ-read-set-is-the-third-budget]].
