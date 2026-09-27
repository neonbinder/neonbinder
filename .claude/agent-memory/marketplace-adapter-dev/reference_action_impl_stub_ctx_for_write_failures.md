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

**Wikidata's pool work items are the exception since NEO-301.** The adapter
is still no-throw, but `runSparql` records the failure on a `LookupTrace`
(`unavailable` for timeout/network/5xx/429), and `enrichPlayer` /
`enrichTeam` / `enrichLeague` / `runEntityReviewLookupImpl` read it AFTER
their catch and throw a retryable `WikidataUnavailableError`. So a stubbed
dead `fetch` now DOES make those actions throw — through the trace, not
through a catch. A stubbed failure that returns fast is retried in-call once
after a real 1.5 s sleep; to simulate a realistic (slow) failure with no
wall clock, `vi.useFakeTimers({ toFake: ["Date"] })` and have the fetch stub
call `vi.setSystemTime(Date.now() + WIKIDATA_FETCH_TIMEOUT_MS)` before it
throws — a slow failure is not retried in-call. See [[workpool-retry-semantics]].

Also: **`runWithOccRetry` (`lib/errors/occ-retry`) takes an injectable
`sleep`**, so pass `{ sleep: async () => {} }` instead of fake timers.

**Resume tests over real data:** the stub need not be scripted. Forward to
the convex-test backend (`runQuery: (ref, a) => t.query(ref, a)`, same for
`runMutation` → `t.mutation`, which accept internal refs) and throw only on
the Nth call whose `getFunctionName(ref)` matches the chunk writer. The first
chunks commit for real, the test asserts the partial state, then re-runs the
public action to prove the resume finishes with no duplicate (NEO-306
`slSetReview.test.ts`). Type the stub as `Parameters<typeof fooImpl>[0]` with
`FunctionReference<"query"|"mutation">` params to stay out of `never`.

Mutation-test the result: move the write back inside the lookup's `try` and
confirm the red lands on the *payload* assertion, not on a stub running out of
script — order the assertions so the "what got written" one comes first.

Related: [[convex-test-read-budget-by-construction]],
[[generated-api-needs-hand-edit-in-worktrees]].
