---
name: drill-tap-timing-root-cause
description: waitToSettleTimeoutMs has zero effect on drill tap duration; the 2s/tap is hierarchyBasedTap change-detection, not post-action settle
metadata:
  type: feedback
---

# Drill tap timing — root cause of 2s/tap

## Finding (2026-06-18, PR #53)

Measured `util-drill-to-2024-topps-chrome.yaml` with all row-select taps and scrollUntilVisible
calls set to `waitToSettleTimeoutMs: 0` (search-box taps at 250ms). Drill duration: **32.5s and
33.1s** across two runs — IDENTICAL to the 32.5s baseline before the change. The `waitToSettleTimeoutMs`
tuning had zero measurable effect.

**Why:** The 2.0s per tap is NOT from `waitToSettleTimeoutMs`. It is from Maestro's
`hierarchyBasedTap` logic, which:
1. Finds the element (~0.35s)
2. Refreshes the element reference (~0.35s)  
3. Waits for a UI accessibility-tree change before proceeding (~1.3s)

That "wait for change" consumes a fixed ~1.3s on top of the ~0.7s locate+click, totaling ~2.0s
regardless of settle settings. It is watching the accessibility tree, not the settle timer.

**What confirmed this:** The logs show "wait to settle 0 ms" on the scrollUntilVisible calls AND
on taps that accepted `waitToSettleTimeoutMs`, yet tap durations remained exactly 2.0s.
The `hierarchyBasedTap` path was confirmed by the log line:
`hierarchyBasedTap-ogj28Uc: Something has changed in the UI judging by view hierarchy. Proceed.`
This appears on every row-select tap — it's the code path that controls the duration.

## How to apply

- Do NOT spend time tuning `waitToSettleTimeoutMs` on tap/scroll actions expecting speedup.
- The only way to cut drill duration is to reduce the NUMBER of actions or to use a Maestro
  version that exposes a flag to skip `hierarchyBasedTap` change-detection on web.
- `waitToSettleTimeoutMs: 0` on scrollUntilVisible IS still correct (cuts the post-scroll settle
  dead wait), but for these in-viewport elements the scroll completes in 1 try anyway — net saving
  is negligible.
- The changes applied (0ms settle on row taps/scrolls, 250ms on search-box taps) are safe and
  correct to keep — they don't harm stability — but they don't move the needle on drill time.
