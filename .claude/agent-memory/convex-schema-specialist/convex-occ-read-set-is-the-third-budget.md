---
name: convex-occ-read-set-is-the-third-budget
description: A .collect() has a THIRD cost beyond system ops and doc reads — its OCC read set; and paging a mutation cuts its own conflict risk while multiplying invalidation events for every concurrent wide reader.
metadata:
  type: project
---

`[[convex-two-transaction-limits]]` names two budgets. There is a third cost
that neither of them measures: **the OCC read set**.

A `.collect()` over an index range is 1 system operation and N document reads —
*and* it puts all N documents into the transaction's read set. Any concurrent
mutation that inserts into that range, or patches any document in it, rolls the
reader back. In a mutation that runs many-wide on a hot table, the read set is
the dominant cost and the other two budgets say nothing about it.

**Why:** in `entityReviewQueue.ts`, `applyLookupResult` runs 5-wide under the
Wikidata pool, and one branch (`stageLeagueRowsImpl`'s QID dedupe) collects the
whole batch through `by_selector_option_and_batch` to filter ~5 league rows out
of ~750. Every other pool item's own `patch` of its own row falls inside that
range, so the pool contends with itself and Convex exhausts its retries. The
schema file already states the rule in NEO-236's own words — "a collect of the
batch is the NEO-189 optimistic-concurrency storm" — and a later ticket added
one anyway, because the *result* was small and the *read set* was not.

**Paging is not a cure for contention; it redistributes it.** The intuition
"a long transaction holds a longer conflict window, so short pages conflict
less" is only half right:

- As the **victim**, paging helps: a short transaction with a small read set is
  invalidated less often and retries cheaply.
- As the **aggressor**, paging hurts: Convex OCC is invalidation-event based,
  not lock-duration based. One transaction writing 750 rows produces ONE
  invalidation; a client-driven chain of 30 pages produces 30, spread across
  the window in which a concurrent wide reader is retrying. That is literally
  what "changed … on every subsequent retry" means — a transient loss turned
  permanent because the retry budget is small and finite.

**How to apply:** when a plan converts a single transaction into a paged chain
(the NEO-294/NEO-296 class), audit every *other* mutation that reads the same
index range wide, and narrow those reads in the same PR. When reviewing a hot
mutation, grep its call tree for `.collect()` / `.take()` on a broad `eq`
prefix and ask what the narrowest range that answers the question is — a
prefix of an existing index usually exists and needs no schema change.

Related: [[convex-two-transaction-limits]],
[[convex-per-row-cost-hides-in-entity-helpers]].
