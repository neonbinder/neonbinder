---
name: optional-to-required-is-two-merges
description: Tightening a schema field from optional to required (or narrowing a union) is the same hazard class as removing one — default to writers + backfill first, schema flip second; one PR only when prod is already clean and rechecked right before merge
metadata:
  type: project
---

`npx convex deploy` validates every existing document against the new schema
before the push lands, so a PR that flips `v.optional(x)` to `x` fails its
own prod deploy (and any PR preview that already holds rows) if one row
lacks the field. The backfill that would fix it only exists on prod once a
release has shipped it, and `convex deploy` from a laptop is forbidden.

**Why:** NEO-331 (2026-10-10) asked for `leagues.level` to become required
"in the same PR"; the deploy order makes that impossible without a race.

**How to apply:** plan it as PR A (every writer supplies the value, one
chokepoint defaults the unknowable case, armed backfill + runbook) → run the
backfill on prod and every dev deployment → PR B (schema + validator copies
tightened, backfill deleted per NEO-323). Say so in the plan and mark the
split **needs Jason** rather than pretending one PR can do it.

Exception (NEO-331, Jason): when the unconforming rows are few, the owner can
fix prod by hand first, and then one PR flips the schema and the writers
together — provided every writer in that PR supplies the value, prod is
re-checked for unconforming rows right before merge, and dev deployments are
fixed before anyone runs `convex dev` on the branch. Related:
[[hand-kept-validator-copies-of-schema-shapes]].
