---
name: wizard-fixture-lookup-throughput
description: Size an entity-review fixture, and any timing claim on it, by its unknown-name count and the 5-wide pool's depth — one live lookup's Convex-side time varies 0.3-20 s, the pool is 5-wide and deployment-wide, teams settle LAST (players inserted first, FIFO), and a READY row is presented at once
metadata:
  type: reference
---

**Per-lookup time varies too much to size a window on; size it on the pool's depth.**
One NPB batch on a PR preview (2026-10-11) ran Convex-side lookups from 0.3 s to 20 s
(Wikidata 502 retries in the tail; one 502'd name was re-looked-up ~42 s later and held
the tail to +44 s). The structural floor is the 5-wide FIFO pool: N unknowns need
ceil(N/5) rounds, each a round-trip plus ~0.2 s between a slot freeing and the next
start, and staged teams queue behind every player. Measured there: first five lookups
+0.5 s after `startBatch`, last player started +13.3 s, first team settled +14.1 s.

**Per-lookup time is a CONVEX number, never a laptop number.** Running the `*Live`
lookup bodies under tsx from a laptop (5 workers) settled 20 NPB names in 3.8 s wall.
Convex-side the same kind of names take ~4-5 s EACH: a CI run that had the 5-wide pool
to itself for the NPB batch started 21 lookups in 21 s. Dev 2026-10-10 agrees: 129 rows
of a 244-name batch (216 players + 28 teams, none recorded) in 180 s (~0.7 rows/s),
all in ~218 s on a later pass. No-match names are faster (~2.3 s, 1995 minor-league
hockey). So a batch of N unknowns keeps "still being looked up" on screen for about
ceil(N/5) x 4-5 s, and longer when other shards share the pool (it is ONE pool for the
deployment, so CI contention only lengthens windows). Fixture-recorded names
(`enrichment_fixture ... hit`) settle instantly and count for nothing.

**Order.** `startBatch` inserts every player row before any team row and the pool is
FIFO, so a team staged by a lookup is enqueued behind every player still waiting. The
first staged team settles roughly when the players have drained, which is when an
untouched player step starts yielding (`resolveNav`, teams first). The wizard walk
helper's first wait (`walkToPlayerRow` in `support/wizard.ts`) is the sanctioned 180 s
Wikidata ceiling, so it cannot drain a batch much over ~125 live names; the team-skip
drain afterwards costs ~3-4 s per team/league step on top (54 steps took 3m25s once
career teams were staged). Check a candidate set's unknown count before choosing the
walk.

**Where the batch starts relative to the spec.** In that CI run the wizard's title
(`Confirm New Players & Teams`, the fetch helper's last gate) painted 0.6 s BEFORE the
first lookup started (trace vs convex-logs clocks). A read right after the helper
returns lands ~1 s into the batch.

**Ready rows.** `isPresentable` is "undecided and not pending". A row inserted READY
(NEO-332: a name two players on file share, no lookup until Create new) is presented
the moment the wizard opens, while everything else is still looking up. Prove that in
ONE read: the heading below the header `0 of N reviewed - K still being looked up`.
Never put a resumed-batch discard helper that waits for something to be absent in front
of such a read: check the header text first and call the discard only inside the branch
that needs it. That is how the same-name pick-step spec skips the walk on a 244-name set. Main-branch backends
look such a row up, so a local run against a deployment on older code needs the walk
to reach it.

Related: `support/wizard.ts` (the walk helpers), [[same-name-player-panel]], [[measure-a-fixture-from-ci-artifacts]].
