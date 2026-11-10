---
name: fake-a-convex-query-value-over-the-websocket
description: NEO-450 — how to fake one reactive Convex query's value in the browser with page.routeWebSocket (no Convex hook) — key by udfPath+args, no-op-version Transition injection, chunk reassembly, end the fake on the server's answer to the retry
metadata:
  type: project
---

When a state needs a server value no UI can produce on cue (a failed sync) and
Jason has ruled out a Convex test hook, fake it at the Convex sync socket:
`support/column-sync-fault.ts` is the worked example (convex 1.49.0).

- Install `page.routeWebSocket` BEFORE `signIn`; a `page.goto` inside a drill
  helper opens a new socket and re-runs the handler, so keep state per socket.
- Learn queryIds from the client's `ModifyQuerySet` `Add { queryId, udfPath,
  args: [obj] }` (udfPath canonical, ".js" stripped); key on udfPath + args,
  never on NB names. A row id the page needs comes from the set builder's
  address (`?brand=<id>`).
- An already-subscribed query only changes when a Transition carries it, and
  the server will not resend an unchanged value. Inject a Transition with
  `startVersion === endVersion ===` the last forwarded `endVersion`: the client
  accepts it and changes no version, ts or auth. Forward every real frame in
  order so the version never drifts.
- `TransitionChunk` frames must be held until the last part, then forwarded
  untouched or replaced by one rewritten Transition.
- End the fake on a REAL event, the server's `ActionResponse` to the
  column's own forced action, then re-inject the last real value. "Alert went
  away" then proves the button reached the server for that column.
- Prove it bites: break the helper's locator text AND the retry hook, and
  check that each one goes red.

**Why:** a hand-made path's real sync never writes a status row, so "stop
faking" alone never clears the UI. And a reload would prove nothing about the
retry button.

**How to apply:** reuse `faultColumnSyncStatus` for column statuses. Build any
other query fault the same way, as its own small helper with the Convex
version in its header.
