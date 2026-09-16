---
name: hand-kept-validator-copies-of-schema-shapes
description: Adding a field to teams or entityReviewQueue means editing strict hand-kept validator copies (teams.ts teamDocValidator, entityReviewQueue.ts decision/enrichment copies) or every screen fails at runtime
metadata:
  type: project
---
A new field on `teams` or on `entityReviewQueue.decision`/`.enrichment` is not
done in schema.ts: `teams.ts` keeps a STRICT `teamDocValidator` used as the
`returns` of list/search/listForManagement, and `entityReviewQueue.ts` keeps
hand copies of the decision and enrichment shapes for `getBatch`. A field in
the schema and not in the copy is a runtime refusal on every function that
returns a row (the wizard fails to open; Team Management lists nothing).

**Why:** noticed while planning NEO-284 (team aliases); the code comments say
so but a plan that assigns schema.ts to one agent and teams.ts to another
must name the copies explicitly or they get missed.

**How to apply:** any plan touching those tables lists the validator copies
as files to edit in the same unit as the schema change, and the alias/index
pin tests (`teams.dedupPin`, `players.aliasIndexPin`) as the guard pattern to
mirror for a new side table.
