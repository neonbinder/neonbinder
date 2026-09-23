---
name: action-impl-stub-ctx-for-write-failures
description: Testing a Convex action's error and write-failure branches — extract a plain *Impl(ctx, args) and script a Pick<ActionCtx,"runQuery"|"runMutation"> stub (convex-test cannot produce an OCC conflict), and never inject the failure at fetch: adapters here are no-throw, so a throwing fetch stub reaches no catch
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

**"I stubbed `fetch` to throw" is not "the code under test saw a throw."**
This generalises well past one file and invalidates a whole category of
error-path tests here. Every adapter in `convex/adapters/` is **no-throw by
convention**: `runSparql` absorbs a transport failure and answers `null` (its
NEO-288 one-retry contract), and `adapters/espn.ts` states the rule outright
("No-throw, like every adapter here"). So a throwing `fetch` stub never
reaches a caller's `catch` — it arrives as a lookup that ran and answered
nothing, and a test named for the catch passes identically with the catch
deleted. Before trusting any error-path test, ask which layer actually
propagates, and inject the failure THERE: for an action, that is the ctx
(`runQuery`/`runMutation`), not the network. Then make the test prove which
path it took — assert the marker the no-match branch logs and the absence of
the one the catch logs — or the name drifts back into fiction. `convex/
wikidataEntityReviewQueue.test.ts` carried exactly this fiction from NEO-99
until NEO-294 renamed it.

Also: **`runWithOccRetry` (`lib/errors/occ-retry`) takes an injectable
`sleep`**, so pass `{ sleep: async () => {} }` instead of fake timers.

Mutation-test the result: move the write back inside the lookup's `try` and
confirm the red lands on the *payload* assertion, not on a stub running out of
script — order the assertions so the "what got written" one comes first.

Related: [[convex-test-read-budget-by-construction]],
[[generated-api-needs-hand-edit-in-worktrees]].
