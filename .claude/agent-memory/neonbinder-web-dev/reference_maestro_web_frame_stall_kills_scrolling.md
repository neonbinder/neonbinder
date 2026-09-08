---
name: maestro-web-frame-stall-kills-scrolling
description: maestro-web's only scroll primitive is a frame-driven smooth scroll, so when headless Chrome's compositor stalls on the drilled set-builder page every scroll silently moves 0px — reproduced on two different sets, and it is not an app CSS/DOM bug
metadata:
  type: reference
---

Whenever an E2E report says "maestro cannot scroll page X", check for a
compositor frame stall before looking for anything in the app's CSS or DOM.

**Why the two are linked.** maestro-web has exactly one scroll primitive
(`maestro/drivers/WebDriver.class`, `scrollVertical` / `swipe(SwipeDirection)`
/ `scrollUntilVisible`): `window.scroll({top: window.scrollY ±
Math.round(window.innerHeight / 2), left: window.scrollX, behavior:
'smooth'})`. Smooth scrolling is a frame-driven animation, so no frames means
zero pixels — and the failure is silent: the command still reports COMPLETED.
`- swipe: {start, end}` is a Selenium `PointerInput` sequence and hangs to its
own 180s timeout for the same reason. Element bounds come from
`getBoundingClientRect()` (viewport coords, `maestro-web.js` `getNodeBounds`),
so "bounds unchanged" really does mean the page never moved.

**How to tell it apart in ten seconds.** Attach a second CDP client to the
live maestro Chrome and count frames:

```
port=$(cat "$(ps -o args= -ax | grep chrome-mac-arm64 \
  | grep -o -- '--user-data-dir=[^ ]*' | head -1 | cut -d= -f2)/DevToolsActivePort" | head -1)
# puppeteer-core: connect({browserURL: 'http://127.0.0.1:'+port}), then in the page
# count requestAnimationFrame ticks and setInterval ticks over 2s.
```

A stalled renderer reports `raf: 0` while `setInterval` ticks ~125/2s — the
main thread is fine, only frame production is dead. Then
`window.scroll({behavior:'smooth'})` moves nothing while `window.scrollTo(0,N)`
moves instantly, and `document.visibilityState` is `"visible"` the whole time.
Once stalled it never recovers: neither DOM mutations, nor an infinite CSS
animation, nor `Emulation.setDeviceMetricsOverride` restarts it.

**The tell in the flow log** is a hung `takeScreenshot`. maestro's
`WebDriver.takeScreenshot` is Selenium `TakesScreenshot.getScreenshotAs`, which
waits on a frame, so `maestro.utils.ScreenshotUtils.takeScreenshot: Taking
screenshot to output sink` with no following line is the stall, sitting in
`~/.maestro/tests/<ts>/maestro.log`.

**Measured on PR #242 (2026-09-08), Chrome for Testing 151.0.7922.77,
`--headless`, 1024x625.** The stall begins when a SET is selected and the
Variant Types column is revealed — screenshots and `- scroll` still work at the
manufacturer level and hang on the very next command. It is NOT set-specific:
Hockey/1995/All Brands/"Roanoke Express ECHL" and Baseball/2024/Topps/"Topps
Big League" both hang at exactly that step, so a flow that passes on one set is
luck, not evidence about the set. It is also not the app: the same states in
puppeteer-driven Chrome launched with maestro's own flag list keep rAF at
45-90/s, smooth-scroll exactly 313px per swipe, and screenshot in 45-80ms.
A second CDP client attached for the whole run prevents the stall entirely —
that run scrolled `Sync card checklist` from y=429 to y=208 and finished green.

**The fix, measured 2026-09-08.** Launch Chrome for Testing with
`--run-all-compositor-stages-before-draw`. maestro's `ChromeSeleniumFactory`
hard-codes its option list and exposes no hook for extra args, so the way in is
a wrapper script pointed at by `SE_BROWSER_PATH` that `exec`s the real binary
with the flag appended. An 8x (screenshot + `- scroll`) probe on the drilled
set-selector page: **unpatched 1/9 screenshots before hanging; with the flag
9/9 screenshots and 8/8 scrolls, twice in a row**, and the screenshots show the
page actually moving. `--disable-new-content-rendering-timeout` alone does not
help (hangs on the first screenshot) and neither does `--headless=old`.

**The app was cleared as the cause.** `scrollColumnIntoView`
(`EntityColumn.tsx`) writing `scrollContainer.scrollLeft` at the moment a
column is revealed was the prime suspect, because the stall starts at exactly
that render. Deferring the write to `requestAnimationFrame` still stalls (6/9
screenshots). Making it a no-op is not even testable — the Sets column then
never scrolls into view and the flow fails one step earlier — which is itself
the reason the function exists. Nothing about the app changes whether the
renderer stops producing frames.
