---
name: patterns-neo424-offered-on-stored-row
description: Relaxing a public mutation's id check to "the id is one the stored row offered" is safe only while every writer of that row field is internal and server-derived; how to enumerate the writers
metadata:
  type: project
---

NEO-424 loosened `entityReviewQueue.recordDecision` so a cross-sport player link
is accepted when the player id is in the STORED row's
`enrichment.existingCandidates` or `enrichment.preselect` (D7). The check reads
the row, never the args, and that held.

**Why it holds, and what to re-check whenever the relaxation is touched:** the
relaxation is only as narrow as the set of writers of those enrichment fields.
At NEO-424 they were: `startBatch` (internalMutation, facts from the gate's
bounded internal queries over committed cards), `resetAutoLinkedRow` (from the
stored decision), `applyLookupResult` (internal; spreads `args.enrichment` from
the Wikidata adapter, which never sets candidates/preselect, then overlays the
row's own), and `switchRowSport` (rebuilds enrichment in the new sport, which
DROPS history candidates and preselect, narrowing). No public mutation accepts
`enrichmentValidator` in its args.

**How to apply:**
- Grep every `enrichment` patch/insert in entityReviewQueue.ts and confirm none
  is public with client-shaped content; grep `enrichmentValidator` in `args:`.
- `applyLookupResult` spreads `args.enrichment` first: if the Wikidata payload
  ever gains `existingCandidates`/`preselect`, third-party data widens D7.
- The commit re-validates a link against the ROW's `sportId`, so any public
  door that can move `row.sportId` without rebuilding enrichment also widens it.
- Negative tests for "not offered -> refused" live in
  `entityReviewQueue.autoLink.test.ts`; confirm they still exist.

Related: [[patterns-neo92-entity-review-queue]], [[patterns-neo313-cross-sport-override]].
