---
name: convex-table-removal-does-not-fail-the-push
description: Removing a whole table from schema.ts while rows still exist does NOT fail `convex deploy` (docs: schemas validate only listed tables); only removing/retyping a FIELD on a kept table trips the stale-row preview hazard
metadata:
  type: reference
---

Convex schema validation applies only to tables listed in the schema
(docs.convex.dev/database/schemas: "schemas only validate documents in the
tables listed in the schema"). So deleting a table definition plus its
functions in one PR is safe even where dev/preview deployments still hold rows
(e.g. NEO-341 retiring `e2eFlowQueue`); the orphan rows are inert and the
preview is deleted on PR close anyway.

**How to apply:** do not plan a two-step "clear rows, then remove table"
sequence for a table removal. Reserve that sequencing for a field removal or
retype on a table that stays (see [[hand-kept-validator-copies-of-schema-shapes]]
and the coordinator's "preview schema rejects stale rows after a field
removal" note). Deleting a Convex module also means regenerating
`convex/_generated/api.d.ts`.
