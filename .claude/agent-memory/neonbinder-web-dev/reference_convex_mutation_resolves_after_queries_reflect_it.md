---
name: reference-convex-mutation-resolves-after-queries-reflect-it
description: A successful useMutation promise resolves only after this client's subscriptions hold its writes; a FAILED one, and EVERY useAction, resolves at once — an action's writes may not be in useQuery yet
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

**Actions are NOT ordered** (same file: `response.type === "ActionResponse"`
resolves immediately, "intentionally decoupled from queries/mutations"). After
`await someAction()`, `useQuery` may still predate the action's last
`ctx.runMutation`. A row COUNT is no fence when the action's final write is a
patch to rows written long before (NEO-333: checklist team lookup patched
candidate rows ~70s after insert; the auto-keep path snapshotted team-less
cards). Fix pattern: the action returns a monotonic fence it read inside its
last mutation (batch id + that mutation's post-write count of a field that only
grows), and the client polls the subscription until it reaches it. Never fence
on a target the server may never reach (`ready === total`) — use the count the
server SAW.
