---
name: workpool-retry-semantics
description: @convex-dev/workpool retries every THROW of a pooled action unless it is a NonRetryableError; onComplete runs only after the final attempt; the failure reaches onComplete as a message string, so classify by a marker in the message
metadata:
  type: reference
---

Verified by reading the installed package source (`src/component/complete.ts`,
`loop.ts`, `worker.ts`, `errors.ts`), not the README:

- With `retryActionsByDefault: true` (or `retry: true` per enqueue) EVERY
  throw is retried until `maxAttempts`, unless the error is a
  `NonRetryableError` (exported from `@convex-dev/workpool`; it is a
  `ConvexError`, so its marker survives the worker's `ctx.runAction` hop).
  Turning retries on for a pool therefore changes what every existing throw
  in its work items does — audit each `throw` (e.g. a deliberate rethrow for
  an onComplete backstop) and wrap the ones that must settle at once.
- `onComplete` is called ONLY when complete decides not to retry (success,
  non-retryable, canceled, or attempts exhausted). Never between attempts. So
  a backstop onComplete is automatically "after the final attempt".
- The action never learns its attempt number (only the worker gets it).
  "Final failure" signals belong in an onComplete, not in the action.
- `RunResult.error` is a STRING (`e.message`, possibly prefixed/stack-
  suffixed by Convex). Put a fixed marker token in your error message and
  search for it (not anchored) to classify the failure in onComplete.
- Backoff after the k-th failure: `initialBackoffMs * base^(k-1) * (0.5 +
  Math.random())`; a retrying item waits in pendingStart and does not hold a
  parallelism slot. The heavy-preprocess and Wikidata pool comments carry the
  worked arithmetic.
- convex-test cannot mount the component: pin `pool.options` (it is a public
  field on the Workpool instance), `vi.spyOn(pool, "enqueueAction")` to see
  onComplete/context wiring, and call the `defineOnComplete` mutation directly
  with `t.mutation(internal.<mod>.<onComplete>, { workId, context, result })`.

Related: [[action-impl-stub-ctx-for-write-failures]].
