---
name: convex-connection-lost-is-a-socket-reconnect
description: "'Connection lost while action was in flight' on a failure screenshot is a Convex CLIENT websocket reconnect, never a server timeout, a slow action or a short flow timeout — the mechanism, and how to prove transport vs product regression from one run's artifacts"
metadata:
  type: reference
---

A failure screenshot showing
`Error: [CONVEX A(<module>:<action>)] Connection lost while action was in flight  Called by client`
is **not** a slow backend, a short flow timeout, or an action that threw.

## Mechanism (read out of the pinned client, not the docs)

The string exists in exactly one place:
`node_modules/convex/dist/esm/browser/sync/request_manager.js`, inside
`RequestManager.restart()`. `restart()` is called from the sync client's
WebSocket **`onOpen`** handler (`browser/sync/client.js`), i.e. on every
RE-connect. Queries are resubscribed and mutations are replayed; actions are
not idempotent, so every in-flight action is rejected with this message.

So the fact asserted by that banner is narrow: *the tab's websocket was torn
down and re-established while an action was outstanding.* It says nothing about
how far the action got, and the action normally keeps running to completion on
the server after the client has given up.

Reconnect triggers, all in `browser/sync/web_socket_manager.js`: `ws.onclose`
(any network or server-side close), `FailedToSendMessage`, and
`closeAndReconnect("InactiveServer")` — which the client fires **itself** when
it has received no server message for `serverInactivityThreshold`, hard-coded
to `6e4` (60 s). Sixty seconds of silence on the socket is sufficient on its
own, so a long action with a quiet subscription is the exposed shape.

## Proving transport vs product regression

Never raise the flow's timeout and never call it a flake without a mechanism.
Discriminate from evidence already in the run:

1. **The in-run cross-client control** ([[flake-runtime-forensics]]) is
   decisive here. Grep every runner artifact for the same step and compare
   durations — `awk` over `debug/*/maestro.log` for that step's
   RUNNING/COMPLETED lines. Nine sibling flows making the identical call
   against the same preview, seconds either side, all returning in seconds,
   means the deployment, the action and the marketplace were healthy. A
   deterministic regression cannot pass nine times and fail once.
2. **Check the deploy timeline** — `gh api …/actions/runs/<id>/jobs`. A Convex
   deploy or the seed job inside the window disconnects every client at once.
3. **Browser-service Cloud Run logs timestamp the fetch.** The per-worker
   `/credentials/<site>-…/token` requests are logged the instant
   `fetchCardChecklist` starts, so they pin the action's start time and show
   whether the marketplace side ever got into trouble.

## Before blaming a paged or chained write

A write that pages at N rows per transaction does **nothing at all** on a
fixture smaller than N: one clear page, one write page, zero
`scheduler.runAfter` calls, and every guard gated on `from > 0` is unreachable.
`SET-REGISTRY.md` records each real set's measured card count — read it before
theorising about a chain that never ran.

## The product finding that rides along

The raw Convex error string reaching the operator is worth filing on its own:
they lose a minute-long marketplace sync, are shown `[CONVEX A(...)]`, and are
offered no retry. Report it; never work around it in the flow.

See also [[never-diagnose-timing-first]].
