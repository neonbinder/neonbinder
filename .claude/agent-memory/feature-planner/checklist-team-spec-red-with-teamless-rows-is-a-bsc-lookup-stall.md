---
name: checklist-team-spec-red-with-teamless-rows-is-a-bsc-lookup-stall
description: Team-shaped reds across shards (teamless checklist rows, unchecked career-team pre-fill, an extra "Which X is this?" step, seed card #300 team, hunt-tray strict mode on base vs parallel) = BSC per-card team lookup failing (timeout OR awselb 429), not the PR; grep bsc_card_team_lookup_failures
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

**Second shape, 429 (seen 2026-11-10):** the card-listing fetch returns
HTTP 429 (`card-listing fetch failed status=429`) instead of timing out, for
every card, across PR runs that overlap in time. When it hits the **seed**
job, the seeded 2024 Topps Chrome base (and every parallel built from it) is
teamless for that whole pass, so collection specs fail far from the cause:
a "Put here" hunt regex that expects the base name to end at the team
(`..., <team>$`) instead matches each parallel (`..., Gold Wave Refractors`)
and Playwright reports a strict-mode violation. Check `convex-logs-seed` for
`failed == requested` before reading the collection spec.

**Why:** the merged-main diff looks like a suspect (NEO-424 touched
resolveChecklistEntities), but the teams are lost before that code runs.

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

**Second signature (seen 2026-11-10, every PR for hours):** the same lookup
answers HTTP 429 in under 30 ms with `server: awselb/2.0` and an empty body
(`bsc_call_failed ... card-listing ... status 429`). Same downstream effects,
plus two more that look like wizard bugs: a created player's in-window career
team is NOT pre-checked (rule 8: no data, no guess), and a namesake that the
card's team would have settled shows up as a "Which <name> is this?" step,
so a spec expecting one undecided name lands on a different one. Bucket the
429s by minute against each failing spec's start/end in the shard log; a
spec that passes inside the window simply needed no card team.
