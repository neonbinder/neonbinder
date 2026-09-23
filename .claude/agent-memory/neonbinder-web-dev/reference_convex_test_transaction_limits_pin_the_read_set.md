---
name: convex-test-transaction-limits-pin-the-read-set
description: convex-test's `transactionLimits.documentsRead` turns a read RANGE into an assertion, which is the only way to test an OCC narrowing whose answer is unchanged by design
metadata:
  type: reference
---

`convexTest({ schema, modules, transactionLimits: { documentsRead: N } })`
(object overload, convex-test >= 0.0.55) enforces Convex's real per-execution
budgets and throws Convex's own `Scanned too many documents in a single
function execution (limit: N)` when a transaction passes one. That is the
handle for testing a **read set**, which is otherwise invisible: convex-test
does not simulate optimistic concurrency, so there is no write-conflict to
assert on.

**Why this matters.** Narrowing a `.collect()` of a whole batch down to an
indexed prefix is behaviour-preserving by design — the *answer* is identical —
so every assertion on the result passes against the wide version too. Only a
budget assertion can fail on the old code.

**How to build one.** Seed the table with filler rows that the narrow range
excludes and the wide one includes, then run the real mutation under a cap
between the two costs. Measure both numbers first by flipping the query shape
and re-running; pick a cap with an order of magnitude of margin each way, and
write both measurements into the test comment so the number is not a mystery.
Observed on NEO-294 (`stageLeagueRowsImpl`'s QID dedupe, 200 filler rows in the
batch): indexed three-field prefix passed at `documentsRead: 5`, the batch-wide
`.collect()` threw at `documentsRead: 120`.

**Gotchas.**
- The cap applies to *every* transaction on that `t`, including each `t.run`.
  A read-back helper that collects the whole table will blow the budget the
  test exists to prove — read back through an index instead.
- `ctx.db.insert` does not count as a read, so seeding hundreds of filler rows
  under a tiny cap is fine.
- Other limits stay at Convex defaults when you pass a partial object, but
  passing anything at all switches enforcement on for the whole run.

Related: [[reference_convex_one_paginate_per_function]],
[[reference_convex_components_unregistered_in_convex_test]].
