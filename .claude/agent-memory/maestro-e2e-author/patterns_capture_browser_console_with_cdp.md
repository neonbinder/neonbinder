---
name: capture-browser-console-with-cdp
description: Maestro captures no browser console — drive Chrome for Testing over raw CDP with Node's built-in WebSocket to turn "An error occurred. Please refresh the page." into a named root cause in two minutes
metadata:
  type: reference
---

Maestro's debug output has `maestro.log`, screenshots and a hierarchy dump, and
**no browser console at all**. So an SPA crash shows up only as a blank page
with `"An error occurred. Please refresh the page."` and a downstream selector
failure — which reads like a flow bug and is usually not one.

No puppeteer/playwright is installed in this repo, and none is needed: Node 22+
ships a global `WebSocket`, and Chrome for Testing (already pinned and
downloaded for the suite) speaks CDP over HTTP + WS. About 30 lines:

```js
const CHROME = "/Users/<you>/.cache/puppeteer/chrome/mac_arm-<ver>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333",
  "--user-data-dir=/tmp/cdp-profile", "--no-first-run",
  "--window-size=1024,629", "about:blank"]);
// GET http://127.0.0.1:9333/json/list → the page target's webSocketDebuggerUrl
// new WebSocket(url); send {id, method:"Runtime.enable"} / "Page.enable"
// listen for Runtime.exceptionThrown and Runtime.consoleAPICalled
// Page.navigate to  <APP_URL>/testing/sign-in?redirect=/set-selector&worker=0
// Runtime.evaluate to click by text, then read document.body.innerText
```

Sign-in works exactly as it does for a flow — the `/testing/sign-in?redirect=…`
URL leaves a real Clerk session — so the browser lands on the same screen the
flow sees, and a `Runtime.evaluate` that clicks an element by `textContent`
reproduces the step that kills it.

**Worked example (2026-09-04).** Every set-selector flow was failing at
`No visible element found: id: Add custom Sports`, one tap into
`util-drill-to-custom`. Thirty seconds of CDP gave the actual line:

```
[CONVEX Q(selectorOptions:getSelectorOptionHoldings)] Server Error
Could not find public function for 'selectorOptions:getSelectorOptionHoldings'.
The above error occurred in the <DeleteSelectorRowControl> component.
```

— a shared-dev deployment lagging `main`, not a selector problem at all. See
[[local-validation-needs-a-pr-preview]].

**Second use, no crash needed:** the same script verifies a navigation
assumption cheaply. It proved `openLink ${APP_URL}/set-selector` mid-flow keeps
the Clerk session and re-lands on a populated Sports column — which is the whole
mechanism behind a "reload loses the screen but not the server session" flow —
without spending a Maestro run or the run lock.

Related: [[negative-asserts-pass-on-a-dead-page]],
[[speaking-conch-run-serialization]].
