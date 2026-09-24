---
name: patterns-neo299-shared-pool-warmups
description: NEO-299 moved heavy warm-ups INTO the heavy workpool; a public signed-in trigger that enqueues onto a shared FIFO pool is a head-of-line DoS on real work; plus the tf service-level metadata-block and cross-repo parity-fetch traps
metadata:
  type: project
---

Rule: any public (even requireUserId) function that ENQUEUES onto a workpool shared with real
user work must be deduped deployment-wide, not just bounded by maxParallelism.

**Why:** @convex-dev/workpool pendingStart is indexed by segment (enqueue time), so dispatch is
FIFO. maxParallelism bounds Cloud Run cost, but the QUEUE is unbounded: a caller looping the
public action puts N items per call ahead of every user's escalations. Queued-not-started items
bump no heartbeat, so the placeholder watchdog (30 min on lastActivityAt) then fails other
users' batches. NEO-299 did this with `warmPreprocess` -> `enqueueHeavyWarmups`
(HEAVY_MAX_PARALLELISM per call, no dedup). The pre-NEO-299 shape (direct fetch beside the pool)
cost 429s instead; moving it into the pool converted cost into starvation.

**How to apply:** when a diff routes "best-effort" work (warm-ups, prefetch, probes) through a
pool real work uses, ask: who can trigger an enqueue, how often, and is there a singleton
"last enqueued at" guard in the enqueuing MUTATION (OCC makes it race-free). Also check the
unit tests pin the dedup, not just the fan-out width.

Related traps from the same audit:
- Terraform google provider 4.x: adding a top-level `metadata { annotations = {...} }` to
  `google_cloud_run_service` makes the service-level annotation map managed; any out-of-band key
  not in config or ignore_changes is REMOVED on apply. Out-of-band settings differ per env, so
  a dev-only plan does not prove prod. Require a prod plan / describe before promotion; watch
  `run.googleapis.com/ingress` specifically (removal widens network exposure).
- Cross-repo parity checks that curl a public raw file: content can only pass/fail the run
  (fine), but a "404 = warn and continue" rollout tolerance is a permanent fail-open unless it
  is made fatal on the path that runs after the rollout (e.g. prod/main).
- A single-source capacity JSON feeds both a Convex fallback and `--max-instances` literals;
  parity checks prove equality, not sanity. Ask for a range/quota bound on the JSON itself.

See [[patterns-neo170-workpool-pipeline]], [[patterns-wikidata-pool-abuse-surface]].
