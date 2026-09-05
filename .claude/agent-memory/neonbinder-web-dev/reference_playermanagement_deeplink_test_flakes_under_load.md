---
name: playermanagement-deeplink-test-flakes-under-load
description: PlayerManagement.test.tsx "writes the param for a player it has just created" can fail in a full components-project run but passes in isolation — check before blaming your diff
metadata:
  type: reference
---

`components/admin/PlayerManagement.test.tsx` → "PlayerManagement — the ?player
deep link > writes the param for a player it has just created" asserted
`url()` was `''` instead of `'?player=p-trout'` during a full
`vitest run --project components` (67 files, high parallelism) on 2026-09-04,
then passed 55/55 when re-run alone seconds later, with no change to the file.

**Why it matters:** it looks like a real regression if your diff touched
anything selector- or routing-adjacent. It is not — the assertion reads
window history state that the harness has not flushed yet under load.

**How to apply:** if this one test fails in a full run and your diff does not
touch `components/admin/` or the search-param plumbing, re-run that single file
before investigating:
`npx vitest run --project components components/admin/PlayerManagement.test.tsx`.
If it passes alone, report it as a pre-existing flake rather than fixing your
own change. Do not fold a fix for it into an unrelated PR.
