---
name: neo296-transaction-bound-tests
description: How to test a NEO-296-style Convex transaction bound (write budget, page + nextFrom, refusal) without hard-coding numbers — plus the fixed-point sortOrder fixture trap and fake-timers-to-observe-between-pages trick
metadata:
  type: reference
---

Testing the NEO-296 transaction bounds in `convex/selectorOptions.ts`
(`selectorOptions.writeBudgets.test.ts`) turned up four reusable things.

**1. A budget that counts WRITES is pinned by three assertions, not one.**
`storeSelectorOptions` returns `{ itemsProcessed, hasMore, writeOps }` and
resumes by REPLAY (re-send the identical list; the stored prefix re-matches by
marketplace id and costs zero writes). The trio that actually defends it:
over-budget call reports `hasMore` with the prefix committed; replay of the
same payload finishes and `writeOps` equals only the tail; replay of a
*complete* store is `writeOps === 0`. That last one is what makes the whole
scheme work and is the cheapest test in the family. Same shape as
`setReconciliation.writeBudget.test.ts` — copy it.

**Note the accounting:** `writeOps = inserts + row patches`. The parent
`children` union patch is deliberately NOT counted (it is inside the fixed
allowance), so an all-insert batch of N under budget gives `writeOps === N`
exactly.

**2. Fixture trap — a "wrong" sortOrder that is accidentally right.**
Seeding a checklist with `sortOrder: count - i` to make every row wrong has a
FIXED POINT at `i === count / 2`, so one row already holds the index the
restamp would write and `patched` comes back one short. Use
`sortOrder: 2 * count - i` (still reverse order, offset past the end, no fixed
point). The same trap hits any test that asserts an exact patch count against
a reversed-index fixture.

**3. Observing the state BETWEEN pages needs `vi.useFakeTimers()`.**
convex-test starts a `runAfter(0)` continuation in the background as soon as it
is scheduled, which races an assertion about the half-done state. Under fake
timers nothing fires until `t.finishAllScheduledFunctions(vi.runAllTimers)`, so
"after one invocation, some node is still unsettled" and "the card pass has not
started" become deterministic. Drive the chain by calling the internal mutation
directly (`t.mutation(internal.…, …)`) for invocation one, then drain.

**4. A module-private bound can still be pinned without its number.** Build a
fixture comfortably past it and assert the *consequence* — `settled > 0 &&
settled < total` — rather than `settled === 300`. That fails when the bound is
removed and survives the bound being retuned. Mutation-verified.

Related: [[project-convex-test-patterns]],
[[reference-neo247-bsc-multicard-reschedule-needs-cancel]].
