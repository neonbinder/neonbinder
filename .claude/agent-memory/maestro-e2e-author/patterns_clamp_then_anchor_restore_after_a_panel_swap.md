---
name: clamp-then-anchor-restore-after-a-panel-swap
description: A create that swaps a deep form for a query-loaded panel leaves the page in TWO scroll states (clamp, then Chrome scroll-anchoring restore); a positioning scroll that reads state 1 is a coin flip — gate on a mount-only element first, without scrolling
metadata:
  type: reference
---

**Signature.** A flow taps a submit button deep in a form (page scrolled to
centre it), the form unmounts, and the panel that replaces it loads through a
`useQuery` on the new id. Then a later wait times out on an element that the
failure screenshot shows is rendered — just ABOVE the viewport — and the step
that was meant to position the page logged a target "already visible" with
`try count: 0` and no swipe.

**Mechanism (measured over CDP, /admin/players, NEO-312):**
1. form unmounts, panel not loaded yet → document shrinks → browser CLAMPS
   scroll to the new max (464 → 82);
2. panel mounts → Chrome scroll anchoring puts the page back EXACTLY where it
   was before the tap (82 → 464), same frame as the mount, no script call
   (focus/scrollIntoView/scrollTo hooks all silent). With
   `overflow-anchor: none` on html+body it stays at 82 — that is the proof.
   A real scroll during state 1 re-selects the anchor and cancels the restore,
   which is why green runs (that swiped during or after it) hid the bug.
In CI the gap between the two states was ~2-3 s — wide enough for a
`scrollUntilVisible` hierarchy read to land in either.

**Fix pattern.** After the tap, gate on an element that exists ONLY in the new
panel and is on screen in state 2 (`extendedWaitUntil`, no scroll, 7000). Only
then scroll, centred, in the direction state 2 implies. Never use a
`scrollUntilVisible` as the first step after such a swap: if its first read
catches state 1 and accepts the target inside the centring band, the restore
moves the page afterwards.

**How to measure it in two minutes:** the CDP probe in
[[probe-a-fixture-without-draining-it]] with a 50 ms in-page sampler of
`scrollY`, `scrollHeight` and the target's `getBoundingClientRect().top`,
plus a `scroll` listener; rerun with `overflow-anchor: none` to confirm.
Wrap every CDP `send` in a timeout and write results BEFORE
`Page.captureScreenshot` — the screenshot can hang (NEO-258 class) and take
the data with it.

Related: [[flows-must-not-rely-on-the-document-bottoming-out]],
[[negative-asserts-pass-on-a-dead-page]].
