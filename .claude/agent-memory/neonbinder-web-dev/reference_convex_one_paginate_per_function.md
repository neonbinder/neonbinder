---
name: convex-one-paginate-per-function
description: Convex (and convex-test) allow exactly ONE .paginate() call per function execution — a chunked walker that loops over several nodes per invocation must use an index-bounded .take() with a hand-rolled _creationTime cursor instead
metadata:
  type: reference
---

A Convex mutation/query may call `.paginate()` only once per execution; a
second call throws "Only a single paginated query (`.paginate()`) is allowed
per function execution" — and convex-test enforces it too, so the error
surfaces as a silently failed scheduled function ("Error when running
scheduled function …" in stderr, test assertions then miss).

**Why it bites:** a self-rescheduling walker that wants to spend one
read-budget across SEVERAL small nodes per invocation (e.g. cards under every
leaf of a set subtree) naturally paginates once per node in a loop.

**How to apply:** page with `.withIndex(idx, q => q.eq(key, id).gt("_creationTime", after)).take(n)`
and carry `after` (the last row's `_creationTime`) as the cursor arg — every
index implicitly ends in `_creationTime`, which is unique within a table, so
"strictly after it" is an exact resume point. `rows.length < n` means the node
is exhausted. See `cascadeSelectorOptionTeams` (NEO-277) for the shape; the
existing single-node walkers (`processBscTeamEnrichmentQueue`,
`backfillCardFeatures`) can keep `.paginate()` because they page one table.
