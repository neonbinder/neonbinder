---
name: real-person-fixture-names-collide-with-committed-checklists
description: A flow that must use a REAL name (e.g. to prove a live Wikidata lookup) has to check it against every checklist the suite COMMITS, not just grep the flows — the 1996 Score flow bulk-adds ~200 real 1996 players as `players` rows every run, and a same-name row demotes the add form's `Create player <name>` to `Open <name>`
metadata:
  type: feedback
---

Rule: before using a real person's name in a flow, grep `.maestro/flows` AND
walk `SET-REGISTRY.md` for every set whose checklist a flow fetches and
COMMITS (the wizard's "Add remaining players as new" mints a `players` row per
unknown card name). Check the candidate against each of those checklists (TCDB
/ a web search is enough) before settling on it.

**Why:** NEO-289 (2026-09-20) planned "Tony Gwynn" as the live-proof name for
`admin/player-live-wikidata-enrichment.yaml`. No flow names him, but he is
#A15 in 1996 Score Dugout Collection Artist's Proofs, which
`inserts-1996-score-one-nb-set-two-bsc-sources.yaml` bulk-commits every CI
run — so on any run where that flow lands first, `/admin/players`' near-match
panel finds the row, the primary button reads `Open Tony Gwynn` with NO
aria-label, `id: "Create player Tony Gwynn"` matches nothing, and the flow
reds by name. Replaced with "Harmon Killebrew" (retired 1975; in none of the
committed sets; resolves on Wikidata under the adapter's exact SPARQL).

**How to apply:** the committed-checklist set today is 2024 Topps Chrome
(seed), 2024 Topps Cubs / Orioles / Brooklyn Collection, Rickwood Field Negro
Leagues, Roanoke Express ECHL (hockey) and 1996 Score Dugout Collection —
re-read `SET-REGISTRY.md` for the current list. Prefer a player who retired
before the oldest committed set's year and is not a legend of any team the
2024 team sets honour. Also note: such a flow is FRESH-ONLY — an existing row
is ADOPTED by `createByAdmin` and never re-enqueued for enrichment, so a
re-run needs a reset, and a `( anyway)?` optional-group hedge on the create
button would let the flow go green on the previous run's QID (R2 false
positive). Say so in the header instead of branching.
