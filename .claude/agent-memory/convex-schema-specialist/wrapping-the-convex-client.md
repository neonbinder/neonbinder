---
name: Wrapping the Convex client
description: Instrumenting ConvexReactClient (mutation/action/watchQuery, custom logger) without changing behaviour; the traps found in a review on convex 1.49
type: pattern
---
- Every hook routes through instance methods, so patching own-properties on the instance covers all of them:
  - useMutation -> `client.mutation(ref, args, {optimisticUpdate})`
  - useAction -> `client.action`
  - useQuery and the classic usePaginatedQuery -> useQueries -> `watchQuery`
  - `client.query` and `prewarmQuery` -> `this.watchQuery`
  - Only `usePaginatedQuery_experimental` goes through `watchPaginatedQuery`.
- `watchQuery` returns a fresh object literal, so reassigning `onUpdate` on it is safe. `localQueryResult()` throws for an error result, and QueriesObserver catches it.
- To track when a promise settles, use `promise.then(clear, clear)` only if you then return the *derived* promise. If you attach handlers to the caller's promise and return that same promise, a fire-and-forget rejection is silently marked handled: no `unhandledrejection`, no PostHog `$exception`, no Playwright `pageerror`. Return `promise.finally(clear)` instead.
- A custom `logger` object gets every `logVerbose` call. The `verbose` option gates only inside `DefaultLogger`.
- Log strings to parse:
  - `received ws message with type X`
  - `pausing WS for auth token fetch [vN]` / `resuming WS after auth token fetch [vN]`
  - A large transition logs `TransitionChunk` per frame, then `assembled full ws message of type Transition`. Match both lines, or "time since last Transition" goes stale on exactly the heavy transitions.
  - The re-auth path (`attempting to reauthenticate`) stops the socket without a "pausing" line.
- `connectionState()` on a client whose `sync` was never used *opens a WebSocket*, because `sync` is lazy. Calling it on a closed client throws. Only read it from a client known to have carried a call.
- React 19 StrictMode `useMemo` keeps the FIRST create result and throws away the second, so the spare client is the one built second.
