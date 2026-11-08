---
name: checklist-team-spec-red-with-teamless-rows-is-a-bsc-lookup-stall
description: A checklist spec that asserts a card's team sub-line, red after "Saved N cards" with EVERY row teamless, is BSC's per-card team lookup timing out, not the PR; grep bsc_card_team_lookup_failures
metadata:
  type: project
---

A set-selector checklist spec that reads a team sub-line after the commit
(e.g. the NEO-333 dual-team spec), red with "Saved N cards" shown and NO row
carrying any team, means BSC's per-card team lookup (`fetchBscCardTeamNames`,
10 s timeout, 10-wide) timed out during the fetch. Signature in the Convex
logs: `bsc_card_team_lookup_failures` with `failed == requested` on the spec's
own requestId, `card-listing fetch error ... TimeoutError` per card, and other
specs' fetches in the same minute failing too. The wizard then walks one extra
post-name step ("Cards with no team") and the save commits teamless cards by
design (CLAUDE.md rule 8: a lookup that never returned goes to the operator;
`processBscTeamEnrichmentQueue` retries at +60 s / +5 min, beyond any 7 s bar).
Seen 2026-11-07 on PR 431 (photo-intake only, nothing on the checklist path).

**Why:** the merged-main diff looks like a suspect (NEO-424 touched
resolveChecklistEntities), but the teams are lost before that code runs.

**How to apply:** check the lookup-failure line before blaming the diff; it is
a BSC flake, full rerun ([[bsc-profile-stalls-are-long-standing]]). The spec
cannot name it today; a named guard is an optional spec improvement.
