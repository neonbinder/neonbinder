---
name: strict-returns-drift-is-invisible-to-typecheck
description: Adding a field to a table whose rows are returned whole by a hand-kept strict `returns` validator passes `npm run typecheck` and every existing unit test, then refuses at runtime the first time a row carries the field — how to find the copies before handing the schema back
metadata:
  type: feedback
---

A schema field added with `v.optional()` on a table whose documents are
returned WHOLE through a hand-written `v.object(...)` `returns` validator is
a runtime refusal (`Object contains extra field '<name>'`), not a compile
error: `npm run typecheck` (`tsc -p convex/tsconfig.json`) is green, and the
unit suite stays green too because nothing writes the field until the
builder's code lands. The gate lies for exactly this class of change.

**Why:** the schema comments on `selectorOptionFields` / `selectorOptionMetadataFields`
record the same bug landing in prod twice (NEO-96, NEO-239); `teams` and
`entityReviewQueue` still keep hand copies (`teams.ts` `teamDocValidator`,
`entityReviewQueue.ts` `decisionValidator` / `teamCreateValidator` /
`enrichmentValidator`) that are NOT derived from the schema, so a schema-only
assignment (NEO-284, 2026-09-16) has to name them for another builder.

**How to apply:** before reporting a schema change done, grep for whole-doc
copies and list them file:line in the report as same-PR edits:
- `_id: v.id("<table>")` in `convex/**/*.ts` — a validator carrying `_id` +
  `_creationTime` is a whole-document copy; one that lists a few fields is a
  projection (safe).
- one distinctive field of the table (`colorCandidates: v.optional`,
  `linkedTeamId`, `excludedCareerTeamNames`) to catch nested-shape copies
  (decision/enrichment unions).
Prove the change by running the convex-test files that load the schema, but
say in the report that green typecheck + green tests do NOT cover the copies.

What DOES cover them: convex-test runs `validateReturnValue` on every
query/mutation/action it executes, so a test that writes the new field onto a
row and then calls each public/internal reader of that table goes red on a
missed copy. Put that test in the plan (one call per reader, incl. internal
`getInternal`-style raw-doc returns, which have their own copy).

Alternative to widening every copy: a field that is a DERIVED copy for one
reader (NEO-318 `players.alsoSportIds`) is better stripped in the shared
doc-to-public helper (`toPublicPlayer`) and re-added only where a validator
names it — public shapes stay byte-identical and the copy cannot leak into
readers that should consult the authoritative table. Raw-doc internal
validators still need the optional field.
See [[reference-typecheck-convex-changes]].
