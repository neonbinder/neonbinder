---
name: real-person-fixture-names-collide-with-committed-checklists
description: A spec that must use a REAL name (e.g. to prove a live Wikidata lookup) has to check it against every checklist the suite COMMITS, not just grep the specs — a committing spec bulk-adds ~200 real players as `players` rows every run, and a same-name row demotes the add form's `Create player <name>` to `Open <name>`
metadata:
  type: feedback
---

Rule: before using a real person's name in a spec, grep `apps/web/playwright/tests`
AND walk `SET-REGISTRY.md` for every set whose checklist a spec fetches and
COMMITS (the wizard's "Add remaining players as new" mints a `players` row per
unknown card name). Check the candidate against each of those checklists (TCDB /
a web search is enough) before settling on it.

**Why:** NEO-289 (2026-09-20) planned "Tony Gwynn" as the live-proof name for the
live Wikidata enrichment spec. No spec names him, but he is a card in a 1996
Score insert that another spec bulk-commits every CI run, so on any run where
that spec lands first, `/admin/players`' near-match panel finds the row, the
primary button reads `Open Tony Gwynn`, and `getByRole("button", { name: "Create
player Tony Gwynn" })` matches nothing: the spec reds by name. Replaced with a
player who retired before the oldest committed set and is in none of them.

**How to apply:** re-read `SET-REGISTRY.md` for the current committed-checklist
list. Prefer a player who retired before the oldest committed set's year and is
not a legend of any team the team sets honour. Such a spec is FRESH-ONLY: an
existing row is ADOPTED by `createByAdmin` and never re-enqueued for enrichment,
so a re-run needs a reset, and an optional "anyway" hedge on the create button
would let the spec go green on the previous run's QID (R2 false positive). Say so
in the header instead of branching.
