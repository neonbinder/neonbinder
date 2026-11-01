---
name: Playwright body attachments, routeWebSocket, Convex mutation resend
description: Where testInfo.attach({body}) ends up in CI artifacts; routeWebSocket connects from inside the page; Convex resends in-flight mutations on reconnect
type: pattern
---

Verified against the installed sources (Playwright 1.63, convex 1.49) while auditing NEO-409.

- `testInfo.attach(name, { body })` is never written to `outputDir`: the body rides
  base64-inline in the reporter events. So an upload glob over `playwright/results/**`
  is irrelevant to it; it reaches CI through the **blob** zip (`report/blob/*.zip`), and
  after `merge-reports` it is inlined in the HTML report when the content type is
  `text/*` or `application/json` (else written to `data/`), and base64 in `results.json`.
  JUnit only carries `path` attachments (`[[ATTACHMENT|...]]`), so the junit check never
  shows a body attachment. Size therefore lands ~4x: blob, shard results.json, merged
  results.json, merged HTML. Cap bodies by bytes, not only lines.
- A fixture teardown that attaches "on failure" reads `testInfo.status !==
  testInfo.expectedStatus`; it is final by teardown time. An overridden `page` fixture
  tears down before `context`, so the page is still open there.
- `page.routeWebSocket` + `ws.connectToServer()` opens the real socket **inside the page**
  with the saved native WebSocket, not from Node. Network path (direct, proxy, CI) is the
  same as an unrouted run; a Node-side HTTP proxy such as a bypass proxy never sees it.
- Convex `RequestManager.restart()` resends every in-flight `Mutation` on socket
  reconnect (actions are failed instead). A test that "swallows the first matching frame"
  then forwards the rest will let the resend through: swallow every matching frame.
- The e2e.yml header keeps the list of what public artifacts knowingly publish; any new
  attachment must be added there.
