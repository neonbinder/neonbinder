---
name: rekey-action-is-not-a-backfill
description: rekeyEntityNames:run only resyncs side rows for entities whose name KEY changed; on a steady-state deployment it writes nothing, so it cannot fill a new derived field even though it calls the single writers
metadata:
  type: project
---

`convex/rekeyEntityNames.ts` calls `syncPlayerSports` / `syncPlayerAliases` /
`syncTeamAliases`, which makes it look like a ready-made way to run a
writer over every entity. It is not: `applyPage` reaches a writer only for a
row whose decision is `changed` (stored key != recomputed key), and on a
steady-state deployment `toRekey` is 0. It also has no table
filter — `run` walks all nine key-bearing tables, plans collisions across
them, and would rewrite any stray stale key it finds, which is outside the
scope of an unrelated field fill.

**Why:** NEO-318 (2026-10-08) asked whether the re-key could backfill a
denormalised `players.alsoSportIds`. It would have been a silent no-op, and
bending its decision functions to treat "copy stale" as "changed" would
pollute its `toRekey` report and idempotence check, which are keyed on name
keys only.

**How to apply:** for a new derived field, fill it with a small dedicated
armed backfill (the `cardPlayerLinks.backfillCardPlayerLinks` page + action
loop shape), walking the narrowest table that implies a non-default value
(e.g. `playerSports` via `pagePlayerSportRows`, not `players`) and writing
through the existing single writer. Check first whether the deployment even
has rows needing it — an absent optional field read as `?? default` may need
no backfill at all. Prod data scripts need Jason's approval (no bespoke
one-offs without asking). Related: [[armed-backfill-models-have-no-cursor]].
