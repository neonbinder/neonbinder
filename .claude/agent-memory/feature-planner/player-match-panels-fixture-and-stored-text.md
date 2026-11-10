---
name: player-match-panels-fixture-and-stored-text
description: E2E for the shared player match panels (NearMatchPanel, SameNamePlayerPanel) and why their candidate text is stored, not live
metadata:
  type: project
---

Two constraints that shape any plan touching how a player candidate is described (NEO-462, 2026-11-07).

1. **The wizard's player NearMatchPanel has no controllable E2E fixture.** Wizard rows come from the seed set's checklist, so a close-match player would have to share a surname with a row you cannot pick in advance, and any player a spec creates in Baseball is looked up (needs a recorded no-match name). Prove the shared panel + `players.nearMatches` on the `/admin/players` add form instead. Two options there: players in a spec-owned custom sport (no sportConfig.wikidata, so minted single-token names), or same-name forks by birth year. Exact ties keep server order (`orderCandidates` falls back to index, and the index returns rows by creation time), so the first-created exact row is the one promoted to the primary "Open ..." button and the rest stay in the panel.
   **Why:** no wizard path exists without a new enrichment capture.
   **How to apply:** offer the wizard surface as a needs-Jason branch with that capture cost. Before relying on the custom-sport route, confirm it really makes no lookup: grep the run's Convex logs for `enrichment_fixture_live_refused`.

2. **`entityReviewQueue.enrichment.existingCandidates[].careerSummary` is preformatted text written at enqueue/lookup time.** A format change reaches only rows written after deploy, and rows already queued keep the old text until their next batch. That is cosmetic, so plan no migration. A schema change is only needed if the panel must speak a structured form.

Related: [[seeded-roster-is-the-read-only-fixture-for-name-matching]], [[aria-names-and-roles-are-the-spec-handles]].
