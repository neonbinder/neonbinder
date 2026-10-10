---
name: wizard-fixture-lookup-throughput
description: Size an entity-review fixture by its unknown-name count — live Wikidata settles ~0.7 rows/s, so the walk util's 180s covers ~125 names; teams settle LAST (players inserted first, FIFO pool); a READY row is presented at once
metadata:
  type: reference
---

**Throughput.** Measured 2026-10-10 on a 244-name batch (216 players + 28
teams, none in the enrichment recording): 129 rows settled in 180s, all in
~218s on a later pass. Budget ~0.7 rows/s. `util-wizard-walk-to-player-row`'s
first wait is the sanctioned 180s Wikidata ceiling, so it cannot drain a batch
much over ~125 live names; the team-skip drain afterwards costs ~3-4s per
team/league step on top (54 steps took 3m25s once career teams were staged).
Check a candidate set's unknown count before choosing the walk.

**Order.** `startBatch` inserts every player row before any team row and the
Wikidata pool is FIFO, so a fresh batch's team rows settle LAST. Until the
first team settles, `resolveNav` has nothing to yield a presented player to.

**Ready rows.** `isPresentable` is "undecided and not pending". A row inserted
READY (NEO-332: a name two players on file share, no lookup until Create new)
is presented the moment the wizard opens, while everything else is still
looking up. That is how `checklist-wizard-same-name-pick-step` skips the walk
on a 244-name set. Main-branch backends look such a row up, so a local run
against a deployment on older code needs the walk to reach it.

Related: [[neo236-wizard-teams-first-walk]], [[wizard-drain-loop-one-footer-guard]].
