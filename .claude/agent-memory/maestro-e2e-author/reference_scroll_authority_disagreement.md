---
name: scroll-authority-disagreement
description: Two Maestro scroll-authority root causes — component scrollToIndex(align:center) vs Maestro visibilityPercentage = stale coords (fix centerElement); and scrollUntilVisible defaults to direction DOWN (fix direction UP for targets above the scroll)
metadata:
  type: reference
---
Two distinct, reproducible (NOT flake) scroll root causes found during the NEO-85 tail-flow RCA (2026-07-05). Both are "coordinate staleness / wrong-direction," not timing.

## 1. Component scroll vs Maestro scroll disagree → stale-coordinate tap miss (RCA aacdbb3f)
When a component fires its OWN `virtuosoRef.scrollToIndex({align:"center"})` on a mutation (e.g. CardChecklist.tsx ~L262 after add-card), the new row settles at viewport CENTER (y≈468/315). But a Maestro `scrollUntilVisible` with `visibilityPercentage: 50` and NO `centerElement` stops the instant the row is 50% visible near the BOTTOM edge (y≈577), reads bounds THERE, then the component's async center-scroll shifts the row ~110px UP before the tap dispatches → tap lands on stale coordinates and misses (or hits the wrong element).
FIX: add `centerElement: true` to that `scrollUntilVisible` so Maestro drives to the SAME center target the component uses — the two scroll authorities agree and the row is stable when its bounds are read. This is the simplest fix and beats a result-keyed retry wrapper. Reinforces [[feedback-centerelement-default-keep]] and Rule 8 (centerElement on every scroll-to-tap).
Gotcha to unlearn: an old comment claimed "the new card sorts to the BOTTOM, so don't center." FALSE — `restampCardChecklistSortOrders` slots by natural cardNumber order (NOT last index), and the component centers it anyway. Don't omit centerElement based on a "it's at the bottom" assumption.

## 2. scrollUntilVisible defaults to direction DOWN — walks AWAY from a target above the scroll (RCA a63e1ef)
`scrollUntilVisible` with no `direction:` defaults to DOWN. If a preceding step scrolled the viewport DOWN past the target (classic: a BSC/SL tablist at the TOP of a card, parked ABOVE after scrolling down to a success banner), a plain DOWN `scrollUntilVisible` for that tab swipes further away and never finds it → fails "No visible element: <tab>".
FIX: set `direction: UP` on that scroll. Pairs fine with `centerElement: true`.
Applies wherever the target sits ABOVE the current scroll position (tablists, page headers) after a prior downward scroll.

## 3. centerElement BREAKS an ASSERT-ONLY scroll to a mid-page target on a tall page (NEO-170, 2026-08-18)
The mirror of case 1. `centerElement: true` is for scroll-TO-TAP (R8) — it makes Maestro drive the target to viewport centre so the captured tap coords are stable. On a scroll that only ASSERTS (no tap), it is not just unnecessary, it can hang the flow.
Mechanism: `scrollUntilVisible` swipes in `innerHeight/2` steps (~314px on the 629px headless viewport). `centerElement` is satisfied only when `isElementNearScreenCenter` holds — element centre within ±height/5 (±~126px) of y=314, i.e. a narrow band. On a tall page the fixed ~314px step can STRADDLE that band: consecutive scrollY values land the target below the band, then above it, never inside → oscillate to the 20000ms timeout. Worked example: heading at doc-y≈800 on a ~1540px page — scrollY 314 puts its centre at ~499 (below band), scrollY 628 at ~185 (above band), band never hit. Removing `centerElement` makes it pass on the FIRST downward step: a plain scroll only needs the element 100% in the viewport, which top-parking satisfies. The sticky binder header is irrelevant — visibilityPercentage is geometric vs the viewport, not occlusion-aware, and nothing is tapped.
RULE: `centerElement` ONLY on a scroll that precedes a `tapOn`. On an assert-only `scrollUntilVisible`, leave it off. (Do not "add centerElement" as a speculative fix for a scroll timeout — on an assert scroll it is the CAUSE, not the cure.)

## 4. Maestro cannot see an <img> — assert on the placeholder shown INSTEAD (NEO-170)
maestro-web's `INVALID_TAGS` drops `img` from the hierarchy, so an image (and its alt text) is unassertable. To prove an image RENDERED, assert on the fallbacks the component shows in its place: e.g. `extendedWaitUntil notVisible ".*Loading image.*"` then `assertNotVisible "Image unavailable"` — together they mean the slot resolved to a real `<img>`. Requires the component to render a fixed-size placeholder for the loading/error states (same box the img fills) so there is text to match; NEO-170's ScanImage does (`h-40` on placeholder AND img → also no layout shift).
