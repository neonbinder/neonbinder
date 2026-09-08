---
name: maestro-web-cannot-scroll-after-base-picker
description: Once BaseSetPicker has been opened and closed, no maestro-web scroll primitive moves the set-builder page — measured four ways; `- swipe:` hangs the driver for 180s
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
