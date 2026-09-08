---
name: claude-in-chrome-tabs-are-hidden
description: Claude-in-Chrome tabs report visibilityState "hidden" — rAF never ticks and every smooth scroll is a no-op, so scroll/animation bugs must be reproduced with puppeteer-core against the pinned Chrome for Testing instead
metadata:
  type: reference
---

Pages driven through the `mcp__claude-in-chrome__*` tools run with
`document.visibilityState === "hidden"`, `document.hidden === true` and
`document.hasFocus() === false`, and the extension renders them into an
oversized virtual viewport (`innerWidth`/`innerHeight` ignore
`resize_window`; `outerWidth`/`outerHeight` disagree with them completely).

Consequences that look exactly like product bugs:

- `requestAnimationFrame` does not tick, so **every frame-driven animation is
  frozen**. `window.scroll({top, behavior:"smooth"})` moves nothing, on any
  page, including a static one — while `window.scrollTo(0, N)` moves
  instantly. This reproduces on `/about` as readily as on
  `/admin/set-builder`, so it localises nothing.
- `Runtime.evaluate` on a script that `await`s a few `setTimeout`s can time
  out with "the renderer may be frozen or unresponsive" for the same reason.
- Viewport-dependent layout (below-the-fold, responsive breakpoints, maestro's
  1024x629) cannot be reproduced at all.

**How to reproduce those properly:** install `puppeteer-core` into the
scratchpad and drive the version-pinned Chrome for Testing that the E2E suite
uses — `apps/web/.maestro/chrome-version` names the pin and
`apps/web/lib-e2e-chrome.sh` builds its path under `~/.cache/puppeteer/chrome`.
Launch with `defaultViewport: {width: 1024, height: 629}` to match maestro-web.
There rAF ticks 60/s and smooth scroll behaves normally, so a real difference
is a real difference.

Chrome tools remain fine for DOM/state inspection (`javascript_tool` reads of
computed styles, overflow ancestors, `[role=dialog]`, `[inert]`,
`activeElement`) and for clicking through a flow — just never for anything
timed, animated, or viewport-sized.

Signing in for a local repro: `VITE_CONVEX_URL=<preview> npx vite --port 3001`,
then `/testing/sign-in?redirect=/set-selector&worker=0`. A worker whose Set
Builder shows the credential gate needs
`/testing/seed-credentials?redirect=/admin/set-builder` — that only writes the
signed-in test user's own marketplace credentials, unlike `/testing/reset`,
which wipes the deployment and must never be run against a preview someone is
testing.
