---
name: checklist-team-spec-red-with-teamless-rows-is-a-bsc-lookup-stall
description: Team-shaped reds across shards (checklist team specs, seed card #300 team, collection hunt-tray strict-mode on base vs parallel) = BSC's per-card team lookup failed (timeout or 429), not the PR; grep bsc_card_team_lookup_failures
metadata:
  type: project
---

A set-selector checklist spec that reads a team sub-line after the commit
(e.g. the NEO-333 dual-team spec), red with "Saved N cards" shown and NO row
carrying any team, means BSC's per-card team lookup (`fetchBscCardTeamNames`,
10 s timeout, 10-wide) failed during the fetch. Signature in the Convex
logs: `bsc_card_team_lookup_failures` with `failed == requested` on the spec's
own requestId, and per card either `card-listing fetch error ... TimeoutError`
(seen 2026-11-07, PR 431) or `card-listing fetch failed status=429` returning
in ~300 ms per 50 (seen 2026-11-10, PR 450, in the SEED's Base fetch). The
wizard then walks one extra post-name step ("Cards with no team") and the save
commits teamless cards by design (CLAUDE.md rule 8: a lookup that never
returned goes to the operator; `processBscTeamEnrichmentQueue` retries at
+60 s / +5 min, beyond any 7 s bar).

When it hits the seed, the collateral is wider: setup builds Gold Wave from Base
~30 s after the Base fetch, before the first retry, so the Gold Wave copies are
teamless while Base rows gain teams piecemeal from the retry queue. Then
`checklist-bsc-team-enrichment` (#300 Mariners) reds, and collection specs that
tell the base card from its parallel in the hunt tray by name shape (`, [^,]+$`)
hit strict mode, because a teamless parallel reads "..., Gold Wave Refractors"
with one comma like a base reads "..., Tigers". Telling them apart by the tray's
caption (plain "2024 Topps Chrome" under the base face) is the robust locator.

**Why:** the merged-main diff looks like a suspect, but the teams are lost
before any PR code runs. Pull `convex-logs-seed-*` as well as the shard's logs.

**How to apply:** check the lookup-failure line (and `byStatus` 429 in
`bsc_call_summary`) before blaming the diff; it is a BSC flake, full rerun
([[bsc-profile-stalls-are-long-standing]], [[bsc-limits-by-volume]]). Fix a
name-shape locator that assumes a parallel always carries a team; never plan a
product change to keep it working.
