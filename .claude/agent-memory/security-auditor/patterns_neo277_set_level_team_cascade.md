---
name: neo277-set-level-team-cascade
description: NEO-277 selectorOptions.teamIds + scheduled chunked cascade — the audit shape for any "preview query + mutation + internal self-rescheduling walker" trio; the durable trap is the preview missing the mutation's scope guard
metadata:
  type: project
---

NEO-277 shipped a trio that will recur: a public PREVIEW query (counts what a
write would touch), a public MUTATION that patches one row and schedules an
INTERNAL self-rescheduling walker over the subtree, carrying "previous value"
and walk state (`nodeIds`/`nodeIndex`/`cursor`) as internal args only.

What held on audit: both public fns `requireAdmin` and registered in
`publicFunctionAuth.test.ts`; ids go through `resolveTeamOnCardIdsForWrite`
(dedupe, `MAX_CARD_TEAMS`, existence, same-sport); no client timestamp or
suppression flag (`teamNoneConfirmedAt`, `teamCheckDoneAt`) is written; the
walker's cursor is strictly monotone (`.gt("_creationTime", after)` +
`nodeIndex` advance), so it terminates; no adapter reads the field.

**Durable traps to re-check on the next such trio:**
- The preview query lacked the mutation's LEVEL guard, so it could be aimed at
  a sport/year/brand root and walk every descendant node (one `db.get` each,
  unbounded by the 2000-card cap) — an admin-only read-budget lever and an
  inconsistent promise (counts for an edit the mutation refuses). Rule: a
  preview must carry every scope guard its mutation carries, before any walk.
- Preview truncates `teamIds` to the cap silently; mutation throws over the
  cap. Same input, different verdict — pin parity in a test.
- `collectDescendantIds` comments still cite a "4096-read limit"; treat the
  bound as "the walk is unbounded by design, the level guard is the bound".

**How to apply:** for any new preview/mutation/walker trio, diff the guard
lists of the preview and the mutation line by line, then trace the walker's
resume args to confirm only the mutation and the walker itself pass them.
