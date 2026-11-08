---
name: patterns-stale-chunk-injection
description: NEO-434 — how to fake a deploy-stale lazy chunk in a signed-out spec (support/stale-chunks.ts), the arm-time snapshot, the no-reload anchor, and the RED breaks that prove it
metadata:
  type: reference
---

`support/stale-chunks.ts` answers 404 for every same-origin code file the page had not requested when `arm()` was called (no file name hard-coded; works on Vite dev `/app/about/page.tsx` and a built `/assets/page-<hash>.js`).

- `page.on("request")` fires before a route predicate, so snapshot the seen set at arm time; route handlers cannot be unrouted mid-flight ("Route is already handled!"), so a flag the handler reads switches `fail-once` / `fail-always` / disarm.
- Arm right before the click that needs the chunk. Signed out, `Get Started` visible means the entry bundle is done; measured no late code requests in either mode, and the spec asserts `blockedUrls()` equals the one URL, so a stray blocked chunk fails loudly.
- "No reload" needs a positive anchor: wait for the 404 response, then drive a client-side nav (About) in the same document and assert zero main-frame document requests since arming (`navigations()`). The landing page re-renders after a reload, so URL/visible checks alone cannot see one.
- RED proof used two breaks: no-op the `window.location.reload()` (Recovers and Gives-up go red), and add a reload to the warm-up `.catch` in `app/landing.tsx` (warm-up spec goes red on the navigation count only).
- A new signed-out spec under `tests/home/` needs no registry, project-scope or timings entry (unknown specs get the median timing).
