---
name: e2e-seed-carries-no-cards
description: The PR-preview E2E reference bundle is 8 reference tables (sport rows, leagues, franchises, teams, aliases, players); every card and variant row is built by the Playwright setup project through the writers, so derived card fields need no seed transform or backfill
metadata:
  type: reference
---

`scripts/reference-seed` bundles exactly `selectorOptions` sport rows plus
leagues, franchises, teams, teamAliases, players, playerAliases and
playerSports; `checkFiles` refuses any other table. 2024 Topps Chrome (Base,
Future Stars, Gold Wave Refractors) is built by `playwright/tests/setup.spec.ts`
via `commitCardChecklistChunk` and `insertParallelCardsPage`, both through
`cardRowCreate.insertCardRow`.

**Why:** NEO-358's audit assumed the seed imported cards around the writers and
asked for a seed transform; it does not. `convex/e2eSeedDerivedFields.test.ts`
and the NEO-358 case in `scripts/reference-seed/pipeline.test.mjs` pin both
halves.

**How to apply:** a new stored card field or derived table reaches the preview
iff `insertCardRow` (or the writer the setup spec drives) writes it. Check that
writer, not the bundle. Only a new field on a sport, team or player row would
need the bundle rebuilt or transformed.
