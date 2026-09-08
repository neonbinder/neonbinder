---
name: maestro-web-cannot-scroll-after-base-picker
description: One set-builder page will not scroll for maestro-web in ANY mode while a structurally identical one moves 313px per swipe — six runs of evidence and everything ruled out
metadata:
  type: reference
---

maestro-web has ONE scrolling primitive under every command: the strings in
`maestro/drivers/WebDriver.class` are
`window.scroll({ top: …, left: …, behavior: 'smooth' })` and
`window.scrollY ± Math.round(window.innerHeight / 2)`. It is a frame-driven
animation, and **on the `/admin/set-builder` page after the base picker has
closed it advances by zero.**

Measured on PR #242's preview, 2026-09-07, four ways, every one leaving the
dumped hierarchy at scroll 0 (root `[0,0][1024,1183]`, header still at y=16):

| tried | result |
|---|---|
| `scrollUntilVisible` (swipes from the viewport centre) | 12 swipes across two commands, target bounds unchanged at y=505, then `No visible element found` |
| `- scroll` ×3 after the cancel | three `Scroll vertically COMPLETED`, page unmoved |
| `- scroll` ×3 DURING the picker's own fetch (its `animate-pulse` skeletons are the one thing on the screen that animates) | same |
| `- swipe: {start: "50%, 85%", end: "50%, 25%"}` | **HANGS** the driver to its own 180s timeout — the same thing `checklist-wizard-skip-commits-and-unskip` records in its header |

Tapping the recovery panel's `Close` does not dismiss the panel and changes
none of it.

**It is not "the page is too tall" and not "the checklist is empty."**
`util-fetch-real-set-checklist-to-wizard` scrolls to the SAME
`id: "Sync card checklist"` on Topps Big League's Base with an equally empty
checklist (measured y=954 on a 629px viewport), and
`checklist-pairing-dialog-cancel` scrolls ~636px on the same screen — both
green on the same preview the same evening. The only thing neither does is open
and close `BaseSetPicker`.

Diagnosis aid, not proof: in a plain headless Chrome on that page
`window.scroll({behavior:'smooth'})` moves nothing while `window.scrollTo(0,N)`
moves it instantly, and `requestAnimationFrame` ticks 60/s on an undrilled
set-builder page and ~0/s once drilled. That browser is frame-starved on the
route generally, so it explains the mechanism (smooth scroll needs frames) but
cannot localise the trigger.

**Consequence for authoring:** a flow that must page-scroll after cancelling the
base picker cannot be written today. That state is unavoidable for a ONE-SIDED
set — `baseHasMapping` reads the SportLots slot alone, so a set with no
SportLots side always auto-opens the picker, and attaching one destroys the
precondition. See [[neo255-one-marketplace-surfaces]].

## Update 2026-09-08 — the cause is NOT the picker, and NOT frames

Re-tested on the build that added `pb-[50vh]` scroll headroom and made Close
dismiss the recovery panel. Both app changes work (Close dismisses, the
replacement `Map Base Set` button appears, both asserted green). **The page
still does not scroll**, six runs, five placements, three commands, every one
leaving the dumped hierarchy at `root=[0,0]`.

The sharpest measurement, and the one to quote: `scrollUntilVisible` on
`Multi-source sets` when it is **already visible at y=534** — the pure centring
path, not a blind search — swiped five times and the bounds never left 534.

That path demonstrably works elsewhere on the same route, build and viewport,
minutes apart: `base-mapping-cancel-recovers` moves the identical element
505 → 192 in ONE swipe **in the same post-Cancel state**, and
`checklist-wizard-skip-not-a-person` moves 432→119, 461→148, 529→216. Every
successful swipe travels exactly 313px = `innerHeight / 2`.

Ruled out, each with evidence — do not re-test these:

| suspect | how it was killed |
|---|---|
| page height / bottom headroom | 715px of scroll room, target 300px down |
| centring convergence | fails on an already-visible element too |
| the recovery panel's height | fails with it up AND dismissed |
| the focus park on `Map Base Set` | fails on a run that never pressed Close |
| a scroll lock / leftover overlay | body and html `overflow: visible`, no covering fixed element, instant `window.scrollTo(0,300)` moves the page |
| busy-vs-idle (frames) | fails 2.4s after a tap with a live marketplace fetch running; and `base-mapping-cancel-recovers` succeeds 8.3s after its tap |
| the element under the swipe origin | `elementFromPoint(512,312)` has NO scrollable ancestor — the document is the scroller |

**The probe browser cannot arbitrate this.** `window.scroll({behavior:"smooth"})`
in headless Chrome-for-Testing works for a while after a page load and then
stops, independently of the page — it "reproduced" a page-specific difference
once and then contradicted itself on the next session. Use Maestro's own logs
(`Element bounds` across `Scrolling try count`) as the only reliable signal.

Consequence unchanged: a flow needing a page scroll on the one-marketplace
Base page cannot be written today, and the fix is outside `.maestro`.
