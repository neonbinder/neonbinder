---
name: patterns-playwright-websocket-route-proxy
description: Auditing a page.routeWebSocket proxy on the Convex sync socket in E2E — where relayed frames (incl. the Authenticate JWT) can and cannot surface in reports/traces, and the close-code and withheld-frame traps (NEO-450, Playwright 1.63)
metadata:
  type: project
---

A Playwright `routeWebSocket` proxy on Convex's `/api/<v>/sync` relays every
frame, including the client's `Authenticate { value: <Clerk JWT> }`, through
`WebSocketRoute.sendToServer/sendToPage` protocol calls.

**Where frames do NOT leak (verified in 1.63 source):** those calls carry
metainfo `group: "route"`; the worker only emits `onStepBegin` to reporters
for steps with no group, and their metainfo has no `renderParams`, so blob /
json / junit reports never see the message. CI traces are off in
playwright.config (they would record call params). So the leak surface is
the helper's own code: grep it for console.log, testInfo.attach, thrown
messages that interpolate a frame.

**Residual:** a LOCAL `retain-on-failure` trace records the protocol call
params, so the JWT lands in test-results/ trace zips (gitignored, short-lived
token). Note-level; becomes a blocker if CI traces are ever switched on.

**Masking traps to check in any such proxy:**
- Close mapping: only 1000/3000-4999 may be passed to close(); anything else
  (1006, 1011) is re-closed with NO code, so the page sees 1005 — reconnect
  still happens, but the original server code is lost from client logs.
- A throw inside `server.onMessage` before the pass-through `ws.send(frame)`
  withholds that frame (e.g. an ActionResponse) — the page hangs to a
  timeout instead of failing by name. Forward first, then do side work.
- While armed, a real `QueryFailed` for the faked query is rewritten to the
  fake value — fine only if the window is bounded by a real server event.

Related: [[patterns-playwright-report-exposure]].
