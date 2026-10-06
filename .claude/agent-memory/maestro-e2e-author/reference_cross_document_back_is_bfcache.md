---
name: cross-document-back-is-bfcache
description: maestro-web `back` = Selenium navigate().back(); after an `openLink` the previous page comes back from Chrome's bfcache (state preserved) even with an open WebSocket — to remount a page on its URL use an in-app route change + `back`; flows cannot read the URL and have no reload/forward
metadata:
  type: reference
---

Decompiled `CdpWebDriver` (cli 2.8.0): `backPress()` is
`navigate().back()`; there is NO refresh and NO forward; `stopApp` is a no-op;
`launchApp` opens the flow's configured url. The current URL is written only
into the hierarchy ROOT's `url` attribute, which no selector/copyTextFrom field
reads — a flow cannot see the address bar.

Measured 2026-10-04 with raw CDP on pinned Chrome for Testing 151: navigate
A → B (full document) → back restores A from the back/forward cache
(`pageshow.persisted === true`, same `performance.timeOrigin`) EVEN WITH an
open WebSocket, and this app's own shell on a local Vite does the same.
ChromeDriver adds no `--disable-back-forward-cache`; maestro-web passes only
`--headless=new --lang --window-size --password-store --disable-search-engine-choice-screen`.

**How to apply:** "openLink elsewhere, then back" does NOT prove a page
rebuilds from its URL — it proves bfcache. To get a fresh MOUNT on the same
URL, leave through an in-app route change (a NavLink tap = pushState), then
`back`: React Router unmounts/remounts the route, component state resets.
Prove the remount with page state the URL does not carry (type into a box
before leaving, assert it EMPTY after). And end the away-visit inside the
other page's content: focus left on a persistent nav link survives Back, and
"focus the deepest column" effects (NEO-224 set builder) never steal it.
Worked example: `set-selector/drill-restores-from-url.yaml`.
