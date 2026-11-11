---
name: workpool-lanes-and-throttle-rows-survive-the-e2e-reset
description: The set-builder reset drains only app tables in its allSteps list; workpool component queues and deployment-wide throttle rows (marketplaceCooldowns, marketplaceWaits) survive it unless added, and carry into CI's mobile pass
metadata:
  type: project
---

The global E2E reset (`runSetBuilderReset` in `convex/selectorOptions.ts`) deletes only the tables in its `allSteps` list. A workpool component's queue (`components.bscTeamPool`, `components.wikidataPool`) lives in the component's own tables, which `ctx.db` cannot reach, so queued items survive a reset and a re-seed and run against deleted rows. A new deployment-wide state table (a cooldown, a wait recorder) also survives unless it gets a reset step.

**Why:** PR 451 (NEO-487): the seed's 335-card fetch left ~300 cards on the one-slot BSC lane; the 429 cooldown it tripped escalated across the pass and would have carried into the mobile re-seed. Stale items checked the cooldown before their row, so they sat deferred for 30 minutes instead of finishing as "not needed".

**How to apply:** any plan that adds a workpool lane or deployment-wide throttle state must say (1) which reset step clears the table (every scope, not a reference-seed table), (2) that the reset calls the pool's `cancelAll`, and (3) that a work item reads its own row BEFORE any wait or cooldown check, so leftovers end at once. Throttle state is cleared only by the global reset, never the per-user bootstrap reset (shards run concurrently). Related: [[per-user-e2e-tables-reset-in-bootstrap-not-the-global-reset]], [[telemetry-awaited-in-a-workpool-worker-holds-the-slot]].
