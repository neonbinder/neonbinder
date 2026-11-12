---
name: canvas-toblob-waits-a-second-in-the-app-page
description: In the real app page under Playwright Chromium, each canvas.toBlob JPEG encode takes ~1000 ms regardless of size (idle-task deadline), so a two-encode resize costs ~2 s
metadata:
  type: reference
---

Measured 2026-11-10 (NEO-466) with in-page timings: `resizeCopyPhoto` on a 949-byte
50x70 JPEG took createImageBitmap ~210 ms, then **~1000 ms per `canvas.toBlob`**
(image, then thumb, sequential) = ~2.2 s. The main thread was idle (no long tasks).
The same `toBlob` on a quiet page (about:blank-like, same headless shell) took 0-7 ms.
The fit is Chromium's async blob encode, which waits for an idle period with about a
1 s start deadline, and the app page never gives it one.

The slow window is right after a write (Add pressed, page re-rendering). The same
resize started when the photo was picked, with the page quiet, took 22-29 ms. NEO-466
shipped both: the image and thumb encodes now run at once, and `preparePhoto` runs
at pick time. Add press to `startUpload` went from about 2.2 s to 183 ms.
`OffscreenCanvas.convertToBlob` was held back as a separate decision.

**How to apply:** when a photo or canvas step looks slow in E2E timings, suspect
`toBlob` scheduling before compute or the network. Start the encode while the page is
idle, and never chain two `toBlob` calls. Measure in the app page; an isolated page
will not reproduce it. Related: [[e2e-timeouts-are-ux-budgets]].
