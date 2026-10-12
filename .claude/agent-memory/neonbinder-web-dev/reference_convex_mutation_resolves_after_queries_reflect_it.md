---
name: reference-convex-mutation-resolves-after-queries-reflect-it
description: A successful useMutation promise resolves only after query subscriptions hold the writes but BEFORE React re-renders — rebuild from useQuery after `await`, but a `.then` must not rely on an effect having seen the new data; a FAILED one resolves at once
metadata:
  type: reference
---

Verified in `convex/dist/esm/browser/sync/request_manager.js` + `client.js`
(convex ^1.44): a successful mutation response is parked as `Completed` with
its server `ts`; `removeCompleted(ts)` resolves it only on the Transition whose
ts covers it, AFTER `remoteQuerySet.transition(...)` has applied the new query
results and just before `notifyOnQueryResultChanges`. A failed mutation
(`!response.success`) resolves immediately — it wrote nothing, so there is
nothing to wait for. `useQuery` reads through `useSubscription`, whose listener
setState fires in that same synchronous block, so a render triggered after the
`await` sees the post-mutation tree.

**How to apply:** after `await apply(...)` it is safe to RESET a reducer and
let a one-shot INIT effect rebuild from the live `useQuery` value (NEO-308's
partial-save rebuild relies on this). Do not snapshot the query value into a
ref inside the async handler instead — the handler's closure and a render-time
ref can both be one render stale. Related: [[reference-rerender-same-element-bails-out]].

**The flip side (NEO-330 × NEO-332):** the query data is new but React has
NOT rendered yet when `.then` runs, so an effect keyed on that data (the
wizard's `resolveNav` effect) has not seen it. A `.then` that rewrites nav
state from a ref (`navRef.current`) reads the pre-update nav and can clobber
what the effect would have done. Make the handler self-sufficient rather than
relying on effect order. To reproduce in a component test with module-state
`useQuery` mocks: have the mutation mock assign the new rows to the query
variable and THEN return `Promise.resolve(...)` — the next render (triggered
by the `.then`'s own setState) reads the new rows, which is exactly the
production order. Prove the test bites by neutralising the fix.
