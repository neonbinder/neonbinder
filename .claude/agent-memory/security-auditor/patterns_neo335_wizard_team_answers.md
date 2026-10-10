---
name: patterns-neo335-wizard-team-answers
description: NEO-335 pre-save team answers on commitCardChecklist (teamIds/teamNone/teamLookup) — what held, and the two traps (fill path skips applyFields so it can retire an operator ruling; string answers on existing rows need applyFields and silently drop)
metadata:
  type: project
---

NEO-335 moved "fill teams" into the entity-review wizard. Preview cards gained
three client-supplied fields read by `commitCardChecklist`:
`teamIds` (NB ids), `teamNone: true`, `teamLookup: "answered"|"failed"`.

What held at audit (2026-10-10), and what to re-check if it changes:
- `teamIds` re-read in an internalQuery before any phase writes; sport walked
  from the row, never the client `sportId`; foreign sport refuses the commit,
  deleted ids are dropped; per-card count capped in `assertCardBatchWithinLimits`.
- `teamNone` stamps `teamNoneConfirmedByUserId` from `requireAdmin`'s return,
  passed into the internal chunk; teams win; never over an existing confirmation.
- `teamLookup` is a status of OUR call, not a marketplace value. Forging
  "answered" only stamps `teamCheckDoneAt`, which SURFACES missingTeam rather
  than hiding it; `bscTeamName` hint is capped and rendered as React text.

Traps:
- The update branch's operator fill bypasses `applyFields`/`baseVersion`
  ("fill only an empty row"), and retires an existing `teamNoneConfirmedAt`.
  The client excludes ruled rows from the section via a live query, so this only
  bites in the in-flight window or with a forged client. Asymmetric with
  `teamNone`, which never overrides a confirmation. See [[patterns-neo102-card-team-none]].
- Team answers carried as STRINGS (`teams`) go through `card.teamOnCardIds`,
  which on an existing row is written only via `applyFields`, so they do
  nothing on a re-synced teamless row. Only `teamIds` fill.
- Doc comments of the form "nothing in path X ever SETS flag Y" go stale when a
  feature adds a setter. Grep for them when a new writer of a suppression flag lands.
