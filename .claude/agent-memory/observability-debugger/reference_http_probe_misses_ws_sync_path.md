---
name: http-probe-misses-ws-sync-path
description: A ConvexHttpClient probe measures function execution, never the WebSocket Transition a useMutation await waits on; posthog-js drops capture() before init()
metadata:
  type: reference
---

Two patterns that make a "client stall" look healthy in the artifacts:

1. **`ConvexHttpClient` is not the sync protocol.** `client.query`/`client.mutation`
   post to `/api/query` and `/api/mutation`: one function execution, one HTTP round
   trip, no subscription, no Transition. A browser `useMutation` await resolves only
   when the next Transition arrives, after every subscribed query re-runs. So a
   probe built on the HTTP client (the NEO-407 one) can report p99 = 60 ms while
   specs wait seconds for writes to settle. To see the sync path, time it in the
   client (wrap the store's mutation calls under E2E and emit a diagnostic with the
   duration), or build the probe on `BaseConvexClient` from `convex/browser` with a
   live subscription. Keep the HTTP probe as the server-side control.

2. **The Convex client announces socket pauses and auth refetches only through
   `_logVerbose`.** `ConvexReactClient` options `verbose`, `logger` and
   `onServerDisconnectError` exist and default off; with none set and no
   `page.on("console")` in the Playwright fixture, there is no record of a pause or
   restart anywhere. Enable them under E2E before theorising about the socket.

3. **posthog-js drops `capture()` before `init()`** (`uninitializedWarning`), with a
   console error only. A provider that calls `posthog.init` in a `useEffect` runs
   AFTER its children's effects, so a mount-time diagnostic in a non-lazy child is
   lost silently. Init at module scope, or queue until `__loaded`.
