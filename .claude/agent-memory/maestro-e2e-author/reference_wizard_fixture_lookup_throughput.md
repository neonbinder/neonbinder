---
name: wizard-fixture-lookup-throughput
description: Size an entity-review fixture, and any timing claim on it, by its unknown-name count — one live lookup of a name Wikidata knows takes ~4-5s Convex-side (a laptop sees ~0.5s), the pool is 5-wide and deployment-wide, teams settle LAST (players inserted first, FIFO), a READY row is presented at once, and a `notVisible` dwell before a timing assert spends the window
metadata:
  type: reference
---

**Per-lookup time is a CONVEX number, never a laptop number.** Running the
`*Live` lookup bodies under tsx from a laptop (5 workers) settled 20 NPB names
in 3.8s wall. Convex-side the same kind of names take ~4-5s EACH: CI run
38073638557 had the 5-wide pool to itself for the NPB batch and started 21
lookups in 21s (first slot freed at +3.8s). Dev 2026-10-10 agrees: 129 rows in
180s (~0.7 rows/s). No-match names are faster (~2.3s, 1995 minor-league
hockey). So a batch of N unknowns keeps "still being looked up" on screen for
about ceil(N/5) × 4-5s, and longer when other flows share the pool (it is
ONE pool for the deployment, so CI contention only lengthens windows).
Fixture-recorded names (`enrichment_fixture … hit`) settle instantly and count
for nothing.

**Order.** `startBatch` inserts every player row before any team row and the
pool is FIFO, so a team staged by a lookup is enqueued behind every player
still waiting. The first staged team settles roughly when the players have
drained — that is when an untouched player step starts yielding
(`resolveNav`, teams first). `util-wizard-walk-to-player-row`'s first wait is
the sanctioned 180s Wikidata ceiling, so it cannot drain much over ~125 live
names; the team-skip drain costs ~3-4s per step on top.

**Where the batch starts relative to the flow.** In 38073638557 the wizard's
title (`Confirm New Players & Teams`, the fetch util's last gate) painted
0.6s BEFORE the first lookup started (maestro.log vs convex-logs clocks). A
read right after the util returns lands ~1s into the batch.

**Ready rows.** `isPresentable` is "undecided and not pending". A row inserted
READY (NEO-332: a name two players on file share, no lookup until Create new)
is presented the moment the wizard opens, while everything else is still
looking up. Prove that in ONE read: the heading `below:` the header
`0 of [0-9]+ reviewed · [0-9]+ still being looked up`. Never put
`util-discard-resumed-review-batch` (a 7s `notVisible` dwell) in front of such
a read: guard a resumed batch with `copyTextFrom` the header + `evalScript` +
`runFlow when: true:` (a script condition, no hierarchy wait) and call the
util only inside it. Then run the walk util to make the rest of the flow
deterministic. See `checklist-wizard-same-name-pick-step`.

Related: [[neo236-wizard-teams-first-walk]], [[wizard-drain-loop-one-footer-guard]],
[[same-name-player-panel]], [[measure-a-fixture-from-ci-artifacts]].
