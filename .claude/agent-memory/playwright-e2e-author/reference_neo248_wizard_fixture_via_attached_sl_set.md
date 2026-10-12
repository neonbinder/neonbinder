---
name: neo248-wizard-fixture-via-attached-sl-set
description: DISPROVEN 2026-09-05 — a SportLots-only fetch never reaches the entity-review wizard (the SL adapter emits no players/teams); the working fixture is the REAL set Baseball/2024/Topps/Topps Big League/Base, 88 unknown names, all readers Cancel-Discard
metadata:
  type: project
---

# NEO-248 — the SL-only wizard fixture DOES NOT WORK (disproven live)

The design "hand-typed set under real ancestors plus ONE attached SportLots set id"
was tested end to end against two PR previews on 2026-09-05 and it CANNOT reach the
entity-review wizard.

`fetchSportLotsChecklist` (`convex/adapters/sportlots.ts`) **declares** `team` /
`teams` / `players` in its return validator but its handler never sets them. The doc
comment on `tokenizeSlDescription` says so deliberately: *"Team extraction is
intentionally NOT attempted here ... BSC supplies the canonical team in the merged
record anyway."* So **a SportLots-only fetch yields zero unknown player/team names for
ANY set**: the wizard never opens and every card commits as "needs attention"
(measured: "Saved 10 cards. 10 need attention", no wizard, `players` unchanged). This
is structural, not a bad choice of source set.

**Unknown names reach the wizard only from BSC** (`parsePlayersField` in
`convex/adapters/buysportscards.ts`) or from the retired hand-added
`pendingPlayerNames` path.

A per-worker set cannot become BSC-resolvable either: `BSC_REQUIRED_LEVELS` checks the
row **at level `setName`**, and the attach dialog writes ids to the **variant** row, so
a hand-typed set stays unresolvable even though `resolveBscFacetFilters` buckets ids by
FACET. Worth raising as a product inconsistency: resolvability is judged per-LEVEL,
the query is built per-FACET.

**THE WORKING ANSWER (measured on PR #235's preview, 2026-09-05):** the real,
BSC-listed set `Baseball > 2024 > Topps > Topps Big League > Base`. It syncs through
the real hierarchy (Base/Insert/Parallel, no reconcile), pairs 310 cards, and opens the
wizard on **88 unknown names (87 players + 1 team)**, first row a player with the
career-team form and "Back to matching" present. The seed provisions its structure and
Base mapping and must NEVER fetch its checklist: committing would make those 87
players known and destroy the fixture.

**All readers must Cancel then Discard.** CI has NO serialization lanes beyond the
shard plan; "sole writer" (1996 Score) is a review convention (SET-REGISTRY), not a
runtime mechanism. Concurrent READS are safe: candidates are scoped to the fetching
operator and batches are keyed by selectorOption + user.

Also rejected on PRODUCT grounds (Jason, 2026-09-05): hand-creating a set with
`+ Custom` and then attaching marketplace data to it. Hand-creating exists to AVOID
syncing; if a test syncs, it must sync through the real hierarchy. And an insert set
never has a "Base" variant.

## Constraint that shapes every spec on a real wizard fixture: NEVER create a player
`players` is GLOBAL and empty at the head of every run. A name one worker "adds as new"
stops being unknown for every worker that fetches the SAME set afterwards, which quietly
drains the fixture until a later spec's wizard never opens. So specs on this fixture end
in **Discard** or decide every row as **skip / link**. Skips are per-set, so they do not
leak.

## Source-set checklist (probe before approving)
Under a real ancestor; small; its players not already in `players` but at least TWO
unknown names; its teams already known (the wizard shows one row at a time and which
settles first is a Wikidata race, so unknown TEAMS make "the current row is a player" a
coin flip); and no other candidate's name may contain it as a substring.

Related: [[reference_neo239_retire_custom_flow_impact]], [[patterns_per_worker_data_isolation]].
