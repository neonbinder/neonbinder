---
name: action-impl-stub-ctx-for-write-failures
description: Test a Convex action's WRITE-failure branches by extracting a plain *Impl(ctx, args) and passing a Pick<ActionCtx,"runQuery"|"runMutation"> stub that dispatches on getFunctionName — convex-test cannot produce an OCC conflict
metadata:
  type: reference
---

convex-test's in-memory db never loses an optimistic-concurrency race, so no
`t.action(...)` test can exercise "the lookup succeeded but the write
conflicted". The house move (same shape as `backstopEntityReviewRowImpl`):
export the action body as a plain `…Impl(ctx, args, occRetry = {})`, type its
ctx as `Pick<ActionCtx, "runQuery" | "runMutation">`, and register the action
as a one-line delegation. The test then hands it a literal cast through
`as unknown as`, scripts `runMutation` with a list of `"ok" | Error`, and
**dispatches on `getFunctionName(ref)`, never reference identity** — the
generated `api` is a proxy and two reads of one path are different objects.
Running off the end of the script should throw: an extra write is usually the
bug being pinned. Such a test needs no convex-test, so it can live beside the
adapter under `convex/adapters/`.

Two things that cost time here:

- **A dead `fetch` does not reach a wikidata lookup's catch.** `runSparql`
  absorbs transport failures and answers `null` (its NEO-288 one-retry
  contract), so a "network down" stub produces a NO-MATCH, not a throw. A test
  that means to exercise the catch must throw from something else in the try —
  the `getSportEnrichmentContext` query is the cheap one.
- **`runWithOccRetry` (`lib/errors/occ-retry`) takes an injectable `sleep`**,
  so pass `{ sleep: async () => {} }` instead of fake timers.

Mutation-test the result: move the write back inside the lookup's `try` and
confirm the red lands on the *payload* assertion, not on a stub running out of
script — order the assertions so the "what got written" one comes first.

Related: [[convex-test-read-budget-by-construction]],
[[generated-api-needs-hand-edit-in-worktrees]].
